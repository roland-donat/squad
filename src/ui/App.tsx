import { useState, type FormEvent } from "react";
import type { Feature, Project } from "../shared/api";
import type { PendingAction, PendingReason } from "../shared/pending";
import { ApiError, openFeature, registerProject } from "./api";
import { FeatureGraphView } from "./graph/FeatureGraphView";
import { MainSessionView } from "./session/MainSessionView";
import { TicketPanel } from "./ticket/TicketPanel";
import {
  graphOf,
  isMainSessionRunning,
  threadOf,
  ticketThreadOf,
  useSquadState,
  waitingOn,
} from "./useSquadState";

export function App() {
  const state = useSquadState();
  const { projects, features, connected } = state;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [openFeatureId, setOpenFeatureId] = useState<string | null>(null);
  const [openTicketId, setOpenTicketId] = useState<string | null>(null);
  const selected = projects.find((project) => project.id === selectedId) ?? projects[0] ?? null;
  const featuresOfProject = features.filter((feature) => feature.projectId === selected?.id);
  const openedFeature =
    featuresOfProject.find((feature) => feature.id === openFeatureId) ?? featuresOfProject[0] ?? null;
  const graph = openedFeature ? graphOf(state, openedFeature.id) : null;
  // Read back from the graph at every render rather than held in state: a ticket
  // that changes state while its panel is open must show the change, and the
  // panel must close itself if the ticket leaves the feature being watched.
  const openedTicket = graph?.tickets.find((ticket) => ticket.id === openTicketId) ?? null;

  /** Opens what an entry of the indicator points at, wherever it lives. */
  function open(action: PendingAction) {
    const feature = features.find((each) => each.id === action.featureId);
    if (feature) setSelectedId(feature.projectId);
    setOpenFeatureId(action.featureId);
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
      </header>

      <WaitingPanel actions={waitingOn(state)} features={features} onOpen={open} />

      <main className="app__body">
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
              features={featuresOfProject}
              openedId={openedFeature?.id ?? null}
              onOpen={setOpenFeatureId}
            />
          ) : (
            <p className="empty">Enregistrer un projet pour y ouvrir une feature.</p>
          )}
        </section>
      </main>

      <div className="app__feature">
        <section className="panel panel--graph" aria-labelledby="titre-graphe">
          <h2 id="titre-graphe">Graphe</h2>
          {openedFeature && graph ? (
            <>
              <p className="panel__context">
                de <strong>{openedFeature.title}</strong>
              </p>
              <FeatureGraphView
                graph={graph}
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
  validation: "fiche de tests à vérifier",
  decision: "décision à trancher",
  failure: "sous-session arrêtée",
  interruption: "sous-session interrompue",
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
            <li key={action.ticketId}>
              <button type="button" className="row" onClick={() => onOpen(action)}>
                <span className="row__title">{action.ticketTitle}</span>
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

/**
 * Submission state shared by every form: an action in flight, and the failure it
 * may come back with, rendered from the error code the server sent.
 */
function useSubmission(action: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "Le serveur est injoignable.");
    } finally {
      setBusy(false);
    }
  }

  return { busy, error, submit };
}

function Failure({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p className="error" role="alert">
      {message}
    </p>
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
  features,
  openedId,
  onOpen,
}: {
  project: Project;
  features: Feature[];
  openedId: string | null;
  onOpen: (featureId: string) => void;
}) {
  const [title, setTitle] = useState("");
  const { busy, error, submit } = useSubmission(async () => {
    const created = await openFeature({ projectId: project.id, title });
    onOpen(created.id);
    setTitle("");
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
          </li>
        ))}
        {features.length === 0 && <li className="empty">Aucune feature en vol sur ce projet.</li>}
      </ul>
    </>
  );
}
