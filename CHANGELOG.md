# copilotkit-vscode-extension

## [Unreleased]

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
