import type { AgentSessionOutcome, ThreadEntry } from "../shared/api";
import type { AgentEvent, AgentSession } from "./agents/launcher";
import type { EventBus } from "./events";
import type { Store } from "./store";

/**
 * How a session's thread gets written. Both kinds of session write the same way,
 * and a thread is the whole record of a session: squad stores every line as it
 * happens rather than pointing at a transcript on disk, so what the developer
 * comes back to read survives a restart and is the same record the interface
 * renders live.
 */

/** One line to write on a thread, before squad says which thread. */
export type ThreadLine = Pick<ThreadEntry, "kind" | "text"> & { detail?: string | null };

/** Which thread a line goes on: a feature's, or one of its tickets'. */
export interface ThreadAddress {
  featureId: string;
  /** Null on the main session, the ticket on a sub-session. */
  ticketId?: string | null;
  sessionId: string;
}

export function appendToThread(
  store: Store,
  bus: EventBus,
  address: ThreadAddress,
  line: ThreadLine,
): void {
  const entry = store.appendThreadEntry({ ...address, ...line });
  bus.publish({ type: "thread-appended", entry });
}

/** What one event of a session becomes on its thread. */
export function lineOf(event: Exclude<AgentEvent, { type: "ended" }>): ThreadLine {
  switch (event.type) {
    case "text":
      return { kind: "agent", text: event.text };
    case "tool-call":
      return {
        kind: "tool",
        text: event.tool,
        detail: event.input === undefined ? null : JSON.stringify(event.input, null, 2),
      };
    case "notice":
      return { kind: "notice", text: event.text };
  }
}

/** How a session stopped, once its whole stream has been written to its thread. */
export interface SessionEnding {
  outcome: AgentSessionOutcome;
  detail?: string;
}

/**
 * Reads a session to its end, writing every event on its thread, and hands back
 * how it stopped. Both kinds of session are drained exactly this way; what
 * differs is what each records about the ending, which is theirs to decide.
 *
 * A stream that throws is an ending too, and a failed one: a session whose
 * transport died said nothing more than one that crashed, and treating the
 * difference as interesting would leave the caller with no ending at all.
 */
export async function drainSession(
  session: AgentSession,
  write: (line: ThreadLine) => void,
): Promise<SessionEnding> {
  let ending: SessionEnding = { outcome: "completed" };
  try {
    for await (const event of session.events()) {
      if (event.type === "ended") {
        ending = { outcome: event.outcome, ...(event.detail === undefined ? {} : { detail: event.detail }) };
        continue;
      }
      write(lineOf(event));
    }
  } catch (failure) {
    ending = {
      outcome: "failed",
      detail: failure instanceof Error ? failure.message : String(failure),
    };
  }
  return ending;
}
