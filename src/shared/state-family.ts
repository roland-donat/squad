import type { Ticket } from "./api";
import type { PendingAction } from "./pending";

/**
 * The five families a ticket is painted with on the map, out of the eleven
 * states it can be in. A map answers one question at a glance, "whose turn is
 * it", and eleven distinctions cannot be drawn at map scale without falling
 * back on colour alone. The exact state is never lost: it stays in the node's
 * accessible label, in its tooltip and in the ticket panel.
 *
 * `awaiting-developer` is not worked out here. It is read off the very list the
 * waiting indicator shows, so the two can never disagree, and the reasons are
 * the ones `pending.ts` already holds: a step whose sheet came back empty waits
 * for nobody and merges on its own, while a ticket with an unanswered question
 * blocks an agent although it is recorded as running.
 */
export const stateFamilies = [
  "blocked",
  "ready",
  "running",
  "awaiting-developer",
  "settled",
] as const;
export type StateFamily = (typeof stateFamilies)[number];

/**
 * The tickets waiting on the developer, by id, taken from the pending actions
 * themselves rather than from a second rule reading the same states. A question
 * the main session asked hangs on no ticket and marks no node.
 */
export function ticketsAwaitingDeveloper(actions: readonly PendingAction[]): Set<string> {
  const waiting = new Set<string>();
  for (const action of actions) {
    if (action.ticketId !== null) waiting.add(action.ticketId);
  }
  return waiting;
}

/** Which family a ticket is painted with, the waiting list having the last word. */
export function familyOf(ticket: Ticket, awaitingDeveloper: ReadonlySet<string>): StateFamily {
  if (awaitingDeveloper.has(ticket.id)) return "awaiting-developer";
  switch (ticket.state) {
    case "merged":
    // Dropped rather than done, and painted with what is over rather than with
    // what waits: nobody owes it anything, and the map says which of the two it
    // was in the node's label and in the panel.
    case "discarded":
      return "settled";
    case "blocked":
      return "blocked";
    // A launch squad accepted and has not opened yet still belongs to the
    // frontier: it waits for a place, not for a person.
    case "ready":
    case "queued":
      return "ready";
    // A reported step that reached here is one nobody has to read, since the
    // waiting list would have claimed it otherwise: squad is merging it, and
    // that is work in flight like any other.
    case "running":
    case "merging":
    case "awaiting-validation":
    // Squad's own pass on the sheet is work in flight like any other, and the
    // one thing it must not read as is a ticket waiting on a person: the pass
    // is what decides whether anything is left for one.
    case "settling":
      return "running";
    // Asked for and waiting for a place, exactly like a queued launch.
    case "settling-queued":
      return "ready";
    // Stopped, in conflict or waiting for a decision: the waiting list holds
    // every one of them, so this only guards the drawing against a state that
    // escaped it rather than against a real case.
    default:
      return "awaiting-developer";
  }
}
