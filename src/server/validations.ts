import type { Feature, Ticket } from "../shared/api";
import { failedPoints, sheetIsWaiting, sheetWasValidated } from "../shared/validation";
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
  /**
   * The pass that empties a sheet of what a command answers, before anyone is
   * woken.
   */
  settlements: { settle(ticket: Ticket): void };
  /** The feature a ticket belongs to, which the pass has to be told about. */
  featureOf(ticket: Ticket): Feature | null;
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
      // Nobody is woken on a sheet nobody has been through yet: squad settles
      // what a command can settle first, and what survives that is what an
      // alert is worth sending for. A feature that went away under the ticket
      // is the one case with nothing to open a pass on.
      const feature = this.dependencies.featureOf(ticket);
      if (feature === null) {
        this.dependencies.alerts.raise(alertFor.testSheetWaiting(ticket));
        return;
      }
      this.dependencies.settlements.settle(ticket);
      return;
    }
    if (sheetWasValidated(ticket.stepReport)) this.dependencies.merges.merge(ticket);
  }

  /**
   * A sheet the settling pass has just been through. The three ways out are the
   * developer's own, reached without them: a point shown broken goes back to
   * the sub-session with its evidence, a point left for a human wakes them with
   * that point alone, and a sheet that holds throughout merges.
   *
   * **What is broken goes back first, even when the sheet still holds points
   * for a person.** A criterion a command proves false is work that is not
   * done, and the wording of a screen that is about to be rewritten is not
   * worth a reading: the correction reports a step of its own, that step has a
   * sheet of its own, and the developer judges once, on work that has settled.
   * Measured on the ten sheets that opened this: five of them held both, and
   * the order below is 15 points of judgement the developer does not spend on
   * work already known to be changing.
   */
  async afterSettling(ticket: Ticket): Promise<void> {
    if (failedPoints(ticket.stepReport).length > 0) {
      await this.dependencies.subSessions.correct(ticket);
      return;
    }
    if (sheetIsWaiting(ticket.stepReport)) {
      this.dependencies.alerts.raise(alertFor.testSheetWaiting(ticket));
      return;
    }
    await this.afterReview(ticket);
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
