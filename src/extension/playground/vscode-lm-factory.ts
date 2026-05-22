import * as crypto from "node:crypto";
import * as vscode from "vscode";
import type { RunAgentInput } from "@ag-ui/client";

/**
 * BuiltInAgent (TanStack factory mode) consumes async iterables of these chunks.
 * Mirrors the chunk vocabulary `convertTanStackStream` understands in
 * `packages/runtime/src/agent/converters/tanstack.ts`.
 */
export type TanStackChunk =
  | { type: "TEXT_MESSAGE_CONTENT"; delta: string }
  | { type: "TEXT_MESSAGE_CHUNK"; delta: string }
  | { type: "TOOL_CALL_START"; toolCallId: string; toolCallName: string }
  | { type: "TOOL_CALL_ARGS"; toolCallId: string; delta: string }
  | { type: "TOOL_CALL_END"; toolCallId: string }
  | { type: "TOOL_CALL_RESULT"; toolCallId: string; content: string };

export interface AgentFactoryContext {
  input: RunAgentInput;
  abortController: AbortController;
  abortSignal: AbortSignal;
}

export interface RecordedCall {
  matchKey: string;
  /** Raw input snapshot — for human inspection of the fixture. Not used for matching. */
  input: { messages: unknown; tools: unknown; modelId: string };
  chunks: TanStackChunk[];
}

type CommonOpts = {
  /** Optional sink for diagnostic events (sends, errors, replay misses). */
  log?: (line: string) => void;
  /**
   * VS Code Language-Model tools (from `vscode.lm.tools`) to expose to the
   * model alongside the user's registered tools. When the model emits a
   * tool call for one of these names, the factory invokes it via
   * `vscode.lm.invokeTool` server-side and emits a `TOOL_CALL_RESULT`
   * chunk so the chat history stays consistent without the consumer
   * needing to know about VS Code's tool surface.
   *
   * Empty/undefined means "expose only the user's tools" (the default).
   */
  vscodeLmTools?: vscode.LanguageModelToolInformation[];
};

export type VscodeLmFactoryOptions =
  | (CommonOpts & {
      model: vscode.LanguageModelChat;
      mode: "live";
    })
  | (CommonOpts & {
      model: vscode.LanguageModelChat;
      mode: "record";
      onCallRecorded: (call: RecordedCall) => void;
    })
  | (CommonOpts & {
      model: vscode.LanguageModelChat;
      mode: "replay";
      /** The full set of recorded calls from the loaded fixture. */
      fixtureCalls: RecordedCall[];
    });

