import type { PluginClientContext } from "@getpaseo/plugin/client";
import { FileDropPanel } from "./client/panel";

export default function contribute(client: PluginClientContext) {
  // Primary surface: a workspace panel pinned to the Explorer location (the right-side rail
  // beside Files/Changes). If a host ever fails to honor `locations`, the equivalent fallback
  // is `client.addSurface("filedrop", FileDropPanel)` + `client.addSidebarItem({...,
  // surface: "filedrop"})`, reachable from the main sidebar instead of the Explorer rail.
  client.addWorkspacePanel({
    id: "filedrop",
    title: "File drop",
    icon: "Upload",
    locations: ["explorer", "workspace"],
    Component: FileDropPanel,
  });
  client.addCommandCenterItem({
    id: "open-filedrop",
    title: "Open file drop",
    icon: "Upload",
    keywords: ["upload", "drop", "files"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("filedrop", { location: "explorer" });
    },
  });
  return () => {};
}
