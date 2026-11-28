import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { downloadDirRpc } from "../shared/rpc";
import { CHUNK_BYTES } from "./upload-file";

type ReadInput = RpcInput<typeof downloadDirRpc>;
type ReadOutput = RpcOutput<typeof downloadDirRpc>;

export interface DownloadedPack {
  // "<dirname>.zip" as suggested by the server.
  name: string;
  size: number;
  parts: Uint8Array[];
}

export interface DownloadDirOptions {
  // Absolute (or ~/) dir path on the host; the daemon canonicalizes and confines it.
  path: string;
  send: (input: ReadInput) => Promise<ReadOutput>;
  onReceived?: (bytes: number) => void;
}

// Empty responses while the pack is still running — the server long-polls a few seconds
// per call, so this bound is generous without risking an infinite loop on a wedged pack.
const MAX_EMPTY_POLLS = 120;

function base64ToBytes(data: string): Uint8Array {
  const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const lookup = new Int16Array(128).fill(-1);
  for (let index = 0; index < B64_CHARS.length; index += 1) {
    lookup[B64_CHARS.charCodeAt(index)] = index;
  }
  const end = data.endsWith("==") ? data.length - 2 : data.endsWith("=") ? data.length - 1 : data.length;
  const bytes = new Uint8Array(Math.floor((end * 3) / 4));
  let out = 0;
  for (let index = 0; index < end; index += 4) {
    const a = lookup[data.charCodeAt(index)];
    const b = lookup[data.charCodeAt(index + 1)];
    const c = index + 2 < end ? lookup[data.charCodeAt(index + 2)] : -1;
    const d = index + 3 < end ? lookup[data.charCodeAt(index + 3)] : -1;
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

// Pulls a staged zip in CHUNK_BYTES pieces — the same loop as downloadFileChunks but
// pinned by packId (the daemon's staging handle) instead of path+inode. The first call
// only STARTS the async pack; `size` stays null until the archive is complete and
// `done` marks the final chunk served.
export async function downloadDirChunks(options: DownloadDirOptions): Promise<DownloadedPack> {
  const { path: dirPath, send, onReceived } = options;
  const parts: Uint8Array[] = [];
  let offset = 0;
  let size = -1;
  let name = "download.zip";
  let packId: string | undefined;
  let emptyPolls = 0;

  for (;;) {
    const result = await send({
      path: dirPath,
      offset,
      maxBytes: CHUNK_BYTES,
      ...(packId !== undefined ? { packId } : {}),
    });
    packId = result.packId;
    name = result.name;
    if (result.size !== null) {
      size = result.size;
    }
    if (result.bytesRead > 0) {
      emptyPolls = 0;
      const part = base64ToBytes(result.dataBase64);
      if (part.length !== result.bytesRead) {
        throw new Error("Download corrupt: chunk payload length does not match bytesRead");
      }
      parts.push(part);
      offset += part.length;
      onReceived?.(offset);
    } else if (!result.done) {
      emptyPolls += 1;
      if (emptyPolls > MAX_EMPTY_POLLS) {
        throw new Error("Folder pack stalled — no archive bytes for too long");
      }
    }
    if (result.done) {
      if (size < 0) {
        // done with size known — the null-size window closes before done is set.
        size = offset;
      }
      break;
    }
  }

  return { name, size: size < 0 ? offset : size, parts };
}
