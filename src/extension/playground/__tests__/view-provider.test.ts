import { describe, expect, it, vi } from "vitest";

// vscode is not available in the vitest runtime — shim the surface used by
// PlaygroundViewProvider (Uri.joinPath for renderHtml, plus the warning-
// message API used by load-fixture's stale-file recovery path).
const vscodeMocks = vi.hoisted(() => ({
  showWarningMessage: vi.fn(),
}));
vi.mock("vscode", () => ({
  Uri: {
    joinPath: (_base: unknown, ...parts: string[]) => ({
      toString: () => parts.join("/"),
      fsPath: parts.join("/"),
    }),
  },
  window: {
    showWarningMessage: vscodeMocks.showWarningMessage,
  },
}));

import { PlaygroundViewProvider } from "../view-provider";
import type { PlaygroundDeps } from "../view-provider";
import type { PlaygroundScanResult } from "../types";

function makeDeps(overrides: Partial<PlaygroundDeps> = {}): PlaygroundDeps {
  return {
    writeSources: vi.fn(),
    bundle: vi.fn(),
    detectMode: vi.fn().mockReturnValue({ kind: "embed" }),
    pickModel: vi.fn().mockResolvedValue({
      id: "gpt-4o-mini",
      name: "GPT-4o Mini",
      family: "gpt-4o-mini",
      vendor: "openai",
    }),
    listModels: vi.fn().mockResolvedValue([]),
    startRuntimeHost: vi.fn().mockResolvedValue({
      url: "http://127.0.0.1:22222",
      stop: vi.fn().mockResolvedValue(undefined),
    }),
    fixtureStore: {
      list: vi.fn().mockReturnValue([]),
      read: vi.fn(),
      save: vi.fn().mockReturnValue("/fake/.copilotkit/fixtures/x.json"),
      delete: vi.fn(),
    },
    readPreferredModelId: vi.fn().mockReturnValue(""),
    writePreferredModelId: vi.fn().mockResolvedValue(undefined),
    readEnableVscodeLmTools: vi.fn().mockReturnValue(false),
    ...overrides,
  };
}

function makeWebview() {
  const listeners: Array<(msg: unknown) => void> = [];
  return {
    webview: {
      options: {},
      html: "",
      onDidReceiveMessage: (fn: (msg: unknown) => void) => {
        listeners.push(fn);
        return { dispose: () => {} };
      },
      postMessage: vi.fn(),
      asWebviewUri: (uri: unknown) => uri,
      cspSource: "vscode-webview://fake",
    },
    onDidDispose: (_fn: () => void) => ({ dispose: () => {} }),
    send: (msg: unknown) => listeners.forEach((l) => l(msg)),
  };
}

const emptyResult: PlaygroundScanResult = {
  providers: [],
  componentsWithHooks: [],
  hookSites: [],
  warnings: [],
};

describe("PlaygroundViewProvider", () => {
  it("replays the last scan result once the webview signals ready", () => {
    const onRefresh = vi.fn();
    const onOpenSource = vi.fn();
    const provider = new PlaygroundViewProvider(
      { fsPath: "/fake", scheme: "file" } as never,
      { onRefresh, onOpenSource },
      makeDeps(),
    );

    provider.setScanResult(emptyResult);

    const view = makeWebview();
    provider.resolveWebviewView(view as never, {} as never, {} as never);

    expect(view.webview.postMessage).not.toHaveBeenCalled();

    view.send({ type: "ready" });
    expect(view.webview.postMessage).toHaveBeenCalledWith({
      type: "scan-result",
      result: emptyResult,
    });
  });

  it("forwards refresh and open-source messages to callbacks", () => {
    const onRefresh = vi.fn();
    const onOpenSource = vi.fn();
    const provider = new PlaygroundViewProvider(
      { fsPath: "/fake", scheme: "file" } as never,
      { onRefresh, onOpenSource },
      makeDeps(),
    );

    const view = makeWebview();
    provider.resolveWebviewView(view as never, {} as never, {} as never);

    view.send({ type: "refresh" });
    expect(onRefresh).toHaveBeenCalledTimes(1);

    view.send({ type: "open-source", filePath: "/a.tsx", line: 7 });
    expect(onOpenSource).toHaveBeenCalledWith("/a.tsx", 7);
  });
});

