import { type CSSProperties, useEffect, useRef, useState } from "react";
import { themes, type AutonomyHaltReason, type Feature, type Project, type Theme } from "../shared/api";
import { pendingActions, type PendingAction, type PendingReason } from "../shared/pending";
import { ticketsAwaitingDeveloper } from "../shared/state-family";
import { piloting, type PilotingRoute } from "../shared/ui-routes";
import { openFeature, registerProject, setGoAsRecommended, updateSettings } from "./api";
import { Dialog } from "./Dialog";
// The lockup itself, not a copy of it in JSX: one drawing serves the header, the
// favicon and the README, and a second one would drift from it in silence.
import lockup from "./brand/squad-lockup.svg?raw";
import { FeatureGraphView } from "./graph/FeatureGraphView";
import { navigate, useRoute } from "./route";
import { Failure, useSubmission } from "./submission";
import { MainSessionView } from "./session/MainSessionView";
import { RecordedSessions } from "./session/RecordedSessions";
import { SettingsView } from "./settings/SettingsView";
import { applyTheme } from "./theme";
import { TicketPanel } from "./ticket/TicketPanel";
import {
  featureQuestionsOf,
  graphOf,
  isMainSessionRunning,
  threadOf,
  ticketQuestionsOf,
  ticketThreadOf,
  useSquadState,
} from "./useSquadState";

/**
 * How much of the map the drawer covers, in pixels. Declared here rather than in
 * the stylesheet: the map has to know it to bring a covered node back into view,
 * and a width living in two places would drift.
 */
const drawerWidth = 448;

