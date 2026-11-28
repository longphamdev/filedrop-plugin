import { type PluginWorkspacePanelProps, useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { Icon, ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import {
  FILEDROP_EXISTS,
  downloadChunkRpc,
  downloadDirRpc,
  existsRpc,
  listDirsRpc,
  uploadChunkRpc,
} from "../shared/rpc";
import { downloadDirChunks } from "./download-dir";
import { downloadFileChunks } from "./download-file";
import { initTargetState, reduceWorkspaceDir, setManualTarget } from "./target";
import { uploadFileChunks } from "./upload-file";
import {
  attachDropZone,
  openFilePicker,
  readBlobBase64,
  saveBlobAs,
  type DroppedFile,
  type DropFailure,
} from "./web";

type UploadStatus = "queued" | "confirm" | "transferring" | "done" | "error";

interface UploadItem {
  id: number;
  name: string;
  size: number;
  sent: number;
  status: UploadStatus;
  error?: string;
  targetDir: string;
  // "up" is a client→host upload, "down" a host→client download.
  direction: "up" | "down";
}

type QueueJob =
  | {
      kind: "upload";
      id: number;
      file: DroppedFile;
      targetDir: string;
      uploadId: string;
      overwrite: boolean;
    }
  | { kind: "download"; id: number; path: string }
  | { kind: "pack"; id: number; path: string };

interface BrowseState {
  path: string;
  parent: string | null;
  entries: { name: string; path: string; isDir: boolean; size?: number }[];
  truncated: boolean;
  total: number;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function FileDropPanel({ theme, layout, workspaceId }: PluginWorkspacePanelProps) {
  const uploadChunk = useRpc(uploadChunkRpc);
  const downloadChunk = useRpc(downloadChunkRpc);
  const downloadDir = useRpc(downloadDirRpc);
  const exists = useRpc(existsRpc);
  const listDirs = useRpc(listDirsRpc);
  const toast = useToast();

  // The workspace snapshot's `directory` is the checkout cwd (a worktree path when the
  // workspace is a worktree — `projectRootPath` would point at the main checkout instead).
  const workspace = useWorkspace(workspaceId, ({ directory }) => ({ directory }));
  const workspaceDir = workspace?.directory ?? null;

  const [targetState, setTargetState] = useState(() => initTargetState(workspaceDir));
  // Snap the destination to the new workspace cwd on a workspace switch; a manual override
  // survives while the workspace stays put.
  useEffect(() => {
    setTargetState((prev) => reduceWorkspaceDir(prev, workspaceDir));
  }, [workspaceDir]);
  const targetDir = targetState.target;
  const setTargetDir = useCallback(
    (value: string) => setTargetState((prev) => setManualTarget(prev, value)),
    [],
  );
  const [dragActive, setDragActive] = useState(false);
  const [items, setItems] = useState<UploadItem[]>([]);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [browse, setBrowse] = useState<BrowseState | null>(null);
  const [browseError, setBrowseError] = useState<string | null>(null);
  // Host→client download side: a path input plus a file-listing browse (dirs navigate,
  // files enqueue a download). Kept separate from the dir-picker browse above.
  const [downloadPath, setDownloadPath] = useState("");
  // Prefill the download path with the workspace dir — mirrors the upload target input
  // so the base dir is visible and the user just appends the filename. Re-anchors on a
  // workspace switch, but only when the box is empty or still shows the previous
  // prefill: text the user typed is never clobbered.
  const dlPrefillForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!workspaceDir || dlPrefillForRef.current === workspaceDir) return;
    setDownloadPath((prev) => {
      const untouched = prev === "" || prev === dlPrefillForRef.current;
      if (!untouched) return prev;
      dlPrefillForRef.current = workspaceDir;
      return workspaceDir;
    });
  }, [workspaceDir]);
  const [dlBrowseOpen, setDlBrowseOpen] = useState(false);
  const [dlBrowse, setDlBrowse] = useState<BrowseState | null>(null);
  const [dlBrowseError, setDlBrowseError] = useState<string | null>(null);
  const dlBrowseReqRef = useRef(0);

  const queueRef = useRef<QueueJob[]>([]);
  const busyRef = useRef(false);
  const nextIdRef = useRef(1);
  // Jobs parked behind an "exists — overwrite?" decision, keyed by their row id.
  const pendingConfirmsRef = useRef(
    new Map<number, Extract<QueueJob, { kind: "upload" }>>(),
  );
  const targetDirRef = useRef(targetDir);
  targetDirRef.current = targetDir;
  const uploadRef = useRef(uploadChunk);
  uploadRef.current = uploadChunk;
  const downloadRef = useRef(downloadChunk);
  downloadRef.current = downloadChunk;
  const downloadDirRef = useRef(downloadDir);
  downloadDirRef.current = downloadDir;
  const existsRef = useRef(exists);
  existsRef.current = exists;
  const listDirsRef = useRef(listDirs);
  listDirsRef.current = listDirs;
  const detachRef = useRef<(() => void) | null>(null);

  const isWeb = Platform.OS === "web";

  const updateItem = useCallback((id: number, patch: Partial<UploadItem>) => {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  const uploadOne = useCallback(
    async (job: Extract<QueueJob, { kind: "upload" }>) => {
      updateItem(job.id, { status: "transferring" });
      try {
        await uploadFileChunks({
          targetDir: job.targetDir,
          file: job.file,
          uploadId: job.uploadId,
          overwrite: job.overwrite,
          send: (input) => uploadRef.current(input),
          readChunk: readBlobBase64,
          onSent: (bytes) => updateItem(job.id, { sent: bytes }),
        });
        updateItem(job.id, { status: "done", sent: job.file.size });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // The exists pre-check can miss (RPC failure or a file that appeared between check and
        // upload) — the server's rejection parks the job behind the same overwrite decision.
        if (message.includes(FILEDROP_EXISTS)) {
          pendingConfirmsRef.current.set(job.id, job);
          updateItem(job.id, { status: "confirm", sent: 0, error: undefined });
          return;
        }
        updateItem(job.id, { status: "error", error: message });
      }
    },
    [updateItem],
  );

  // Pulls a host file into memory chunk-by-chunk, then hands the parts to the browser's
  // save machinery. Native builds can fetch but have no save dialog — surface that as an
  // item error rather than silently dropping the bytes.
  const downloadOne = useCallback(
    async (job: Extract<QueueJob, { kind: "download" }>) => {
      updateItem(job.id, { status: "transferring" });
      try {
        const file = await downloadFileChunks({
          path: job.path,
          // The row is created with size 0 — pin it from the FIRST response only, so a
          // file growing mid-download doesn't inflate the percentage's denominator.
          send: async (input) => {
            const result = await downloadRef.current(input);
            if (input.offset === 0) updateItem(job.id, { size: result.size });
            return result;
          },
          onReceived: (bytes) => updateItem(job.id, { sent: bytes }),
        });
        if (!saveBlobAs(file.name, file.parts)) {
          throw new Error("Saving downloads is only available in the browser");
        }
        updateItem(job.id, { status: "done", sent: file.size, size: file.size });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        updateItem(job.id, { status: "error", error: message });
      }
    },
    [updateItem],
  );

  // Folder download: the daemon walks the tree, packs one zip, stages it, then this
  // pulls it down with the same chunked loop. One row per folder — no N-row flood.
  const packOne = useCallback(
    async (job: Extract<QueueJob, { kind: "pack" }>) => {
      updateItem(job.id, { status: "transferring" });
      try {
        const pack = await downloadDirChunks({
          path: job.path,
          send: async (input) => {
            const result = await downloadDirRef.current(input);
            // Size is null while the daemon is still packing — pin it once it lands.
            if (result.size !== null) updateItem(job.id, { size: result.size });
            return result;
          },
          onReceived: (bytes) => updateItem(job.id, { sent: bytes }),
        });
        if (!saveBlobAs(pack.name, pack.parts)) {
          throw new Error("Saving downloads is only available in the browser");
        }
        updateItem(job.id, { status: "done", sent: pack.size, size: pack.size });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        updateItem(job.id, { status: "error", error: message });
      }
    },
    [updateItem],
  );

  // Sequential by design: one file at a time, one chunk in flight. The re-check after
  // releasing `busy` closes the race where a drop lands between the empty-queue break and
  // the release — without it that job would sit `queued` forever.
  const drain = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      for (;;) {
        const job = queueRef.current.shift();
        if (!job) break;
        if (job.kind === "download") {
          await downloadOne(job);
        } else if (job.kind === "pack") {
          await packOne(job);
        } else {
          await uploadOne(job);
        }
      }
    } finally {
      busyRef.current = false;
      if (queueRef.current.length > 0) void drain();
    }
  }, [downloadOne, packOne, uploadOne]);

  const handleFiles = useCallback(
    (files: DroppedFile[], failures: DropFailure[] = []) => {
      const dir = targetDirRef.current;
      const nextId = () => {
        const id = nextIdRef.current;
        nextIdRef.current += 1;
        return id;
      };
      void (async () => {
        // Unreadable drop entries (e.g. a folder the browser refused to list) become error
        // rows up front — the alternative is a silent 0-byte upload under the folder's name.
        const rows: UploadItem[] = failures.map((failure) => ({
          id: nextId(),
          name: failure.name,
          size: 0,
          sent: 0,
          status: "error",
          error: failure.message,
          targetDir: dir,
          direction: "up",
        }));
        const checks = await Promise.all(
          files.map(async (file) => {
            try {
              const result = await existsRef.current({
                targetDir: dir,
                relativePath: file.relativePath,
              });
              return { file, hit: result };
            } catch {
              // A failed pre-check must not block the drop — enqueue anyway. The server still
              // enforces the contract; its FILEDROP_EXISTS rejection parks the row as confirm.
              return { file, hit: null };
            }
          }),
        );
        const jobs: QueueJob[] = [];
        for (const { file, hit } of checks) {
          const id = nextId();
          const base = {
            id,
            name: file.relativePath,
            size: file.size,
            sent: 0,
            targetDir: dir,
            direction: "up" as const,
          };
          if (hit?.exists && hit.isDir) {
            rows.push({ ...base, status: "error", error: "A folder already exists at this path" });
            continue;
          }
          const job: QueueJob = {
            kind: "upload",
            id,
            file,
            targetDir: dir,
            uploadId: crypto.randomUUID(),
            overwrite: false,
          };
          if (hit?.exists) {
            pendingConfirmsRef.current.set(id, job);
            rows.push({ ...base, status: "confirm" });
          } else {
            jobs.push(job);
            rows.push({ ...base, status: "queued" });
          }
        }
        queueRef.current.push(...jobs);
        setItems((prev) => [...prev, ...rows]);
        void drain();
      })();
    },
    [drain],
  );

  const resolveConflict = useCallback(
    (id: number, overwrite: boolean) => {
      const job = pendingConfirmsRef.current.get(id);
      pendingConfirmsRef.current.delete(id);
      if (!job || !overwrite) {
        // Skip drops the job and its row entirely.
        setItems((prev) => prev.filter((item) => item.id !== id));
        return;
      }
      job.overwrite = true;
      queueRef.current.push(job);
      updateItem(id, { status: "queued", sent: 0, error: undefined });
      void drain();
    },
    [drain, updateItem],
  );

  const resolveAllConflicts = useCallback(
    (overwrite: boolean) => {
      for (const id of [...pendingConfirmsRef.current.keys()]) {
        resolveConflict(id, overwrite);
      }
    },
    [resolveConflict],
  );

  // Click-to-browse uses the same validated path as drops: picked Files carry
  // webkitRelativePath (folder picks) into the identical DroppedFile shape.
  const pickFiles = useCallback(
    (directory: boolean) => {
      void openFilePicker({ directory }).then((files) => {
        if (files.length > 0) handleFiles(files);
      });
    },
    [handleFiles],
  );

  // Keep the latest handlers reachable from the DOM listeners without re-attaching.
  const handlersRef = useRef({ onFiles: handleFiles, onDragStateChange: setDragActive });
  handlersRef.current = { onFiles: handleFiles, onDragStateChange: setDragActive };

  const setDropNode = useCallback((node: unknown) => {
    detachRef.current?.();
    detachRef.current = null;
    if (node) {
      detachRef.current = attachDropZone(node, {
        onFiles: (files, failures) => handlersRef.current.onFiles(files, failures),
        onDragStateChange: (active) => handlersRef.current.onDragStateChange(active),
      });
    }
  }, []);

  useEffect(() => () => detachRef.current?.(), []);

  const browseTo = useCallback(async (path?: string) => {
    setBrowseError(null);
    try {
      const result = await listDirsRef.current(path ? { path } : {});
      setBrowse(result);
    } catch (error) {
      setBrowse(null);
      setBrowseError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const toggleBrowse = useCallback(() => {
    if (browseOpen) {
      setBrowseOpen(false);
      return;
    }
    setBrowseOpen(true);
    void browseTo(targetDirRef.current.trim() || undefined);
  }, [browseOpen, browseTo]);

  const useBrowseDir = useCallback(() => {
    if (!browse) return;
    setTargetDir(browse.path);
    setBrowseOpen(false);
    toast.show(`Target set to ${browse.path}`, { variant: "success" });
  }, [browse, toast]);

  // A download job carries the host path the daemon will read — the daemon confines it
  // to the allowed roots, so a mistyped path fails as an item error, not a write.
  // No trim here: browsed paths must round-trip exactly (edge-whitespace names are
  // legal), and the typed input is trimmed in startDownload before it gets here.
  const enqueueDownload = useCallback(
    (hostPath: string) => {
      if (!hostPath.trim()) return;
      const id = nextIdRef.current;
      nextIdRef.current += 1;
      queueRef.current.push({ kind: "download", id, path: hostPath });
      setItems((prev) => [
        ...prev,
        { id, name: hostPath, size: 0, sent: 0, status: "queued", targetDir: "", direction: "down" },
      ]);
      void drain();
    },
    [drain],
  );

  const dlBrowseTo = useCallback(async (path?: string, retryParent = false) => {
    setDlBrowseError(null);
    // Generation guard: only the latest request may land — a stale response arriving
    // after a newer one would repaint the list with the wrong directory.
    const reqId = ++dlBrowseReqRef.current;
    try {
      const result = await listDirsRef.current(
        path ? { path, includeFiles: true } : { includeFiles: true },
      );
      if (reqId !== dlBrowseReqRef.current) return;
      setDlBrowse(result);
    } catch (error) {
      if (reqId !== dlBrowseReqRef.current) return;
      const message = error instanceof Error ? error.message : String(error);
      // A typed anchor may name a file — the server can't tell without listing. On
      // ENOTDIR, retry the containing dir so the file shows up in the list.
      if (retryParent && path && message.includes("ENOTDIR")) {
        const slash = path.replace(/\/+$/, "").lastIndexOf("/");
        void dlBrowseTo(slash > 0 ? path.slice(0, slash) : undefined);
        return;
      }
      setDlBrowse(null);
      setDlBrowseError(message);
    }
  }, []);

  const startDownload = useCallback(() => {
    const typed = downloadPath.trim();
    // Relative names resolve against the same directory uploads target — the workspace
    // dir by default — so `foo.txt` and `~/foo.txt` and `/abs/foo.txt` all work.
    // Home paths are only `~` or `~/…` — a leading `~` on anything else (a real file
    // literally named `~notes.txt`) must stay a relative name, matching expandHome.
    const isHome = typed === "~" || typed.startsWith("~/");
    const resolved =
      typed && !typed.startsWith("/") && !isHome
        ? `${targetDirRef.current.replace(/\/+$/, "")}/${typed}`
        : typed;
    if (!resolved) return;
    const openBrowse = () => {
      setDlBrowseOpen(true);
      void dlBrowseTo(resolved);
    };
    // `~` alone and trailing-/ paths are dirs by spelling — open the browser on them.
    if (resolved === "~" || resolved.endsWith("/")) {
      openBrowse();
      return;
    }
    // Anything else might still be a dir (e.g. the prefilled workspace dir has no
    // trailing slash). Probe once: isDir → browse there; otherwise enqueue the file.
    const slash = resolved.lastIndexOf("/");
    const parent = slash > 0 ? resolved.slice(0, slash) : "/";
    const leaf = resolved.slice(slash + 1);
    void (async () => {
      try {
        const probe = await existsRef.current({ targetDir: parent, relativePath: leaf });
        if (probe.exists && probe.isDir) {
          openBrowse();
          return;
        }
      } catch {
        // Probe failed (outside roots, bad name) — fall through and let the download
        // row carry the real server error.
      }
      enqueueDownload(resolved);
      setDownloadPath("");
    })();
  }, [downloadPath, enqueueDownload, dlBrowseTo]);

  const toggleDlBrowse = useCallback(() => {
    if (dlBrowseOpen) {
      setDlBrowseOpen(false);
      return;
    }
    setDlBrowseOpen(true);
    // Anchor at the typed path (the prefilled workspace dir), falling back to the upload
    // target. Whether it names a file or dir is the server's call — retryParent lets a
    // file path fall back to its containing dir instead of erroring.
    const anchor = downloadPath.trim() || targetDirRef.current.trim() || undefined;
    void dlBrowseTo(anchor, true);
  }, [dlBrowseOpen, dlBrowseTo, downloadPath]);

  // Mirror of "Choose a folder instead" on the upload side: the daemon walks the tree
  // and packs one zip server-side, so a folder is a single transfer row — no client
  // walk, no per-file rows, and a pack failure surfaces as a real error row.
  const downloadFolder = useCallback(
    (dirPath: string) => {
      const id = nextIdRef.current++;
      const leaf = dirPath.split("/").filter((s) => s.length > 0).pop() ?? dirPath;
      setItems((prev) => [
        { id, name: `${leaf}.zip`, size: 0, sent: 0, status: "queued", targetDir: "", direction: "down" },
        ...prev,
      ]);
      queueRef.current.push({ kind: "pack", id, path: dirPath });
      void drain();
    },
    [drain],
  );

  const clearFinished = useCallback(() => {
    // "confirm" rows are unresolved decisions, not finished — keep them (and their parked jobs).
    setItems((prev) =>
      prev.filter(
        (item) => item.status === "queued" || item.status === "confirm" || item.status === "transferring",
      ),
    );
  }, []);

  const pad = layout.compact ? 12 : 16;
  const styles = useMemo(
    () => ({
      screen: {
        flex: 1,
        backgroundColor: theme.colors.surface0,
      },
      screenContent: { padding: pad, gap: pad },
      headingRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      heading: { color: theme.colors.foreground, fontSize: layout.compact ? 16 : 18, fontWeight: "600" as const },
      label: { color: theme.colors.foregroundMuted, fontSize: 12 },
      inputRow: {
        flexDirection: "row" as const,
        gap: 8,
        alignItems: "center" as const,
        flexWrap: "wrap" as const,
      },
      input: {
        flexGrow: 1,
        minWidth: 0,
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
        fontSize: 13,
      },
      button: {
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 8,
        backgroundColor: theme.colors.surface2,
        borderWidth: 1,
        borderColor: theme.colors.border,
      },
      buttonAccent: {
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 8,
        backgroundColor: theme.colors.accent,
      },
      buttonText: { color: theme.colors.foreground, fontSize: 13 },
      buttonAccentText: { color: theme.colors.accentForeground, fontSize: 13 },
      browseBox: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        backgroundColor: theme.colors.surface1,
        maxHeight: 220,
        overflow: "hidden" as const,
      },
      browsePath: { color: theme.colors.foregroundMuted, fontSize: 12, padding: 8 },
      browseRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingHorizontal: 10,
        paddingVertical: 7,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
      },
      browseRowText: { color: theme.colors.foreground, fontSize: 13, flex: 1 },
      dropZone: {
        borderWidth: 2,
        borderStyle: "dashed" as const,
        borderColor: dragActive ? theme.colors.accent : theme.colors.border,
        borderRadius: 12,
        backgroundColor: dragActive ? theme.colors.surface2 : theme.colors.surface1,
        padding: layout.compact ? 24 : 40,
        alignItems: "center" as const,
        gap: 8,
      },
      dropTitle: { color: theme.colors.foreground, fontSize: layout.compact ? 14 : 16 },
      dropHint: { color: theme.colors.foregroundMuted, fontSize: 12, textAlign: "center" as const },
      folderPickRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        alignSelf: "center" as const,
        gap: 6,
        paddingVertical: 4,
        paddingHorizontal: 8,
      },
      folderPickText: { color: theme.colors.foregroundMuted, fontSize: 12 },

      itemRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingVertical: 6,
      },
      confirmButton: {
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 6,
        backgroundColor: theme.colors.surface2,
        borderWidth: 1,
        borderColor: theme.colors.border,
      },
      confirmButtonText: { color: theme.colors.foreground, fontSize: 12 },
      conflictBar: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingVertical: 4,
      },
      itemName: { color: theme.colors.foreground, fontSize: 13, flex: 1 },
      itemMeta: { color: theme.colors.foregroundMuted, fontSize: 12 },
      itemError: { color: theme.colors.statusDanger, fontSize: 12 },
      sectionRow: { flexDirection: "row" as const, alignItems: "center" as const, justifyContent: "space-between" as const },
      errorText: { color: theme.colors.statusDanger, fontSize: 12, padding: 8 },
    }),
    [theme, layout.compact, dragActive, pad],
  );

  const conflictCount = items.reduce((count, item) => count + (item.status === "confirm" ? 1 : 0), 0);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.screenContent}>
      <View style={styles.headingRow}>
        <Icon name="Upload" size={18} color={theme.colors.foreground} />
        <Text style={styles.heading}>File drop</Text>
      </View>

      <Text style={styles.label}>Target directory on this host</Text>
      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          value={targetDir}
          onChangeText={setTargetDir}
          placeholder="/absolute/path or ~/path"
          placeholderTextColor={theme.colors.foregroundMuted}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Pressable accessibilityRole="button" onPress={toggleBrowse} style={styles.button}>
          <Text style={styles.buttonText}>{browseOpen ? "Close" : "Browse"}</Text>
        </Pressable>
      </View>

      {browseOpen ? (
        <View style={styles.browseBox}>
          <Text style={styles.browsePath}>{browse ? browse.path : "Loading…"}</Text>
          {browseError ? <Text style={styles.errorText}>{browseError}</Text> : null}
          {browse ? (
            <ScrollView keyboardShouldPersistTaps="handled">
              {browse.parent ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => void browseTo(browse.parent ?? undefined)}
                  style={styles.browseRow}
                >
                  <Icon name="ArrowUp" size={14} color={theme.colors.foregroundMuted} />
                  <Text style={styles.browseRowText}>..</Text>
                </Pressable>
              ) : null}
              {browse.entries.map((dir) => (
                <Pressable
                  key={dir.path}
                  accessibilityRole="button"
                  onPress={() => void browseTo(dir.path)}
                  style={styles.browseRow}
                >
                  <Icon name="Folder" size={14} color={theme.colors.foregroundMuted} />
                  <Text style={styles.browseRowText} numberOfLines={1}>
                    {dir.name}
                  </Text>
                </Pressable>
              ))}
              {browse.entries.length === 0 ? (
                <Text style={styles.browsePath}>No subdirectories</Text>
              ) : null}
              {browse.truncated ? (
                <Text style={styles.browsePath}>
                  …and {Math.max(0, browse.total - browse.entries.length)} more
                </Text>
              ) : null}
            </ScrollView>
          ) : null}
          {browse ? (
            <View style={{ padding: 8 }}>
              <Pressable accessibilityRole="button" onPress={useBrowseDir} style={styles.buttonAccent}>
                <Text style={styles.buttonAccentText}>Use this folder</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      ) : null}

      <Pressable
        ref={setDropNode}
        accessibilityRole="button"
        accessibilityLabel="Drop files here or press to browse files"
        onPress={() => pickFiles(false)}
        style={(state) => {
          // RNW supplies `hovered` on web; RN's type predates it.
          const hovered = (state as { hovered?: boolean }).hovered === true;
          return [
            styles.dropZone,
            (state.pressed || hovered) && { borderColor: theme.colors.accent },
          ];
        }}
      >
        <Icon
          name="Download"
          size={layout.compact ? 24 : 32}
          color={dragActive ? theme.colors.accent : theme.colors.foregroundMuted}
        />
        <Text style={styles.dropTitle}>
          {isWeb
            ? dragActive
              ? "Release to upload"
              : "Drop files or click to browse"
            : "Drop files here"}
        </Text>
        <Text style={styles.dropHint} numberOfLines={2}>
          {isWeb
            ? `Files land in ${targetDir} on this host`
            : "Drag and drop is only available in the browser or desktop app"}
        </Text>
      </Pressable>
      {isWeb ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Choose a folder to upload"
          onPress={() => pickFiles(true)}
          style={styles.folderPickRow}
        >
          <Icon name="FolderOpen" size={14} color={theme.colors.foregroundMuted} />
          <Text style={styles.folderPickText}>Choose a folder instead</Text>
        </Pressable>
      ) : null}

      <Text style={styles.label}>Download from this host</Text>
      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          value={downloadPath}
          onChangeText={setDownloadPath}
          onSubmitEditing={startDownload}
          placeholder="~/file, /absolute/file, or file-in-workspace"
          placeholderTextColor={theme.colors.foregroundMuted}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Pressable accessibilityRole="button" onPress={toggleDlBrowse} style={styles.button}>
          <Text style={styles.buttonText}>{dlBrowseOpen ? "Close" : "Browse"}</Text>
        </Pressable>
      </View>

      {dlBrowseOpen ? (
        <View style={styles.browseBox}>
          <Text style={styles.browsePath}>{dlBrowse ? dlBrowse.path : "Loading…"}</Text>
          {dlBrowseError ? <Text style={styles.errorText}>{dlBrowseError}</Text> : null}
          {dlBrowse ? (
            <ScrollView keyboardShouldPersistTaps="handled">
              {dlBrowse.parent ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => void dlBrowseTo(dlBrowse.parent ?? undefined)}
                  style={styles.browseRow}
                >
                  <Icon name="ArrowUp" size={14} color={theme.colors.foregroundMuted} />
                  <Text style={styles.browseRowText}>..</Text>
                </Pressable>
              ) : null}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Download all files in this folder"
                onPress={() => void downloadFolder(dlBrowse.path)}
                style={styles.browseRow}
              >
                <Icon name="ArrowDownToLine" size={14} color={theme.colors.accent} />
                <Text style={styles.browseRowText}>Download all files in this folder</Text>
              </Pressable>
              {dlBrowse.entries.map((entry) => (
                <Pressable
                  key={entry.path}
                  accessibilityRole="button"
                  accessibilityLabel={
                    entry.isDir ? `Open folder ${entry.name}` : `Download ${entry.name}`
                  }
                  onPress={() =>
                    entry.isDir ? void dlBrowseTo(entry.path) : enqueueDownload(entry.path)
                  }
                  style={styles.browseRow}
                >
                  <Icon
                    name={entry.isDir ? "Folder" : "File"}
                    size={14}
                    color={theme.colors.foregroundMuted}
                  />
                  <Text style={styles.browseRowText} numberOfLines={1}>
                    {entry.name}
                  </Text>
                  {entry.isDir ? null : (
                    <Text style={styles.itemMeta}>
                      {entry.size !== undefined ? formatBytes(entry.size) : ""}
                    </Text>
                  )}
                  {entry.isDir ? null : (
                    <Icon name="Download" size={13} color={theme.colors.accent} />
                  )}
                </Pressable>
              ))}
              {dlBrowse.entries.length === 0 ? (
                <Text style={styles.browsePath}>Empty directory</Text>
              ) : null}
              {dlBrowse.truncated ? (
                <Text style={styles.browsePath}>
                  …and {Math.max(0, dlBrowse.total - dlBrowse.entries.length)} more
                </Text>
              ) : null}
            </ScrollView>
          ) : null}
        </View>
      ) : null}

      {items.length > 0 ? (
        <View>
          <View style={styles.sectionRow}>
            <Text style={styles.label}>Transfers</Text>
            <Pressable accessibilityRole="button" onPress={clearFinished}>
              <Text style={styles.label}>Clear finished</Text>
            </Pressable>
          </View>
          {conflictCount > 1 ? (
            <View style={styles.conflictBar}>
              <Text style={styles.label}>{conflictCount} files already exist</Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => resolveAllConflicts(true)}
                style={styles.confirmButton}
              >
                <Text style={styles.confirmButtonText}>Overwrite all</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={() => resolveAllConflicts(false)}
                style={styles.confirmButton}
              >
                <Text style={styles.confirmButtonText}>Skip all</Text>
              </Pressable>
            </View>
          ) : null}
          <ScrollView style={{ maxHeight: layout.compact ? 160 : 200 }}>
            {items.map((item) => {
              const percent = item.size > 0 ? Math.round((item.sent / item.size) * 100) : 0;
              const icon =
                item.status === "done"
                  ? "CircleCheckBig"
                  : item.status === "error"
                    ? "CircleAlert"
                    : item.status === "transferring"
                      ? "LoaderCircle"
                      : item.direction === "down"
                        ? "Download"
                        : "Clock";
              const iconColor =
                item.status === "done"
                  ? theme.colors.statusSuccess
                  : item.status === "error"
                    ? theme.colors.statusDanger
                    : theme.colors.foregroundMuted;
              return (
                <View key={item.id}>
                  {item.status === "confirm" ? (
                    <View style={styles.itemRow}>
                      <Icon name="CircleAlert" size={14} color={theme.colors.statusWarning} />
                      <Text style={styles.itemName} numberOfLines={1}>
                        {item.name}
                      </Text>
                      <Text style={styles.itemMeta}>exists — overwrite?</Text>
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => resolveConflict(item.id, true)}
                        style={styles.confirmButton}
                      >
                        <Text style={styles.confirmButtonText}>Overwrite</Text>
                      </Pressable>
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => resolveConflict(item.id, false)}
                        style={styles.confirmButton}
                      >
                        <Text style={styles.confirmButtonText}>Skip</Text>
                      </Pressable>
                    </View>
                  ) : (
                    <View style={styles.itemRow}>
                      <Icon name={icon} size={14} color={iconColor} />
                      <Text style={styles.itemName} numberOfLines={1}>
                        {item.name}
                      </Text>
                      <Text style={styles.itemMeta}>
                        {item.status === "done"
                          ? formatBytes(item.size)
                          : item.status === "error"
                            ? "failed"
                            : item.status === "queued"
                              ? "queued"
                              : `${percent}%`}
                      </Text>
                    </View>
                  )}
                  {item.error ? <Text style={styles.itemError}>{item.error}</Text> : null}
                </View>
              );
            })}
          </ScrollView>
        </View>
      ) : null}
    </ScrollView>
  );
}
