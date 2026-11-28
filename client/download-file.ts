import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { downloadChunkRpc } from "../shared/rpc";
import { CHUNK_BYTES } from "./upload-file";

type ReadInput = RpcInput<typeof downloadChunkRpc>;
type ReadOutput = RpcOutput<typeof downloadChunkRpc>;

export interface DownloadedFile {
  // Basename of the canonical path the daemon resolved — the browser save uses it.
  name: string;
  size: number;
  // Chunk bytes in order; the saver hands them straight to Blob() so the file is never
  // concatenated into one contiguous buffer before the browser takes over.
  parts: Uint8Array[];
}

export interface DownloadFileOptions {
  // Absolute (or ~/) path on the host; the daemon canonicalizes and confines it.
  path: string;
  send: (input: ReadInput) => Promise<ReadOutput>;
  onReceived?: (bytes: number) => void;
}

// Decodes base64 without DOM globals so the same code runs on native (no atob there).
const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_LOOKUP = new Int16Array(128).fill(-1);
for (let index = 0; index < B64_CHARS.length; index += 1) {
  B64_LOOKUP[B64_CHARS.charCodeAt(index)] = index;
}

function base64ToBytes(data: string): Uint8Array {
  const end = data.endsWith("==") ? data.length - 2 : data.endsWith("=") ? data.length - 1 : data.length;
  const bytes = new Uint8Array(Math.floor((end * 3) / 4));
  let out = 0;
  for (let index = 0; index < end; index += 4) {
    const a = B64_LOOKUP[data.charCodeAt(index)];
    const b = B64_LOOKUP[data.charCodeAt(index + 1)];
    const c = index + 2 < end ? B64_LOOKUP[data.charCodeAt(index + 2)] : -1;
    const d = index + 3 < end ? B64_LOOKUP[data.charCodeAt(index + 3)] : -1;
    bytes[out] = ((a << 2) | (b >> 4)) & 0xff;
    out += 1;
    if (c >= 0) {
      bytes[out] = (((b & 15) << 4) | (c >> 2)) & 0xff;
      out += 1;
      if (d >= 0) {
        bytes[out] = (((c & 3) << 6) | d) & 0xff;
        out += 1;
      }
    }
  }
  return bytes.subarray(0, out);
}

// Pulls one host file in CHUNK_BYTES pieces — the mirror of uploadFileChunks: one RPC in
// flight, sequential offsets. The first response's `size` pins the snapshot, so a file
// that grows mid-download yields a consistent prefix and a file that shrinks ends in a
// short/zero chunk, which trips the stall check below instead of looping forever.
export async function downloadFileChunks(options: DownloadFileOptions): Promise<DownloadedFile> {
  const { path: filePath, send, onReceived } = options;
  const parts: Uint8Array[] = [];
  let offset = 0;
  let size = -1;
  let canonical = filePath;
  let fileId: string | undefined;

  for (;;) {
    // After the first chunk the daemon has returned the canonical path and the file's
    // inode identity — re-request by those so a renamed spelling or a same-size swap is
    // caught server-side instead of silently mixing bytes from two files.
    const result = await send({
      path: canonical,
      offset,
      maxBytes: CHUNK_BYTES,
      ...(fileId !== undefined ? { fileId } : {}),
    });
    canonical = result.path;
    fileId = result.fileId;
    if (size < 0) size = result.size;
    if (result.bytesRead === 0) {
      if (offset >= size) break;
      throw new Error("Download stalled: the file changed size while reading");
    }
    const part = base64ToBytes(result.dataBase64);
    if (part.length !== result.bytesRead) {
      throw new Error("Download corrupt: chunk payload length does not match bytesRead");
    }
    // A file that grew mid-download yields chunks reaching past the pinned size — keep
    // only the snapshot prefix so the saved bytes always equal the reported size.
    const keep = Math.min(part.length, size - offset);
    parts.push(part.subarray(0, keep));
    offset += keep;
    onReceived?.(Math.min(offset, size));
    if (offset >= size) break;
  }

  const name = canonical.split("/").filter((segment) => segment.length > 0).pop() ?? "download";
  return { name, size, parts };
}
