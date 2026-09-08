import { afterEach, describe, expect, it } from "vitest";
import type { Feature, Project, RecordedSession, ThreadEntry } from "../../src/shared/api";
import { apiRoutes, attachRecordedSessionRoute } from "../../src/shared/api";
import { createTemporaryRepository } from "../support/git";
import { writeRecordedSessions, type RecordedSessionSpec } from "../support/recorded-sessions";
import { createScriptedLauncher, type ScriptedAgent } from "../support/scripted-launcher";
import { startTestSquad, type TestSquad } from "../support/squad";

/**
 * A feature that starts from work already done. The grilling and the spec are
 * written at the terminal, which is out of squad's first milestone on purpose;
 * what squad owes is the door between that conversation and a graph. Attaching
 * one opens a feature whose main session is that very conversation, resumed.
 *
 * Everything underneath is real: a directory shaped like the one claude-code
 * keeps, real transcripts on disk, a real git repository, and the scripted
 * launcher standing in for the model alone.
 */
describe("resuming a recorded conversation", () => {
  let squad: TestSquad;
  const parked: Array<() => void> = [];

  afterEach(async () => {
    for (const open of parked) open();
    parked.length = 0;
    await squad.dispose();
  });

  /** What squad was asked to open, which is where a resume is read from. */
  interface Opened {
    resumeSessionId: string | undefined;
    workingDirectory: string;
  }

  async function start(
    sessions: RecordedSessionSpec[],
    options: { withoutDirectory?: boolean } = {},
  ): Promise<{ opened: Opened[] }> {
    const opened: Opened[] = [];
    const recordedSessionsDir = options.withoutDirectory
      ? "/tmp/squad-aucune-conversation-enregistree"
      : await writeRecordedSessions(sessions);
    squad = await startTestSquad({
      recordedSessionsDir,
      launcher: createScriptedLauncher(async (agent: ScriptedAgent) => {
        opened.push({
          resumeSessionId: agent.request.resumeSessionId,
          workingDirectory: agent.request.workingDirectory,
        });
        // Parked: what matters is what squad opened, not what the session does.
        await new Promise<void>((resolve) => parked.push(resolve));
      }),
    });
    return { opened };
  }

  async function list(search?: string): Promise<RecordedSession[]> {
    const route =
      search === undefined
        ? apiRoutes.recordedSessions
        : `${apiRoutes.recordedSessions}?search=${encodeURIComponent(search)}`;
    const response = await squad.request("GET", route);
    expect(response.status).toBe(200);
    const { sessions } = (await response.json()) as { sessions: RecordedSession[] };
    return sessions;
  }

  /** The whole thread of a feature, as a fresh connection is handed it. */
  async function readThread(featureId: string): Promise<ThreadEntry[]> {
    const stream = await squad.openEventStream();
    const snapshot = await stream.next();
    if (snapshot.type !== "snapshot") throw new Error("the first event is always a snapshot");
    return snapshot.threads.filter((entry) => entry.featureId === featureId);
  }

  /** Twelve conversations, so the ten shown leave two out to be searched for. */
  function twelve(cwd: string): RecordedSessionSpec[] {
    return Array.from({ length: 12 }, (_, index) => ({
      id: `session-${String(index).padStart(2, "0")}`,
      cwd,
      title: `Conversation ${index}`,
      recordedAt: new Date(Date.UTC(2026, 0, index + 1)),
    }));
  }

  it("shows the ten most recent, newest first, and no sub-agent transcript", async () => {
    const repository = await createTemporaryRepository();
    await start([
      ...twelve(repository),
      {
        id: "sous-agent",
        cwd: repository,
        title: "Un sous-agent",
        recordedAt: new Date(Date.UTC(2026, 5, 1)),
        subagent: true,
      },
    ]);

    const shown = await list();

    // Ten, newest first: the two oldest of the twelve are left out.
    expect(shown).toHaveLength(10);
    expect(shown.map((session) => session.title)).toEqual([
      "Conversation 11",
      "Conversation 10",
      "Conversation 9",
      "Conversation 8",
      "Conversation 7",
      "Conversation 6",
      "Conversation 5",
      "Conversation 4",
      "Conversation 3",
      "Conversation 2",
    ]);
    // The sub-agent transcript is the most recent file of all, and it is not a
    // session: resuming it would resume something that never drove anything.
    expect(shown.map((session) => session.id)).not.toContain("sous-agent");
    // What identifies a session, and nothing of what was said in it.
    expect(shown[0]).toMatchObject({ cwd: repository, branch: "main" });
    expect(shown[0]?.bytes).toBeGreaterThan(0);
  });

  it("finds a conversation beyond the ten shown, by what identifies it", async () => {
    const repository = await createTemporaryRepository();
    const elsewhere = await createTemporaryRepository();
    await start([
      ...twelve(repository),
      {
        id: "recherchee",
        cwd: elsewhere,
        branch: "feat/interface",
        title: "Le grilling de l'interface",
        firstMessage: "On reprend la conception de l'interface de muscadet.",
        recordedAt: new Date(Date.UTC(2025, 0, 1)),
      },
    ]);

    // The oldest of all, so the ten most recent do not hold it.
    expect((await list()).map((session) => session.id)).not.toContain("recherchee");

    expect((await list("grilling")).map((session) => session.id)).toEqual(["recherchee"]);
    expect((await list("muscadet")).map((session) => session.id)).toEqual(["recherchee"]);
    expect((await list("feat/interface")).map((session) => session.id)).toEqual(["recherchee"]);
    // Every term has to match, which is what makes a search of two words narrow.
    expect(await list("grilling introuvable")).toEqual([]);
  });

  it("attaches a conversation: its repository, a feature, and the session resumed", async () => {
    const repository = await createTemporaryRepository();
    const { opened } = await start([
      {
        id: "a-reprendre",
        cwd: repository,
        title: "Le grilling de la fondation",
        recordedAt: new Date(Date.UTC(2026, 2, 1)),
      },
    ]);

    // Squad knows no project yet: attaching is what hands it this repository.
    const before = await squad.request("GET", apiRoutes.projects);
    expect(((await before.json()) as { projects: Project[] }).projects).toEqual([]);

    const response = await squad.request("POST", attachRecordedSessionRoute("a-reprendre"), {});
    expect(response.status).toBe(201);
    const { project, feature } = (await response.json()) as {
      project: Project;
      feature: Feature;
    };

    // The repository the conversation ran in, registered and carried.
    expect(project.path).toBe(repository);
    expect(feature.projectId).toBe(project.id);
    expect(feature.repositories.map((each) => each.projectId)).toEqual([project.id]);
    // Named after the conversation rather than after its identifier.
    expect(feature.title).toBe("Le grilling de la fondation");
    expect(feature.resumedSessionId).toBe("a-reprendre");

    // And the main session is that conversation carrying on, in its repository.
    await expect.poll(() => opened.length, { timeout: 10_000 }).toBe(1);
    expect(opened[0]?.resumeSessionId).toBe("a-reprendre");
    expect(opened[0]?.workingDirectory).toBe(repository);

    // The thread says so, and says where the conversation lives rather than
    // repeating it.
    const said = (await readThread(feature.id)).filter((entry) => entry.kind === "notice");
    expect(said.map((entry) => entry.text)).toContain(
      "the main session was resumed from a recorded conversation",
    );
    expect(said[0]?.detail).toContain(repository);
  });

  it("refuses a conversation that is already the thread of a feature", async () => {
    const repository = await createTemporaryRepository();
    await start([
      { id: "a-reprendre", cwd: repository, title: "Le grilling", recordedAt: new Date() },
    ]);
    const first = await squad.request("POST", attachRecordedSessionRoute("a-reprendre"), {});
    expect(first.status).toBe(201);

    const again = await squad.request("POST", attachRecordedSessionRoute("a-reprendre"), {});

    expect(again.status).toBe(409);
    const listed = await squad.request("GET", apiRoutes.features);
    expect(((await listed.json()) as { features: Feature[] }).features).toHaveLength(1);
  });

  it("says there is nothing to resume rather than failing, when nothing was recorded", async () => {
    await start([], { withoutDirectory: true });

    expect(await list()).toEqual([]);
    // And a conversation nobody recorded cannot be attached.
    const response = await squad.request("POST", attachRecordedSessionRoute("inconnue"), {});
    expect(response.status).toBe(404);
  });
});
