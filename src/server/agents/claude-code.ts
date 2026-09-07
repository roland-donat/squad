import { randomUUID } from "node:crypto";
import type { Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentSessionOutcome } from "../../shared/api";
import { squadMcpServerName } from "../mcp";
import type { AgentEvent, AgentLauncher, AgentSession, OpenAgentSession } from "./launcher";

/**
 * The real launcher: a claude-code session behind the narrow interface, opened
 * through the official agent SDK in streaming input mode. Streaming input is
 * what makes the session two-way and long lived: the prompt is an open stream
 * squad keeps pushing messages onto, rather than a string handed over once, so
 * the same session answers the spec, `/to-tickets` and every later exchange.
 *
 * Nothing here manages context. The session relies on claude-code's own
 * automatic compaction, and squad neither asks for one nor tries to avoid one.
 */
export function createClaudeCodeLauncher(): AgentLauncher {
  return {
    async open(request: OpenAgentSession): Promise<AgentSession> {
      // Loaded here rather than at the top of the module: the SDK carries the
      // claude-code runtime with it, and squad starts up, serves the graph and
      // runs its whole seam suite without ever opening a real session.
      const { query } = await import("@anthropic-ai/claude-agent-sdk");

      const id = randomUUID();
      const prompts = new PromptStream();
      const run = query({
        prompt: prompts.iterate(),
        options: buildOptions(request, id),
      });

      let stopping = false;

      return {
        id,
        events: () => drain(run, () => stopping),
        async send(text) {
          prompts.push(text);
        },
        async stop() {
          stopping = true;
          prompts.close();
          run.close();
        },
      };
    },
  };
}

/**
 * How a session is opened, and the one place the guarantees of ADR 0004 are
 * written down. Both of the settings below are set explicitly rather than left
 * to the SDK's defaults: they are the only thing keeping an unconfined agent
 * within the developer's instructions, and a default that changes underneath
 * squad would remove them without anything saying so.
 */
function buildOptions(request: OpenAgentSession, sessionId: string): Options {
  return {
    cwd: request.workingDirectory,
    sessionId,
    // Claude Code's own system prompt, never a bare one: a minimal session is a
    // session that has not read the project's conventions. Squad's briefing is
    // appended to it rather than replacing it, for the same reason.
    systemPrompt: { type: "preset", preset: "claude_code", append: request.briefing },
    // User, project and local settings, which is what loads the global and
    // project `CLAUDE.md` along with everything the developer configured.
    settingSources: ["user", "project", "local"],
    // Squad's own tools, on the same origin as the interface: the only contract
    // the session has with squad (ADR 0002).
    mcpServers: { [squadMcpServerName]: { type: "http", url: request.mcpUrl } },
    // No permission prompts and no sandbox (ADR 0004): a request for permission
    // that nobody answers would stall a ticket for hours, which is the worst
    // failure mode for a tool meant to work while nobody is watching.
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    stderr: (data: string) => {
      // The runtime's own diagnostics, kept out of the thread: the thread is
      // what the developer reads, and this is what a crash is debugged from.
      process.stderr.write(`[claude-code ${sessionId}] ${data}`);
    },
  };
}

/**
 * The session's events, ending on exactly one `ended`. A stop asked for by squad
 * is a completion, not a failure: the difference is whether anyone is still
 * waiting for the session, and only squad knows that.
 */
async function* drain(run: Query, stopping: () => boolean): AsyncIterable<AgentEvent> {
  let outcome: AgentSessionOutcome = "completed";
  let detail: string | undefined;
  try {
    for await (const message of run) {
      yield* translate(message);
    }
  } catch (failure) {
    if (!stopping()) {
      outcome = "failed";
      detail = failure instanceof Error ? failure.message : String(failure);
    }
  }
  yield { type: "ended", outcome, ...(detail === undefined ? {} : { detail }) };
}

/** What one message of the SDK becomes on the thread, if anything. */
function* translate(message: SDKMessage): Generator<AgentEvent> {
  if (message.type === "assistant") {
    if (message.error !== undefined) {
      yield { type: "notice", text: `the model call failed: ${message.error}` };
    }
    for (const block of message.message.content) {
      // Thinking blocks are deliberately dropped: the thread shows what the
      // agent said and did, not how it got there.
      if (block.type === "text" && block.text.trim() !== "") {
        yield { type: "text", text: block.text };
      } else if (block.type === "tool_use") {
        yield { type: "tool-call", tool: block.name, input: block.input };
      }
    }
    return;
  }
  // A result closes a turn, not the session: in streaming input mode the
  // session lives on and answers the next message. Only a failed turn is worth
  // a line, since a successful one has already said everything it had to say.
  if (message.type === "result" && message.subtype !== "success") {
    yield { type: "notice", text: `the turn ended in ${message.subtype}` };
  }
}

/**
 * The messages squad pushes into a running session, as the async iterable the
 * SDK takes for a prompt. It stays open for the life of the session: closing it
 * is what tells claude-code that no further turn is coming.
 */
class PromptStream {
  private readonly pending: SDKUserMessage[] = [];
  private readonly waiting: Array<(result: IteratorResult<SDKUserMessage>) => void> = [];
  private closed = false;

  push(text: string): void {
    if (this.closed) return;
    const message: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    };
    const waiter = this.waiting.shift();
    if (waiter) waiter({ value: message, done: false });
    else this.pending.push(message);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiting.length > 0) {
      this.waiting.shift()?.({ value: undefined, done: true });
    }
  }

  iterate(): AsyncIterable<SDKUserMessage> {
    const stream = this;
    return {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<SDKUserMessage>> {
            const buffered = stream.pending.shift();
            if (buffered) return Promise.resolve({ value: buffered, done: false });
            if (stream.closed) return Promise.resolve({ value: undefined, done: true });
            return new Promise((resolve) => stream.waiting.push(resolve));
          },
        };
      },
    };
  }
}