describe("PlaygroundViewProvider — bundling", () => {
  it("posts bundle-ready after setScanResult when a provider is present", async () => {
    const bundleFn = vi.fn().mockResolvedValue({
      code: "var __copilotkit_playground = {};",
      success: true,
    });
    const codegenFn = vi.fn().mockReturnValue({
      outDir: "/tmp/ignored",
      entryPath: "/tmp/ignored/entry.tsx",
    });

    const onRefresh = vi.fn();
    const onOpenSource = vi.fn();
    const deps = makeDeps({
      bundle: bundleFn,
      writeSources: codegenFn,
    });
    const provider = new PlaygroundViewProvider(
      { fsPath: "/fake", scheme: "file" } as never,
      { onRefresh, onOpenSource },
      deps,
    );

    const result: PlaygroundScanResult = {
      providers: [
        {
          filePath: "/x/App.tsx",
          loc: { line: 1, column: 0, endLine: 1, endColumn: 1 },
          importedName: "CopilotKitProvider",
          importSource: "@copilotkit/react-core/v2",
          props: {},
        },
      ],
      componentsWithHooks: [],
      hookSites: [],
      warnings: [],
    };

    const view = makeWebview();
    provider.resolveWebviewView(view as never, {} as never, {} as never);
    view.send({ type: "ready" });

    provider.setScanResult(result);
    await new Promise((r) => setTimeout(r, 30));

    expect(codegenFn).toHaveBeenCalledWith(result, {
      runtimeUrlOverride: "http://127.0.0.1:22222/api/copilotkit",
    });
    expect(bundleFn).toHaveBeenCalledWith("/tmp/ignored/entry.tsx");
    expect(view.webview.postMessage).toHaveBeenCalledWith({
      type: "bundle-ready",
      payload: { code: "var __copilotkit_playground = {};", css: undefined },
    });
  });

  it("posts bundle-error when bundling fails", async () => {
    const bundleFn = vi
      .fn()
      .mockResolvedValue({ success: false, error: "rolldown exploded" });
    const codegenFn = vi.fn().mockReturnValue({
      outDir: "/tmp/ignored",
      entryPath: "/tmp/ignored/entry.tsx",
    });

    const provider = new PlaygroundViewProvider(
      { fsPath: "/fake", scheme: "file" } as never,
      { onRefresh: vi.fn(), onOpenSource: vi.fn() },
      makeDeps({ bundle: bundleFn, writeSources: codegenFn }),
    );

    const view = makeWebview();
    provider.resolveWebviewView(view as never, {} as never, {} as never);
    view.send({ type: "ready" });

    provider.setScanResult({
      providers: [
        {
          filePath: "/x/App.tsx",
          loc: { line: 1, column: 0, endLine: 1, endColumn: 1 },
          importedName: "CopilotKitProvider",
          importSource: "@copilotkit/react-core/v2",
          props: {},
        },
      ],
      componentsWithHooks: [],
      hookSites: [],
      warnings: [],
    });
    await new Promise((r) => setTimeout(r, 30));

    expect(view.webview.postMessage).toHaveBeenCalledWith({
      type: "bundle-error",
      message: "rolldown exploded",
    });
  });

  it("replays the last bundle when the webview signals ready", async () => {
    const bundleFn = vi.fn().mockResolvedValue({
      code: "var __copilotkit_playground = {};",
      success: true,
    });
    const codegenFn = vi.fn().mockReturnValue({
      outDir: "/tmp/ignored",
      entryPath: "/tmp/ignored/entry.tsx",
    });

    const provider = new PlaygroundViewProvider(
      { fsPath: "/fake", scheme: "file" } as never,
      { onRefresh: vi.fn(), onOpenSource: vi.fn() },
      makeDeps({ bundle: bundleFn, writeSources: codegenFn }),
    );

    // Scan arrives BEFORE the webview resolves.
    provider.setScanResult({
      providers: [
        {
          filePath: "/x/App.tsx",
          loc: { line: 1, column: 0, endLine: 1, endColumn: 1 },
          importedName: "CopilotKitProvider",
          importSource: "@copilotkit/react-core/v2",
          props: {},
        },
      ],
      componentsWithHooks: [],
      hookSites: [],
      warnings: [],
    });
    await new Promise((r) => setTimeout(r, 30));

    // Now the webview resolves and signals ready.
    const view = makeWebview();
    provider.resolveWebviewView(view as never, {} as never, {} as never);
    view.send({ type: "ready" });

    // Both scan-result and bundle-ready must have been posted.
    expect(view.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "scan-result" }),
    );
    expect(view.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "bundle-ready" }),
    );
  });
});

