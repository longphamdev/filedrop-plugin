# Workspace Protocol

> Per-repo dispatch, review, and validation policy for the filedrop Paseo plugin (Lead-facing; Lead passes only applicable technical constraints to writers).

## Strictness, Decision Boundary & Review Routing
- **Default review bar:** no separate review for Tiny/Normal lanes; single fresh read-only review before accepting changes to `server/paths.ts` root/containment logic or `shared/rpc.ts` contracts.
- **Human must decide here (beyond global boundary):** `paseo plugin install/reload/remove`, `paseo reload`, any daemon restart, edits to `~/.paseo/config.json`, and widening `FILEDROP_ALLOWED_ROOTS` on a live daemon. All `paseo` CLI invocations are currently deny-ruled — escalate instead of working around.

## Model Routing & Dispatch Defaults
- **Supervisor:** `slop-devin-lead/swe-2-high` (same seat as Lead while this repo has one seat)
- **Lead (standard / complex):** `slop-devin-lead/swe-2-high` / `slop-devin-lead/swe-2-high` (`modeId`: bypass)
- **Writer (standard / complex):** `slop-devin-peer/swe-2-high` / `slop-devin-peer/swe-2-high` (`modeId`: bypass for unattended ops; 1 fresh Writer per slice)
- **Fresh Read-Only Review:** `slop-devin-peer/swe-2-high` (fresh Peer seat with a neutral, read-only brief)
- **Process Watch (optional, off by default):** `slop-devin-observer/swe-2-high`
- **Context Handoff Target:** hand off Lead/Supervisor near `~200k` tokens (or every 2–3 slices) to prevent expensive cold-cache rebuilds after idle gaps.

## Validation & Environment Exclusivity
- **Official acceptance command(s):** `npm run typecheck` (must be clean). For `server/` handlers, a targeted Node smoke test against a temp directory inside `$HOME` exercising the changed path — chunked write, traversal rejection, allowed-root rejection — cleaned up afterward.
- **Shared resources / exclusive locks:** none in-repo. The daemon on :6767 manages all running agents (including seats working here); never restart it or run `paseo reload` without explicit Human approval.

## Publication & External Effects Policy
- Remote: `origin` = `github.com/longphamdev/filedrop-plugin` (public). Releases ship as tags (`v1.0.x`); the registry submission lives at `getpaseo/plugins#3253`.
- Push, tag, and registry-PR actions run only on explicit Human directive. `git push` is deny-ruled in this seat: use the `gh api` Git-Data path (`blobs` → `trees` → `commits` → ref/tag ops, `XDG_CONFIG_HOME=~/.config`), then `git fetch` + re-sync local `master`/tags to the remote SHAs — GitHub normalizes committer timezones, so remote SHAs differ from locally-created commits even with identical trees.
- No other external side effects: writes stay inside this repo (server code may write to `$HOME` only during explicit verification, cleaned up immediately).

## Repo-Specific Anti-Patterns To Watch
- DOM globals/`className`/`onClick` outside `client/web.ts` — every export there must stay gated on `Platform.OS === "web"`.
- RPC names with uppercase letters or characters outside `[a-z0-9._-]` — silently rejected at registration.
- `Text`/surfaces without `theme.colors` colors — renders black in dark themes.
- Hardcoded `~` or `projectRootPath` where a workspace cwd is wanted — `projectRootPath` is the main checkout, not a worktree's cwd (`directory`).
- Unchunked base64 payloads in one RPC — relay path bounds frames; keep the 256 KiB chunking.
- Uploads reading live UI state mid-flight — capture the destination per job at enqueue (see `handleFiles`).
