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
 * How many times squad sends the same ticket back to the sub-session that built
 * it. A sheet answered, corrected and reported again has had squad's word once;
 * a third round is two agents disagreeing, and a person ends that faster than
 * another pass would.
 *
 * It bounds the sending back and nothing else. The pass that settles a sheet
 * runs on every round, because typing a point costs nothing, risks nothing and
 * changes nothing in the repository: what it takes away from the developer is
 * the points a command answers, and what it hands them is an arbitration
 * carrying the road it recommends rather than a bare line. A round where squad
 * stopped typing altogether would put the untyped sheet in front of the
 * developer, arbitrations and all, which is precisely what the pass exists to
 * prevent. Measured on the instance that opened this: 15 of the 33 points
 * waiting came from three sheets nobody had typed.
 */
export const settlingRounds = 2;

/**
 * Whether a sheet is still waiting on a human: it holds at least one point
 * nobody has been through, or it holds a point squad showed false and may no
 * longer send back. A sheet that came back empty asked for no hand check at
 * all, and one already gone through waits on squad rather than on its reader.
 *
 * The second case is what keeps a step from disappearing at the last round: a
 * failed point is not a merge and is no longer a correction, so the only place
 * left for it is the developer, and this is the list they read.
 */
export function sheetIsWaiting(report: StepReport | null): boolean {
  if (report === null) return false;
  if (report.sheet.some((point) => point.verdict === "pending")) return true;
  return !report.correctable && failedPoints(report).length > 0;
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