describe("PlaygroundViewProvider — missing-fixture recovery", () => {
  it("load-fixture with a missing file does not set replayFixturePath and refreshes the sidebar", async () => {
    const readFn = vi.fn().mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });
    const listFn = vi.fn().mockReturnValue([]);
    const startRuntimeHost = vi.fn().mockResolvedValue({
      url: "http://127.0.0.1:22222",
      stop: vi.fn().mockResolvedValue(undefined),
      vscodeLmTools: { enabled: false, count: 0 },
    });
    const bundleFn = vi
      .fn()
      .mockResolvedValue({ success: true, code: "var __copilotkit_playground = {};" });
    const codegenFn = vi.fn().mockReturnValue({
      outDir: "/tmp/x",
      entryPath: "/tmp/x/entry.tsx",
    });

    vscodeMocks.showWarningMessage.mockClear();

    const provider = new PlaygroundViewProvider(
      { fsPath: "/fake", scheme: "file" } as never,
      { onRefresh: vi.fn(), onOpenSource: vi.fn() },
      makeDeps({
        startRuntimeHost,
        bundle: bundleFn,
        writeSources: codegenFn,
        fixtureStore: {
          list: listFn,
          read: readFn,
          save: vi.fn(),
          delete: vi.fn(),
        },
      }),
    );
    const view = makeWebview();
    provider.resolveWebviewView(view as never, {} as never, {} as never);
    view.send({ type: "ready" });

    view.webview.postMessage.mockClear();
    listFn.mockClear();

    view.send({ type: "load-fixture", filePath: "/ghost/x.json" });
    await new Promise((r) => setTimeout(r, 30));

    // Fresh fixtures-list must be posted so the stale UI entry vanishes.
    expect(view.webview.postMessage).toHaveBeenCalledWith({
      type: "fixtures-list",
      fixtures: [],
    });
    // User gets a one-shot warning.
    expect(vscodeMocks.showWarningMessage).toHaveBeenCalledTimes(1);

    // CRITICAL: a subsequent rebundle must NOT try to read the ghost
    // fixture (replayFixturePath should not have been committed) and
    // must start the runtime in record mode rather than dying with
    // ENOENT.
    readFn.mockClear();
    startRuntimeHost.mockClear();
    provider.setScanResult({
      providers: [
        {
          filePath: "/x/App.tsx",
          loc: { line: 1, column: 0, endLine: 1, endColumn: 1 },
          importedName: "CopilotKitProvider",
          importSource: "@copilotkit/react-core/v2",
          props: {},
        },
      ],
      componentsWithHooks: [],
      hookSites: [],
      warnings: [],
    });
    await new Promise((r) => setTimeout(r, 30));

    expect(readFn).not.toHaveBeenCalled();
    expect(startRuntimeHost).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "record" }),
    );
  });

  it("runBundle recovers when the active fixture vanishes mid-session", async () => {
    // First read (during load-fixture) succeeds; second read (during the
    // forced rebundle) throws to simulate the file being deleted between
    // load-fixture and the next runBundle pass.
    let allowRead = true;
    const readFn = vi.fn().mockImplementation(() => {
      if (allowRead) {
        return {
          metadata: {
            name: "X",
            createdAt: "2026-01-01T00:00:00.000Z",
            modelId: "m",
            modelVendor: "v",
            version: 2 as const,
          },
          calls: [],
        };
      }
      throw new Error("ENOENT");
    });
    const listFn = vi.fn().mockReturnValue([]);
    const startRuntimeHost = vi.fn().mockResolvedValue({
      url: "http://127.0.0.1:22222",
      stop: vi.fn().mockResolvedValue(undefined),
      vscodeLmTools: { enabled: false, count: 0 },
    });
    const bundleFn = vi
      .fn()
      .mockResolvedValue({ success: true, code: "var __copilotkit_playground = {};" });
    const codegenFn = vi.fn().mockReturnValue({
      outDir: "/tmp/x",
      entryPath: "/tmp/x/entry.tsx",
    });

    const provider = new PlaygroundViewProvider(
      { fsPath: "/fake", scheme: "file" } as never,
      { onRefresh: vi.fn(), onOpenSource: vi.fn() },
      makeDeps({
        startRuntimeHost,
        bundle: bundleFn,
        writeSources: codegenFn,
        fixtureStore: {
          list: listFn,
          read: readFn,
          save: vi.fn(),
          delete: vi.fn(),
        },
      }),
    );
    const view = makeWebview();
    provider.resolveWebviewView(view as never, {} as never, {} as never);
    view.send({ type: "ready" });

    view.send({ type: "load-fixture", filePath: "/some/x.json" });
    await new Promise((r) => setTimeout(r, 30));

    // Simulate the file being deleted out from under us. The next
    // rebundle must NOT propagate ENOENT — it must clear the stale
    // path, refresh fixtures-list, and start the runtime in record
    // mode so the chat surface unsticks.
    allowRead = false;
    startRuntimeHost.mockClear();
    view.webview.postMessage.mockClear();

    provider.setScanResult({
      providers: [
        {
          filePath: "/x/App.tsx",
          loc: { line: 1, column: 0, endLine: 1, endColumn: 1 },
          importedName: "CopilotKitProvider",
          importSource: "@copilotkit/react-core/v2",
          props: {},
        },
      ],
      componentsWithHooks: [],
      hookSites: [],
      warnings: [],
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(startRuntimeHost).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "record" }),
    );
    // A bundle-ready must eventually fire — the chat must unstick.
    expect(view.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "bundle-ready" }),
    );
    // And the sidebar gets a fresh list (entry gone).
    expect(view.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "fixtures-list" }),
    );
  });
});

