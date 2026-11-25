import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  linkSync,
  lstatSync,
  openSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import path from "node:path";
import type { RpcInput } from "@getpaseo/plugin";
import { FILEDROP_EXISTS, type uploadChunkRpc } from "../shared/rpc";
import { ensureDirWithin, isInside, resolveTargetDir, sanitizeRelativePath } from "./paths";

const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
// Chunks are staged under "<name>.filedrop-part-<token8>" next to the destination and
// published onto the final name only once totalSize bytes have landed, so an
// interrupted upload never leaves a truncated file at the destination.
const PART_SUFFIX = ".filedrop-part";
// O_NOFOLLOW makes the opens below fail on a staging path swapped to a symlink between
// lstat and open (ELOOP), closing the leaf-component TOCTOU window.
const NOFOLLOW = constants.O_NOFOLLOW || 0;
// Fresh staging is created EXCLUSIVELY ("wx"): a pre-existing file at the staging path
// errors on EEXIST — it is never truncated. Resuming opens r+ after ownership checks.
const OPEN_EXCLUSIVE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW;
const OPEN_APPEND = constants.O_RDWR | NOFOLLOW;

// Ownership registry: a staging file may be appended to only while this process
// remembers creating it for the calling upload. Filename and byte count are not proof —
// the entry also pins the file's device+inode (recorded via fstat at the exclusive
// create), so a foreign file swapped in at the same path is rejected by identity, not
// just by name. Entries drop at the final rename; abandoned uploads keep theirs so the
// same uploadId can still resume, and the map is capped so abandonment cannot grow it
// without bound. After a daemon restart the registry is empty, so orphaned
// .filedrop-part files cannot resume — a new upload arrives with a new uploadId,
// stages under a new token-suffixed name, and starts fresh via O_EXCL.
const STAGING_REGISTRY_LIMIT = 1024;
interface StagingEntry {
  stagingPath: string;
  totalSize: number;
  dev: number;
  ino: number;
}
const stagingRegistry = new Map<string, StagingEntry>();

