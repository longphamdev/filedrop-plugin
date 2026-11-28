import type { PluginServerContext } from "@getpaseo/plugin/server";
import { listDirs } from "./server/dirs";
import { downloadChunk } from "./server/download";
import { pathExists } from "./server/exists";
import { downloadDirChunk } from "./server/pack";
import { uploadChunk } from "./server/upload";
import {
  downloadChunkRpc,
  downloadDirRpc,
  existsRpc,
  listDirsRpc,
  uploadChunkRpc,
} from "./shared/rpc";

export default function contribute(server: PluginServerContext) {
  server.handle(listDirsRpc, listDirs);
  server.handle(existsRpc, pathExists);
  server.handle(uploadChunkRpc, uploadChunk);
  server.handle(downloadChunkRpc, downloadChunk);
  server.handle(downloadDirRpc, downloadDirChunk);
  return () => {};
}
