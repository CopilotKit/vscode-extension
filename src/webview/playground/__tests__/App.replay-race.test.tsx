/** @vitest-environment jsdom */
import * as React from "react";
import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// `vi.mock` is hoisted above imports, so we route the controllable
// state through `vi.hoisted` instead of a regular top-level closure.
const mocks = vi.hoisted(() => {
  let deferredResolve: ((exports: unknown) => void) | null = null;
  let deferredReject: ((err: unknown) => void) | null = null;
  const executePlaygroundBundle = (): Promise<unknown> =>
    new Promise((resolve, reject) => {
      deferredResolve = resolve as (exports: unknown) => void;
      deferredReject = reject;
    });
  return {
    executePlaygroundBundle,
    resolve: (exports: unknown) => deferredResolve?.(exports),
    reject: (err: unknown) => deferredReject?.(err),
  };
});

vi.mock("../bundle-loader", () => ({
  executePlaygroundBundle: mocks.executePlaygroundBundle,
}));

vi.mock("../bridge", () => ({
  // Stub out the real vscode.postMessage path — sendToExtension is a
  // fire-and-forget from the App's perspective for this race test.
  sendToExtension: () => {},
  // Hand back a real `window message` listener so we can drive the App
  // via window.postMessage(...).
  onExtensionMessage: (handler: (msg: unknown) => void) => {
    const listener = (e: MessageEvent): void => handler(e.data);
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  },
}));

import { App } from "../App";

describe("App play-fixture race", () => {
  it("defers the replay CustomEvent until the new bundle is mounted", async () => {
    const replayEvents: Array<{ messages: unknown[] }> = [];
    const listener = (ev: Event): void => {
      const detail = (ev as CustomEvent<{ messages: unknown[] }>).detail;
      replayEvents.push(detail);
    };
    window.addEventListener("copilotkit-playground-replay", listener);

    render(<App />);

    // Give the App's initial useEffect a chance to attach the message
    // listener before we post.
    await act(async () => {
      await Promise.resolve();
    });

    // Step 1: extension delivers a new bundle, then immediately the
    // play-fixture payload. This mirrors view-provider.ts ordering.
    await act(async () => {
      window.postMessage(
        { type: "bundle-ready", payload: { code: "" } },
        "*",
      );
      window.postMessage(
        {
          type: "play-fixture",
          messages: [{ id: "1", role: "user", content: "hi" }],
        },
        "*",
      );
      // Flush the postMessage queue.
      await new Promise((r) => setTimeout(r, 0));
    });

    // executePlaygroundBundle was called but the promise hasn't resolved
    // yet — the new ChatPlayground (and its replay listener) isn't
    // mounted. The App MUST NOT have dispatched the replay event yet.
    expect(replayEvents).toHaveLength(0);

    // Step 2: resolve the deferred bundle. The new ChatPlayground stub
    // registers a listener in its mount effect — the App's effect runs
    // AFTER child effects on the same commit, so the listener is
    // guaranteed to be attached before the App dispatches the queued
    // replay.
    let chatSawReplay = 0;
    function ChatPlayground(): React.JSX.Element | null {
      React.useEffect(() => {
        const onReplay = (): void => {
          chatSawReplay += 1;
        };
        window.addEventListener("copilotkit-playground-replay", onReplay);
        return () =>
          window.removeEventListener(
            "copilotkit-playground-replay",
            onReplay,
          );
      }, []);
      return null;
    }
    function PlaygroundEntry(): React.JSX.Element | null {
      return null;
    }

    await act(async () => {
      mocks.resolve({ PlaygroundEntry, ChatPlayground });
      // Let the bundle-promise microtask + React effects flush.
      await new Promise((r) => setTimeout(r, 0));
    });

    // Once the new bundle mounts, the queued replay should have fired
    // exactly once — and the new chat must have caught it.
    expect(replayEvents).toHaveLength(1);
    expect(chatSawReplay).toBe(1);

    window.removeEventListener("copilotkit-playground-replay", listener);
  });
});
