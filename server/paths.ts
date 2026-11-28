import { lstatSync, mkdirSync, realpathSync, type Stats } from "node:fs";
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

// Creates `dir` (or verifies it exists) one component at a time below `anchor`, an
// already-canonical allowed root. Every existing component must be a real directory —
// never a symlink — and a missing component is created only after its parent chain is
// verified, so no mkdir can follow a symlink out of the root: an escape is rejected
// before anything outside the roots is created.
export function ensureDirWithin(anchor: string, dir: string): string {
  const relative = path.relative(anchor, dir);
  if (relative === "" || relative === ".") return anchor;
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Path escapes the allowed root");
  }
  let cursor = anchor;
  for (const segment of relative.split(path.sep)) {
    const next = path.join(cursor, segment);
    let stat: Stats | null = null;
    try {
      stat = lstatSync(next);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (stat === null) {
      try {
        mkdirSync(next);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      stat = lstatSync(next);
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`Path component is a symbolic link: ${next}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Path component is not a directory: ${next}`);
    }
    // Progressive canonical verify: a component swapped to a symlink between lstat
    // and this point resolves here, so deeper segments are never touched.
    const real = realpathSync(next);
    if (!isInside(real, anchor)) {
      throw new Error(`Path component resolves outside the allowed root: ${next}`);
    }
    cursor = real;
  }
  return cursor;
}

// Resolves a user-supplied directory to a canonical path inside an allowed root.
// `create` performs the documented `mkdir -p` for upload targets; browsing never creates.
export function resolveTargetDir(input: string, options: { create: boolean }): string {
  // No trim — same contract as resolveReadablePath: browsed/typed paths must round-trip
  // byte-exact, and a dir whose name ends in a space is otherwise unreachable. The
  // panel already trims typed input before sending.
  const expanded = expandHome(input);
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

  if (options.create) {
    // Anchor at the canonical allowed root that contains the target — either matched
    // directly or reached through a configured (possibly symlink-spelled) root — then
    // create component-by-component. A mid-path symlink is rejected before any mkdir
    // can follow it outside the root.
    let anchor: string;
    let rel: string;
    const canonical = roots.find((root) => isInside(lexical, root));
    if (canonical !== undefined) {
      anchor = canonical;
      rel = path.relative(canonical, lexical);
    } else {
      const spelled = configuredRoots().find((root) => isInside(lexical, root));
      if (spelled === undefined) throw outsideRootsError(roots);
      try {
        anchor = realpathSync(spelled);
      } catch {
        throw outsideRootsError(roots);
      }
      rel = path.relative(spelled, lexical);
    }
    return ensureDirWithin(anchor, rel === "" ? anchor : path.join(anchor, rel));
  }

  // Browsing creates nothing: canonical re-verify suffices — a symlinked component can
  // resolve outside the root that passed the lexical gate.
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

// Resolves a user-supplied file path for reading: same gates as the browse half of
// resolveTargetDir (lexical containment first, then canonical re-verify) except the result
// may be any existing path — the caller fstat-verifies it is a regular file. Reads are a
// browse-class operation: an interior symlink is allowed because the returned canonical
// path is provably inside a root.
export function resolveReadablePath(input: string): string {
  // No trim: browsed paths must round-trip exactly — upload and browse preserve
  // edge-whitespace names, and the panel already trims typed input before sending.
  const expanded = expandHome(input);
  if (expanded.includes("\0")) throw new Error("Invalid path");
  if (!path.isAbsolute(expanded)) {
    throw new Error("File path must be an absolute path (or start with ~/)");
  }
  const roots = allowedRoots();
  if (roots.length === 0) {
    throw new Error("No readable roots are configured on this host");
  }
  const lexical = path.resolve(expanded);
  const inside =
    roots.some((root) => isInside(lexical, root)) ||
    configuredRoots().some((root) => isInside(lexical, root));
  if (!inside) throw outsideRootsError(roots);

  let resolved: string;
  try {
    resolved = realpathSync(lexical);
  } catch {
    const error = new Error(`File does not exist: ${lexical}`) as NodeJS.ErrnoException;
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
