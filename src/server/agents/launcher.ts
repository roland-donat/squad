import type { AgentSessionOutcome } from "../../shared/api";

/**
 * The only boundary through which non-determinism enters squad. Everything
 * behind it is a real process running a model; everything in front of it is
 * deterministic, which is what makes the whole chain testable.
 *
 * The interface stays narrow on purpose: open a session in a working directory,
 * emit a stream of events, take an incoming message, end. Two implementations
 * face it, one backed by the official agent SDK and one scripted double.
 */
export interface AgentLauncher {
  open(request: OpenAgentSession): Promise<AgentSession>;
}

/** Whether the session drives a whole feature or a single ticket. */
export type AgentSessionRole = "main" | "sub";

export interface OpenAgentSession {
  role: AgentSessionRole;
  featureId: string;
  /** Set for a sub-session, which exists for exactly one ticket. */
  ticketId?: string;
  /** The repository for a main session, the ticket's worktree for a sub-session. */
  workingDirectory: string;
  /** Squad's MCP endpoint: the only contract the session has with squad (ADR 0002). */
  mcpUrl: string;
}

/**
 * What a session reports as it works. Tool calls are announced but their
 * arguments are not: squad already holds everything a tool wrote, and the thread
 * of a session is read from the store rather than reconstructed from here.
 */
export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool-call"; tool: string }
  | { type: "ended"; outcome: AgentSessionOutcome; detail?: string };

export interface AgentSession {
  readonly id: string;
  /** Ends when the session ends; its last event is always an `ended` one. */
  events(): AsyncIterable<AgentEvent>;
  /** Hands a message to the running session. */
  send(text: string): Promise<void>;
  /** Ends the session wherever it is, without waiting for it to conclude. */
  stop(): Promise<void>;
}
