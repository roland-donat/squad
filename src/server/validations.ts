import type { Ticket } from "../shared/api";
import { sheetIsWaiting, sheetWasValidated } from "../shared/validation";
import { alertFor, type Alerts } from "./alerts";

/**
 * What follows a test sheet, in the one place that decides it. A sheet comes to
 * rest in exactly three ways, and each has one consequence: it is waiting, and
 * the developer is told; it came back with everything checked, or with nothing
 * on it at all, and the branch merges; it came back with a point unchecked, and
 * the comment goes back to the sub-session that wrote the step.
 *
 * Both ways into it end here: a step reported through the tools, and a sheet
 * handed back through the API. Reading the sheet in two places would be two
 * places to disagree about what "validated" means, and a ticket that merges
 * without having been validated is the one thing this chain must not do.
 */

export interface ValidationDependencies {
  alerts: Alerts;
  /** Declared by what is needed of it: a validated step is a branch to merge. */
  merges: { merge(ticket: Ticket): void };
  /** Likewise: a rejected sheet is a correction to hand back. */
  subSessions: { correct(ticket: Ticket): Promise<void> };
}

export class Validations {
  constructor(private readonly dependencies: ValidationDependencies) {}

  /**
   * A step that has just been reported. A sheet with something on it stops here
   * and wakes whoever has to read it; an empty one has nothing for a human to
   * do, so it goes straight on, which is what makes an unattended run mean
   * anything.
   */
  afterReport(ticket: Ticket): void {
    if (sheetIsWaiting(ticket.stepReport)) {
      this.dependencies.alerts.raise(alertFor.testSheetWaiting(ticket));
      return;
    }
    if (sheetWasValidated(ticket.stepReport)) this.dependencies.merges.merge(ticket);
  }

  /** A sheet the developer has just been through. */
  async afterReview(ticket: Ticket): Promise<void> {
    if (sheetWasValidated(ticket.stepReport)) {
      this.dependencies.merges.merge(ticket);
      return;
    }
    await this.dependencies.subSessions.correct(ticket);
  }
}
