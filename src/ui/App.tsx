import { useEffect, useRef, useState } from "react";
import { pendingActions } from "../shared/pending";
import { home, type Route } from "../shared/ui-routes";
import { Brand, Connection, ThemeSwitch } from "./chrome";
import { FeatureView } from "./feature/FeatureView";
import { HomeView } from "./home/HomeView";
import { NewFeatureView } from "./home/NewFeatureView";
import { navigate, normaliseAddress, useRoute } from "./route";
import { SettingsView } from "./settings/SettingsView";
import { releaseTabName } from "./tab";
import { applyTheme } from "./theme";
import { useSquadState } from "./useSquadState";

/**
 * Which screen is up, and nothing else.
 *
 * Squad used to be one page, and everything it could do was on it at once: the
 * work, the list of features, the list of projects and the three forms that set
 * them up. It is four screens now, each answering one question. Where do I go,
 * which is the home screen. What am I opening, which is the creation screen.
 * What is happening on this piece of work, which is a feature's own tab. And
 * what is squad configured with, which is the settings.
 */
export function App() {
  const state = useSquadState();
  const route = useRoute();

  // The ground the interface is drawn on, as squad holds it. Held back until the
  // first snapshot: before it the settings are placeholders, and applying them
  // would undo what the bootstrap script painted from the last known theme.
  useEffect(() => {
    if (!state.loaded) return;
    applyTheme(state.settings.theme);
  }, [state.loaded, state.settings.theme]);

  const opened =
    route.screen === "feature"
      ? (state.features.find((feature) => feature.id === route.featureId) ?? null)
      : null;

  // What the address named and squad does not have. An alert sent three weeks
  // ago, a link copied from another database: it is said, rather than quietly
  // swapped for the first feature to hand, which with one tab per feature would
  // land the reader in a piece of work that is not the one they were called to.
  const [lost, setLost] = useState<string | null>(null);
  // One effect and not two: the second used to clear what the first had just
  // written, whenever both ran on the same commit. Going back to a feature that
  // has since been deleted does exactly that, and landed on the home screen
  // with no explanation, which is the one thing this exists to prevent.
  useEffect(() => {
    if (!state.loaded) return;
    if (route.screen === "feature" && opened === null) {
      setLost("La feature demandée n'existe plus : squad ne la connaît pas.");
      navigate(home(), { replace: true });
      return;
    }
    // Cleared as soon as one goes somewhere on purpose, so it says what just
    // happened rather than sitting on the home screen for the rest of the day.
    if (route.screen !== "home") setLost(null);
  }, [state.loaded, route.screen, opened]);

  // The address is corrected, never suffered: an address squad still reads but
  // no longer writes is put back into the shape squad writes today. At every
  // render, and off the live address: a move made a moment ago must not be
  // undone by a route this render was given before it.
  useEffect(normaliseAddress);

  // A tab holds a feature's name only while it is showing that feature.
  useEffect(() => {
    if (route.screen !== "feature") releaseTabName();
  }, [route.screen]);

  // Where leaving the settings goes back to. They carry no selection, being a
  // screen of their own, so without this the feature being watched would be
  // dropped on the way there and back. Reachable by their address alone, so the
  // home screen is what it falls back to rather than the browser's history.
  const back = useRef<Route>(home());
  if (route.screen !== "settings") back.current = route;

  const waiting = pendingActions(state.graphs, state.questions);
  useTitle(route, opened?.title ?? null, waiting);

  if (route.screen === "settings") return <SettingsScreen state={state} back={back.current} />;
  if (route.screen === "new-feature") return <NewFeatureView state={state} />;
  if (route.screen === "feature" && opened !== null) {
    return <FeatureView state={state} route={route} feature={opened} />;
  }
  return <HomeView state={state} lost={lost} />;
}

/**
 * What the tab is called, which with one tab per feature is the only thing
 * telling four squad tabs apart once they are down to a favicon and three
 * letters. The count comes first because that is the convention every browser
 * user already reads without being taught it, and the feature's own name comes
 * before squad's so that what survives the truncation is what distinguishes.
 */
function useTitle(
  route: Route,
  featureTitle: string | null,
  waiting: readonly { featureId: string }[],
): void {
  const count =
    route.screen === "feature"
      ? waiting.filter((action) => action.featureId === route.featureId).length
      : waiting.length;
  const subject =
    route.screen === "settings"
      ? "Réglages"
      : route.screen === "new-feature"
        ? "Nouvelle feature"
        : featureTitle;
  useEffect(() => {
    const named = subject === null ? "squad" : `${subject} · squad`;
    document.title = count === 0 ? named : `(${count}) ${named}`;
  }, [subject, count]);
}

/**
 * What squad is configured with. Its own screen, reached from wherever one was
 * and returning there.
 */
function SettingsScreen({
  state,
  back,
}: {
  state: ReturnType<typeof useSquadState>;
  back: Route;
}) {
  return (
    <div className="app">
      <header className="app__header">
        <Brand onClick={() => navigate(home())} />
        <h1 className="app__subject">Réglages</h1>
        <p className="app__tagline">
          Ce que squad lit à chaque alerte et à chaque lancement. Rien n'est lu dans
          l'environnement : ce qui est en vigueur est ce qui est ici.
        </p>
        <Connection connected={state.connected} />
        <ThemeSwitch theme={state.settings.theme} />
        <button type="button" className="link" onClick={() => navigate(back)}>
          revenir
        </button>
      </header>
      <main className="app__screen">
        <SettingsView settings={state.settings} projects={state.projects} />
      </main>
    </div>
  );
}
