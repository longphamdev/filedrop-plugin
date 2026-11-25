import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import type { RpcInput } from "@getpaseo/plugin";
import type { existsRpc } from "../shared/rpc";
import { isInside, resolveTargetDir, sanitizeRelativePath } from "./paths";

const ABSENT = { exists: false, isDir: false } as const;

// Pre-upload probe for the client's overwrite confirm. A missing target dir or path is
// "absent", not an error; forbidden paths (outside roots, '..', traversal) still throw —
// reporting them as absent would mislead the client into an upload that then fails.
export function pathExists(input: RpcInput<typeof existsRpc>) {
  let directory: string;
  try {
    directory = resolveTargetDir(input.targetDir, { create: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...ABSENT };
    throw error;
  }

  const relative = sanitizeRelativePath(input.relativePath);
  const filePath = path.join(directory, relative);
  if (!isInside(filePath, directory)) {
    throw new Error("Resolved path escapes the target directory");
  }

  // A mid-path symlinked component could resolve outside the target; canonical-verify the
  // parent before answering. Missing parent means the leaf can't exist either.
  try {
    const realParent = realpathSync(path.dirname(filePath));
    if (!isInside(realParent, directory)) {
      throw new Error("Resolved path escapes the target directory");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...ABSENT };
    throw error;
  }

  // lstat so a dangling symlink still counts as occupied — the client must not treat the
  // name as free (upload itself refuses to write through symlinks).
  try {
    return { exists: true, isDir: lstatSync(filePath).isDirectory() };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...ABSENT };
    throw error;
  }
}
