import { useState } from "react";
import type { Feature, Project, RecordedSession } from "../../shared/api";
import { feature as featureRoute, home } from "../../shared/ui-routes";
import {
  attachRecordedSession,
  openFeature,
  registerProject,
  startMainSession,
  updateProject,
} from "../api";
import { Brand, Connection, ThemeSwitch } from "../chrome";
import { navigate } from "../route";
import { RecordedSessionPicker } from "../session/RecordedSessionPicker";
import { openFeatureTab } from "../tab";
import { Failure, useSubmission } from "../submission";
import type { SquadState } from "../useSquadState";

/**
 * Opening a feature, from nothing or from a conversation already had.
 *
 * One screen and one form, with the origin chosen at the top: what a feature is
 * configured with does not depend on where its thread starts, so asking twice
 * would be asking the same questions in two places and letting them drift.
 *
 * A screen rather than a dialog, and an address of its own: it is rechargeable,
 * the back button cancels it, and it is the one screen where a repository squad
 * has never seen can be handed over without leaving what one was doing.
 */

type Origin = "blank" | "recorded";

export function NewFeatureView({ state }: { state: SquadState }) {
  const { projects } = state;
  const [origin, setOrigin] = useState<Origin>("blank");
  const [recorded, setRecorded] = useState<RecordedSession | null>(null);

  const [title, setTitle] = useState("");
  // Which registered project the feature hangs on, or the empty string while a
  // path is being typed for a repository squad does not drive yet.
  const [homeProjectId, setHomeProjectId] = useState("");
  // Whether the choice has been made rather than merely offered. The projects
  // arrive on the event stream, so the first render has none of them: without
  // this the form would settle on "a repository squad does not drive yet" and
  // stay there, on a machine that drives four.
  const [chose, setChose] = useState(false);
  if (!chose && homeProjectId === "" && projects.length > 0) {
    setChose(true);
    setHomeProjectId(projects[0]?.id ?? "");
  }
  const [newPath, setNewPath] = useState("");
  const [alsoOn, setAlsoOn] = useState<string[]>([]);
  const [goAsRecommended, setGoAsRecommended] = useState(false);
  const [prompt, setPrompt] = useState("");

  const chosenProject = projects.find((project) => project.id === homeProjectId) ?? null;
  // The repository a conversation ran in, which is where it will be resumed:
  // shown, never offered as a choice. Resuming it anywhere else is not possible.
  const forcedRepository =
    origin === "recorded" && recorded !== null ? (recorded.repository ?? recorded.cwd) : null;
  const recordedProject =
    forcedRepository === null
      ? null
      : (projects.find((project) => project.path === forcedRepository) ?? null);
  // Whose settings the two fields below edit, when there is one to edit yet.
  const settingsOf = origin === "recorded" ? recordedProject : chosenProject;

  const [defaultBranch, setDefaultBranch] = useState("");
  const [verifyCommand, setVerifyCommand] = useState("");
  // Taken from the project as soon as one is settled on, and only then: typing
  // into these must not be undone by a render.
  const [readFrom, setReadFrom] = useState<string | null>(null);
  if (settingsOf !== null && readFrom !== settingsOf.id) {
    setReadFrom(settingsOf.id);
    setDefaultBranch(settingsOf.defaultBranch);
    setVerifyCommand(settingsOf.verifyCommand ?? "");
  }

  const others = projects.filter((project) => project.id !== settingsOf?.id);

  const { busy, error, submit } = useSubmission(async () => {
    const opened = origin === "recorded" ? await resumeIt() : await openIt();
    // The repository's own settings, applied once squad has a project to apply
    // them to: on the recorded path that is only true after the attachment,
    // which is what registered the repository.
    await applySettings(opened.project);
    // Starting the thread is not configuring the feature, so it is its own
    // request: a session that fails to open leaves a feature configured exactly
    // as asked, which is where a main session that fails to open already leaves
    // things.
    if (prompt.trim() !== "") await startMainSession(opened.feature.id, { prompt });
    // Back to the list, and the work opened in its own tab: the gesture ends
    // where the work starts, and the home screen stays what one comes back to.
    navigate(home());
    openFeatureTab(featureRoute(opened.feature.id));
  });

  async function openIt(): Promise<{ project: Project; feature: Feature }> {
    const project =
      chosenProject ??
      // A repository squad has never seen, handed over as part of the gesture
      // that needs it: sending the developer to the settings screen in the
      // middle of opening a feature would lose what they had already typed.
      (await registerProject({ path: newPath }));
    const feature = await openFeature({
      projectId: project.id,
      title,
      otherProjectIds: alsoOn.filter((id) => id !== project.id),
      goAsRecommended,
    });
    return { project, feature };
  }

  async function resumeIt(): Promise<{ project: Project; feature: Feature }> {
    if (recorded === null) throw new Error("no conversation chosen");
    return attachRecordedSession(recorded.id, {
      ...(title.trim() === "" ? {} : { title }),
      otherProjectIds: alsoOn,
      goAsRecommended,
    });
  }

  async function applySettings(project: Project): Promise<void> {
    const branch = defaultBranch.trim() === "" ? project.defaultBranch : defaultBranch;
    const command = verifyCommand.trim();
    if (branch === project.defaultBranch && command === (project.verifyCommand ?? "")) return;
    await updateProject(project.id, { defaultBranch: branch, verifyCommand: command });
  }

  const named = title.trim() !== "" || (origin === "recorded" && recorded !== null);
  const sited = origin === "recorded" ? recorded !== null : chosenProject !== null || newPath.trim() !== "";

  return (
    <div className="app">
      <header className="app__header">
        <Brand onClick={() => navigate(home())} />
        <h1 className="app__subject">Nouvelle feature</h1>
        <p className="app__tagline">
          Un chantier, du spec jusqu'à la fusion. Il part de rien, ou d'une conversation
          claude-code déjà menée.
        </p>
        <Connection connected={state.connected} />
        <ThemeSwitch theme={state.settings.theme} />
        <button type="button" className="link" onClick={() => navigate(home())}>
          revenir à l'accueil
        </button>
      </header>

      <main className="app__screen">
        <form className="form form--wide" onSubmit={submit}>
          <fieldset className="field">
            <legend>D'où part cette feature</legend>
            <label className="field field--check">
              <input
                type="radio"
                name="origine"
                checked={origin === "blank"}
                onChange={() => setOrigin("blank")}
              />
              <span>Partir de zéro</span>
            </label>
            <label className="field field--check">
              <input
                type="radio"
                name="origine"
                checked={origin === "recorded"}
                onChange={() => setOrigin("recorded")}
              />
              <span>Reprendre une conversation claude-code</span>
            </label>
          </fieldset>

          {origin === "recorded" ? (
            <>
              <RecordedSessionPicker
                projects={projects}
                chosen={recorded}
                onChoose={setRecorded}
              />
              {forcedRepository !== null && (
                <p className="panel__context">
                  Dépôt d'attache : <strong>{forcedRepository}</strong>
                  <span className="row__meta">
                    {recordedProject === null
                      ? "pas encore enregistré, le rattachement s'en charge"
                      : "déjà piloté par squad"}
                    . Une conversation reprise repart dans son propre répertoire : ce dépôt ne
                    se choisit pas.
                  </span>
                </p>
              )}
            </>
          ) : (
            <fieldset className="field">
              <legend>Dépôt d'attache</legend>
              {projects.map((project) => (
                <label key={project.id} className="field field--check">
                  <input
                    type="radio"
                    name="attache"
                    checked={homeProjectId === project.id}
                    onChange={() => {
                      setChose(true);
                      setHomeProjectId(project.id);
                      setNewPath("");
                    }}
                  />
                  <span>
                    {project.name}
                    <span className="row__meta"> {project.path}</span>
                  </span>
                </label>
              ))}
              <label className="field field--check">
                <input
                  type="radio"
                  name="attache"
                  checked={homeProjectId === ""}
                  onChange={() => {
                    setChose(true);
                    setHomeProjectId("");
                  }}
                />
                <span>Un dépôt que squad ne pilote pas encore</span>
              </label>
              {homeProjectId === "" && (
                <label className="field">
                  <span>Chemin du dépôt</span>
                  <input
                    value={newPath}
                    onChange={(event) => setNewPath(event.target.value)}
                    placeholder="/home/moi/projets/mon-depot"
                    required
                  />
                </label>
              )}
            </fieldset>
          )}

          <label className="field">
            <span>
              Intitulé de la feature
              {origin === "recorded" && " (vide : celui de la conversation)"}
            </span>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Fondation : squelette et stockage"
              required={origin === "blank"}
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

          <label className="field field--check">
            <input
              type="checkbox"
              checked={goAsRecommended}
              onChange={(event) => setGoAsRecommended(event.target.checked)}
            />
            <span>
              Partir en go-as-recommandé : squad lance seul ce que la frontière permet et répond
              aux questions d'implémentation par la recommandation de l'agent.
            </span>
          </label>

          <fieldset className="field">
            <legend>Réglages du dépôt d'attache</legend>
            <label className="field">
              <span>Branche par défaut</span>
              <input
                value={defaultBranch}
                onChange={(event) => setDefaultBranch(event.target.value)}
                placeholder="main"
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
            {verifyCommand.trim() === "" && (
              <p className="settings__note">
                Sans commande de vérification, rien ne tourne après une fusion, donc rien n'est
                jamais rouge : c'est le seul filet qui attrape ce que deux tranches vertes
                séparément cassent ensemble, et sur un dépôt sans intégration continue c'est
                aussi le seul qui précède la fusion automatique de la pull request.
              </p>
            )}
          </fieldset>

          <label className="field">
            <span>Premier message de la session principale (facultatif)</span>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={5}
              placeholder={
                origin === "recorded"
                  ? "ce qu'on reprend, ou /to-tickets pour découper le spec déjà écrit"
                  : "le spec à coller, puis /to-tickets pour le découper"
              }
            />
            <span className="row__meta">
              Rempli, la session principale démarre avec. Une conversation reprise n'est
              réellement relancée que par ce premier message.
            </span>
          </label>

          <button type="submit" disabled={busy || !named || !sited}>
            Ouvrir la feature
          </button>
          <Failure message={error} />
        </form>
      </main>
    </div>
  );
}
