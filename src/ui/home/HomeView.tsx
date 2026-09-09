import type { AutonomyHaltReason, Feature } from "../../shared/api";
import { graphProgress, isDrained } from "../../shared/graph";
import { pendingActions } from "../../shared/pending";
import { feature as featureRoute } from "../../shared/ui-routes";
import { Brand, Connection, ThemeSwitch } from "../chrome";
import { navigate } from "../route";
import { openFeatureTab } from "../tab";
import { graphOf, type SquadState } from "../useSquadState";

/**
 * Every feature squad drives, flat, whatever project it hangs on. This is the
 * screen one opens in the morning, so it answers one question: where do I go.
 *
 * Flat because a project is an attribute of a feature rather than a place one
 * works in. A feature carries several repositories, so filing it under one of
 * them was already an approximation, and having to pick a project before seeing
 * any work was a step that decided nothing.
 *
 * Delivered features are kept, folded away. They are not archived: nothing here
 * is a state written down. A feature is in flight until its graph has drained,
 * and drained is read off the graph, which is the same rule that decides what
 * squad sends off in a pull request.
 */
export function HomeView({ state, lost }: { state: SquadState; lost: string | null }) {
  const waiting = pendingActions(state.graphs, state.questions);
  const rows = state.features.map((feature) => {
    const graph = graphOf(state, feature.id);
    return {
      feature,
      progress: graphProgress(graph),
      drained: isDrained(graph),
      waiting: waiting.filter((action) => action.featureId === feature.id).length,
      repositories: feature.repositories
        .map(
          (carried) =>
            state.projects.find((project) => project.id === carried.projectId)?.name ??
            "dépôt inconnu",
        )
        .join(", "),
    };
  });

  const inFlight = rows.filter((row) => !row.drained).sort(byWhatWaits);
  const delivered = rows.filter((row) => row.drained).sort(byWhatWaits);

  return (
    <div className="app">
      <header className="app__header">
        <Brand />
        {/* The name is drawn in the lockup, so the heading beside it is there
            for what reads the page rather than for what looks at it. */}
        <h1 className="app__subject visually-hidden">squad</h1>
        <p className="app__tagline">Poste de pilotage local pour agents claude-code</p>
        <Connection connected={state.connected} />
        <ThemeSwitch theme={state.settings.theme} />
        <button type="button" className="link" onClick={() => navigate({ screen: "settings" })}>
          réglages
        </button>
      </header>

      <main className="app__screen">
        {lost !== null && (
          <p className="notice" role="status">
            {lost}
          </p>
        )}

        <section className="panel" aria-labelledby="titre-en-vol">
          <div className="home__head">
            <h2 id="titre-en-vol">Features en vol</h2>
            <button type="button" onClick={() => navigate({ screen: "new-feature" })}>
              Nouvelle feature
            </button>
          </div>
          {inFlight.length === 0 ? (
            <p className="empty">
              Aucune feature en vol. Une feature est un chantier, du spec jusqu'à la fusion : elle
              part de rien, ou d'une conversation claude-code déjà menée, et le dépôt qu'elle
              touche s'enregistre au passage.
            </p>
          ) : (
            <ul className="list">
              {inFlight.map((row) => (
                <FeatureRow key={row.feature.id} {...row} />
              ))}
            </ul>
          )}
        </section>

        {delivered.length > 0 && (
          <details className="panel">
            <summary>
              <h2 className="home__summary">Features livrées</h2>
              <span className="row__meta">{delivered.length}</span>
            </summary>
            <ul className="list">
              {delivered.map((row) => (
                <FeatureRow key={row.feature.id} {...row} />
              ))}
            </ul>
          </details>
        )}
      </main>
    </div>
  );
}

/**
 * What waits comes first, and the more of it the higher. Then the most recently
 * opened. Recency of activity would read better still, and there is nothing to
 * read it from: a feature carries the day it was opened and nothing else, and
 * deriving it from its tickets would lie, a sub-session that has been running
 * for two hours without writing a ticket moving nothing.
 */
function byWhatWaits(
  a: { waiting: number; feature: Feature },
  b: { waiting: number; feature: Feature },
): number {
  if (a.waiting !== b.waiting) return b.waiting - a.waiting;
  return b.feature.createdAt.localeCompare(a.feature.createdAt);
}

/** Why the mode stopped, said as the thing the developer has to look at. */
const haltLabels: Record<AutonomyHaltReason, string> = {
  "scope-question": "une question change le périmètre",
  decision: "un ticket de décision attend d'être tranché",
  failure: "un ticket s'est arrêté",
  "depth-cap": "le plafond de profondeur d'engendrement est atteint",
};

/**
 * One feature, said in what decides whether to go there: what waits on it, how
 * far its graph has come, and whether it is running without me. Everything here
 * is already in the state the browser holds, so the row costs no request.
 */
function FeatureRow({
  feature,
  progress,
  waiting,
  repositories,
}: {
  feature: Feature;
  progress: { merged: number; total: number };
  waiting: number;
  repositories: string;
}) {
  const halt = feature.autonomyHalt;
  return (
    <li>
      <button
        type="button"
        className="row row--feature"
        onClick={() => openFeatureTab(featureRoute(feature.id))}
      >
        <span className="row__title">
          {feature.title}
          {waiting > 0 && <span className="count count--waiting">{waiting}</span>}
        </span>
        <span className="row__detail">{repositories}</span>
        <span className="row__meta">
          {progress.total === 0
            ? "graphe pas encore écrit"
            : `${progress.merged} ticket${progress.merged > 1 ? "s" : ""} fusionné${
                progress.merged > 1 ? "s" : ""
              } sur ${progress.total}`}
          {feature.goAsRecommended &&
            (halt === null
              ? " · go-as-recommandé en cours"
              : ` · go-as-recommandé interrompu, ${haltLabels[halt.reason]}`)}
        </span>
      </button>
    </li>
  );
}
