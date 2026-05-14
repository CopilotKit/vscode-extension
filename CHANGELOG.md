# copilotkit-vscode-extension

## [Unreleased]

## 0.2.3 — 2026-05-14

### Fixed

- Playground saved-replay sidebar: deleting a fixture file out of band (Explorer, terminal, git pull) now refreshes the sidebar within ~1 s via a Node `fs.watch` on `.copilotkit/fixtures/`. The previous `vscode.workspace.createFileSystemWatcher` was unreliable for dot-prefixed paths on Windows; the entry would stick around until the next reload.
- Playground ▶ on a saved replay no longer drops the recorded conversation. The previous race posted `play-fixture` before the new bundle's `PlaygroundChat` had registered its replay listener; the App shell now unmounts the stale bundle synchronously on `bundle-ready`, queues the replay messages, and dispatches them after the new chat mounts (React runs child effects before parent effects on the same commit, so the listener is guaranteed to be attached).
- Playground recovery: clicking ▶ on a fixture whose file has been deleted no longer permanently bricks the panel ("Preparing chat surface…" + ENOENT loop). `load-fixture` now reads the file before committing `replayFixturePath`, refreshes the sidebar, and surfaces a one-shot warning. The `runBundle` pass also recovers when the active fixture vanishes mid-session by falling back to record mode instead of crashing.
- Playground Refresh button: always reconciles the saved-replays sidebar with disk at the start of every rebundle. Refresh is now a guaranteed manual recovery path even if the fs.watch misses an event.
- Playground chat with many `vscode.lm` tools: some models (notably Claude through Copilot Chat with ~80+ tools forwarded) silently reject requests by returning 200 OK with an empty stream. The chat now auto-retries once without the `vscode.lm` tools so the user gets a real response on the same query. If both attempts return empty, an actionable in-chat message explains the cause and points at the `copilotkit.playground.enableVscodeLmTools` setting.
- Playground stream translation: text content streamed as `LanguageModelDataPart` (text/plain or application/json mimes) is surfaced as `TEXT_MESSAGE_CONTENT` instead of being silently dropped. Newer Claude builds routed through Copilot Chat had been producing empty chats this way.

### Added

- Playground output channel now logs unknown `vscode.lm` stream-part types (constructor name + mime when applicable) so future model-side changes leave a breadcrumb instead of an empty chat.

## 0.2.2 — 2026-05-05

### Fixed

- Publish pipeline: dropped the dedicated `macos-13` (Intel) runner; GitHub's Intel Mac queue is being wound down and routinely held publish runs for 1–4+ hours waiting for allocation. The `darwin-x64` matrix entry now runs on `macos-latest` (M-series) and cross-installs x64 native bindings via `pnpm --config.supportedArchitectures.cpu=x64` before packaging — `vsce package --target` only stamps the manifest, so the .vsix's bindings come from whatever's in `node_modules`. Same four targets ship; allocation latency is gone.

### Note

- `0.2.1` was tagged but never reached the Marketplace — its publish run was held in queue waiting for `macos-13` allocation when it was cancelled. `0.2.2` is the first version that actually completes the platform-specific publish flow added in `0.2.1`.

## 0.2.1 — 2026-05-05

### Fixed

- Marketplace activation crash (`Cannot find module 'rolldown'`). The `0.2.0` .vsix was published without the native-backed runtime dependencies (`rolldown`, `oxc-parser`, `@tailwindcss/node`, `@tailwindcss/oxide`), so requiring them at activation threw on every install. Switched the publish pipeline to ship platform-specific .vsix builds (`win32-x64`, `linux-x64`, `darwin-x64`, `darwin-arm64`) with the appropriate native bindings included.
- Playground console crash (`Cannot access 'require_event_client' before initialization`). Rolldown's `__commonJSMin` wrapper hits a TDZ shadow-bug when bundling certain CJS dists; routed the affected packages (`@tanstack/pacer`, `@tanstack/devtools-event-client`, `@copilotkit/shared`) to their ESM entries to bypass the wrap.

## 0.2.0 — 2026-05-05

### Added

- Playground — embedded chat surface powered by `vscode.lm` for interacting with CopilotKit agents directly in the editor.
- Playground scanner detects CopilotKit hooks and providers in your workspace, wires them into a local runtime, and hot-reloads on file saves.
- Fixture recording and replay — capture a conversation once, then re-run it deterministically for development and testing.
- Model picker via `vscode.lm.selectChatModels` with optional `vscode.lm.tools` forwarding.
- Tailwind v4 compile pass in the playground bundler for user component CSS.

### Fixed

- SSE error handling for `RUN_ERROR` events now uses sentinel-based detection instead of message string comparison.
- Fixture store hardened: path traversal protection, version validation, name collision avoidance, corrupt file warnings.
- Anonymous default exports are now correctly included in the playground aggregator.
- Nested `UnserializableRef` values in provider props are correctly inlined in codegen output.

## 0.1.0 — 2026-04-21

### Added

- A2UI Preview — live-preview catalog components from the VS Code sidebar.
- Hook Explorer — explore `useCopilotAction` and `useCoAgent` hook renders without leaving the editor.
- AG-UI Inspector — inspect AG-UI agent runs from within VS Code.
