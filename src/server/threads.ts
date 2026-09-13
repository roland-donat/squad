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

/**
 * What one event of a session becomes on its thread. The two endings write
 * nothing: what each says is the caller's to record, and a turn ending says
 * nothing a reader of the thread needs.
 */
export function lineOf(
  event: Exclude<AgentEvent, { type: "ended" } | { type: "turn-ended" }>,
): ThreadLine {
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
  return drain(session, write, false);
}

/**
 * Reads a session that was opened for a single job and is over when that job
 * is: the first turn to end closes it.
 *
 * **A session does not end when its agent stops talking.** The launcher runs
 * the SDK in streaming input mode, where a result closes a turn and not the
 * session, so the process lives until squad stops it. A sub-session is meant to
 * stay, being the thread a correction is handed back to, and it is drained the
 * other way. The two jobs are not: a resolution session answers through git and
 * calls no tool at all, and a settling pass may end its turn having said
 * nothing, which is an ordinary way for one to end. Waiting for either process
 * waits for something only a stop causes, and that held a merge, and with it
 * every merge its project had queued behind, for 23 hours on the instance that
 * opened this.
 */
export async function drainOneTurn(
  session: AgentSession,
  write: (line: ThreadLine) => void,
): Promise<SessionEnding> {
  return drain(session, write, true);
}

async function drain(
  session: AgentSession,
  write: (line: ThreadLine) => void,
  endsWithItsTurn: boolean,
): Promise<SessionEnding> {
  let ending: SessionEnding = { outcome: "completed" };
  // The first ending wins. A session stopped on its own turn ends twice: once
  // for the turn, once when the stop closes the stream, and the second says how
  // the stop went rather than how the work did.
  let ended = false;
  const record = (event: { outcome: AgentSessionOutcome; detail?: string }): void => {
    if (ended) return;
    ending = { outcome: event.outcome, ...(event.detail === undefined ? {} : { detail: event.detail }) };
    ended = true;
  };
  try {
    for await (const event of session.events()) {
      if (event.type === "turn-ended") {
        // A session squad keeps hearing from goes on: a sub-session reports its
        // step and stays, being the thread a correction is handed back to.
        if (!endsWithItsTurn) continue;
        record(event);
        // Stopped rather than broken out of: the loop goes on reading whatever
        // the stop flushes, and it is the stream closing that ends it, exactly
        // as when something else stopped the session. Caught rather than left
        // floating: an unhandled rejection takes the server down, and squad is
        // meant to run unwatched.
        void session.stop().catch((failure: unknown) => {
          console.error(`could not stop a session that had finished its turn`, failure);
        });
        continue;
      }
      if (event.type === "ended") {
        record(event);
        continue;
      }
      write(lineOf(event));
    }
  } catch (failure) {
    if (!ended) {
      ending = {
        outcome: "failed",
        detail: failure instanceof Error ? failure.message : String(failure),
      };
    }
  }
  return ending;
}
