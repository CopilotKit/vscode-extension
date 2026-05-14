import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({}));

import { FixturesDirWatcher } from "../fixtures-dir-watcher";

describe("FixturesDirWatcher", () => {
  let tmpRoot: string;
  let watcher: FixturesDirWatcher | null = null;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fixtures-watcher-"));
  });

  afterEach(() => {
    watcher?.dispose();
    watcher = null;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("fires onChange when a file inside the watched dir is deleted", async () => {
    const fixturesDir = path.join(tmpRoot, ".copilotkit", "fixtures");
    fs.mkdirSync(fixturesDir, { recursive: true });
    const filePath = path.join(fixturesDir, "x.json");
    fs.writeFileSync(filePath, "{}");

    const onChange = vi.fn();
    watcher = new FixturesDirWatcher(fixturesDir, onChange);

    fs.unlinkSync(filePath);

    await waitFor(() => onChange.mock.calls.length > 0);
    expect(onChange).toHaveBeenCalled();
  });

  it("fires onChange when a file is created in the watched dir", async () => {
    const fixturesDir = path.join(tmpRoot, ".copilotkit", "fixtures");
    fs.mkdirSync(fixturesDir, { recursive: true });

    const onChange = vi.fn();
    watcher = new FixturesDirWatcher(fixturesDir, onChange);

    fs.writeFileSync(path.join(fixturesDir, "new.json"), "{}");

    await waitFor(() => onChange.mock.calls.length > 0);
    expect(onChange).toHaveBeenCalled();
  });

  it("is a no-op when the directory does not exist yet", () => {
    const fixturesDir = path.join(tmpRoot, "absent", "fixtures");
    const log = vi.fn();
    const onChange = vi.fn();
    watcher = new FixturesDirWatcher(fixturesDir, onChange, log);

    // Nothing thrown, no attachment log line.
    expect(log).not.toHaveBeenCalledWith(
      expect.stringMatching(/attached/),
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("dispose stops further events", async () => {
    const fixturesDir = path.join(tmpRoot, ".copilotkit", "fixtures");
    fs.mkdirSync(fixturesDir, { recursive: true });

    const onChange = vi.fn();
    watcher = new FixturesDirWatcher(fixturesDir, onChange);
    watcher.dispose();
    watcher = null;

    fs.writeFileSync(path.join(fixturesDir, "after-dispose.json"), "{}");
    // Give the OS a moment to deliver any stray events.
    await new Promise((r) => setTimeout(r, 100));
    expect(onChange).not.toHaveBeenCalled();
  });
});

async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 2000, intervalMs = 20 } = {},
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timeout");
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
