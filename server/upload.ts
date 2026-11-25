import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  writeSync,
  type Stats,
} from "node:fs";
import path from "node:path";
import type { RpcInput } from "@getpaseo/plugin";
import { FILEDROP_EXISTS, type uploadChunkRpc } from "../shared/rpc";
import { isInside, resolveTargetDir, sanitizeRelativePath } from "./paths";

const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
// Chunks are staged under "<name>.filedrop-part[-<token8>]" next to the destination and
// renamed onto the final name only once totalSize bytes have landed, so an interrupted
// upload never leaves a truncated file at the destination.
const PART_SUFFIX = ".filedrop-part";
// O_NOFOLLOW makes the opens below fail on a staging path swapped to a symlink between
// lstat and open (ELOOP), closing the leaf-component TOCTOU window.
const NOFOLLOW = constants.O_NOFOLLOW || 0;
const OPEN_CREATE = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NOFOLLOW;
const OPEN_APPEND = constants.O_RDWR | NOFOLLOW;

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
function stagingPath(filePath: string, uploadId: string | undefined): string {
  if (uploadId === undefined) return `${filePath}${PART_SUFFIX}`;
  const token = uploadId.replace(/-/g, "").slice(0, 8).toLowerCase();
  if (!/^[0-9a-f]{8}$/.test(token)) {
    throw new Error("uploadId must contain at least 8 hexadecimal characters");
  }
  return `${filePath}${PART_SUFFIX}-${token}`;
}

export function uploadChunk(input: RpcInput<typeof uploadChunkRpc>) {
  const { targetDir, filename, dataBase64, offset, totalSize, overwrite, uploadId } = input;
  if (dataBase64.length % 4 !== 0 || !BASE64_RE.test(dataBase64)) {
    throw new Error("Invalid base64 payload");
  }
  const data = Buffer.from(dataBase64, "base64");
  if (data.length > MAX_CHUNK_BYTES) throw new Error("Chunk exceeds the 8 MiB limit");
  if (offset + data.length > totalSize) {
    throw new Error("Chunk extends past the declared totalSize");
  }

  const directory = resolveTargetDir(targetDir, { create: true });
  const relative = sanitizeRelativePath(filename);
  const filePath = path.join(directory, relative);
  if (!isInside(filePath, directory)) {
    throw new Error("Resolved path escapes the target directory");
  }
  const parentDir = path.dirname(filePath);
  mkdirSync(parentDir, { recursive: true });
  // Re-verify after mkdir: path components may have resolved through symlinks during
  // creation, so the canonical parent must still sit inside the resolved target dir.
  const realParent = realpathSync(parentDir);
  if (!isInside(realParent, directory)) {
    throw new Error("Resolved path escapes the target directory");
  }

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

  // offset 0 opens with "w" (truncate/create); later chunks require "r+" and must land
  // exactly at the current staging end — a gap or overlap means a stale or interleaved
  // upload, which we reject.
  const fd = openSync(part, offset === 0 ? OPEN_CREATE : OPEN_APPEND);
  try {
    if (offset > 0) {
      const size = fstatSync(fd).size;
      if (offset !== size) {
        throw new Error(`Unexpected chunk offset ${offset}; staged file is ${size} bytes`);
      }
    }
    writeSync(fd, data, 0, data.length, offset);
  } finally {
    closeSync(fd);
  }

  const bytesWritten = offset + data.length;
  if (bytesWritten === totalSize) {
    // Final chunk: recheck the destination before the atomic rename — it may have
    // appeared mid-upload, and without overwrite we must not clobber it.
    const final = lstatOrNull(filePath);
    if (final?.isSymbolicLink()) {
      throw new Error(`Destination is a symbolic link: ${filePath}`);
    }
    if (final && !overwrite) {
      throw new Error(`${FILEDROP_EXISTS}: ${filename} already exists at ${filePath}`);
    }
    renameSync(part, filePath);
  }
  return { path: filePath, bytesWritten };
}
