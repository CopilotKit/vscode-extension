import { describe, expect, it, vi } from "vitest";
import * as crypto from "node:crypto";
import type { RunAgentInput } from "@ag-ui/client";
import type { LanguageModelChat } from "vscode";
import { vscodeLmFactory, type RecordedCall } from "../vscode-lm-factory";

vi.mock("vscode", () => ({
  LanguageModelTextPart: class {
    constructor(public value: string) {}
  },
  LanguageModelToolCallPart: class {
    constructor(
      public callId: string,
      public name: string,
      public input: unknown,
    ) {}
  },
  LanguageModelToolResultPart: class {
    constructor(
      public callId: string,
      public content: unknown[],
    ) {}
  },
  CancellationTokenSource: class {
    token = { isCancellationRequested: false };
    cancel() {
      this.token.isCancellationRequested = true;
    }
    dispose() {}
  },
  LanguageModelChatMessage: {
    User: (text: string) => ({ role: "user", content: text }),
    Assistant: (text: string) => ({ role: "assistant", content: text }),
  },
}));

function makeModel(streamParts: unknown[]) {
  return {
    id: "test-model",
    family: "test",
    name: "Test",
    vendor: "test",
    sendRequest: vi.fn(async () => ({
      stream: (async function* () {
        for (const p of streamParts) yield p;
      })(),
      text: (async function* () {})(),
    })),
  } as unknown as LanguageModelChat;
}

const minimalInput: RunAgentInput = {
  threadId: "t1",
  runId: "r1",
  state: {},
  messages: [{ id: "m1", role: "user", content: "hello" }],
  tools: [],
  context: [],
  forwardedProps: {},
};

describe("vscodeLmFactory — live mode", () => {
  it("yields TEXT_MESSAGE_CONTENT chunks for each text part", async () => {
    const { LanguageModelTextPart } = await import("vscode");
    const model = makeModel([
      new LanguageModelTextPart("Hello"),
      new LanguageModelTextPart(" world"),
    ]);
    const factory = vscodeLmFactory({ model, mode: "live" });
    const chunks: unknown[] = [];
    const ac1 = new AbortController();
    for await (const c of factory({
      input: minimalInput,
      abortController: ac1,
      abortSignal: ac1.signal,
    })) {
      chunks.push(c);
    }
    expect(chunks).toEqual([
      { type: "TEXT_MESSAGE_CONTENT", delta: "Hello" },
      { type: "TEXT_MESSAGE_CONTENT", delta: " world" },
    ]);
  });

  it("yields TOOL_CALL_START + ARGS + END for a tool-call part", async () => {
    const { LanguageModelToolCallPart } = await import("vscode");
    const model = makeModel([
      new LanguageModelToolCallPart("call_1", "search", { q: "ag-ui" }),
    ]);
    const factory = vscodeLmFactory({ model, mode: "live" });
    const chunks: unknown[] = [];
    const ac2 = new AbortController();
    for await (const c of factory({
      input: minimalInput,
      abortController: ac2,
      abortSignal: ac2.signal,
    })) {
      chunks.push(c);
    }
    expect(chunks).toEqual([
      {
        type: "TOOL_CALL_START",
        toolCallId: "call_1",
        toolCallName: "search",
      },
      {
        type: "TOOL_CALL_ARGS",
        toolCallId: "call_1",
        delta: JSON.stringify({ q: "ag-ui" }),
      },
      { type: "TOOL_CALL_END", toolCallId: "call_1" },
    ]);
  });
});

