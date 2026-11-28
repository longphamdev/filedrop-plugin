# filedrop

Two-way file transfer for [Paseo](https://paseo.sh). Drop files or folders from the
machine running the Paseo app (your browser) and they land in a directory on the daemon
host — or browse the host filesystem and pull files back down to your client.

## Requirements

- Paseo daemon **>= 0.17.0** with `pluginsEnabled: true` in its `config.json`.
- The Paseo **web or desktop app** for drag-drop, the file pickers, and saving downloads.
  Native clients see the panel and both browsers but cannot drop or save.

## Install

```bash
paseo plugin install /absolute/path/to/filedrop-plugin
paseo plugin ls        # expect filedrop: running
```

Source edits need `paseo plugin reload filedrop` — never restart the daemon to pick them up.

## Use it

- The **File drop** panel lives on the Explorer rail beside Files/Changes, or open it with
  **⌘K / Ctrl+K → "Open file drop"**.
- The target directory defaults to the **current workspace's own directory** and snaps to
  the new workspace's directory when you switch. Type any absolute path or `~/path`, or
  press **Browse** to walk the host filesystem.
- **Drop** files or a folder onto the dashed zone, **click it** for a file picker, or use
  **Choose a folder instead** to upload a whole directory tree — relative paths are
  recreated on the host.
- Dropping onto an existing filename parks the row behind an **"exists — overwrite?"**
  decision; when several collide you get **Overwrite all / Skip all**.
- To **download** from the host, type an absolute path (or `~/path`) under *Download a
  file from this host* and press **Download**, or press **Browse files** to walk the host
  filesystem — folders navigate, clicking a file saves it through your browser's normal
  download flow. Saving is web/desktop only.
- Uploads and downloads share one sequential **Transfers** list — progress, final size,
  or an error row each. **Clear finished** tidies it.

## Safety design

- Writes **and reads** are confined to **allowed roots** — the daemon user's home
  directory by default. Widen with the `FILEDROP_ALLOWED_ROOTS` environment variable on
  the daemon (path-delimited, e.g. `/data:/srv/uploads`).
- Downloads are read-class, like browsing: the requested path is contained lexically
  then canonicalized, so a symlink pointing outside the roots is refused while an
  interior symlink resolves fine. The canonical path is opened `O_NOFOLLOW | O_NONBLOCK`
  and `fstat`-verified as a regular file — directories, fifos, and race-swapped links
  are rejected. After the open, the canonical name is re-resolved and the fd's device +
  inode compared, so a mid-path component raced to a symlink between resolve and open
  cannot walk the read outside the roots; each chunk call then pins that inode via a
  `fileId` the client echoes, so a same-size replacement mid-download is rejected
  instead of silently mixing bytes.
- Downloads assemble the whole file in the client's browser memory before saving (Blob +
  object URL — inherent to browser saves without a streaming File System Access
  fallback). Fine for typical files; pulling multi-GB files can strain a browser tab.
- `..` segments are rejected outright; paths are contained lexically **before** any
  directory is created and re-verified canonically after — a symlinked component that
  resolves outside the root is refused.
- Symlinked destinations are never written through or renamed over (checked with `lstat`,
  `O_NOFOLLOW` on staging opens).
- Files stream in **256 KiB chunks** into a `<name>.filedrop-part[-<token>]` staging file
  beside the destination and are **renamed** only when the declared size has landed — an
  interrupted upload never leaves a truncated file under the final name. Interrupted runs
  do leave the staged `.filedrop-part-*` file behind.
- An existing destination needs an explicit overwrite; a same-named folder is never
  clobbered.

> Plugins are trusted, unsandboxed code. The server half runs in a daemon subprocess with
> access to the host's files, processes, credentials, and network. Install only code you
> have inspected.

## Repo layout

```
paseo-plugin.json      manifest (id: filedrop, requires paseo >=0.17.0)
index.client.tsx       panel + Command Center registrations
index.server.ts        RPC handler registrations
client/                app-side UI — React Native primitives only;
                       all DOM lives in client/web.ts, gated on Platform.OS === "web"
server/                daemon subprocess — fs containment, chunked writes/reads, dir listing
shared/rpc.ts          Zod RPC contracts (filedrop.upload / .exists / .list-dirs / .download)
docs/                  SLOP intake and workspace protocol
```

## Develop

```bash
npm install
npm run typecheck    # tsc --noEmit, must stay clean
```
