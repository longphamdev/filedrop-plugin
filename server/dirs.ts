import { lstatSync, readdirSync } from "node:fs";
import path from "node:path";
import type { RpcInput } from "@getpaseo/plugin";
import type { listDirsRpc } from "../shared/rpc";
import { allowedRoots, isInside, resolveTargetDir } from "./paths";

const MAX_ENTRIES = 500;

export function listDirs(input: RpcInput<typeof listDirsRpc>) {
  // No trim: browsed paths must round-trip exactly — whitespace-named dirs are legal on
  // POSIX, and the panel already trims its typed input before sending.
  const resolved = resolveTargetDir(input.path || "~", { create: false });
  const includeFiles = input.includeFiles === true;
  const all = readdirSync(resolved, { withFileTypes: true })
    .filter(
      (entry) =>
        !entry.name.startsWith(".") && (entry.isDirectory() || (includeFiles && entry.isFile())),
    )
    .map((entry) => {
      const entryPath = path.join(resolved, entry.name);
      let size: number | undefined;
      if (entry.isFile()) {
        try {
          // The Dirent said "file", but the entry may have been swapped since readdir —
          // only report a size when the fresh lstat still sees a regular file, so a
          // symlink or fifo that raced in never lends its own stat to a file row.
          const fresh = lstatSync(entryPath);
          if (fresh.isFile()) size = fresh.size;
        } catch {
          // A file that vanishes mid-listing reports no size rather than failing the list.
        }
      }
      return { name: entry.name, path: entryPath, isDir: entry.isDirectory(), size };
    })
    // Directories first (they navigate), then files; alphabetical within each group.
    .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));

  const parentPath = path.dirname(resolved);
  const roots = allowedRoots();
  const parent =
    parentPath !== resolved && roots.some((root) => isInside(parentPath, root))
      ? parentPath
      : null;

  const entries = all.slice(0, MAX_ENTRIES);
  return { path: resolved, parent, entries, truncated: all.length > MAX_ENTRIES, total: all.length };
}
