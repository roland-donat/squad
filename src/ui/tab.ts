import { routePath, type FeatureRoute } from "../shared/ui-routes";

/**
 * How a feature is entered: in a tab of its own, named after the feature.
 *
 * Named rather than merely new, because the name is what makes the tab the
 * feature's own rather than one more copy of it. Opening the same feature twice
 * from the home screen brings the tab already showing it back to the front,
 * instead of leaving two tabs on one graph with two event streams open on it.
 *
 * The reach of this has a limit worth knowing: a browser only finds a tab by
 * name inside the group of contexts it was opened from. A link clicked in a
 * chat or in a desktop notification lands in a group of its own, so the tab it
 * opens is not the one this would find. `claimTabName` narrows that gap, and
 * does not close it.
 */
export function openFeatureTab(route: FeatureRoute): void {
  window.open(routePath(route), tabNameOf(route.featureId));
}

/**
 * The name this tab answers to, so a later `openFeatureTab` on the same feature
 * finds it rather than opening a second one. Called by the feature screen for
 * the tab it is drawn in, whichever way that tab came to exist.
 */
export function claimTabName(featureId: string): void {
  window.name = tabNameOf(featureId);
}

/** Frees the name, so a screen that is not a feature holds no feature's tab. */
export function releaseTabName(): void {
  if (window.name.startsWith(prefix)) window.name = "";
}

const prefix = "squad-feature-";

function tabNameOf(featureId: string): string {
  return `${prefix}${featureId}`;
}