describe("PlaygroundViewProvider — refreshFixturesList", () => {
  it("posts a fresh fixtures-list to the webview", () => {
    const listFn = vi
      .fn()
      .mockReturnValueOnce([])
      .mockReturnValueOnce([
        {
          filePath: "/fake/.copilotkit/fixtures/a.json",
          metadata: {
            name: "A",
            createdAt: "2026-01-01T00:00:00.000Z",
            modelId: "m",
            modelVendor: "v",
            version: 2 as const,
          },
        },
      ]);
    const provider = new PlaygroundViewProvider(
      { fsPath: "/fake", scheme: "file" } as never,
      { onRefresh: vi.fn(), onOpenSource: vi.fn() },
      makeDeps({
        fixtureStore: {
          list: listFn,
          read: vi.fn(),
          save: vi.fn(),
          delete: vi.fn(),
        },
      }),
    );
    const view = makeWebview();
    provider.resolveWebviewView(view as never, {} as never, {} as never);
    view.send({ type: "ready" });

    view.webview.postMessage.mockClear();
    provider.refreshFixturesList();

    expect(view.webview.postMessage).toHaveBeenCalledWith({
      type: "fixtures-list",
      fixtures: expect.arrayContaining([
        expect.objectContaining({ metadata: expect.objectContaining({ name: "A" }) }),
      ]),
    });
  });

  it("clears the active replay path if its backing file is gone", async () => {
    // Pick a path that definitely does not exist on disk so the
    // fs.existsSync check inside refreshFixturesList returns false.
    const phantomPath = "/this/path/does/not/exist/x.json";
    const readFn = vi.fn().mockReturnValue({
      metadata: {
        name: "X",
        createdAt: "2026-01-01T00:00:00.000Z",
        modelId: "m",
        modelVendor: "v",
        version: 2 as const,
      },
      calls: [],
    });
    const startRuntimeHost = vi.fn().mockResolvedValue({
      url: "http://127.0.0.1:22222",
      stop: vi.fn().mockResolvedValue(undefined),
      vscodeLmTools: { enabled: false, count: 0 },
    });
    const bundleFn = vi.fn().mockResolvedValue({
      code: "var __copilotkit_playground = {};",
      success: true,
    });
    const codegenFn = vi.fn().mockReturnValue({
      outDir: "/tmp/ignored",
      entryPath: "/tmp/ignored/entry.tsx",
    });

    const provider = new PlaygroundViewProvider(
      { fsPath: "/fake", scheme: "file" } as never,
      { onRefresh: vi.fn(), onOpenSource: vi.fn() },
      makeDeps({
        startRuntimeHost,
        bundle: bundleFn,
        writeSources: codegenFn,
        fixtureStore: {
          list: vi.fn().mockReturnValue([]),
          read: readFn,
          save: vi.fn(),
          delete: vi.fn(),
        },
      }),
    );
    const view = makeWebview();
    provider.resolveWebviewView(view as never, {} as never, {} as never);
    view.send({ type: "ready" });

    // Pretend the user clicked ▶ on a fixture that no longer exists.
    view.send({ type: "load-fixture", filePath: phantomPath });
    await new Promise((r) => setTimeout(r, 30));

    // Drop our stale view of the active fixture.
    provider.refreshFixturesList();

    // The next rebundle must NOT try to read the missing fixture and
    // must start the runtime in "record" mode (the fallback).
    startRuntimeHost.mockClear();
    readFn.mockClear();
    provider.setScanResult({
      providers: [
        {
          filePath: "/x/App.tsx",
          loc: { line: 1, column: 0, endLine: 1, endColumn: 1 },
          importedName: "CopilotKitProvider",
          importSource: "@copilotkit/react-core/v2",
          props: {},
        },
      ],
      componentsWithHooks: [],
      hookSites: [],
      warnings: [],
    });
    await new Promise((r) => setTimeout(r, 30));

    expect(readFn).not.toHaveBeenCalled();
    expect(startRuntimeHost).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "record" }),
    );
  });
});

