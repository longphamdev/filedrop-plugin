import { mkdirSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

// Configured roots expanded and lexically resolved, without realpath — a root spelled
// through a symlink keeps a distinct lexical identity, and the lexical gate below must
// accept paths spelled either way.
function configuredRoots(): string[] {
  const raw = process.env.FILEDROP_ALLOWED_ROOTS;
  const roots =
    raw && raw.trim().length > 0
      ? raw.split(path.delimiter).filter((entry) => entry.trim().length > 0)
      : [os.homedir()];
  return roots.map((root) => path.resolve(expandHome(root.trim())));
}

// Writes are confined to these roots. Override with FILEDROP_ALLOWED_ROOTS (path-delimited).
// Default: the daemon user's home directory.
export function allowedRoots(): string[] {
  const resolved: string[] = [];
  for (const root of configuredRoots()) {
    try {
      resolved.push(realpathSync(root));
    } catch {
      // Skip roots that cannot be resolved.
    }
  }
  return resolved;
}

export function isInside(child: string, root: string): boolean {
  const relative = path.relative(root, child);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function outsideRootsError(roots: string[]): Error {
  return new Error(
    `Target directory is outside the allowed roots: ${roots.join(", ")}. ` +
      `Set FILEDROP_ALLOWED_ROOTS on the daemon to widen the scope.`,
  );
}

// Resolves a user-supplied directory to a canonical path inside an allowed root.
// `create` performs the documented `mkdir -p` for upload targets; browsing never creates.
export function resolveTargetDir(input: string, options: { create: boolean }): string {
  const expanded = expandHome(input.trim());
  if (expanded.includes("\0")) throw new Error("Invalid path");
  if (!path.isAbsolute(expanded)) {
    throw new Error("Target directory must be an absolute path (or start with ~/)");
  }
  const roots = allowedRoots();
  if (roots.length === 0) {
    throw new Error("No writable roots are configured on this host");
  }
  // Lexical containment gate BEFORE mkdirSync: an absolute path escaping every root is
  // rejected without creating anything on disk.
  const lexical = path.resolve(expanded);
  const inside =
    roots.some((root) => isInside(lexical, root)) ||
    configuredRoots().some((root) => isInside(lexical, root));
  if (!inside) throw outsideRootsError(roots);

  if (options.create) mkdirSync(lexical, { recursive: true });

  // Canonical re-verify after any creation: a symlinked component can resolve outside the
  // root that passed the lexical gate. Residual: with `create`, mkdirSync may already have
  // made directories through a mid-path symlink before this check rejects the target.
  let resolved: string;
  try {
    resolved = realpathSync(lexical);
  } catch {
    const error = new Error(`Directory does not exist: ${lexical}`) as NodeJS.ErrnoException;
    error.code = "ENOENT";
    throw error;
  }
  if (!roots.some((root) => isInside(resolved, root))) {
    throw outsideRootsError(roots);
  }
  return resolved;
}

// A dropped name is either a bare filename or a '/'-separated relative path (folder drops).
// POSIX semantics: only '/' separates segments — a backslash is a legal filename character,
// so "a\b.txt" stays one segment. '..' anywhere is rejected outright so traversal can never
// resolve. A Windows-style "..\x" is a single legal POSIX filename, not traversal.
export function sanitizeRelativePath(name: string): string {
  const segments: string[] = [];
  for (const segment of name.split(/\/+/)) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") throw new Error("Filename must not contain '..'");
    if (segment.includes("\0")) throw new Error("Filename contains an invalid character");
    if (segment.length > 255) throw new Error("Filename segment is too long");
    segments.push(segment);
  }
  if (segments.length === 0) throw new Error("Filename is empty");
  if (segments.length > 20) throw new Error("Filename path is too deep");
  return path.join(...segments);
}
