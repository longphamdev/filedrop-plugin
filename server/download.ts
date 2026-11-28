import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import type { RpcInput } from "@getpaseo/plugin";
import type { downloadChunkRpc } from "../shared/rpc";
import { allowedRoots, isInside, resolveReadablePath } from "./paths";

const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
// O_NOFOLLOW rejects a leaf swapped to a symlink between realpath and open (ELOOP);
// O_NONBLOCK keeps a fifo or device that somehow slipped through from blocking the read —
// the fstat regular-file check below then rejects it. Both are no-ops on regular files.
const OPEN_READ = constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0);

export function downloadChunk(input: RpcInput<typeof downloadChunkRpc>) {
  const { offset } = input;
  const maxBytes = Math.min(input.maxBytes ?? MAX_CHUNK_BYTES, MAX_CHUNK_BYTES);
  // resolveReadablePath returns the canonical path — all symlinks resolved and contained
  // inside an allowed root — so opening it (rather than the caller's spelling) also keeps
  // the read pinned to the verified path.
  const filePath = resolveReadablePath(input.path);
  const roots = allowedRoots();

  const fd = openSync(filePath, OPEN_READ);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error(`Not a regular file: ${filePath}`);
    }
    // fd-identity check: a mid-path component swapped to a symlink between resolve and
    // open could have walked this open outside the roots (O_NOFOLLOW only covers the
    // leaf). Re-resolve the canonical name NOW: if it escaped containment or no longer
    // names the inode on this fd, the open raced a swap — reject. Once the fd is pinned
    // to this verified inode, later path swaps cannot move it.
    let reResolved: string;
    try {
      reResolved = realpathSync(filePath);
    } catch {
      throw new Error(`File changed while opening: ${filePath}`);
    }
    if (!roots.some((root) => isInside(reResolved, root))) {
      throw new Error(`Resolved path escapes the allowed roots: ${filePath}`);
    }
    const reStat = lstatSync(reResolved);
    if (reStat.dev !== stat.dev || reStat.ino !== stat.ino) {
      throw new Error(`File changed while opening: ${filePath}`);
    }
    // Cross-chunk pinning: when the client echoes the first chunk's fileId, the file
    // opened now must be the same inode — a same-size replacement is a different file.
    const fileId = `${stat.dev}:${stat.ino}`;
    if (input.fileId !== undefined && input.fileId !== fileId) {
      throw new Error(`File changed since the download started: ${filePath}`);
    }
    if (offset > stat.size) {
      throw new Error(`Offset ${offset} is past the end of ${filePath} (${stat.size} bytes)`);
    }
    const length = Math.min(maxBytes, stat.size - offset);
    const buffer = Buffer.allocUnsafe(length);
    // Positional read: a file being rewritten mid-download can return fewer bytes than
    // asked for; the client advances by bytesRead and stalls out if that hits 0 early.
    const bytesRead = length === 0 ? 0 : readSync(fd, buffer, 0, length, offset);
    return {
      path: filePath,
      size: stat.size,
      dataBase64: buffer.subarray(0, bytesRead).toString("base64"),
      bytesRead,
      fileId,
    };
  } finally {
    closeSync(fd);
  }
}