describe("PlaygroundViewProvider — HTML bootstrap", () => {
  it("injects a nonce bootstrap script so bundle-loader can discover it", () => {
    const provider = new PlaygroundViewProvider(
      { fsPath: "/fake", scheme: "file" } as never,
      { onRefresh: vi.fn(), onOpenSource: vi.fn() },
      makeDeps(),
    );
    const view = makeWebview();
    provider.resolveWebviewView(view as never, {} as never, {} as never);
    // The test webview mock receives the HTML via `webview.html = ...`
    const html = view.webview.html;
    // The HTML must include a bootstrap script that writes the nonce.
    expect(html).toMatch(/window\.__copilotkit_nonce\s*=/);
    // It must include the bundle script with a nonce attribute.
    expect(html).toMatch(/nonce="[^"]+"[^>]*src="/);
  });
});

describe("PlaygroundViewProvider — orchestration", () => {
  it("posts mode-unsupported for absolute runtimeUrl", async () => {
    const provider = new PlaygroundViewProvider(
      { fsPath: "/fake", scheme: "file" } as never,
      { onRefresh: vi.fn(), onOpenSource: vi.fn() },
      makeDeps({
        detectMode: vi.fn().mockReturnValue({
          kind: "proxy-unsupported",
          url: "https://api.example.com",
        }),
      }),
    );
    const view = makeWebview();
    provider.resolveWebviewView(view as never, {} as never, {} as never);
    view.send({ type: "ready" });
    provider.setScanResult({
      providers: [
        {
          filePath: "/x/App.tsx",
          loc: { line: 1, column: 0, endLine: 1, endColumn: 1 },
          importedName: "CopilotKitProvider",
          importSource: "@copilotkit/react-core/v2",
          props: { runtimeUrl: "https://api.example.com" },
        },
      ],
      componentsWithHooks: [],
      hookSites: [],
      warnings: [],
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(view.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "mode-unsupported", kind: "proxy" }),
    );
  });

  it("posts no-model-available when no model is returned", async () => {
    const provider = new PlaygroundViewProvider(
      { fsPath: "/fake", scheme: "file" } as never,
      { onRefresh: vi.fn(), onOpenSource: vi.fn() },
      makeDeps({
        pickModel: vi.fn().mockResolvedValue(null),
      }),
    );
    const view = makeWebview();
    provider.resolveWebviewView(view as never, {} as never, {} as never);
    view.send({ type: "ready" });
    provider.setScanResult({
      providers: [
        {
          filePath: "/x/App.tsx",
          loc: { line: 1, column: 0, endLine: 1, endColumn: 1 },
          importedName: "CopilotKitProvider",
          importSource: "@copilotkit/react-core/v2",
          props: {},
        },
      ],
      componentsWithHooks: [],
      hookSites: [],
      warnings: [],
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(view.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "no-model-available" }),
    );
  });

  it("starts runtime host and passes runtime URL to codegen", async () => {
    const writeSourcesFn = vi.fn().mockReturnValue({
      outDir: "/tmp/ignored",
      entryPath: "/tmp/ignored/entry.tsx",
    });
    const bundleFn = vi.fn().mockResolvedValue({
      code: "var __copilotkit_playground = {};",
      success: true,
    });
    const provider = new PlaygroundViewProvider(
      { fsPath: "/fake", scheme: "file" } as never,
      { onRefresh: vi.fn(), onOpenSource: vi.fn() },
      makeDeps({ writeSources: writeSourcesFn, bundle: bundleFn }),
    );
    const view = makeWebview();
    provider.resolveWebviewView(view as never, {} as never, {} as never);
    view.send({ type: "ready" });
    provider.setScanResult({
      providers: [
        {
          filePath: "/x/App.tsx",
          loc: { line: 1, column: 0, endLine: 1, endColumn: 1 },
          importedName: "CopilotKitProvider",
          importSource: "@copilotkit/react-core/v2",
          props: {},
        },
      ],
      componentsWithHooks: [],
      hookSites: [],
      warnings: [],
    });
    // Allow multiple microtask turns for the chained awaits in runBundle.
    await new Promise((r) => setTimeout(r, 30));
    expect(writeSourcesFn).toHaveBeenCalledWith(expect.anything(), {
      runtimeUrlOverride: "http://127.0.0.1:22222/api/copilotkit",
    });
    expect(view.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "bundle-ready" }),
    );
  });

  it("stops the previous session when setScanResult is called again", async () => {
    const stop1 = vi.fn().mockResolvedValue(undefined);
    const stop2 = vi.fn().mockResolvedValue(undefined);
    const runtime1 = { url: "http://127.0.0.1:33333", stop: stop1 };
    const runtime2 = { url: "http://127.0.0.1:44444", stop: stop2 };
    const deps = makeDeps({
      writeSources: vi.fn().mockReturnValue({
        outDir: "/tmp/ignored",
        entryPath: "/tmp/ignored/entry.tsx",
      }),
      bundle: vi.fn().mockResolvedValue({ success: true, code: "var x;" }),
      startRuntimeHost: vi
        .fn()
        .mockResolvedValueOnce(runtime1)
        .mockResolvedValueOnce(runtime2),
    });
    const provider = new PlaygroundViewProvider(
      { fsPath: "/fake", scheme: "file" } as never,
      { onRefresh: vi.fn(), onOpenSource: vi.fn() },
      deps,
    );
    const view = makeWebview();
    provider.resolveWebviewView(view as never, {} as never, {} as never);
    view.send({ type: "ready" });

    const scan: PlaygroundScanResult = {
      providers: [
        {
          filePath: "/x/App.tsx",
          loc: { line: 1, column: 0, endLine: 1, endColumn: 1 },
          importedName: "CopilotKitProvider",
          importSource: "@copilotkit/react-core/v2",
          props: {},
        },
      ],
      componentsWithHooks: [],
      hookSites: [],
      warnings: [],
    };
    provider.setScanResult(scan);
    await new Promise((r) => setTimeout(r, 30));
    provider.setScanResult(scan);
    await new Promise((r) => setTimeout(r, 60));

    expect(stop1).toHaveBeenCalled();
  });

  it("saves a fixture when save-fixture is received", async () => {
    const saveFn = vi.fn().mockReturnValue("/fake/.copilotkit/fixtures/x.json");
    const listFn = vi.fn().mockReturnValue([
      {
        filePath: "/fake/.copilotkit/fixtures/x.json",
        metadata: {
          name: "x",
          createdAt: "2026-04-23T12:00:00Z",
          modelId: "gpt-4o-mini",
          modelVendor: "openai",
          version: 2 as const,
        },
      },
    ]);
    const fakeModel = {
      id: "gpt-4o-mini",
      name: "GPT-4o Mini",
      family: "gpt-4o-mini",
      vendor: "openai",
    };
    const deps = makeDeps({
      writeSources: vi.fn().mockReturnValue({
        outDir: "/tmp",
        entryPath: "/tmp/x.tsx",
      }),
      bundle: vi.fn().mockResolvedValue({ success: true, code: "var x;" }),
      pickModel: vi.fn().mockResolvedValue(fakeModel),
      startRuntimeHost: vi.fn().mockResolvedValue({
        url: "http://127.0.0.1:22222",
        stop: vi.fn().mockResolvedValue(undefined),
      }),
      fixtureStore: {
        list: listFn,
        read: vi.fn(),
        save: saveFn,
        delete: vi.fn(),
      },
    });
    const provider = new PlaygroundViewProvider(
      { fsPath: "/fake", scheme: "file" } as never,
      { onRefresh: vi.fn(), onOpenSource: vi.fn() },
      deps,
    );
    const view = makeWebview();
    provider.resolveWebviewView(view as never, {} as never, {} as never);
    view.send({ type: "ready" });
    provider.setScanResult({
      providers: [
        {
          filePath: "/x/App.tsx",
          loc: { line: 1, column: 0, endLine: 1, endColumn: 1 },
          importedName: "CopilotKitProvider",
          importSource: "@copilotkit/react-core/v2",
          props: {},
        },
      ],
      componentsWithHooks: [],
      hookSites: [],
      warnings: [],
    });
    await new Promise((r) => setTimeout(r, 60));
    view.send({ type: "save-fixture", name: "my-session" });
    await new Promise((r) => setTimeout(r, 30));
    expect(saveFn).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "my-session",
        modelId: "gpt-4o-mini",
        modelVendor: "openai",
        version: 2,
      }),
      { calls: [] },
    );
    expect(view.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "fixtures-list" }),
    );
  });
});
