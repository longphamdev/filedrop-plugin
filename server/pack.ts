import { once } from "node:events";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createDeflateRaw } from "node:zlib";
import type { RpcInput } from "@getpaseo/plugin";
import type { downloadDirRpc } from "../shared/rpc";
import { allowedRoots, isInside, resolveTargetDir } from "./paths";

const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
const READ_BYTES = 4 * 1024 * 1024;
// A staged archive lives at most this long — long enough to pull a multi-GB zip at a
// trickle, short enough that abandoned packs can't fill /tmp.
const PACK_TTL_MS = 10 * 60 * 1000;
const MAX_STAGED = 8;
// Classic zip limits: u16 entry count, u32 sizes. Zip64 is not emitted — exceeding
// these fails loudly instead of producing a corrupt archive.
const MAX_ENTRIES = 65535;
const MAX_U32 = 0xffffffff;
const OPEN_READ = constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0);

// ---------------------------------------------------------------------------
// CRC32 (IEEE), incremental — the standard reflected-table implementation.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

// Carries the running state between calls; finalize once with `state ^ 0xffffffff`.
function crc32Update(state: number, bytes: Uint8Array): number {
  let c = state;
  for (let i = 0; i < bytes.length; i += 1) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return c;
}

function dosDateTime(date: Date): { dosTime: number; dosDate: number } {
  // DOS dates only span 1980–2107; a legal POSIX mtime outside that range would make
  // writeUInt16LE throw and kill the whole pack, so clamp into range instead.
  const year = Math.min(2107, Math.max(1980, date.getFullYear()));
  return {
    dosTime: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    dosDate: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

// ---------------------------------------------------------------------------
// Walk: every regular file under the canonical dir, recursive, hidden entries included
// (the archive is "the folder" — not the browse view of it). Symlinks and special files
// are skipped: lstat.isFile()/isDirectory() are both false for them, which is also what
// confines the pack — a symlink is never opened, raced or not.
//
// Names are carried as RAW BYTES, not decoded strings: readdirSync("buffer") returns
// the exact bytes on disk. A decoded string lossy-mangles non-UTF-8 names to U+FFFD —
// opening that mangled string yields ENOENT and the file would be silently dropped.
// Zip entry names are the raw bytes; bit 11 (UTF-8 flag) is set per entry only when
// the name decodes without replacement characters.
const SEP = Buffer.from("/");

interface WalkFile {
  // Absolute path and zip-entry name, both as raw bytes.
  abs: Buffer;
  nameBytes: Buffer;
  // Name is valid UTF-8 — controls flag bit 11 for this entry.
  utf8: boolean;
}

async function walkFiles(root: string): Promise<WalkFile[]> {
  const files: WalkFile[] = [];
  const pending: { abs: Buffer; rel: Buffer }[] = [
    { abs: Buffer.from(root), rel: Buffer.alloc(0) },
  ];
  while (pending.length > 0) {
    const { abs, rel } = pending.pop() as { abs: Buffer; rel: Buffer };
    let names: Buffer[];
    try {
      names = readdirSync(abs, "buffer");
    } catch (error) {
      // The root itself unreadable must not silently yield an "empty" archive — that
      // would report a successful folder download that contains nothing.
      if (rel.length === 0) throw error;
      // A subdir that vanishes or denies read mid-walk is skipped — the pack covers
      // what was readable, and an unreadable entry is no worse than never existing.
      continue;
    }
    for (const name of names) {
      const childAbs = Buffer.concat([abs, SEP, name]);
      let stat;
      try {
        stat = lstatSync(childAbs);
      } catch {
        // Entry vanished between readdir and lstat — skipped like an unreadable dir.
        continue;
      }
      const childRel = rel.length === 0 ? name : Buffer.concat([rel, SEP, name]);
      if (stat.isDirectory()) {
        pending.push({ abs: childAbs, rel: childRel });
      } else if (stat.isFile()) {
        files.push({
          abs: childAbs,
          nameBytes: childRel,
          utf8: !name.toString("utf8").includes("�"),
        });
      }
    }
    // Yield between directories so a huge tree doesn't stall the plugin subprocess.
    await new Promise((resolve) => setImmediate(resolve));
  }
  files.sort((a, b) => Buffer.compare(a.nameBytes, b.nameBytes));
  return files;
}

// Same identity gate as file downloads: open O_NOFOLLOW, fstat it, then re-resolve +
// containment + dev/ino so a component swapped to a symlink mid-walk can't slip
// outside-root bytes into the archive.
function openContained(abs: Buffer, roots: string[]): number {
  const fd = openSync(abs, OPEN_READ);
  const display = abs.toString("utf8");
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`Not a regular file: ${display}`);
    // realpath must round-trip raw bytes: the JS implementation decodes path
    // components to strings internally and ENOENTs on non-UTF-8 names — .native
    // goes through libc realpath(3) on the raw Buffer instead. The stringified
    // form is still fine for the root-prefix check: a mangled leaf keeps its
    // inside-root prefix.
    const reResolvedBytes = realpathSync.native(abs, "buffer");
    const reResolved = reResolvedBytes.toString("utf8");
    if (!roots.some((root) => isInside(reResolved, root))) {
      throw new Error(`Resolved path escapes the allowed roots: ${display}`);
    }
    const reStat = lstatSync(reResolvedBytes);
    if (reStat.dev !== stat.dev || reStat.ino !== stat.ino) {
      throw new Error(`File changed while opening: ${display}`);
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Zip assembly. Sizes and CRCs aren't known until each file is deflated, so entries set
// bit 3 (data descriptor): local headers carry zeros and the real values trail the data.
// The central directory + EOCD carry the real values — that's what readers index on.

interface CentralEntry {
  nameBytes: Buffer;
  dosTime: number;
  dosDate: number;
  crc: number;
  compressedSize: number;
  size: number;
  offset: number;
  // Flags for the local header + central record: bit 3 (data descriptor) always set,
  // bit 11 (UTF-8 name) only when the raw name is valid UTF-8.
  flags: number;
}

// The archive sink shared by runPack and every packOne. `write` NEVER throws: a
// writeSync failure during a zlib "data" event would escape through zlib's synchronous
// processCallback — outside any try/catch — and kill the whole plugin subprocess as an
// uncaughtException. Errors are recorded instead and checked at awaitable points.
interface ArchiveSink {
  write(bytes: Uint8Array): void;
  error(): Error | null;
}

// Streams one file through deflate into `sink`. Returns the central-directory fields;
// `entry.offset` is assigned by the caller, who owns the archive position counter.
// openContained + the mtime lstat run BEFORE any bytes are written — the caller may
// skip this file when the error lands with `offset` unchanged; mid-stream failures
// leave a partial entry behind and must stay fatal.
async function packOne(
  sink: ArchiveSink,
  file: WalkFile,
  roots: string[],
): Promise<CentralEntry> {
  const fd = openContained(file.abs, roots);
  try {
    const { abs, nameBytes, utf8 } = file;
    const { dosTime, dosDate } = dosDateTime(lstatSync(abs).mtime);
    const flags = utf8 ? 0x0808 : 0x0008;

    // Local header: sig, ver 20, flags (data descriptor + UTF-8 iff name is valid
    // UTF-8), method 8 (deflate), times, crc/csize/usize = 0 (real values trail in the
    // descriptor), name len, extra len 0.
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(flags, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(dosTime, 10);
    header.writeUInt16LE(dosDate, 12);
    header.writeUInt16LE(nameBytes.length, 26);
    sink.write(header);
    sink.write(nameBytes);
    if (sink.error()) throw sink.error();

    const deflator = createDeflateRaw();
    let crc = 0xffffffff;
    let size = 0;
    let compressedSize = 0;
    deflator.on("data", (chunk: Buffer) => {
      compressedSize += chunk.length;
      sink.write(chunk);
    });
    const buf = Buffer.alloc(READ_BYTES);
    for (;;) {
      const read = readSync(fd, buf, 0, buf.length, null);
      if (read === 0) break;
      const slice = buf.subarray(0, read);
      crc = crc32Update(crc, slice);
      size += read;
      // deflator.write keeps a REFERENCE until zlib consumes the chunk — buf is
      // reused by the next readSync, so hand it a copy or the stream deflates
      // mutated bytes. Await drain on backpressure too — a GB file must not pile
      // copies into zlib's internal queue faster than deflate can consume them.
      if (!deflator.write(Buffer.from(slice))) {
        await once(deflator, "drain");
      }
    }
    deflator.end();
    // "end", not "finish": finish only means the writable side drained — a Transform
    // can still emit "data" after it. Raced against "error" so a zlib failure can
    // never hang the pack on a once(end) that never fires.
    const streamError = await Promise.race([
      once(deflator, "end").then(() => null as Error | null),
      once(deflator, "error").then((args: unknown[]) => args[0] as Error),
    ]);
    if (streamError) throw streamError;
    if (sink.error()) throw sink.error();

    // Check the u32 budget BEFORE writing the descriptor — writeUInt32LE would throw
    // a bare RangeError on a >4GiB file instead of the intended message.
    const crc32 = (crc ^ 0xffffffff) >>> 0;
    const display = nameBytes.toString("utf8");
    if (size > MAX_U32 || compressedSize > MAX_U32) {
      throw new Error(`File too large for zip (no Zip64): ${display}`);
    }

    // Data descriptor: optional sig + crc + compressed size + uncompressed size.
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc32, 4);
    descriptor.writeUInt32LE(compressedSize, 8);
    descriptor.writeUInt32LE(size, 12);
    sink.write(descriptor);
    if (sink.error()) throw sink.error();

    return { nameBytes, dosTime, dosDate, crc: crc32, compressedSize, size, offset: 0, flags };
  } finally {
    closeSync(fd);
  }
}

interface StagedPack {
  id: string;
  file: string;
  name: string;
  canonicalDir: string;
  // Bytes flushed to the staged file so far — grows while the pack runs.
  bytesWritten: number;
  // Final size once `done`; null while packing.
  size: number | null;
  done: boolean;
  error: string | null;
  timer: NodeJS.Timeout;
}

const staged = new Map<string, StagedPack>();

// Long-poll budget per chunk call — comfortably under the plugin RPC timeout so a call
// always answers before the invoker gives up.
const POLL_WAIT_MS = 5000;
// Once the final byte is served the archive only needs to survive a lost-response retry,
// not the full staging TTL.
const POST_DONE_TTL_MS = 30 * 1000;

function dropPack(id: string): void {
  const pack = staged.get(id);
  if (!pack) return;
  clearTimeout(pack.timer);
  staged.delete(id);
  try {
    rmSync(pack.file, { force: true });
  } catch {
    // Temp cleanup races are harmless — the OS reaps tmpdir eventually.
  }
}

// Writes one zip into pack.file, publishing progress through pack.bytesWritten. Runs
// in the background — a folder can take minutes to deflate, far past any RPC timeout —
// and lands its outcome on pack.size / pack.done / pack.error for readers to pick up.
async function runPack(pack: StagedPack, dir: string, roots: string[]): Promise<void> {
  // 0o600: staged archives live in a world-writable tmpdir — a default-umask file is
  // readable by every local user, leaking the packed folder's contents cross-uid.
  const fd = openSync(pack.file, "w", 0o600);
  let offset = 0;
  let sinkError: Error | null = null;
  const central: CentralEntry[] = [];
  try {
    const sink: ArchiveSink = {
      write(bytes) {
        if (sinkError) return;
        try {
          writeSync(fd, bytes);
          offset += bytes.length;
          pack.bytesWritten = offset;
        } catch (error) {
          sinkError = error instanceof Error ? error : new Error(String(error));
        }
      },
      error: () => sinkError,
    };
    for (const file of await walkFiles(dir)) {
      if (central.length >= MAX_ENTRIES) {
        throw new Error(`Too many files for zip (max ${MAX_ENTRIES}): ${dir}`);
      }
      const localOffset = offset;
      let entry: CentralEntry;
      try {
        entry = await packOne(sink, file, roots);
      } catch (error) {
        // Archive-write failures are always fatal (disk full, fd errors). So is a
        // mid-stream failure — a partial entry is already committed to the archive.
        // But an open-stage failure (file vanished, unreadable, raced to non-regular
        // between walk and open) wrote zero bytes: skip the file like an unreadable
        // subdir instead of failing the whole folder download.
        if (sinkError !== null) throw sinkError;
        if (offset !== localOffset) throw error;
        continue;
      }
      entry.offset = localOffset;
      central.push(entry);
    }
    if (sinkError !== null) throw sinkError;
    const centralOffset = offset;
    for (const entry of central) {
      const record = Buffer.alloc(46);
      record.writeUInt32LE(0x02014b50, 0);
      record.writeUInt16LE(20, 4); // version made by
      record.writeUInt16LE(20, 6); // version needed
      record.writeUInt16LE(entry.flags, 8); // data-descriptor (+ UTF-8 when the name is valid)
      record.writeUInt16LE(8, 10); // deflate
      record.writeUInt16LE(entry.dosTime, 12);
      record.writeUInt16LE(entry.dosDate, 14);
      record.writeUInt32LE(entry.crc, 16);
      record.writeUInt32LE(entry.compressedSize, 20);
      record.writeUInt32LE(entry.size, 24);
      record.writeUInt16LE(entry.nameBytes.length, 28);
      record.writeUInt32LE(entry.offset, 42);
      sink.write(record);
      sink.write(entry.nameBytes);
    }
    if (sinkError !== null) throw sinkError;
    const centralSize = offset - centralOffset;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(central.length, 8);
    eocd.writeUInt16LE(central.length, 10);
    eocd.writeUInt32LE(centralSize, 12);
    eocd.writeUInt32LE(centralOffset, 16);
    sink.write(eocd);
    if (sinkError !== null) throw sinkError;
    if (offset > MAX_U32) throw new Error("Archive too large for zip (no Zip64)");
    pack.size = offset;
    pack.done = true;
  } catch (error) {
    latchError(pack, error);
  } finally {
    closeSync(fd);
  }
}

// Latches an error onto the pack and shrinks its TTL: a failed pack still holds a
// MAX_STAGED slot — without a short expiry, 8 failed downloads wedge every new folder
// download for the full staging TTL. 30s is ample for an actively-polling client to
// read the latched error, and a dead one frees its slot quickly.
function latchError(pack: StagedPack, error: unknown): void {
  pack.error = error instanceof Error ? error.message : String(error);
  clearTimeout(pack.timer);
  pack.timer = setTimeout(() => dropPack(pack.id), POST_DONE_TTL_MS);
  pack.timer.unref();
}

// Resolves the dir (containment-verified), registers a staged pack, kicks runPack in
// the background, and returns the handle so the first RPC answers immediately.
function startPack(dir: string, roots: string[]): StagedPack {
  if (staged.size >= MAX_STAGED) {
    throw new Error("Too many folder downloads in progress — wait for one to finish");
  }
  const id = randomBytes(16).toString("hex");
  const leaf = dir.split("/").filter((segment) => segment.length > 0).pop() ?? "download";
  const pack: StagedPack = {
    id,
    file: path.join(os.tmpdir(), `filedrop-pack-${id}.zip`),
    name: `${leaf}.zip`,
    canonicalDir: dir,
    bytesWritten: 0,
    size: null,
    done: false,
    error: null,
    timer: null as unknown as NodeJS.Timeout,
  };
  pack.timer = setTimeout(() => dropPack(id), PACK_TTL_MS);
  pack.timer.unref();
  staged.set(id, pack);
  runPack(pack, dir, roots).catch((error) => {
    // runPack already latches errors via its own catch; this covers a throw above
    // it (e.g. the staging openSync before the try block).
    latchError(pack, error);
  });
  return pack;
}

export async function downloadDirChunk(input: RpcInput<typeof downloadDirRpc>) {
  const maxBytes = Math.min(input.maxBytes ?? MAX_CHUNK_BYTES, MAX_CHUNK_BYTES);
  let pack: StagedPack;

  if (input.packId !== undefined) {
    const found = staged.get(input.packId);
    if (!found) {
      throw new Error("Pack expired or unknown — start the folder download again");
    }
    pack = found;
  } else {
    // resolveTargetDir's browse half: lexical gate, canonical re-verify, inside roots.
    const dir = resolveTargetDir(input.path, { create: false });
    // A file path passes the same gates — reject it here instead of packing an empty
    // archive and reporting a successful folder download.
    let dirStat;
    try {
      dirStat = statSync(dir);
    } catch {
      throw new Error(`Directory does not exist: ${dir}`);
    }
    if (!dirStat.isDirectory()) {
      throw new Error(`Not a directory: ${dir}`);
    }
    pack = startPack(dir, allowedRoots());
  }

  // Long-poll while the reader is caught up and the writer is still running, so a slow
  // pack doesn't bounce empty responses at the client.
  const deadline = Date.now() + POLL_WAIT_MS;
  while (
    pack.error === null &&
    !pack.done &&
    pack.bytesWritten <= input.offset &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (pack.error !== null) {
    const message = pack.error;
    // Reading the error retires the pack: the slot frees immediately instead of
    // waiting out the errored-pack TTL, and a client that lost this response gets
    // "pack expired" on retry — which is accurate, the pack is gone.
    dropPack(pack.id);
    throw new Error(message);
  }

  const available = Math.max(0, pack.bytesWritten - input.offset);
  const want = Math.min(maxBytes, available);
  let dataBase64 = "";
  let bytesRead = 0;
  if (want > 0) {
    const buf = Buffer.alloc(want);
    const fd = openSync(pack.file, constants.O_RDONLY);
    try {
      bytesRead = readSync(fd, buf, 0, want, input.offset);
    } finally {
      closeSync(fd);
    }
    dataBase64 = buf.subarray(0, bytesRead).toString("base64");
  }
  const done = pack.done && pack.size !== null && input.offset + bytesRead >= pack.size;
  if (done) {
    // Final byte served — shrink the TTL to a short retry grace instead of letting a
    // completed archive occupy tmpdir (and a MAX_STAGED slot) for the full window.
    clearTimeout(pack.timer);
    pack.timer = setTimeout(() => dropPack(pack.id), POST_DONE_TTL_MS);
    pack.timer.unref();
  }
  return {
    path: pack.canonicalDir,
    name: pack.name,
    size: pack.size,
    dataBase64,
    bytesRead,
    done,
    packId: pack.id,
  };
}
