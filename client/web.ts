import { Platform } from "react-native";

// Web-only module: the only file in this plugin allowed to touch DOM globals. Every export is
// gated on Platform.OS === "web"; native callers get a no-op detach or a rejection. DOM types
// are declared locally because the plugin tsconfig deliberately omits the "DOM" lib.
interface WebBlobLike {
  readonly size: number;
  slice(start: number, end: number): WebBlobLike;
}

interface WebFileLike extends WebBlobLike {
  readonly name: string;
  readonly webkitRelativePath?: string;
}

interface WebFileListLike {
  readonly length: number;
  item(index: number): WebFileLike | null;
}

interface WebDataTransferItemLike {
  readonly kind: string;
  webkitGetAsEntry?: () => WebEntryLike | null;
  getAsFile?: () => WebFileLike | null;
}

interface WebDataTransferItemListLike {
  readonly length: number;
  readonly [index: number]: WebDataTransferItemLike;
}

interface WebDataTransferLike {
  readonly files: WebFileListLike;
  readonly items?: WebDataTransferItemListLike;
  readonly types: readonly string[];
  dropEffect: string;
}

// FileSystemEntry API (as returned by DataTransferItem.webkitGetAsEntry). Entries are only
// valid inside the synchronous drop handler — capture them before the event returns.
interface WebEntryLike {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly name: string;
  readonly fullPath: string;
}

interface WebFileEntryLike extends WebEntryLike {
  file(onSuccess: (file: WebFileLike) => void, onError?: (error: unknown) => void): void;
}

interface WebDirectoryReaderLike {
  readEntries(
    onSuccess: (entries: WebEntryLike[]) => void,
    onError?: (error: unknown) => void,
  ): void;
}

interface WebDirectoryEntryLike extends WebEntryLike {
  createReader(): WebDirectoryReaderLike;
}

interface WebDragEventLike {
  preventDefault(): void;
  stopPropagation(): void;
  readonly dataTransfer: WebDataTransferLike | null;
}

interface WebDropTargetLike {
  addEventListener(type: string, listener: (event: WebDragEventLike) => void): void;
  removeEventListener(type: string, listener: (event: WebDragEventLike) => void): void;
}

interface WebElementLike {
  appendChild(child: WebElementLike): void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

interface WebFileInputLike extends WebElementLike {
  type: string;
  multiple: boolean;
  files: WebFileListLike | null;
  onchange: (() => void) | null;
  setAttribute(name: string, value: string): void;
  click(): void;
  remove(): void;
}

interface WebDocumentLike {
  createElement(tag: string): WebFileInputLike;
  body: WebElementLike;
}

interface WebFileReaderLike {
  onload: (() => void) | null;
  onerror: ((event: unknown) => void) | null;
  readonly result: string | ArrayBuffer | null;
  readAsDataURL(blob: WebBlobLike): void;
}

declare const FileReader: { new (): WebFileReaderLike };
declare const document: WebDocumentLike;

// Cross-platform surface of a dropped file. `relativePath` carries webkitRelativePath for
// folder drops so the daemon can recreate the tree; it equals `name` for plain files.
export interface DroppedFile {
  readonly name: string;
  readonly relativePath: string;
  readonly size: number;
  slice(start: number, end: number): DroppedBlob;
}

export interface DroppedBlob {
  readonly size: number;
}

// A dropped entry that could not be read (e.g. a directory the browser refused to open).
// Surfaced as an error row so a failed folder drop never degrades into a silent 0-byte file.
export interface DropFailure {
  readonly name: string;
  readonly message: string;
}

export interface DropZoneHandlers {
  onFiles(files: DroppedFile[], failures?: DropFailure[]): void;
  onDragStateChange?(active: boolean): void;
}

function toDroppedFile(file: WebFileLike, relativePath: string): DroppedFile {
  return {
    name: file.name,
    relativePath,
    size: file.size,
    slice: (start, end) => file.slice(start, end),
  };
}

function toDroppedFiles(list: WebFileListLike | null | undefined): DroppedFile[] {
  if (!list) return [];
  const files: DroppedFile[] = [];
  for (let index = 0; index < list.length; index += 1) {
    const file = list.item(index);
    if (!file) continue;
    const relativePath =
      file.webkitRelativePath && file.webkitRelativePath.length > 0
        ? file.webkitRelativePath
        : file.name;
    files.push(toDroppedFile(file, relativePath));
  }
  return files;
}

function readAllEntries(dir: WebDirectoryEntryLike): Promise<WebEntryLike[]> {
  const reader = dir.createReader();
  const entries: WebEntryLike[] = [];
  return new Promise((resolve, reject) => {
    const readBatch = () => {
      // readEntries returns batches (up to 100), not the whole listing — keep calling until
      // an empty batch means the directory is exhausted.
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(entries);
          return;
        }
        entries.push(...batch);
        readBatch();
      }, reject);
    };
    readBatch();
  });
}

