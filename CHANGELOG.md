# copilotkit-vscode-extension

## [Unreleased]

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