function lstatOrNull(filePath: string): Stats | null {
  try {
    return lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

// uploadId supplies the per-upload staging token (its first 8 hex chars) so two writers
// uploading the same name concurrently stage under different names.
function stagingPath(filePath: string, uploadId: string): string {
  const token = uploadId.replace(/-/g, "").slice(0, 8).toLowerCase();
  if (!/^[0-9a-f]{8}$/.test(token)) {
    throw new Error("uploadId must contain at least 8 hexadecimal characters");
  }
  return `${filePath}${PART_SUFFIX}-${token}`;
}

export function uploadChunk(input: RpcInput<typeof uploadChunkRpc>) {
  const { targetDir, filename, dataBase64, offset, totalSize, overwrite, uploadId } = input;
  if (!uploadId) throw new Error("uploadId is required");
  if (dataBase64.length % 4 !== 0 || !BASE64_RE.test(dataBase64)) {
    throw new Error("Invalid base64 payload");
  }
  const data = Buffer.from(dataBase64, "base64");
  if (data.length > MAX_CHUNK_BYTES) throw new Error("Chunk exceeds the 8 MiB limit");
  if (offset + data.length > totalSize) {
    throw new Error("Chunk extends past the declared totalSize");
  }
  if (data.length === 0 && totalSize !== 0) {
    throw new Error("Empty chunk for a non-empty upload");
  }

  const directory = resolveTargetDir(targetDir, { create: true });
  const relative = sanitizeRelativePath(filename);
  const filePath = path.join(directory, relative);
  if (!isInside(filePath, directory)) {
    throw new Error("Resolved path escapes the target directory");
  }
  const parentDir = path.dirname(filePath);
  // Create parents component-by-component under the canonical target: a symlink in a
  // dropped folder tree is rejected before any mkdir can follow it out of the root.
  ensureDirWithin(directory, parentDir);

  // lstat (not stat): a symlinked destination must never be written through or renamed
  // over silently. Residual TOCTOU: the leaf could be swapped between this check and the
  // staging rename — O_NOFOLLOW guards the opens; a swap before renameSync would rename
  // onto the replaced name, which is still confined to the verified parent directory.
  const stat = lstatOrNull(filePath);
  if (stat?.isSymbolicLink()) {
    throw new Error(`Destination is a symbolic link: ${filePath}`);
  }
  if (stat?.isDirectory()) {
    throw new Error(`Destination is a directory: ${filePath}`);
  }
  if (stat) {
    // Existing destination (overwrite path): canonical-verify it as well.
    const realFile = realpathSync(filePath);
    if (!isInside(realFile, directory)) {
      throw new Error("Resolved path escapes the target directory");
    }
  }
  if (offset === 0 && stat && !overwrite) {
    throw new Error(`${FILEDROP_EXISTS}: ${filename} already exists at ${filePath}`);
  }

  const part = stagingPath(filePath, uploadId);
  const partStat = lstatOrNull(part);
  if (partStat && !partStat.isFile()) {
    throw new Error(`Staging path is not a regular file: ${part}`);
  }

  // Resuming requires the registry to prove this process created the staging file for
  // this upload: same uploadId, same staging path, same declared totalSize, and the
  // device+inode pinned at creation matching the file on disk. A foreign file — even
  // one that matches name and size — fails on identity and is never modified,
  // truncated, or renamed. An entry for a different staging path means the uploadId is
  // already claimed by another upload.
  const entry = stagingRegistry.get(uploadId);
  const owned =
    partStat !== null &&
    entry !== undefined &&
    entry.stagingPath === part &&
    entry.totalSize === totalSize &&
    partStat.dev === entry.dev &&
    partStat.ino === entry.ino
      ? entry
      : null;
  if (partStat !== null && owned === null) {
    throw new Error(`Staging file is not owned by this upload: ${part}`);
  }
  if (partStat === null) {
    if (offset !== 0) {
      throw new Error(`No staged upload for offset ${offset}: ${part}`);
    }
    if (entry !== undefined && entry.stagingPath !== part) {
      throw new Error(`uploadId already owns a different staging file: ${entry.stagingPath}`);
    }
  }

  const fd = openSync(part, owned !== null ? OPEN_APPEND : OPEN_EXCLUSIVE);
  try {
    // fstat is authoritative: the staging path could be swapped between lstat and open,
    // but the fd pins the inode, so these checks act on exactly the file written below.
    const opened = fstatSync(fd);
    if (owned !== null) {
      if (opened.dev !== owned.dev || opened.ino !== owned.ino) {
        throw new Error(`Staging file is not owned by this upload: ${part}`);
      }
      if (offset === 0) {
        // Owned restart (e.g. a confirmed-overwrite retry): truncate on the pinned
        // fd — no unlink, so this path can never remove a foreign file.
        ftruncateSync(fd, 0);
      } else if (opened.size !== offset) {
        throw new Error(`Unexpected chunk offset ${offset}; staged file changed size`);
      }
    }
    writeSync(fd, data, 0, data.length, offset);
    if (owned === null) {
      if (stagingRegistry.size >= STAGING_REGISTRY_LIMIT) {
        stagingRegistry.delete(stagingRegistry.keys().next().value!);
      }
      stagingRegistry.set(uploadId, {
        stagingPath: part,
        totalSize,
        dev: opened.dev,
        ino: opened.ino,
      });
    }
  } finally {
    closeSync(fd);
  }

  const bytesWritten = offset + data.length;
  if (bytesWritten === totalSize) {
    // Final chunk: recheck the destination before publishing — it may have appeared
    // mid-upload, and without overwrite we must not clobber it.
    const final = lstatOrNull(filePath);
    if (final?.isSymbolicLink()) {
      throw new Error(`Destination is a symbolic link: ${filePath}`);
    }
    if (final && !overwrite) {
      throw new Error(`${FILEDROP_EXISTS}: ${filename} already exists at ${filePath}`);
    }
    // Publish only the file this process created: the staging path could have been
    // swapped since the last write. Residual: Node has no renameat on an fd, so the
    // check-to-publish window cannot be closed entirely; it stays confined to the
    // already-verified parent directory.
    const staged = lstatSync(part);
    const registered = stagingRegistry.get(uploadId);
    if (
      registered === undefined ||
      staged.dev !== registered.dev ||
      staged.ino !== registered.ino
    ) {
      throw new Error(`Staging file is not owned by this upload: ${part}`);
    }
    if (overwrite) {
      renameSync(part, filePath);
    } else {
      // link() fails EEXIST if a destination appeared between the lstat above and
      // here — atomic no-replace publication, no silent clobber.
      try {
        linkSync(part, filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error(`${FILEDROP_EXISTS}: ${filename} already exists at ${filePath}`);
        }
        throw error;
      }
      unlinkSync(part);
    }
    stagingRegistry.delete(uploadId);
  }
  return { path: filePath, bytesWritten };
}