export function App() {
  const state = useSquadState();
  const { projects, features, connected } = state;
  // The selection is the address (`route.ts`): what is watched is therefore
  // linkable, survives a reload, and differs from one tab to the next.
  const route = useRoute();
  // Which of the two screens is up. Squad is one page: piloting is what it is
  // for, and the settings are what it is configured with, so they take the
  // place of the panels rather than sitting among them.
  const settingsOpen = route.screen === "settings";
  // Where leaving the settings goes back to. Their address carries no
  // selection, being a screen of its own, so without this the feature being
  // watched would be dropped on the way there and back.
  const lastPiloting = useRef<PilotingRoute>(piloting());
  if (route.screen === "piloting") lastPiloting.current = route;
  const selection = route.screen === "piloting" ? route : lastPiloting.current;

  const selected =
    projects.find((project) => project.id === selection.projectId) ?? projects[0] ?? null;
  const featuresOfProject = features.filter((feature) => feature.projectId === selected?.id);
  const openedFeature =
    featuresOfProject.find((feature) => feature.id === selection.featureId) ??
    featuresOfProject[0] ??
    null;
  const graph = openedFeature ? graphOf(state, openedFeature.id) : null;
  // Read back from the graph at every render rather than held in state: a ticket
  // that changes state while its panel is open must show the change, and the
  // panel must close itself if the ticket leaves the feature being watched.
  const openedTicket = graph?.tickets.find((ticket) => ticket.id === selection.ticketId) ?? null;

  // The address always says what is on screen: what was shown without being
  // named gets named, and what is named without existing any more stops being
  // claimed. Replaced rather than pushed, since the developer did not make this
  // move and has no step here to walk back to. Held until the first snapshot,
  // because everything is unknown while squad has said nothing, and correcting
  // then would erase a link before it could be honoured.
  const shownProjectId = selected?.id ?? null;
  const shownFeatureId = openedFeature?.id ?? null;
  const shownTicketId = openedTicket?.id ?? null;
  useEffect(() => {
    if (!state.loaded || route.screen !== "piloting") return;
    navigate(
      piloting({
        projectId: shownProjectId,
        featureId: shownFeatureId,
        ticketId: shownTicketId,
      }),
      { replace: true },
    );
  }, [state.loaded, route.screen, shownProjectId, shownFeatureId, shownTicketId]);
  // The ground the interface is drawn on, as squad holds it. Held back until the
  // first snapshot: before it the settings are placeholders, and applying them
  // would undo what the bootstrap script painted from the last known theme.
  const theme = state.settings.theme;
  useEffect(() => {
    if (!state.loaded) return;
    applyTheme(theme);
  }, [state.loaded, theme]);
  // The repositories the opened feature carries, named: the graph and the
  // ticket panel say which one a ticket is built in, and both read this.
  const repositoryNames = new Map(
    (openedFeature?.repositories ?? []).map((carried) => [
      carried.projectId,
      projects.find((project) => project.id === carried.projectId)?.name ?? "dépôt inconnu",
    ]),
  );

  // Read once and shared: the waiting indicator lists these, and the map paints
  // the same tickets as waiting on a person. Working the rule out twice would
  // let the two disagree on the very thing squad wakes someone up for.
  const waiting = pendingActions(state.graphs, state.questions);

  /** Opens what an entry of the indicator points at, wherever it lives. */
  function open(action: PendingAction) {
    const feature = features.find((each) => each.id === action.featureId);
    if (!feature) return;
    navigate(
      piloting({
        projectId: feature.projectId,
        featureId: feature.id,
        // Null on a question the main session asked: it hangs on no ticket, and
        // the thread to answer it in is the feature's own.
        ticketId: action.ticketId,
      }),
    );
  }

  // What squad is set up with, asked for one dialog at a time. Registering a
  // repository, opening a feature and resuming a conversation are done once,
  // and the shell owes its height to piloting.
  const [dialog, setDialog] = useState<"project" | "feature" | "recorded" | null>(null);
  // The drawer covers the right of the map permanently, which is right while
  // one reads a ticket and wrong while one reads the whole chantier.
  const [drawerOpen, setDrawerOpen] = useState(true);
  const showDrawer = openedFeature !== null && drawerOpen;
  // How much of the map the drawer hides, so the map can translate a node back
  // into what is left. In pixels because that is what the viewport works in.
  const obstructedRight = showDrawer ? drawerWidth : 0;

  // Escape gives the map back: the ticket closes and the drawer falls back to
  // the thread. Not while a dialog is up, where Escape is the dialog's own.
  useEffect(() => {
    if (openedTicket === null || dialog !== null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      navigate(piloting({ projectId: shownProjectId, featureId: shownFeatureId }));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openedTicket, dialog, shownProjectId, shownFeatureId]);

  return (
    <div className="app">
      <header className="app__header">
        {/* The name is drawn in the lockup, so the heading is for what reads the
            page rather than for what looks at it. */}
        <span className="brand" aria-hidden="true" dangerouslySetInnerHTML={{ __html: lockup }} />
        <h1 className="visually-hidden">squad</h1>
        <p>Poste de pilotage local pour agents claude-code</p>
        <span className={connected ? "badge badge--live" : "badge"}>
          {connected ? "connecté" : "hors ligne"}
        </span>
        <button
          type="button"
          className="link"
          onClick={() => navigate(settingsOpen ? lastPiloting.current : { screen: "settings" })}
        >
          {settingsOpen ? "revenir au pilotage" : "réglages"}
        </button>
        <ThemeSwitch theme={theme} />
      </header>

      {settingsOpen ? (
        <main className="app__screen">
          <SettingsView settings={state.settings} projects={projects} />
        </main>
      ) : (
        /* The work, in one row that fills the shell: what waits on me down the
           left, the map it waits in taking everything else, and the drawer over
           its right edge for the one thing being read. */
        <main className="app__work">
          <aside className="rail">
            <WaitingPanel actions={waiting} features={features} onOpen={open} />

            <section className="panel" aria-labelledby="titre-projets">
              <h2 id="titre-projets">Projets</h2>
              <ul className="list">
                {projects.map((project) => (
                  <li key={project.id}>
                    <button
                      type="button"
                      className={project.id === selected?.id ? "row row--selected" : "row"}
                      onClick={() => navigate(piloting({ projectId: project.id }))}
                      aria-current={project.id === selected?.id}
                    >
                      <span className="row__title">{project.name}</span>
                      <span className="row__detail">{project.path}</span>
                    </button>
                  </li>
                ))}
                {projects.length === 0 && (
                  <li className="empty">Aucun projet enregistré pour l'instant.</li>
                )}
              </ul>
            </section>

            <section className="panel" aria-labelledby="titre-features">
              <h2 id="titre-features">Features</h2>
              {selected ? (
                <ul className="list">
                  {featuresOfProject.map((feature) => (
                    <li key={feature.id}>
                      <button
                        type="button"
                        className={feature.id === openedFeature?.id ? "row row--selected" : "row"}
                        onClick={() =>
                          navigate(piloting({ projectId: selected.id, featureId: feature.id }))
                        }
                        aria-current={feature.id === openedFeature?.id}
                      >
                        <span className="row__title">{feature.title}</span>
                        <span className="row__meta">
                          ouverte le {new Date(feature.createdAt).toLocaleString("fr-FR")}
                        </span>
                      </button>
                    </li>
                  ))}
                  {featuresOfProject.length === 0 && (
                    <li className="empty">Aucune feature en vol sur ce projet.</li>
                  )}
                </ul>
              ) : (
                <p className="empty">Enregistrer un projet pour y ouvrir une feature.</p>
              )}
            </section>

            <div className="rail__setup">
              <button type="button" className="link" onClick={() => setDialog("project")}>
                enregistrer un projet
              </button>
              <button
                type="button"
                className="link"
                disabled={selected === null}
                onClick={() => setDialog("feature")}
              >
                ouvrir une feature
              </button>
              <button type="button" className="link" onClick={() => setDialog("recorded")}>
                reprendre une conversation
              </button>
            </div>
          </aside>

          <section
            className="panel panel--graph"
            aria-labelledby="titre-graphe"
            /* What the drawer covers, so the header and the legend stay out from
               under it while the viewport keeps the full width: resizing it on
               every open would invalidate the framing one has just made. */
            style={{ "--obstructed": `${obstructedRight}px` } as CSSProperties}
          >
            <div className="graph__header">
              <h2 id="titre-graphe">Graphe</h2>
              {openedFeature && (
                <>
                  <p className="panel__context">
                    de <strong>{openedFeature.title}</strong>
                    {openedFeature.repositories.length > 1 && (
                      <span className="row__meta">
                        {" · "}
                        {openedFeature.repositories.length} dépôts :{" "}
                        {openedFeature.repositories
                          .map((carried) => repositoryNames.get(carried.projectId))
                          .join(", ")}
                      </span>
                    )}
                    {openedFeature.repositories.flatMap((carried) =>
                      // Once the graph has drained: one address per repository
                      // squad sent off, and the place the rest of that story is
                      // told.
                      carried.pullRequestUrl === null
                        ? []
                        : [
                            <a
                              key={carried.projectId}
                              className="link"
                              href={carried.pullRequestUrl}
                              target="_blank"
                              rel="noreferrer"
                            >
                              pull request{" "}
                              {openedFeature.repositories.length > 1
                                ? repositoryNames.get(carried.projectId)
                                : ""}
                            </a>,
                          ],
                    )}
                  </p>
                  {/* Beside the map it drives rather than on the feature's row:
                      how much of this chantier runs without me is read where
                      one watches it run. */}
                  <AutonomySwitch feature={openedFeature} />
                </>
              )}
            </div>
            {openedFeature && graph ? (
              <FeatureGraphView
                graph={graph}
                repositoryNames={repositoryNames}
                awaitingDeveloper={ticketsAwaitingDeveloper(waiting)}
                selectedId={openedTicket?.id ?? null}
                obstructedRight={obstructedRight}
                onSelect={(ticketId) =>
                  navigate(
                    piloting({
                      projectId: shownProjectId,
                      featureId: shownFeatureId,
                      ticketId,
                    }),
                  )
                }
                onDeselect={() => {
                  // Only when something is open: a press on the background is
                  // the ordinary way of moving the map, and it would otherwise
                  // stack an identical address in the history at every drag.
                  if (openedTicket === null) return;
                  navigate(piloting({ projectId: shownProjectId, featureId: shownFeatureId }));
                }}
              />
            ) : (
              <p className="empty">Ouvrir une feature pour voir son graphe.</p>
            )}
          </section>

          {openedFeature && (
            <aside
              className="drawer"
              data-open={drawerOpen ? "true" : undefined}
              style={drawerOpen ? { width: drawerWidth } : undefined}
            >
              <button
                type="button"
                className="drawer__handle"
                aria-expanded={drawerOpen}
                onClick={() => setDrawerOpen((open) => !open)}
              >
                {drawerOpen ? "replier le panneau" : "déplier le panneau"}
              </button>
              {drawerOpen &&
                (openedTicket ? (
                  <section className="panel panel--ticket" aria-labelledby="titre-ticket">
                    <h2 id="titre-ticket">Ticket</h2>
                    <TicketPanel
                      ticket={openedTicket}
                      thread={ticketThreadOf(state, openedTicket.id)}
                      questions={ticketQuestionsOf(state, openedTicket.id)}
                      repository={
                        repositoryNames.size > 1
                          ? (repositoryNames.get(openedTicket.projectId) ?? null)
                          : null
                      }
                      onClose={() =>
                        navigate(piloting({ projectId: shownProjectId, featureId: shownFeatureId }))
                      }
                    />
                  </section>
                ) : (
                  <section className="panel panel--session" aria-labelledby="titre-session">
                    <h2 id="titre-session">Session principale</h2>
                    <MainSessionView
                      feature={openedFeature}
                      thread={threadOf(state, openedFeature.id)}
                      questions={featureQuestionsOf(state, openedFeature.id)}
                      running={isMainSessionRunning(state, openedFeature.id)}
                    />
                  </section>
                ))}
            </aside>
          )}
        </main>
      )}

      <Dialog
        title="Enregistrer un projet"
        open={dialog === "project"}
        onClose={() => setDialog(null)}
      >
        <RegisterProjectForm onRegistered={() => setDialog(null)} />
      </Dialog>
      <Dialog title="Ouvrir une feature" open={dialog === "feature"} onClose={() => setDialog(null)}>
        {selected && (
          <OpenFeatureForm
            project={selected}
            projects={projects}
            onOpened={(featureId) => {
              setDialog(null);
              navigate(piloting({ projectId: selected.id, featureId }));
            }}
          />
        )}
      </Dialog>
      <Dialog
        title="Reprendre une conversation"
        open={dialog === "recorded"}
        onClose={() => setDialog(null)}
      >
        <RecordedSessions
          projects={projects}
          onAttached={(feature) => {
            setDialog(null);
            navigate(piloting({ projectId: feature.projectId, featureId: feature.id }));
          }}
        />
      </Dialog>
    </div>
  );
}

/** The three grounds, in the order they are offered. */
const themeLabels: Record<Theme, string> = {
  system: "système",
  light: "clair",
  dark: "sombre",
};

/**
 * Which ground the interface is drawn on. The choice is a squad setting like
 * any other, so it goes to the server and comes back on the event stream: the
 * switch shows what is in force, never what was clicked.
 *
 * Three native radios rather than hand-written ARIA: the arrow keys, the group
 * semantics and the announced state all come for free.
 */
function ThemeSwitch({ theme }: { theme: Theme }) {
  // What was just clicked. A ref rather than state, since the submission reads
  // it when it runs and nothing renders from it.
  const chosen = useRef<Theme>(theme);
  const { error, run } = useSubmission(() => updateSettings({ theme: chosen.current }));

  return (
    <>
      <fieldset className="theme">
        <legend className="visually-hidden">Thème de l'interface</legend>
        {themes.map((option) => (
          <label className="theme__option" key={option}>
            <input
              type="radio"
              name="theme"
              value={option}
              checked={option === theme}
              onChange={() => {
                chosen.current = option;
                void run();
              }}
            />
            <span>{themeLabels[option]}</span>
          </label>
        ))}
      </fieldset>
      <Failure message={error} />
    </>
  );
}

/** What each reason means for the developer, said as the thing they have to do. */
const reasonLabels: Record<PendingReason, string> = {
  question: "question d'un agent",
  validation: "fiche de tests à vérifier",
  decision: "décision à trancher",
  failure: "sous-session arrêtée",
  interruption: "sous-session interrompue",
  conflict: "conflit de fusion à démêler",
};

/**
 * Everything waiting on the developer, all features together and always on
 * screen. It holds nothing of its own: what is listed follows from the graphs,
 * so an entry leaves the moment the thing it points at stops waiting.
 */
function WaitingPanel({
  actions,
  features,
  onOpen,
}: {
  actions: PendingAction[];
  features: Feature[];
  onOpen: (action: PendingAction) => void;
}) {
  return (
    <section className="panel panel--waiting" aria-labelledby="titre-attente">
      <h2 id="titre-attente">Actions en attente</h2>
      {actions.length === 0 ? (
        <p className="empty">Rien n'attend d'action de ma part.</p>
      ) : (
        <ul className="list">
          {actions.map((action) => (
            <li key={`${action.reason}:${action.ticketId ?? action.featureId}:${action.title}`}>
              <button type="button" className="row" onClick={() => onOpen(action)}>
                <span className="row__title">{action.title}</span>
                <span className="row__meta">
                  {reasonLabels[action.reason]}
                  {" · "}
                  {features.find((feature) => feature.id === action.featureId)?.title ??
                    "feature inconnue"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Why the mode stopped, said as the thing the developer has to look at. */
const haltLabels: Record<AutonomyHaltReason, string> = {
  "scope-question": "une question change le périmètre",
  decision: "un ticket de décision attend d'être tranché",
  failure: "un ticket s'est arrêté",
  "depth-cap": "le plafond de profondeur d'engendrement est atteint",
};

/**
 * Go-as-recommended on the feature it drives: squad launches what the frontier
 * allows and answers implementation questions with the agent's own
 * recommendation. What stopped it is read here, and starting it again is what
 * says that is dealt with: nothing else restarts a night of autonomy.
 *
 * One control per state rather than one control that means three things: arming
 * it, taking it back after a stop and stopping it are three decisions, and a
 * button whose meaning depends on what it says is a button read wrong.
 */
function AutonomySwitch({ feature }: { feature: Feature }) {
  const halt = feature.autonomyHalt;
  const arming = useSubmission(() => setGoAsRecommended(feature.id, true));
  const stopping = useSubmission(() => setGoAsRecommended(feature.id, false));
  const busy = arming.busy || stopping.busy;

  return (
    <span className="autonomy">
      {!feature.goAsRecommended && (
        <button type="button" className="chip" disabled={busy} onClick={() => void arming.run()}>
          go-as-recommandé : arrêté
        </button>
      )}
      {feature.goAsRecommended && halt !== null && (
        <>
          <button type="button" className="chip" disabled={busy} onClick={() => void arming.run()}>
            go-as-recommandé : interrompu, relancer
          </button>
          <span className="autonomy__halt">
            {haltLabels[halt.reason]} : « {halt.detail} »
          </span>
        </>
      )}
      {feature.goAsRecommended && halt === null && (
        <span className="chip chip--armed">go-as-recommandé : en cours</span>
      )}
      {feature.goAsRecommended && (
        <button
          type="button"
          className="link"
          disabled={busy}
          onClick={() => void stopping.run()}
        >
          arrêter
        </button>
      )}
      <Failure message={arming.error ?? stopping.error} />
    </span>
  );
}

function RegisterProjectForm({ onRegistered }: { onRegistered: () => void }) {
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const { busy, error, submit } = useSubmission(async () => {
    await registerProject({ path, ...(name.trim() ? { name } : {}) });
    setPath("");
    setName("");
    onRegistered();
  });

  return (
    <form className="form" onSubmit={submit}>
      <label className="field">
        <span>Chemin du dépôt</span>
        <input
          value={path}
          onChange={(event) => setPath(event.target.value)}
          placeholder="/home/moi/projets/mon-depot"
          required
        />
      </label>
      <label className="field">
        <span>Nom (facultatif)</span>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="repris du dossier si vide"
        />
      </label>
      <button type="submit" disabled={busy}>
        Enregistrer le projet
      </button>
      <Failure message={error} />
    </form>
  );
}

/**
 * Opening a feature: its title, and the repositories beyond its own it is
 * allowed to touch. In a dialog, since one opens a feature once and pilots it
 * all day; the features themselves are listed in the rail.
 */
function OpenFeatureForm({
  project,
  projects,
  onOpened,
}: {
  project: Project;
  /** Every registered project, since a feature may carry more than its own. */
  projects: Project[];
  onOpened: (featureId: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [alsoOn, setAlsoOn] = useState<string[]>([]);
  const others = projects.filter((each) => each.id !== project.id);
  const { busy, error, submit } = useSubmission(async () => {
    const created = await openFeature({
      projectId: project.id,
      title,
      otherProjectIds: alsoOn,
    });
    setTitle("");
    setAlsoOn([]);
    onOpened(created.id);
  });

  return (
    <>
      <p className="panel__context">
        sur <strong>{project.name}</strong>
      </p>
      <form className="form" onSubmit={submit}>
        <label className="field">
          <span>Intitulé de la feature</span>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Fondation : squelette et stockage"
            required
          />
        </label>
        {others.length > 0 && (
          <fieldset className="field">
            <legend>Autres dépôts que cette feature peut toucher</legend>
            {others.map((other) => (
              <label key={other.id} className="field field--check">
                <input
                  type="checkbox"
                  checked={alsoOn.includes(other.id)}
                  onChange={(event) =>
                    setAlsoOn((current) =>
                      event.target.checked
                        ? [...current, other.id]
                        : current.filter((id) => id !== other.id),
                    )
                  }
                />
                <span>{other.name}</span>
              </label>
            ))}
          </fieldset>
        )}
        <button type="submit" disabled={busy}>
          Ouvrir la feature
        </button>
        <Failure message={error} />
      </form>
    </>
  );
}
