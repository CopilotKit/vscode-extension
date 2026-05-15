import * as fs from "node:fs";
import * as vscode from "vscode";

/**
 * Watches `<workspaceRoot>/.copilotkit/fixtures/` for changes so the
 * saved-replays sidebar stays in sync with the on-disk state.
 *
 * We use Node's `fs.watch` rather than `vscode.workspace.createFileSystemWatcher`
 * because VS Code's watcher is unreliable for dot-prefixed directories
 * across platforms (Windows in particular swallows events for paths under
 * `.copilotkit/`). `fs.watch` runs in the extension host's Node runtime
 * and sees every event the OS reports for the watched directory.
 *
 * If the fixtures directory doesn't exist yet, `attach()` is a no-op and
 * a 5-second poll re-tries until the directory appears (e.g. after the
 * user's first save). Once attached, the watcher is permanent.
 */
export class FixturesDirWatcher implements vscode.Disposable {
  private watcher: fs.FSWatcher | null = null;
  private retry: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly fixturesDir: string,
    private readonly onChange: () => void,
    private readonly log: (line: string) => void = () => {},
  ) {
    this.attach();
    if (!this.watcher) {
      this.retry = setInterval(() => this.attach(), 5000);
    }
  }

  private attach(): void {
    if (this.watcher) return;
    if (!fs.existsSync(this.fixturesDir)) return;
    try {
      this.watcher = fs.watch(this.fixturesDir, (eventType, filename) => {
        this.log(
          `[fixtures-watcher] fs.watch ${eventType} ${filename ?? "<no filename>"}`,
        );
        this.onChange();
      });
      this.log(`[fixtures-watcher] attached to ${this.fixturesDir}`);
      if (this.retry) {
        clearInterval(this.retry);
        this.retry = null;
      }
    } catch (err) {
      this.log(
        `[fixtures-watcher] fs.watch failed for ${this.fixturesDir}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  dispose(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.retry) {
      clearInterval(this.retry);
      this.retry = null;
    }
  }
}
