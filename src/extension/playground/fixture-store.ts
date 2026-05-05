import * as fs from "node:fs";
import * as path from "node:path";
import type { RecordedCall } from "./vscode-lm-factory";

export interface FixtureMetadata {
  name: string;
  createdAt: string;
  modelId: string;
  modelVendor: string;
  version: 2;
}

export interface SavedFixture {
  metadata: FixtureMetadata;
  calls: RecordedCall[];
}

export interface FixtureListEntry {
  filePath: string;
  metadata: FixtureMetadata;
}

export interface FixtureStoreOptions {
  onWarn?: (message: string) => void;
}

/**
 * Filesystem-backed store for playground chat fixtures. Each fixture is a
 * single JSON file under `<workspaceRoot>/.copilotkit/fixtures/`. The v2
 * format stores recorded vscode-lm calls; v1 (journal-shaped) files are
 * skipped with a warning — they were dev artifacts only.
 */
export class FixtureStore {
  private readonly onWarn: (message: string) => void;

  constructor(
    private readonly workspaceRoot: string,
    opts: FixtureStoreOptions = {},
  ) {
    this.onWarn = opts.onWarn ?? (() => {});
  }

  private fixturesDir(): string | null {
    if (!this.workspaceRoot) return null;
    return path.join(this.workspaceRoot, ".copilotkit", "fixtures");
  }

  private requireFixturesDir(): string {
    const dir = this.fixturesDir();
    if (!dir) {
      throw new Error("workspace root is not set — cannot access fixtures");
    }
    return dir;
  }

  private isInsideFixturesDir(filePath: string): boolean {
    const dir = this.requireFixturesDir();
    const resolved = path.resolve(filePath);
    const resolvedDir = path.resolve(dir) + path.sep;
    return resolved.startsWith(resolvedDir);
  }

  list(): FixtureListEntry[] {
    const dir = this.fixturesDir();
    if (!dir || !fs.existsSync(dir)) return [];
    const entries: FixtureListEntry[] = [];
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const filePath = path.join(dir, name);
      try {
        const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        if (content?.metadata?.version === 2) {
          entries.push({ filePath, metadata: content.metadata });
        } else {
          this.onWarn(
            `[fixture-store] skipping v1 fixture ${filePath} — pre-vscode.lm format`,
          );
        }
      } catch (err) {
        this.onWarn(
          `[fixture-store] failed to parse ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return entries.sort((a, b) => {
      if (a.metadata.createdAt < b.metadata.createdAt) return 1;
      if (a.metadata.createdAt > b.metadata.createdAt) return -1;
      return 0;
    });
  }

  read(filePath: string): SavedFixture {
    if (!this.isInsideFixturesDir(filePath)) {
      throw new Error("refusing to read file outside fixtures directory");
    }
    const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (content?.metadata?.version !== 2) {
      throw new Error(
        `fixture version mismatch: expected version 2, got ${content?.metadata?.version ?? "unknown"}`,
      );
    }
    return content as SavedFixture;
  }

  save(metadata: FixtureMetadata, body: { calls: RecordedCall[] }): string {
    const dir = this.requireFixturesDir();
    fs.mkdirSync(dir, { recursive: true });
    const safeName = sanitizeName(metadata.name) || "fixture";
    let filePath = path.join(dir, `${safeName}.json`);
    let suffix = 2;
    while (fs.existsSync(filePath)) {
      filePath = path.join(dir, `${safeName}-${suffix}.json`);
      suffix++;
    }
    const payload: SavedFixture = { metadata, calls: body.calls };
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf-8");
    return filePath;
  }

  delete(filePath: string): void {
    if (!this.isInsideFixturesDir(filePath)) {
      throw new Error("refusing to delete file outside fixtures directory");
    }
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
}

function sanitizeName(name: string): string {
  return name
    .replace(/\.\./g, "_")
    .replace(/[\\/]/g, "-")
    .replace(/[^\w.\-]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 100);
}