describe("vscodeLmFactory — record mode", () => {
  it("yields chunks AND reports each call to onCallRecorded", async () => {
    const { LanguageModelTextPart } = await import("vscode");
    const model = makeModel([new LanguageModelTextPart("Hi")]);
    const recorded: unknown[] = [];
    const factory = vscodeLmFactory({
      model,
      mode: "record",
      onCallRecorded: (call) => recorded.push(call),
    });
    const chunks: unknown[] = [];
    const ac3 = new AbortController();
    for await (const c of factory({
      input: minimalInput,
      abortController: ac3,
      abortSignal: ac3.signal,
    })) {
      chunks.push(c);
    }
    expect(chunks).toEqual([{ type: "TEXT_MESSAGE_CONTENT", delta: "Hi" }]);
    expect(recorded).toHaveLength(1);
    const [call] = recorded as Array<{ matchKey: string; chunks: unknown[] }>;
    expect(call.matchKey).toMatch(/^[0-9a-f]{64}$/);
    expect(call.chunks).toEqual([
      { type: "TEXT_MESSAGE_CONTENT", delta: "Hi" },
    ]);
  });
});

describe("vscodeLmFactory — replay mode", () => {
  it("yields recorded chunks for a matching matchKey", async () => {
    const { LanguageModelTextPart } = await import("vscode");
    // Record first to compute the matchKey deterministically.
    const recordModel = makeModel([new LanguageModelTextPart("Hi")]);
    let recordedCall: RecordedCall | null = null;
    const recordFactory = vscodeLmFactory({
      model: recordModel,
      mode: "record",
      onCallRecorded: (call) => {
        recordedCall = call;
      },
    });
    const ac4 = new AbortController();
    for await (const _ of recordFactory({
      input: minimalInput,
      abortController: ac4,
      abortSignal: ac4.signal,
    })) {
      void _;
    }
    expect(recordedCall).not.toBeNull();

    // Now replay using a model that would throw if called.
    const replayModel = makeModel([]);
    (
      replayModel.sendRequest as unknown as ReturnType<typeof vi.fn>
    ).mockImplementation(async () => {
      throw new Error("replay must not call vscode.lm");
    });
    const factory = vscodeLmFactory({
      model: replayModel,
      mode: "replay",
      fixtureCalls: [recordedCall!],
    });
    const chunks: unknown[] = [];
    const ac5 = new AbortController();
    for await (const c of factory({
      input: minimalInput,
      abortController: ac5,
      abortSignal: ac5.signal,
    })) {
      chunks.push(c);
    }
    expect(chunks).toEqual([{ type: "TEXT_MESSAGE_CONTENT", delta: "Hi" }]);
  });

  it("throws when no fixture matches the input", async () => {
    const replayModel = makeModel([]);
    const factory = vscodeLmFactory({
      model: replayModel,
      mode: "replay",
      fixtureCalls: [],
    });
    const ac6 = new AbortController();
    const iter = factory({
      input: minimalInput,
      abortController: ac6,
      abortSignal: ac6.signal,
    })[Symbol.asyncIterator]();
    await expect(iter.next()).rejects.toThrow(/no fixture call matches/i);
  });

  it("consumes same-key calls in order across multiple iterations", async () => {
    const baseInput = minimalInput;
    // Build matchKey for input by inspecting what record produces.
    const recordModel = makeModel([{ kind: "text", value: "First" } as never]);
    // We can't easily reuse record output here; compute matchKey directly from
    // the same hash function used in implementation by hashing the canonical input.
    const matchKey = crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          messages: baseInput.messages,
          tools: baseInput.tools,
          modelId: "test-model",
        }),
      )
      .digest("hex");
    const inputSnapshot = {
      messages: baseInput.messages,
      tools: baseInput.tools,
      modelId: "test-model",
    };
    const calls: RecordedCall[] = [
      {
        matchKey,
        input: inputSnapshot,
        chunks: [{ type: "TEXT_MESSAGE_CONTENT", delta: "A" }],
      },
      {
        matchKey,
        input: inputSnapshot,
        chunks: [{ type: "TEXT_MESSAGE_CONTENT", delta: "B" }],
      },
    ];
    const factory = vscodeLmFactory({
      model: recordModel,
      mode: "replay",
      fixtureCalls: calls,
    });
    const collect = async () => {
      const out: unknown[] = [];
      const ac = new AbortController();
      for await (const c of factory({
        input: baseInput,
        abortController: ac,
        abortSignal: ac.signal,
      })) {
        out.push(c);
      }
      return out;
    };
    expect(await collect()).toEqual([
      { type: "TEXT_MESSAGE_CONTENT", delta: "A" },
    ]);
    expect(await collect()).toEqual([
      { type: "TEXT_MESSAGE_CONTENT", delta: "B" },
    ]);
    await expect(collect()).rejects.toThrow();
  });
});

