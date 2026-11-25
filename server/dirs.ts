import { readdirSync } from "node:fs";
import path from "node:path";
import type { RpcInput } from "@getpaseo/plugin";
import type { listDirsRpc } from "../shared/rpc";
import { allowedRoots, isInside, resolveTargetDir } from "./paths";

const MAX_ENTRIES = 500;

export function listDirs(input: RpcInput<typeof listDirsRpc>) {
  const resolved = resolveTargetDir(input.path?.trim() || "~", { create: false });
  const all = readdirSync(resolved, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => ({ name: entry.name, path: path.join(resolved, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const parentPath = path.dirname(resolved);
  const roots = allowedRoots();
  const parent =
    parentPath !== resolved && roots.some((root) => isInside(parentPath, root))
      ? parentPath
      : null;

  const entries = all.slice(0, MAX_ENTRIES);
  return { path: resolved, parent, entries, truncated: all.length > MAX_ENTRIES, total: all.length };
}
