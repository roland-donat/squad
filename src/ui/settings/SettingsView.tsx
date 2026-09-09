import { useEffect, useState } from "react";
import type { Project, Settings } from "../../shared/api";
import { registerProject, updateProject, updateSettings } from "../api";
import { Failure, useSubmission } from "../submission";

/**
 * Everything squad is configured with, in one place: what holds for the machine
 * and what holds for one project. Nothing is read from the environment, so what
 * is in force is what is on this screen, and changing it here is the only way
 * it changes.
 *
 * A field holds what is being typed into it, and takes what the server holds
 * back whenever that changes: the settings arrive on the event stream like
 * everything else, and a screen showing a value squad no longer applies is a
 * screen that lies about what is in force.
 */
export function SettingsView({
  settings,
  projects,
}: {
  settings: Settings;
  projects: Project[];
}) {
  return (
    <div className="app__settings">
      <section className="panel" aria-labelledby="titre-reglages-machine">
        <h2 id="titre-reglages-machine">Réglages de la machine</h2>
        <p className="panel__context">
          Ce qui vaut pour tous les projets et toutes les features.
        </p>
        <MachineForm settings={settings} />
      </section>

      <section className="panel" aria-labelledby="titre-reglages-projets">
        <h2 id="titre-reglages-projets">Dépôts pilotés</h2>
        <p className="panel__context">
          Un dépôt entre ici, ou au passage quand une feature en nomme un que squad ne pilote
          pas encore.
        </p>
        <RegisterProjectForm />
        {projects.length === 0 ? (
          <p className="empty">Aucun projet enregistré pour l'instant.</p>
        ) : (
          projects.map((project) => (
            <ProjectForm key={project.id} project={project} />
          ))
        )}
      </section>
    </div>
  );
}

/**
 * Handing squad a repository, which is the one thing that has to happen before
 * anything else. Here rather than on a screen one pilots from: it is done once
 * per repository, and the creation screen does it in passing for the repository
 * a feature actually names.
 */
function RegisterProjectForm() {
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const { busy, error, submit } = useSubmission(async () => {
    await registerProject({ path, ...(name.trim() ? { name } : {}) });
    setPath("");
    setName("");
  });

  return (
    <form className="form settings__project" onSubmit={submit}>
      <fieldset>
        <legend>Enregistrer un dépôt</legend>
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
      </fieldset>
    </form>
  );
}

function MachineForm({ settings }: { settings: Settings }) {
  const [webhookUrl, setWebhookUrl] = useState(settings.webhookUrl ?? "");
  const [desktop, setDesktop] = useState(settings.desktopNotifications);
  const [machineCap, setMachineCap] = useState(String(settings.machineConcurrencyCap));
  const [depthCap, setDepthCap] = useState(String(settings.generationDepthCap));
  useEffect(() => {
    setWebhookUrl(settings.webhookUrl ?? "");
    setDesktop(settings.desktopNotifications);
    setMachineCap(String(settings.machineConcurrencyCap));
    setDepthCap(String(settings.generationDepthCap));
  }, [
    settings.webhookUrl,
    settings.desktopNotifications,
    settings.machineConcurrencyCap,
    settings.generationDepthCap,
  ]);
  const { busy, error, done, submit } = useSubmission(async () => {
    await updateSettings({
      // Empty clears it: an alert then goes to the desktop and nowhere else.
      webhookUrl: webhookUrl.trim() === "" ? null : webhookUrl.trim(),
      desktopNotifications: desktop,
      machineConcurrencyCap: Number(machineCap),
      generationDepthCap: Number(depthCap),
    });
  });

  return (
    <form className="form" onSubmit={submit}>
      <label className="field">
        <span>URL du webhook d'alerte</span>
        <input
          value={webhookUrl}
          onChange={(event) => setWebhookUrl(event.target.value)}
          placeholder="vide : les alertes ne partent que sur le bureau"
        />
      </label>
      <label className="field field--check">
        <input
          type="checkbox"
          checked={desktop}
          onChange={(event) => setDesktop(event.target.checked)}
        />
        <span>Notifier aussi sur le bureau de cette machine</span>
      </label>
      <label className="field">
        <span>Sous-sessions simultanées sur la machine</span>
        <input
          type="number"
          min={1}
          value={machineCap}
          onChange={(event) => setMachineCap(event.target.value)}
        />
      </label>
      <label className="field">
        <span>Profondeur d'engendrement maximale</span>
        <input
          type="number"
          min={0}
          value={depthCap}
          onChange={(event) => setDepthCap(event.target.value)}
        />
      </label>
      <button type="submit" disabled={busy}>
        Enregistrer les réglages
      </button>
      <Outcome error={error} saved={done} />
    </form>
  );
}

function ProjectForm({ project }: { project: Project }) {
  const [path, setPath] = useState(project.path);
  const [defaultBranch, setDefaultBranch] = useState(project.defaultBranch);
  const [verifyCommand, setVerifyCommand] = useState(project.verifyCommand ?? "");
  const [cap, setCap] = useState(String(project.featureConcurrencyCap));
  useEffect(() => {
    setPath(project.path);
    setDefaultBranch(project.defaultBranch);
    setVerifyCommand(project.verifyCommand ?? "");
    setCap(String(project.featureConcurrencyCap));
  }, [project.path, project.defaultBranch, project.verifyCommand, project.featureConcurrencyCap]);
  const { busy, error, done, submit } = useSubmission(async () => {
    await updateProject(project.id, {
      path,
      defaultBranch,
      verifyCommand,
      featureConcurrencyCap: Number(cap),
    });
  });

  return (
    <form className="form settings__project" onSubmit={submit}>
      <fieldset>
        <legend>{project.name}</legend>
        <label className="field">
          <span>Chemin du dépôt</span>
          <input value={path} onChange={(event) => setPath(event.target.value)} required />
        </label>
        <label className="field">
          <span>Branche par défaut</span>
          <input
            value={defaultBranch}
            onChange={(event) => setDefaultBranch(event.target.value)}
            required
          />
        </label>
        <label className="field">
          <span>Commande de vérification</span>
          <input
            value={verifyCommand}
            onChange={(event) => setVerifyCommand(event.target.value)}
            placeholder="pnpm verify"
          />
        </label>
        <p className="settings__note">
          Sans commande de vérification, rien ne tourne après une fusion : c'est le seul filet qui
          attrape ce que deux tranches vertes séparément cassent ensemble.
        </p>
        <label className="field">
          <span>Sous-sessions simultanées par feature</span>
          <input
            type="number"
            min={1}
            value={cap}
            onChange={(event) => setCap(event.target.value)}
          />
        </label>
        <button type="submit" disabled={busy}>
          Enregistrer le projet
        </button>
        <Outcome error={error} saved={done} />
      </fieldset>
    </form>
  );
}

/** What a submission left behind: a failure to read, or a change that took. */
function Outcome({ error, saved }: { error: string | null; saved: boolean }) {
  if (error !== null) return <Failure message={error} />;
  if (!saved) return null;
  return (
    <p className="settings__saved" role="status">
      Enregistré.
    </p>
  );
}
