import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { uploadChunkRpc } from "../shared/rpc";
import type { DroppedBlob, DroppedFile } from "./web";

// 256 KiB raw → ~341 KiB base64 per RPC: comfortably under any WebSocket frame cap on the
// direct connection and the remote relay path.
export const CHUNK_BYTES = 256 * 1024;

type ChunkInput = RpcInput<typeof uploadChunkRpc>;
type ChunkOutput = RpcOutput<typeof uploadChunkRpc>;

export interface UploadFileOptions {
  targetDir: string;
  file: DroppedFile;
  // One id per job so the server can correlate chunks of a single upload.
  uploadId: string;
  // Sent on every chunk; without it the server rejects an existing target with FILEDROP_EXISTS.
  overwrite?: boolean;
  send: (input: ChunkInput) => Promise<ChunkOutput>;
  // Reads one already-sliced blob to base64. Injected because the web implementation uses
  // FileReader (client/web.ts); tests pass a synchronous reader.
  readChunk: (blob: DroppedBlob) => Promise<string>;
  onSent?: (bytes: number) => void;
}

// Streams one file in chunks. Reads are lazy — Blob.slice hands back a reference and only the
// current 256 KiB slice is materialized, so multi-GB files never enter memory whole. Each RPC
// is awaited before the next slice is read, which is the socket backpressure (one frame in
// flight) and keeps chunk order for the server's offset checks.
export async function uploadFileChunks(options: UploadFileOptions): Promise<string> {
  const { targetDir, file, uploadId, overwrite, send, readChunk, onSent } = options;
  let offset = 0;
  let path = "";

  if (file.size === 0) {
    // One call so the daemon still creates the empty file.
    const result = await send({
      targetDir,
      filename: file.relativePath,
      dataBase64: "",
      offset: 0,
      totalSize: file.size,
      overwrite,
      uploadId,
    });
    path = result.path;
    onSent?.(0);
    return path;
  }

  while (offset < file.size) {
    const blob = file.slice(offset, Math.min(offset + CHUNK_BYTES, file.size));
    const dataBase64 = await readChunk(blob);
    const result = await send({
      targetDir,
      filename: file.relativePath,
      dataBase64,
      offset,
      totalSize: file.size,
      overwrite,
      uploadId,
    });
    if (result.bytesWritten <= offset) throw new Error("Upload stalled");
    offset = result.bytesWritten;
    path = result.path;
    onSent?.(Math.min(offset, file.size));
  }
  return path;
}
