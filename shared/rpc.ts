import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// RPC names allow lowercase letters, digits, dots, hyphens, underscores only.

// Marker embedded in the upload error message when the destination already exists, so the
// client can match it and drive its overwrite-confirm flow.
export const FILEDROP_EXISTS = "FILEDROP_EXISTS";

export const listDirsRpc = defineRpc({
  name: "filedrop.list-dirs",
  input: z.object({ path: z.string().max(4096).optional() }),
  output: z.object({
    path: z.string(),
    parent: z.string().nullable(),
    entries: z.array(z.object({ name: z.string(), path: z.string() })),
    // Listing caps at 500 entries; when truncated, `total` lets the client show "N more".
    truncated: z.boolean(),
    total: z.number().int().nonnegative(),
  }),
});

// Pre-upload probe: the client calls this before uploading to decide whether an overwrite
// confirm is needed. Never creates directories.
export const existsRpc = defineRpc({
  name: "filedrop.exists",
  input: z.object({
    targetDir: z.string().min(1).max(4096),
    // Bare filename or '/'-separated relative path, same rules as upload's `filename`.
    relativePath: z.string().min(1).max(4096),
  }),
  output: z.object({
    exists: z.boolean(),
    isDir: z.boolean(),
  }),
});

// Uploads are chunked (256 KiB client-side) into a staging file next to the destination:
// "<name>.filedrop-part", or "<name>.filedrop-part-<token>" where token is the first 8 hex
// chars of uploadId so concurrent uploads of the same name don't interleave. When
// bytesWritten reaches totalSize the staging file is renamed onto the destination, so a
// failed upload never leaves a truncated file under the final name.
export const uploadChunkRpc = defineRpc({
  name: "filedrop.upload",
  input: z.object({
    targetDir: z.string().min(1).max(4096),
    // Bare filename or '/'-separated relative path (folder drops carry webkitRelativePath).
    filename: z.string().min(1).max(4096),
    dataBase64: z.string().max(12 * 1024 * 1024),
    offset: z.number().int().nonnegative(),
    // Declared final size; the chunk completing it triggers the rename. Also a protocol
    // check: bytes past totalSize are rejected.
    totalSize: z.number().int().nonnegative(),
    // Required to start an upload onto an existing destination — offset 0 without it fails
    // with a FILEDROP_EXISTS error.
    overwrite: z.boolean().optional(),
    // Crypto-random per upload job (client sends a UUID); first 8 hex chars suffix the
    // staging name. Optional; without it the shared ".filedrop-part" name is used.
    uploadId: z.string().max(64).optional(),
  }),
  output: z.object({
    path: z.string(),
    bytesWritten: z.number().int().nonnegative(),
  }),
});
