import type { PluginServerContext } from "@getpaseo/plugin/server";
import { listDirs } from "./server/dirs";
import { pathExists } from "./server/exists";
import { uploadChunk } from "./server/upload";
import { existsRpc, listDirsRpc, uploadChunkRpc } from "./shared/rpc";

export default function contribute(server: PluginServerContext) {
  server.handle(listDirsRpc, listDirs);
  server.handle(existsRpc, pathExists);
  server.handle(uploadChunkRpc, uploadChunk);
  return () => {};
}
