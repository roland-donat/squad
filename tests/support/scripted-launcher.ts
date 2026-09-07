import { randomUUID } from "node:crypto";
import type {
  AgentEvent,
  AgentLauncher,
  AgentSession,
  OpenAgentSession,
} from "../../src/server/agents/launcher";
import { connectToSquadTools, readToolAnswer, type McpConnection, type ToolOutcome } from "./mcp";

/**
 * The one double of the whole suite: instead of starting a claude-code process,
 * it replays a scripted scenario of tool calls and messages, then ends. It is
 * the only place non-determinism is removed; the tools it calls, the HTTP
 * transport it calls them over, the database behind them and the git repository
 * underneath are all real.
 */
export interface ScriptedAgent {
  /** What squad asked for when it opened this session. */
  readonly request: OpenAgentSession;
  /** Waits for the next message squad hands to the session, and returns it. */
  awaitMessage(): Promise<string>;
  /** Emits a line of the agent's own text on the session's event stream. */
  say(text: string): void;
  /** Calls one of squad's tools and returns its answer, failing on a refusal. */
  call(tool: string, input: unknown): Promise<unknown>;
  /** Calls a tool and hands back its outcome, so a refusal can be inspected. */
  attempt(tool: string, input: unknown): Promise<ToolOutcome>;
}

export type AgentScript = (agent: ScriptedAgent) => Promise<void>;

export function createScriptedLauncher(script: AgentScript): AgentLauncher {
  return {
    async open(request: OpenAgentSession): Promise<AgentSession> {
      // Like the real launcher: a resumed session answers to the id it is
      // resuming, so the ticket keeps pointing at one session throughout.
      const id = request.resumeSessionId ?? randomUUID();
      const events = new EventChannel();
      const messages = new MessageQueue();
      // Held in a box rather than a variable: the script assigns it from inside
      // a closure, and a plain `let` would read as never assigned below.
      const connection: { tools: McpConnection | null } = { tools: null };

      const attempt = async (tool: string, input: unknown): Promise<ToolOutcome> => {
        connection.tools ??= await connectToSquadTools(request.mcpUrl);
        const outcome = await connection.tools.attempt(tool, input);
        // Announced with what it was called with, like the real launcher: the
        // interface folds a tool call away behind its name, so the arguments
        // are the whole of what there is left to unfold.
        events.push({ type: "tool-call", tool, input });
        return outcome;
      };

      const agent: ScriptedAgent = {
        request,
        awaitMessage: () => messages.next(),
        say: (text) => events.push({ type: "text", text }),
        attempt,
        async call(tool, input) {
          return readToolAnswer(tool, await attempt(tool, input));
        },
      };

      void (async () => {
        try {
          await script(agent);
          events.push({ type: "ended", outcome: "completed" });
        } catch (failure) {
          if (!events.stopped) {
            const detail = failure instanceof Error ? failure.message : String(failure);
            events.push({ type: "ended", outcome: "failed", detail });
          }
        } finally {
          await connection.tools?.close();
          events.close();
        }
      })();

      return {
        id,
        events: () => events.iterate(),
        async send(text) {
          messages.push(text);
        },
        async stop() {
          events.stopped = true;
          messages.abort();
          events.close();
        },
      };
    },
  };
}

/** A push stream of events, readable exactly once as an async iterable. */
class EventChannel {
  stopped = false;
  private readonly pending: AgentEvent[] = [];
  private readonly waiting: Array<(result: IteratorResult<AgentEvent>) => void> = [];
  private closed = false;

  push(event: AgentEvent): void {
    if (this.closed) return;
    const waiter = this.waiting.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.pending.push(event);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiting.length > 0) {
      this.waiting.shift()?.({ value: undefined, done: true });
    }
  }

  iterate(): AsyncIterable<AgentEvent> {
    const channel = this;
    return {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<AgentEvent>> {
            const buffered = channel.pending.shift();
            if (buffered) return Promise.resolve({ value: buffered, done: false });
            if (channel.closed) return Promise.resolve({ value: undefined, done: true });
            return new Promise((resolve) => channel.waiting.push(resolve));
          },
        };
      },
    };
  }
}

/** Messages squad hands to the session, awaited one at a time by the script. */
class MessageQueue {
  private readonly pending: string[] = [];
  private readonly waiting: Array<{
    resolve: (text: string) => void;
    reject: (reason: Error) => void;
  }> = [];

  push(text: string): void {
    const waiter = this.waiting.shift();
    if (waiter) waiter.resolve(text);
    else this.pending.push(text);
  }

  abort(): void {
    while (this.waiting.length > 0) {
      this.waiting.shift()?.reject(new Error("the session was stopped"));
    }
  }

  next(): Promise<string> {
    const buffered = this.pending.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    return new Promise((resolve, reject) => this.waiting.push({ resolve, reject }));
  }
}
