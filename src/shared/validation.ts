import type { StepReport, TestSheetPoint } from "./api";

/**
 * What a test sheet says, once the developer has been through it or once it came
 * back empty. Three questions are asked of a sheet, in three places: the alert
 * that wakes someone, the indicator that lists what waits on them, and the chain
 * that merges or sends a correction back. They are answered here so that a sheet
 * cannot be waiting for one of them and validated for another.
 *
 * Nothing here reads `reviewedAt`: an empty sheet asked for no reading at all
 * and is validated the moment it is reported, which is what makes a step nobody
 * has to look at merge on its own.
 */

/**
 * Whether a sheet is still waiting on a human: it holds at least one point
 * nobody has been through. A sheet that came back empty asked for no hand check
 * at all, and one already gone through waits on squad rather than on its reader.
 */
export function sheetIsWaiting(report: StepReport | null): boolean {
  return report !== null && report.sheet.some((point) => point.verdict === "pending");
}

/** The points the developer left unchecked, which is what a correction is made of. */
export function failedPoints(report: StepReport | null): TestSheetPoint[] {
  return report === null ? [] : report.sheet.filter((point) => point.verdict === "failed");
}

/**
 * Whether a step may merge: its sheet is gone through, or there was nothing on
 * it, and nothing on it failed. This is the one place "validated" is decided,
 * and a ticket whose step is not validated is a ticket that never merges.
 */
export function sheetWasValidated(report: StepReport | null): boolean {
  return report !== null && !sheetIsWaiting(report) && failedPoints(report).length === 0;
}
