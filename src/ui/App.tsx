import { useState, type FormEvent } from "react";
import type { Feature, Project } from "../shared/api";
import { ApiError, openFeature, registerProject } from "./api";
import { useSquadState } from "./useSquadState";

export function App() {
  const { projects, features, connected } = useSquadState();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = projects.find((project) => project.id === selectedId) ?? projects[0] ?? null;

  return (
    <div className="app">
      <header className="app__header">
        <h1>squad</h1>
        <p>Poste de pilotage local pour agents claude-code</p>
        <span className={connected ? "badge badge--live" : "badge"}>
          {connected ? "connecté" : "hors ligne"}
        </span>
      </header>

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
                  <span className="row__meta">branche {project.defaultBranch}</span>
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
              features={features.filter((feature) => feature.projectId === selected.id)}
            />
          ) : (
            <p className="empty">Enregistrer un projet pour y ouvrir une feature.</p>
          )}
        </section>
      </main>
    </div>
  );
}

function RegisterProjectForm() {
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await registerProject({ path, ...(name.trim() ? { name } : {}) });
      setPath("");
      setName("");
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "Le serveur est injoignable.");
    } finally {
      setBusy(false);
    }
  }

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
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function FeaturesPanel({ project, features }: { project: Project; features: Feature[] }) {
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await openFeature({ projectId: project.id, title });
      setTitle("");
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "Le serveur est injoignable.");
    } finally {
      setBusy(false);
    }
  }

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
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </form>
      <ul className="list">
        {features.map((feature) => (
          <li key={feature.id}>
            <div className="row row--static">
              <span className="row__title">{feature.title}</span>
              <span className="row__meta">
                ouverte le {new Date(feature.createdAt).toLocaleString("fr-FR")}
              </span>
            </div>
          </li>
        ))}
        {features.length === 0 && <li className="empty">Aucune feature en vol sur ce projet.</li>}
      </ul>
    </>
  );
}
