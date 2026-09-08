import type { FeatureGraph, Question, Ticket } from "./api";
import { sheetIsWaiting } from "./validation";

/**
 * What is waiting on the developer, right now, across every feature. The rule
 * lives here rather than in the interface so that what the indicator lists and
 * what squad considers a stop are one and the same thing: a state that appears
 * in this list is a state squad cannot leave on its own.
 *
 * Nothing is stored: it follows from the graphs the client already holds, so an
 * action that resolves itself disappears from the list without a write.
 */

/** Why a ticket is waiting, which is also what the developer has to do about it. */
export const pendingReasons = [
  "question",
  "validation",
  "decision",
  "failure",
  "interruption",
  "conflict",
] as const;
export type PendingReason = (typeof pendingReasons)[number];

export interface PendingAction {
  featureId: string;
  /** Null on a question the main session asked: it hangs on no ticket. */
  ticketId: string | null;
  /** What is waiting, named: a ticket's title, or a question's statement. */
  title: string;
  reason: PendingReason;
}

/** Whether a ticket is waiting on the developer, and why. */
function pendingActionOf(ticket: Ticket): PendingReason | null {
  switch (ticket.state) {
    case "awaiting-validation":
      return sheetIsWaiting(ticket.stepReport) ? "validation" : null;
    case "awaiting-decision":
      return "decision";
    case "failed":
      return "failure";
    case "interrupted":
      return "interruption";
    case "conflict":
      return "conflict";
    default:
      return null;
  }
}

/**
 * Everything waiting on the developer: the questions first, then what the
 * graphs say. The questions first because an agent is blocked on each of them,
 * doing nothing until it is answered, where a ticket waiting for a test sheet
 * has at least finished its work.
 */
export function pendingActions(
  graphs: readonly FeatureGraph[],
  questions: readonly Question[],
): PendingAction[] {
  const waiting: PendingAction[] = questions
    .filter((question) => question.state === "pending")
    .map((question) => ({
      featureId: question.featureId,
      ticketId: question.ticketId,
      title: question.prompt,
      reason: "question" as const,
    }));
  for (const graph of graphs) {
    for (const ticket of graph.tickets) {
      const reason = pendingActionOf(ticket);
      if (reason === null) continue;
      waiting.push({
        featureId: graph.featureId,
        ticketId: ticket.id,
        title: ticket.title,
        reason,
      });
    }
  }
  return waiting;
}
