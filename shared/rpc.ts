import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// RPC names allow lowercase letters, digits, dots, hyphens, underscores only.

// Marker embedded in the upload error message when the destination already exists, so the
// client can match it and drive its overwrite-confirm flow.
export const FILEDROP_EXISTS = "FILEDROP_EXISTS";

export const listDirsRpc = defineRpc({
  name: "filedrop.list-dirs",
  input: z.object({
    path: z.string().max(4096).optional(),
    // The target-directory picker lists directories only; the download browser sets this
    // to include regular files (dirs sort first, then files, both alphabetical).
    includeFiles: z.boolean().optional(),
  }),
  output: z.object({
    path: z.string(),
    parent: z.string().nullable(),
    entries: z.array(
      z.object({
        name: z.string(),
        path: z.string(),
        isDir: z.boolean(),
        // Present on regular files only.
        size: z.number().int().nonnegative().optional(),
      }),
    ),
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
// "<name>.filedrop-part-<token>" where token is the first 8 hex chars of uploadId so
// concurrent uploads of the same name don't interleave. When bytesWritten reaches
// totalSize the staging file is published onto the destination, so a failed upload never
// leaves a truncated file under the final name.
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
    // staging name and the whole id keys the daemon's staging-ownership registry, so it
    // must be present and unique per upload job.
    uploadId: z.string().min(1).max(64),
  }),
  output: z.object({
    path: z.string(),
    bytesWritten: z.number().int().nonnegative(),
  }),
});

// Downloads are the pull mirror of uploads: the client requests one chunk per call at an
// explicit offset and the daemon returns base64 plus the file's size so the client can
// loop until it has the whole file. `path` is verified inside the allowed roots exactly
// like browsed paths — reads can no more escape the roots than browsing can.
export const downloadChunkRpc = defineRpc({
  name: "filedrop.download",
  input: z.object({
    // Absolute path on the host (or ~/…), as returned by list-dirs browsing.
    path: z.string().min(1).max(4096),
    offset: z.number().int().nonnegative(),
    // Per-call read cap; the server clamps it to 8 MiB and the client pulls 256 KiB.
    maxBytes: z.number().int().positive().max(8 * 1024 * 1024).optional(),
    // "dev:ino" from the first chunk's response, echoed on later chunks — pins the
    // download to one inode so a same-size file swapped in mid-download is rejected
    // instead of silently mixing bytes.
    fileId: z.string().max(64).optional(),
  }),
  output: z.object({
    // The canonical path actually read — every symlink resolved, inside an allowed root.
    path: z.string(),
    size: z.number().int().nonnegative(),
    dataBase64: z.string(),
    bytesRead: z.number().int().nonnegative(),
    // "dev:ino" of the file actually opened, verified fresh on every call.
    fileId: z.string(),
  }),
});

// Folder download: the daemon walks a directory inside the allowed roots (regular files
// only — symlinks and special files are skipped, exactly the set `list-dirs` exposes)
// and packs it into a zip staged in os.tmpdir(). Packing is ASYNC — the first call
// (no packId) starts the pack in the background and returns a packId immediately;
// later calls echo it and pull whatever bytes have been written so far, long-polling
// a few seconds when the reader catches up with the writer. `done` marks the archive
// complete; `size` stays null until then.
export const downloadDirRpc = defineRpc({
  name: "filedrop.download-dir",
  input: z.object({
    // Absolute dir path on the host (or ~/…); only meaningful on the first call.
    path: z.string().min(1).max(4096),
    offset: z.number().int().nonnegative(),
    maxBytes: z.number().int().positive().max(8 * 1024 * 1024).optional(),
    // Staged-pack handle from the first response — pins subsequent chunks to that
    // archive; the staged file is deleted when its TTL expires.
    packId: z.string().max(64).optional(),
  }),
  output: z.object({
    // Canonical path of the directory that was packed.
    path: z.string(),
    // Suggested archive filename — "<dirname>.zip".
    name: z.string(),
    // Final archive size, null while the pack is still running.
    size: z.number().int().nonnegative().nullable(),
    dataBase64: z.string(),
    bytesRead: z.number().int().nonnegative(),
    // True when the pack has finished and every archive byte has been served — the
    // client may stop pulling.
    done: z.boolean(),
    packId: z.string(),
  }),
});