function fileFromEntry(entry: WebFileEntryLike): Promise<WebFileLike> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function walkEntry(
  entry: WebEntryLike,
  files: DroppedFile[],
  failures: DropFailure[],
): Promise<void> {
  // entry.fullPath is "/"-prefixed and already contains the dropped root's name, so a dropped
  // folder "a" holding "b.txt" yields "a/b.txt" — exactly the relative path the daemon wants.
  const relativePath = entry.fullPath.replace(/^\/+/, "") || entry.name;
  if (entry.isFile) {
    try {
      files.push(toDroppedFile(await fileFromEntry(entry as WebFileEntryLike), relativePath));
    } catch {
      failures.push({ name: relativePath, message: "Could not read dropped file" });
    }
    return;
  }
  if (entry.isDirectory) {
    let children: WebEntryLike[];
    try {
      children = await readAllEntries(entry as WebDirectoryEntryLike);
    } catch {
      failures.push({ name: relativePath, message: "Could not read dropped folder" });
      return;
    }
    for (const child of children) await walkEntry(child, files, failures);
    return;
  }
  failures.push({ name: relativePath, message: "Unsupported dropped item" });
}

// Attaches HTML5 drag-drop listeners to the DOM node behind a React Native ref (in
// react-native-web, host component refs resolve to DOM elements — the same pattern the app
// uses for its own drop zones). Returns a detach function; a no-op off the web.
export function attachDropZone(node: unknown, handlers: DropZoneHandlers): () => void {
  if (Platform.OS !== "web" || node == null) return () => {};
  const target = node as WebDropTargetLike;
  let dragDepth = 0;

  function hasFiles(event: WebDragEventLike): boolean {
    return (event.dataTransfer?.types ?? []).includes("Files");
  }

  function handleDragEnter(event: WebDragEventLike) {
    event.preventDefault();
    event.stopPropagation();
    dragDepth += 1;
    if (hasFiles(event)) handlers.onDragStateChange?.(true);
  }

  function handleDragOver(event: WebDragEventLike) {
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  }

  function handleDragLeave(event: WebDragEventLike) {
    event.preventDefault();
    event.stopPropagation();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) handlers.onDragStateChange?.(false);
  }

  function handleDrop(event: WebDragEventLike) {
    event.preventDefault();
    event.stopPropagation();
    dragDepth = 0;
    handlers.onDragStateChange?.(false);
    const dataTransfer = event.dataTransfer;
    // Entries must be read inside the synchronous handler — the browser invalidates
    // DataTransferItem and FileSystemEntry objects once the event returns. The async walk
    // below only awaits reader callbacks; the entry handles themselves were captured here.
    const items = dataTransfer?.items;
    if (items && items.length > 0) {
      const dropped: { entry: WebEntryLike | null; file: WebFileLike | null }[] = [];
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        if (!item || item.kind !== "file") continue;
        const entry = item.webkitGetAsEntry?.() ?? null;
        dropped.push({ entry, file: entry ? null : (item.getAsFile?.() ?? null) });
      }
      if (dropped.length === 0) return;
      void (async () => {
        const files: DroppedFile[] = [];
        const failures: DropFailure[] = [];
        for (const { entry, file } of dropped) {
          if (entry) {
            await walkEntry(entry, files, failures);
          } else if (file) {
            files.push(toDroppedFile(file, file.name));
          } else {
            failures.push({ name: "Dropped item", message: "Could not read dropped item" });
          }
        }
        if (files.length > 0 || failures.length > 0) handlers.onFiles(files, failures);
      })();
      return;
    }
    const files = toDroppedFiles(dataTransfer?.files);
    if (files.length > 0) handlers.onFiles(files);
  }

  target.addEventListener("dragenter", handleDragEnter);
  target.addEventListener("dragover", handleDragOver);
  target.addEventListener("dragleave", handleDragLeave);
  target.addEventListener("drop", handleDrop);
  return () => {
    target.removeEventListener("dragenter", handleDragEnter);
    target.removeEventListener("dragover", handleDragOver);
    target.removeEventListener("dragleave", handleDragLeave);
    target.removeEventListener("drop", handleDrop);
  };
}

// Opens the OS file picker through a hidden input. `directory` sets webkitdirectory so folder
// picks produce webkitRelativePath values, which toDroppedFiles preserves into DroppedFile —
// the same shape drops produce, so picked files flow through the identical upload path.
// Resolves [] on cancel and off-web.
export function openFilePicker(options: { directory?: boolean } = {}): Promise<DroppedFile[]> {
  if (Platform.OS !== "web") return Promise.resolve([]);
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  // Hidden but kept in the DOM — Safari ignores .click() on detached inputs.
  input.setAttribute("style", "display:none");
  if (options.directory) input.setAttribute("webkitdirectory", "");
  return new Promise((resolve) => {
    let settled = false;
    const finish = (files: DroppedFile[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.remove();
      resolve(files);
    };
    // Older browsers never fire "cancel"; don't wedge the panel on a dismissed dialog.
    const timer = setTimeout(() => finish([]), 120_000);
    input.onchange = () => finish(toDroppedFiles(input.files));
    input.addEventListener("cancel", () => finish([]));
    document.body.appendChild(input);
    input.click();
  });
}

export function readBlobBase64(blob: DroppedBlob): Promise<string> {
  if (Platform.OS !== "web") {
    return Promise.reject(new Error("File reading is only available in the browser"));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("Unexpected file read result"));
        return;
      }
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error("Could not read file data"));
    reader.readAsDataURL(blob as WebBlobLike);
  });
}
