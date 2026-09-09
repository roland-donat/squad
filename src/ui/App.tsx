import { useEffect, useRef, useState } from "react";
import { themes, type AutonomyHaltReason, type Feature, type Project, type Theme } from "../shared/api";
import { pendingActions, type PendingAction, type PendingReason } from "../shared/pending";
import { ticketsAwaitingDeveloper } from "../shared/state-family";
import { piloting, type PilotingRoute } from "../shared/ui-routes";
import { openFeature, registerProject, setGoAsRecommended, updateSettings } from "./api";
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

      {settingsOpen && <SettingsView settings={state.settings} projects={projects} />}

      {/* The work, in one row and above everything else: what waits on me, the
          graph it waits in, and the thread it is settled in. What squad is set
          up with lives below, since setting it up is not piloting it. */}
      <main className="app__work" hidden={settingsOpen}>
        <WaitingPanel
          actions={waiting}
          features={features}
          onOpen={open}
        />
        <section className="panel panel--graph" aria-labelledby="titre-graphe">
          <h2 id="titre-graphe">Graphe</h2>
          {openedFeature && graph ? (
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
                  // Once the graph has drained: one address per repository squad
                  // sent off, and the place the rest of that story is told.
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
              <FeatureGraphView
                graph={graph}
                repositoryNames={repositoryNames}
                awaitingDeveloper={ticketsAwaitingDeveloper(waiting)}
                selectedId={openedTicket?.id ?? null}
                onSelect={(ticketId) =>
                  navigate(
                    piloting({
                      projectId: shownProjectId,
                      featureId: shownFeatureId,
                      ticketId,
                    }),
                  )
                }
              />
            </>
          ) : (
            <p className="empty">Ouvrir une feature pour voir son graphe.</p>
          )}
        </section>

        {openedTicket ? (
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
            {openedFeature ? (
              <MainSessionView
                feature={openedFeature}
                thread={threadOf(state, openedFeature.id)}
                questions={featureQuestionsOf(state, openedFeature.id)}
                running={isMainSessionRunning(state, openedFeature.id)}
              />
            ) : (
              <p className="empty">Ouvrir une feature pour lui parler.</p>
            )}
          </section>
        )}
      </main>

      {/* What squad is set up with, under the work rather than above it:
          registering a repository, opening a feature and resuming a
          conversation are what one does once, and piloting is what one does
          all day. */}
      <aside className="app__setup" hidden={settingsOpen}>
        <section className="panel" aria-labelledby="titre-projets">
          <h2 id="titre-projets">Projets</h2>
          <RegisterProjectForm />
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
            <FeaturesPanel
              project={selected}
              projects={projects}
              features={featuresOfProject}
              openedId={openedFeature?.id ?? null}
              onOpen={(featureId) => navigate(piloting({ projectId: selected.id, featureId }))}
            />
          ) : (
            <p className="empty">Enregistrer un projet pour y ouvrir une feature.</p>
          )}
        </section>
        <RecordedSessions
          projects={projects}
          onAttached={(feature) =>
            navigate(piloting({ projectId: feature.projectId, featureId: feature.id }))
          }
        />
      </aside>
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

function RegisterProjectForm() {
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const { busy, error, submit } = useSubmission(async () => {
    await registerProject({ path, ...(name.trim() ? { name } : {}) });
    setPath("");
    setName("");
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

function FeaturesPanel({
  project,
  projects,
  features,
  openedId,
  onOpen,
}: {
  project: Project;
  /** Every registered project, since a feature may carry more than its own. */
  projects: Project[];
  features: Feature[];
  openedId: string | null;
  onOpen: (featureId: string) => void;
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
    onOpen(created.id);
    setTitle("");
    setAlsoOn([]);
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
      <ul className="list">
        {features.map((feature) => (
          <li key={feature.id}>
            <button
              type="button"
              className={feature.id === openedId ? "row row--selected" : "row"}
              onClick={() => onOpen(feature.id)}
              aria-current={feature.id === openedId}
            >
              <span className="row__title">{feature.title}</span>
              <span className="row__meta">
                ouverte le {new Date(feature.createdAt).toLocaleString("fr-FR")}
              </span>
            </button>
            {/* On the feature rather than beside its graph: how much of it runs
                without me is a property of the piece of work, and the graph
                panel holds the graph and nothing else. */}
            {feature.id === openedId && <AutonomySwitch feature={feature} />}
          </li>
        ))}
        {features.length === 0 && <li className="empty">Aucune feature en vol sur ce projet.</li>}
      </ul>
    </>
  );
}
