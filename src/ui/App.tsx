import { useState } from "react";
import type { AutonomyHaltReason, Feature, Project } from "../shared/api";
import { pendingActions, type PendingAction, type PendingReason } from "../shared/pending";
import { openFeature, registerProject, setGoAsRecommended } from "./api";
import { FeatureGraphView } from "./graph/FeatureGraphView";
import { Failure, useSubmission } from "./submission";
import { MainSessionView } from "./session/MainSessionView";
import { RecordedSessions } from "./session/RecordedSessions";
import { SettingsView } from "./settings/SettingsView";
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [openFeatureId, setOpenFeatureId] = useState<string | null>(null);
  const [openTicketId, setOpenTicketId] = useState<string | null>(null);
  // Which of the two screens is up. Squad is one page: piloting is what it is
  // for, and the settings are what it is configured with, so they take the
  // place of the panels rather than sitting among them.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const selected = projects.find((project) => project.id === selectedId) ?? projects[0] ?? null;
  const featuresOfProject = features.filter((feature) => feature.projectId === selected?.id);
  const openedFeature =
    featuresOfProject.find((feature) => feature.id === openFeatureId) ?? featuresOfProject[0] ?? null;
  const graph = openedFeature ? graphOf(state, openedFeature.id) : null;
  // Read back from the graph at every render rather than held in state: a ticket
  // that changes state while its panel is open must show the change, and the
  // panel must close itself if the ticket leaves the feature being watched.
  const openedTicket = graph?.tickets.find((ticket) => ticket.id === openTicketId) ?? null;
  // The repositories the opened feature carries, named: the graph and the
  // ticket panel say which one a ticket is built in, and both read this.
  const repositoryNames = new Map(
    (openedFeature?.repositories ?? []).map((carried) => [
      carried.projectId,
      projects.find((project) => project.id === carried.projectId)?.name ?? "dépôt inconnu",
    ]),
  );

  /** Opens what an entry of the indicator points at, wherever it lives. */
  function open(action: PendingAction) {
    const feature = features.find((each) => each.id === action.featureId);
    if (feature) setSelectedId(feature.projectId);
    setSettingsOpen(false);
    setOpenFeatureId(action.featureId);
    // Null on a question the main session asked: it hangs on no ticket, and the
    // thread to answer it in is the feature's own.
    setOpenTicketId(action.ticketId);
  }

  return (
    <div className="app">
      <header className="app__header">
        <h1>squad</h1>
        <p>Poste de pilotage local pour agents claude-code</p>
        <span className={connected ? "badge badge--live" : "badge"}>
          {connected ? "connecté" : "hors ligne"}
        </span>
        <button type="button" className="link" onClick={() => setSettingsOpen(!settingsOpen)}>
          {settingsOpen ? "revenir au pilotage" : "réglages"}
        </button>
      </header>

      <WaitingPanel
        actions={pendingActions(state.graphs, state.questions)}
        features={features}
        onOpen={open}
      />

      {settingsOpen && <SettingsView settings={state.settings} projects={projects} />}

      {!settingsOpen && (
        // Above the graph and under the two panels that hold what squad already
        // drives: this is where a feature comes from when it comes from work
        // already done at the terminal.
        <RecordedSessions
          onAttached={(feature) => {
            setSelectedId(feature.projectId);
            setOpenFeatureId(feature.id);
            setOpenTicketId(null);
          }}
        />
      )}

      <main className="app__body" hidden={settingsOpen}>
        <section className="panel" aria-labelledby="titre-projets">
          <h2 id="titre-projets">Projets</h2>
          <RegisterProjectForm />
          <ul className="list">
            {projects.map((project) => (
              <li key={project.id}>
                <button
                  type="button"
                  className={project.id === selected?.id ? "row row--selected" : "row"}
                  onClick={() => setSelectedId(project.id)}
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
              onOpen={setOpenFeatureId}
            />
          ) : (
            <p className="empty">Enregistrer un projet pour y ouvrir une feature.</p>
          )}
        </section>
      </main>

      <div className="app__feature" hidden={settingsOpen}>
        <section className="panel panel--graph" aria-labelledby="titre-graphe">
          <h2 id="titre-graphe">Graphe</h2>
          {openedFeature && graph ? (
            <>
              <p className="panel__context">
                de <strong>{openedFeature.title}</strong>
                {openedFeature.repositories.length > 1 && (
                  <span className="row__meta">
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
                selectedId={openedTicket?.id ?? null}
                onSelect={setOpenTicketId}
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
              onClose={() => setOpenTicketId(null)}
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
      </div>
    </div>
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
      <h2 id="titre-attente">En attente de moi</h2>
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