export function vscodeLmFactory(
  opts: VscodeLmFactoryOptions,
): (ctx: AgentFactoryContext) => AsyncIterable<TanStackChunk> {
  const log = opts.log ?? (() => {});
  // Replay state: how many times each matchKey has been consumed in this session.
  const replayCursor = new Map<string, number>();
  const fixtureCalls = opts.mode === "replay" ? opts.fixtureCalls : [];

  return async function* (ctx) {
    const matchKey = computeMatchKey(ctx.input, opts.model.id);
    log(
      `[vscode-lm-factory] run mode=${opts.mode} matchKey=${matchKey.slice(0, 12)}… messages=${ctx.input.messages.length} tools=${ctx.input.tools?.length ?? 0}`,
    );

    if (opts.mode === "replay") {
      const consumed = replayCursor.get(matchKey) ?? 0;
      let seen = 0;
      for (const call of fixtureCalls) {
        if (call.matchKey !== matchKey) continue;
        if (seen === consumed) {
          replayCursor.set(matchKey, consumed + 1);
          for (const c of call.chunks) yield c;
          return;
        }
        seen++;
      }
      throw new Error(
        `vscode-lm-factory: no fixture call matches matchKey=${matchKey} (consumed=${consumed})`,
      );
    }

    // Live + record both call vscode.lm.
    const messages = toLmMessages(ctx.input);
    const tokenSource = new vscode.CancellationTokenSource();
    ctx.abortSignal.addEventListener("abort", () => tokenSource.cancel(), {
      once: true,
    });

    const recordedChunks: TanStackChunk[] = [];

    const userTools = toLmTools(ctx.input.tools);
    const vscodeLmTools = (opts.vscodeLmTools ?? []).map(
      (t): vscode.LanguageModelChatTool => ({
        name: t.name,
        description: t.description,
        inputSchema: normalizeInputSchema(t.inputSchema),
      }),
    );
    const vscodeLmToolNames = new Set(vscodeLmTools.map((t) => t.name));
    const tools = [...userTools, ...vscodeLmTools];

    // Single-attempt streaming helper. Used twice: first with the full
    // tool set (user + vscode.lm); if that returns 0 chunks AND vscode.lm
    // tools were forwarded, again with user tools only. Models that
    // silently reject requests with too many tools (e.g. Claude via
    // Copilot Chat with 80+ tools) recover gracefully without the user
    // having to flip a setting.
    const attempt = async function* (
      toolsForRequest: vscode.LanguageModelChatTool[],
      label: string,
    ): AsyncGenerator<TanStackChunk, number> {
      log(
        `[vscode-lm-factory] sendRequest ${label} model=${opts.model.id} userTools=${userTools.length} vscodeLmTools=${
          toolsForRequest.length - userTools.length
        }`,
      );
      const response = await opts.model.sendRequest(
        messages,
        toolsForRequest.length > 0 ? { tools: toolsForRequest } : {},
        tokenSource.token,
      );
      let chunkCount = 0;
      let unknownPartCount = 0;
      for await (const part of response.stream) {
        if (ctx.abortSignal.aborted) break;
        let translated = false;
        for (const chunk of translatePart(part)) {
          translated = true;
          chunkCount++;
          if (opts.mode === "record") recordedChunks.push(chunk);
          yield chunk;
        }
        if (
          !translated &&
          !(part instanceof vscode.LanguageModelToolCallPart)
        ) {
          // Part type we don't recognize (e.g. a thinking/reasoning part
          // some vscode.lm providers stream, or a DataPart with a binary
          // mime). Log it so we can extend translatePart instead of
          // silently producing an empty chat.
          unknownPartCount++;
          const ctor = (part as { constructor?: { name?: string } })
            ?.constructor?.name;
          const isDataPart =
            typeof vscode.LanguageModelDataPart === "function" &&
            part instanceof vscode.LanguageModelDataPart;
          const mime = isDataPart
            ? (part as vscode.LanguageModelDataPart).mimeType
            : undefined;
          log(
            `[vscode-lm-factory] dropping unknown stream part: ctor=${ctor ?? typeof part}${
              mime ? ` mime=${mime}` : ""
            }`,
          );
        }
        // For vscode.lm tool calls, also invoke server-side and emit a
        // TOOL_CALL_RESULT chunk so the chat history records the result
        // without the consumer needing to execute the tool itself.
        if (
          part instanceof vscode.LanguageModelToolCallPart &&
          vscodeLmToolNames.has(part.name)
        ) {
          const resultChunk = await invokeVscodeLmTool(
            part,
            tokenSource.token,
            log,
          );
          chunkCount++;
          if (opts.mode === "record") recordedChunks.push(resultChunk);
          yield resultChunk;
        }
      }
      log(
        `[vscode-lm-factory] ${label} complete chunks=${chunkCount}${
          unknownPartCount > 0 ? ` unknownParts=${unknownPartCount}` : ""
        }`,
      );
      return chunkCount;
    };

    try {
      // First attempt with the full tool surface.
      let chunkCount = yield* attempt(tools, "attempt 1");

      // If the model silently returned nothing AND we sent vscode.lm
      // tools, retry without them. Keeps `enableVscodeLmTools=true` viable
      // even when the active model can't cope with a large tool budget.
      if (chunkCount === 0 && vscodeLmTools.length > 0) {
        log(
          `[vscode-lm-factory] attempt 1 empty — retrying without ${vscodeLmTools.length} vscode.lm tool(s)`,
        );
        chunkCount = yield* attempt(userTools, "attempt 2 (no vscode.lm tools)");
      }

      // Still nothing → surface an actionable in-chat message so the user
      // isn't staring at a frozen input.
      if (chunkCount === 0) {
        const totalTools = userTools.length + vscodeLmTools.length;
        const message =
          vscodeLmTools.length > 20
            ? `**The model returned no content.** This request forwarded **${totalTools} tools** (${vscodeLmTools.length} from VS Code language-model providers like GitHub Copilot, plus ${userTools.length} from your code). Retrying without the VS Code tools also returned nothing — the model may be rate-limited, refusing the request, or unavailable.\n\nTry a different model, or disable \`copilotkit.playground.enableVscodeLmTools\` in your VS Code settings and click **Refresh**.`
            : `**The model returned no content.** Check the *CopilotKit Playground* output channel for details. The model may have hit a rate limit, refused the request, or returned a part type the playground doesn't recognize.`;
        // Synthetic chunk — NOT pushed into recordedChunks so it never
        // gets baked into a saved fixture.
        yield { type: "TEXT_MESSAGE_CONTENT", delta: message };
      }
    } catch (err) {
      log(
        `[vscode-lm-factory] sendRequest threw: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    } finally {
      tokenSource.dispose();
    }

    if (opts.mode === "record") {
      opts.onCallRecorded({
        matchKey,
        input: {
          messages: ctx.input.messages,
          tools: ctx.input.tools,
          modelId: opts.model.id,
        },
        chunks: recordedChunks,
      });
    }
  };
}

function computeMatchKey(input: RunAgentInput, modelId: string): string {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        messages: input.messages,
        tools: input.tools,
        modelId,
      }),
    )
    .digest("hex");
}

/**
 * Converts AG-UI conversation messages to vscode.lm's `LanguageModelChatMessage`
 * format.
 *
 * The non-obvious bits:
 *   - Assistant turns with tool calls go in as `Assistant([textPart, …,
 *     toolCallParts])` — VS Code's API expects an array of parts when an
 *     assistant turn has tool calls, not a bare string.
 *   - Tool RESULT messages (role "tool") go in as `User([toolResultPart])`.
 *     VS Code's chat API doesn't have a dedicated "tool" role; tool
 *     results are user-role messages whose content is a
 *     `LanguageModelToolResultPart` keyed by the tool call id. Without
 *     this, the runtime drops every result and the model loops thinking
 *     its previous tool calls produced no output (e.g. firing
 *     `copilot_fetchWebPage` 5×).
 */
function toLmMessages(input: RunAgentInput): vscode.LanguageModelChatMessage[] {
  const out: vscode.LanguageModelChatMessage[] = [];
  for (const m of input.messages) {
    const text = typeof m.content === "string" ? m.content : "";
    if (m.role === "user") {
      out.push(vscode.LanguageModelChatMessage.User(text));
    } else if (m.role === "assistant") {
      const parts: Array<
        vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart
      > = [];
      if (text) parts.push(new vscode.LanguageModelTextPart(text));
      const toolCalls = (m as { toolCalls?: unknown }).toolCalls;
      if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
          const id = (tc as { id?: unknown })?.id;
          const fn = (
            tc as { function?: { name?: unknown; arguments?: unknown } }
          )?.function;
          if (typeof id !== "string" || typeof fn?.name !== "string") continue;
          let parsedArgs: object = {};
          if (typeof fn.arguments === "string" && fn.arguments.length > 0) {
            try {
              const v = JSON.parse(fn.arguments);
              if (v && typeof v === "object" && !Array.isArray(v)) {
                parsedArgs = v as object;
              }
            } catch {
              /* leave empty — a malformed args blob shouldn't kill the run */
            }
          }
          parts.push(
            new vscode.LanguageModelToolCallPart(id, fn.name, parsedArgs),
          );
        }
      }
      // Assistant turns are required to have non-empty content. Skip
      // entirely if both text and tool calls are missing (corrupt history).
      if (parts.length > 0) {
        out.push(vscode.LanguageModelChatMessage.Assistant(parts));
      }
    } else if (m.role === "tool") {
      const toolCallId = (m as { toolCallId?: unknown }).toolCallId;
      if (typeof toolCallId !== "string") continue;
      const resultPart = new vscode.LanguageModelToolResultPart(toolCallId, [
        new vscode.LanguageModelTextPart(text),
      ]);
      out.push(vscode.LanguageModelChatMessage.User([resultPart]));
    }
  }
  return out;
}

/**
 * Translates AG-UI tools (`{ name, description, parameters }`) into vscode.lm's
 * `LanguageModelChatTool[]` shape. AG-UI's `parameters` is _supposed_ to be a
 * JSON Schema object, but in practice playground hooks (especially
 * `useHumanInTheLoop` and `useFrontendTool` with no params) often leave it
 * `null`, `undefined`, an array, or a non-object — and vscode.lm rejects the
 * whole request with `"schema must be a JSON Schema of type: 'object'"`.
 * Coerce everything to a minimum-viable object schema so a single misshapen
 * tool can't take down the entire run. Tools without a name are skipped.
 */
function toLmTools(
  agUiTools: RunAgentInput["tools"] | undefined,
): vscode.LanguageModelChatTool[] {
  if (!agUiTools || agUiTools.length === 0) return [];
  const out: vscode.LanguageModelChatTool[] = [];
  for (const t of agUiTools) {
    if (!t || typeof t !== "object" || typeof t.name !== "string") continue;
    out.push({
      name: t.name,
      description: typeof t.description === "string" ? t.description : t.name,
      inputSchema: normalizeInputSchema(t.parameters),
    });
  }
  return out;
}

function normalizeInputSchema(params: unknown): object {
  // Already a usable object schema with type: "object" — pass through.
  if (
    params &&
    typeof params === "object" &&
    !Array.isArray(params) &&
    (params as { type?: unknown }).type === "object"
  ) {
    return params as object;
  }
  // No params or malformed — emit a no-arg object schema (model still sees
  // the tool's name + description and can decide whether to call it).
  return { type: "object", properties: {}, additionalProperties: false };
}

/**
 * Invokes a system tool via `vscode.lm.invokeTool`, flattens the
 * `LanguageModelToolResult` content into a single text payload, and
 * wraps it as a TanStack `TOOL_CALL_RESULT` chunk. Errors are surfaced
 * as a JSON-stringified error result so the model can keep going.
 */
async function invokeVscodeLmTool(
  part: vscode.LanguageModelToolCallPart,
  token: vscode.CancellationToken,
  log: (line: string) => void,
): Promise<TanStackChunk> {
  log(`[vscode-lm-factory] invokeTool ${part.name} (callId=${part.callId})`);
  try {
    const result = await vscode.lm.invokeTool(
      part.name,
      { input: (part.input ?? {}) as Record<string, unknown>, toolInvocationToken: undefined },
      token,
    );
    const content = result.content
      .map((p) => {
        if (p instanceof vscode.LanguageModelTextPart) return p.value;
        // Other content types (LanguageModelPromptTsxPart) are stringified
        // best-effort — the model only sees text in the result.
        try {
          return JSON.stringify(p);
        } catch {
          return "";
        }
      })
      .join("");
    log(
      `[vscode-lm-factory] invokeTool ${part.name} ok (${content.length} chars)`,
    );
    return { type: "TOOL_CALL_RESULT", toolCallId: part.callId, content };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`[vscode-lm-factory] invokeTool ${part.name} threw: ${message}`);
    return {
      type: "TOOL_CALL_RESULT",
      toolCallId: part.callId,
      content: JSON.stringify({ error: message }),
    };
  }
}

function* translatePart(part: unknown): Generator<TanStackChunk> {
  if (part instanceof vscode.LanguageModelTextPart) {
    yield { type: "TEXT_MESSAGE_CONTENT", delta: part.value };
    return;
  }
  if (part instanceof vscode.LanguageModelToolCallPart) {
    const toolCallId = part.callId;
    yield { type: "TOOL_CALL_START", toolCallId, toolCallName: part.name };
    yield {
      type: "TOOL_CALL_ARGS",
      toolCallId,
      delta: JSON.stringify(part.input ?? {}),
    };
    yield { type: "TOOL_CALL_END", toolCallId };
    return;
  }
  // Some vscode.lm providers stream text content as `LanguageModelDataPart`
  // with a text/* or application/json mime instead of plain `TextPart`
  // (notably newer Claude builds routed through Copilot Chat). Surface
  // those as text deltas — otherwise they'd be dropped and the user would
  // see an empty chat. Binary mimes (image/*, etc.) are skipped here and
  // logged at the call site so we can extend support if needed.
  //
  // Guarded with a typeof check because older VS Code builds (or the
  // vitest vscode mock) may not define `LanguageModelDataPart`, and
  // `part instanceof undefined` throws.
  if (
    typeof vscode.LanguageModelDataPart === "function" &&
    part instanceof vscode.LanguageModelDataPart
  ) {
    const mime = part.mimeType || "";
    if (mime.startsWith("text/") || mime === "application/json") {
      const text = new TextDecoder("utf-8").decode(part.data);
      if (text.length > 0) {
        yield { type: "TEXT_MESSAGE_CONTENT", delta: text };
      }
      return;
    }
  }
}
