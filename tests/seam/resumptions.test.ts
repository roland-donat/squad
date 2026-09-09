import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Feature, Project, RecordedSession, ThreadEntry } from "../../src/shared/api";
import { apiRoutes, attachRecordedSessionRoute, mainSessionRoute } from "../../src/shared/api";
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

  async function read(
    search?: string,
  ): Promise<{ sessions: RecordedSession[]; matching: number; readable: boolean }> {
    const route =
      search === undefined
        ? apiRoutes.recordedSessions
        : `${apiRoutes.recordedSessions}?search=${encodeURIComponent(search)}`;
    const response = await squad.request("GET", route);
    expect(response.status).toBe(200);
    return (await response.json()) as {
      sessions: RecordedSession[];
      matching: number;
      readable: boolean;
    };
  }

  async function list(search?: string): Promise<RecordedSession[]> {
    return (await read(search)).sessions;
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
    // And what is not shown is said rather than kept quiet: twelve conversations
    // match, ten are on screen.
    expect((await read()).matching).toBe(12);
    // What identifies a session, and nothing of what was said in it.
    expect(shown[0]).toMatchObject({ cwd: repository, repository, branch: "main" });
    expect(shown[0]?.bytes).toBeGreaterThan(0);
  });

  it("names the repository a conversation ran in, not the directory it ran from", async () => {
    const repository = await createTemporaryRepository();
    const inside = join(repository, "src", "server");
    await mkdir(inside, { recursive: true });
    await start([{ id: "en-sous-dossier", cwd: inside, title: "Depuis un sous-dossier" }]);

    const [session] = await list();

    // Where it ran is kept as it was recorded; what it belongs to is the
    // repository, which is what the reader recognises and what attaching
    // registers.
    expect(session?.cwd).toBe(inside);
    expect(session?.repository).toBe(repository);
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

  it("attaches a conversation: its repository, a feature, and what it is bound to", async () => {
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

    // No session is opened by attaching. A claude-code session resumed with
    // nothing to say has nothing to do and ends at once, and the message that
    // followed would then open a blank one, which is the whole point missed.
    expect(opened).toEqual([]);

    // The thread says what this feature is bound to, and says where the
    // conversation lives rather than repeating it.
    const said = (await readThread(feature.id)).filter((entry) => entry.kind === "notice");
    expect(said.map((entry) => entry.text)).toContain(
      "this feature was opened on a recorded conversation",
    );
    expect(said[0]?.detail).toContain(repository);
  });

  it("takes the same settings as a feature opened from nothing", async () => {
    const repository = await createTemporaryRepository();
    const elsewhere = await createTemporaryRepository();
    await start([{ id: "a-reprendre", cwd: repository, title: "Le grilling de la fondation" }]);
    const registered = await squad.request("POST", apiRoutes.projects, { path: elsewhere });
    const { project: also } = (await registered.json()) as { project: Project };

    // The door a feature came through changes where its thread starts, not what
    // it is configured with: the creation screen asks the same questions of
    // both, so both requests have to accept the same answers.
    const response = await squad.request("POST", attachRecordedSessionRoute("a-reprendre"), {
      title: "Reprise nommée à la main",
      otherProjectIds: [also.id],
      goAsRecommended: true,
    });

    expect(response.status).toBe(201);
    const { project, feature } = (await response.json()) as {
      project: Project;
      feature: Feature;
    };
    expect(feature.title).toBe("Reprise nommée à la main");
    expect(feature.goAsRecommended).toBe(true);
    expect(feature.repositories.map((each) => each.projectId)).toEqual([project.id, also.id]);
  });

  it("resumes that conversation at every start, not only at the first", async () => {
    const repository = await createTemporaryRepository();
    const { opened } = await start([
      { id: "a-reprendre", cwd: repository, title: "Le grilling de la fondation" },
    ]);
    const attached = await squad.request("POST", attachRecordedSessionRoute("a-reprendre"), {});
    const { feature } = (await attached.json()) as { feature: Feature };

    // What the developer types first is what opens it, and it opens as that
    // conversation carrying on, in its own repository.
    const first = await squad.request("POST", mainSessionRoute(feature.id), {
      prompt: "/to-spec",
    });
    expect(first.status).toBe(202);
    await expect.poll(() => opened.length, { timeout: 10_000 }).toBe(1);
    expect(opened[0]?.resumeSessionId).toBe("a-reprendre");
    expect(opened[0]?.workingDirectory).toBe(repository);

    // And so does the next one. A session lives as long as its process; the one
    // that comes after it is the same thread of work, and squad opened a blank
    // session there for as long as the binding was read once and then forgotten.
    parked.splice(0).forEach((open) => open());
    await expect
      .poll(async () => {
        const running = await squad.request("GET", apiRoutes.features);
        await running.json();
        return opened.length;
      }, { timeout: 10_000 })
      .toBe(1);
    const again = await squad.request("POST", mainSessionRoute(feature.id), {
      prompt: "/to-tickets",
    });
    expect(again.status).toBe(202);
    await expect.poll(() => opened.length, { timeout: 10_000 }).toBe(2);
    expect(opened[1]?.resumeSessionId).toBe("a-reprendre");
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

  it("tells a store it cannot read from a machine that recorded nothing", async () => {
    await start([], { withoutDirectory: true });

    const unreadable = await read();
    expect(unreadable.sessions).toEqual([]);
    // Said rather than shown as an empty shelf: a directory squad cannot open
    // is a diagnosis, and the two answers must not look the same.
    expect(unreadable.readable).toBe(false);
    // And a conversation nobody recorded cannot be attached.
    const response = await squad.request("POST", attachRecordedSessionRoute("inconnue"), {});
    expect(response.status).toBe(404);
  });

  it("reads an empty store as an empty shelf, not as a failure", async () => {
    await start([]);

    const empty = await read();
    expect(empty.sessions).toEqual([]);
    expect(empty.readable).toBe(true);
  });
});