describe("vscodeLmFactory — empty-stream recovery", () => {
  function makeMultiResponseModel(streams: unknown[][]): {
    model: LanguageModelChat;
    callCount: () => number;
  } {
    let idx = 0;
    const model = {
      id: "test-model",
      family: "test",
      name: "Test",
      vendor: "test",
      sendRequest: vi.fn(async () => {
        const parts = streams[idx] ?? [];
        idx++;
        return {
          stream: (async function* () {
            for (const p of parts) yield p;
          })(),
          text: (async function* () {})(),
        };
      }),
    } as unknown as LanguageModelChat;
    return { model, callCount: () => idx };
  }

  it("auto-retries without vscode.lm tools when the first stream is empty", async () => {
    const { LanguageModelTextPart } = await import("vscode");
    const { model, callCount } = makeMultiResponseModel([
      [], // first attempt: empty
      [new LanguageModelTextPart("retry worked")], // second attempt: text
    ]);
    const factory = vscodeLmFactory({
      model,
      mode: "live",
      vscodeLmTools: [
        {
          name: "ghc_tool_1",
          description: "x",
          inputSchema: { type: "object" },
        } as unknown as import("vscode").LanguageModelToolInformation,
      ],
    });
    const chunks: unknown[] = [];
    const ac = new AbortController();
    for await (const c of factory({
      input: minimalInput,
      abortController: ac,
      abortSignal: ac.signal,
    })) {
      chunks.push(c);
    }
    expect(callCount()).toBe(2);
    expect(chunks).toEqual([
      { type: "TEXT_MESSAGE_CONTENT", delta: "retry worked" },
    ]);
  });

  it("yields a single actionable message when both attempts return empty", async () => {
    const { model, callCount } = makeMultiResponseModel([[], []]);
    const factory = vscodeLmFactory({
      model,
      mode: "live",
      vscodeLmTools: Array.from({ length: 25 }, (_, i) => ({
        name: `vscode_tool_${i}`,
        description: "x",
        inputSchema: { type: "object" },
      })) as unknown as import("vscode").LanguageModelToolInformation[],
    });
    const chunks: Array<{ type: string; delta?: string }> = [];
    const ac = new AbortController();
    for await (const c of factory({
      input: minimalInput,
      abortController: ac,
      abortSignal: ac.signal,
    })) {
      chunks.push(c as { type: string; delta?: string });
    }
    expect(callCount()).toBe(2);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.type).toBe("TEXT_MESSAGE_CONTENT");
    // The high-tool-count branch of the message mentions the tool counts
    // so the user can act on it.
    expect(chunks[0]?.delta).toMatch(/25/);
  });

  it("does not retry when there were no vscode.lm tools to drop", async () => {
    const { model, callCount } = makeMultiResponseModel([[]]);
    const factory = vscodeLmFactory({
      model,
      mode: "live",
      // No vscodeLmTools — empty stream is not recoverable by retry.
    });
    const chunks: unknown[] = [];
    const ac = new AbortController();
    for await (const c of factory({
      input: minimalInput,
      abortController: ac,
      abortSignal: ac.signal,
    })) {
      chunks.push(c);
    }
    expect(callCount()).toBe(1);
    // Only the synthetic actionable message.
    expect(chunks).toHaveLength(1);
  });
});
