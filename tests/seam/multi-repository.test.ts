import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Feature, FeatureGraph, Project, Ticket, TicketState } from "../../src/shared/api";
import {
  apiRoutes,
  featureGraphRoute,
  mainSessionRoute,
  projectRoute,
  ticketSessionRoute,
} from "../../src/shared/api";
import { addOrigin, commitFile, createTemporaryRepository, listBranches } from "../support/git";
import { installGhStub, type GhStub } from "../support/gh";
import { createScriptedLauncher, type ScriptedAgent } from "../support/scripted-launcher";
import { startTestSquad, type TestSquad } from "../support/squad";

/**
 * A feature that carries several repositories, because a piece of work often
 * does: an interface changed in one and its callers in another. One graph, one
 * main session, one frontier, and arrows that mean the same thing whether the
 * two tickets they join live in the same repository or not.
 *
 * Everything underneath is real, as everywhere else: two git repositories, two
 * sets of branches, two remotes, and a `gh` on the path that answers like the
 * forge's own.
 */
describe("a feature that carries several repositories", () => {
  let squad: TestSquad;
  let gh: GhStub | null = null;
  const gates: Gate[] = [];

  afterEach(async () => {
    for (const gate of gates) gate.open();
    gates.length = 0;
    await squad.dispose();
    gh?.restore();
    gh = null;
  });

  /** A sub-session that stays where it is until the test lets it go. */
  interface Gate {
    passed: Promise<void>;
    open(): void;
  }

  function gate(): Gate {
    let release = () => {};
    const passed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const created = { passed, open: () => release() };
    gates.push(created);
    return created;
  }

  interface TicketSpec {
    title: string;
    /** Which repository builds it: the home one when left out. */
    on?: "muscadet" | "raichu";
    criteria?: string[];
    blockedBy?: string[];
  }

  interface Scene {
    feature(): Promise<Feature>;
    graph(): Promise<FeatureGraph>;
    ticket(title: string): Promise<Ticket>;
    launch(title: string): Promise<void>;
    reaches(title: string, state: TicketState): Promise<Ticket>;
    /** The two repositories, as squad registered them. */
    home: Project;
    other: Project;
    /** A third repository squad drives and the feature does not carry. */
    stranger: Project;
  }

  /**
   * Two registered repositories and a feature carrying both, its home one being
   * the first. A third is registered and left out on purpose: a repository squad
   * drives is not a repository this feature may write into.
   */
  async function start(options: {
    tickets: TicketSpec[];
    carryOther?: boolean;
    verifyCommand?: string;
    /** A verification of its own for a repository, over the shared one. */
    verifyOn?: Partial<Record<"muscadet" | "raichu", string>>;
    mainSession?: (agent: ScriptedAgent, projects: Record<string, Project>) => Promise<void>;
    subSession?: (agent: ScriptedAgent, title: string) => Promise<void>;
  }): Promise<Scene> {
    const titles = new Map<string, string>();
    // Filled before the main session is started, which is what lets its script
    // name a repository by its id or by its path.
    const registered: Record<string, Project> = {};
    squad = await startTestSquad({
      launcher: createScriptedLauncher(async (agent) => {
        if (agent.request.role === "main") {
          await agent.awaitMessage();
          const written = new Map<string, string>();
          for (const spec of options.tickets) {
            const created = (await agent.call("create_ticket", {
              featureId: agent.request.featureId,
              ...(spec.on === undefined ? {} : { projectId: registered[spec.on]?.id }),
              kind: "build",
              title: spec.title,
              description: `Ce que demande « ${spec.title} ».`,
              acceptanceCriteria: spec.criteria ?? [],
              blockedBy: (spec.blockedBy ?? []).map((blocker) => written.get(blocker) ?? blocker),
            })) as Ticket;
            written.set(spec.title, created.id);
            titles.set(created.id, created.title);
          }
          await options.mainSession?.(agent, registered);
          return;
        }
        // A settling pass this scenario does not script: it ends without
        // answering, so the sheet reaches the developer untouched, which is
        // what these scenarios are about.
        if (agent.request.role === "settling") return;
        await options.subSession?.(agent, titles.get(agent.request.ticketId ?? "") ?? "");
      }),
    });

    const register = async (path: string, verifyCommand?: string): Promise<Project> => {
      const response = await squad.request("POST", apiRoutes.projects, { path });
      expect(response.status).toBe(201);
      const { project } = (await response.json()) as { project: Project };
      const command = verifyCommand ?? options.verifyCommand;
      if (command !== undefined) {
        const declared = await squad.request("PUT", projectRoute(project.id), {
          verifyCommand: command,
        });
        expect(declared.status).toBe(200);
      }
      return project;
    };
    const home = await register(await createTemporaryRepository(), options.verifyOn?.muscadet);
    const other = await register(await createTemporaryRepository(), options.verifyOn?.raichu);
    const stranger = await register(await createTemporaryRepository());
    registered["muscadet"] = home;
    registered["raichu"] = other;
    registered["voisin"] = stranger;

    const opened = await squad.request("POST", apiRoutes.features, {
      projectId: home.id,
      title: "La nouvelle interface",
      ...(options.carryOther === false ? {} : { otherProjectIds: [other.id] }),
    });
    expect(opened.status).toBe(201);
    const { feature } = (await opened.json()) as { feature: Feature };
    await squad.request("POST", mainSessionRoute(feature.id), { prompt: "/to-tickets" });

    const graph = async (): Promise<FeatureGraph> => {
      const response = await squad.request("GET", featureGraphRoute(feature.id));
      return (await response.json()) as FeatureGraph;
    };
    const ticket = async (title: string): Promise<Ticket> => {
      const found = (await graph()).tickets.find((each) => each.title === title);
      if (!found) throw new Error(`no ticket titled "${title}" in the graph`);
      return found;
    };
    await expect
      .poll(async () => (await graph()).tickets.length, { timeout: 10_000 })
      .toBe(options.tickets.length);

    return {
      home,
      other,
      stranger,
      graph,
      ticket,
      async feature() {
        const response = await squad.request("GET", apiRoutes.features);
        const { features } = (await response.json()) as { features: Feature[] };
        const found = features.find((each) => each.id === feature.id);
        if (!found) throw new Error("the feature is missing from the list");
        return found;
      },
      async launch(title) {
        const target = await ticket(title);
        const response = await squad.request("POST", ticketSessionRoute(target.id), {});
        expect(response.status).toBe(202);
      },
      async reaches(title, state) {
        await expect.poll(async () => (await ticket(title)).state, { timeout: 15_000 }).toBe(state);
        return ticket(title);
      },
    };
  }

  /** Ends a step declaring every criterion automated: nothing for a human to do. */
  async function reportCovered(agent: ScriptedAgent): Promise<void> {
    const graph = (await agent.call("read_graph", {
      featureId: agent.request.featureId,
    })) as FeatureGraph;
    const own = graph.tickets.find((each) => each.id === agent.request.ticketId);
    await agent.call("report_step", {
      featureId: agent.request.featureId,
      ticketId: agent.request.ticketId,
      summary: `Ce que demandait « ${own?.title ?? ""} » est construit.`,
      coverage: (own?.acceptanceCriteria ?? []).map((criterion) => ({
        criterionId: criterion.id,
        verdict: "automated",
      })),
      recommendation: "Fusionner.",
    });
  }

  it("builds a ticket where it says, and waits across repositories", async () => {
    const working = gate();
    const scene = await start({
      tickets: [
        { title: "L'interface de muscadet", criteria: ["Elle est en place"] },
        { title: "Les appels de raichu", on: "raichu", blockedBy: ["L'interface de muscadet"] },
      ],
      subSession: async (agent, title) => {
        await agent.awaitMessage();
        if (title === "L'interface de muscadet") {
          await commitFile(agent.request.workingDirectory, "interface.ts", "1\n", "feat: interface");
          await reportCovered(agent);
          return;
        }
        await working.passed;
      },
    });

    // Each ticket says which repository builds it, and the arrow between them
    // means what it always means, across two repositories.
    const inRaichu = await scene.ticket("Les appels de raichu");
    expect(inRaichu.projectId).toBe(scene.other.id);
    expect((await scene.ticket("L'interface de muscadet")).projectId).toBe(scene.home.id);
    expect(inRaichu.state).toBe("blocked");

    // The blocker is built and merged in its own repository, and nothing of it
    // shows up in the other.
    await scene.launch("L'interface de muscadet");
    await scene.reaches("L'interface de muscadet", "merged");
    expect(await listBranches(scene.home.path)).toContain(
      (await scene.feature()).repositories.find((each) => each.projectId === scene.home.id)
        ?.worktree?.branch,
    );
    expect(await listBranches(scene.other.path)).toEqual(["main"]);

    // Released by a merge in another repository, and built in its own: the
    // second repository is checked out only now, on its first ticket.
    const released = await scene.reaches("Les appels de raichu", "ready");
    await scene.launch(released.title);
    const running = await scene.reaches("Les appels de raichu", "running");
    expect(await listBranches(scene.other.path)).toContain(running.worktree?.branch);
    // And its branch is nowhere near the first repository.
    expect(await listBranches(scene.home.path)).not.toContain(running.worktree?.branch);
  });

  it("refuses a ticket in a repository the feature does not carry", async () => {
    const refusal = { text: "" };
    const scene = await start({
      tickets: [{ title: "L'interface de muscadet" }],
      mainSession: async (agent, projects) => {
        const outcome = await agent.attempt("create_ticket", {
          featureId: agent.request.featureId,
          projectId: projects["voisin"]?.id,
          kind: "build",
          title: "Chez le voisin",
          description: "Un dépôt que la feature ne porte pas.",
        });
        expect(outcome.refused).toBe(true);
        refusal.text = outcome.text;
      },
    });

    await expect.poll(() => refusal.text, { timeout: 10_000 }).not.toBe("");
    // The refusal names what the feature does carry, so the session can correct
    // itself rather than guess.
    expect(refusal.text).toContain(scene.home.name);
    expect(refusal.text).toContain(scene.other.name);
    expect((await scene.graph()).tickets).toHaveLength(1);
  });

  it("carries a repository the session found by its path, and refuses one squad does not drive", async () => {
    const found = { carried: null as Feature | null, refusal: "" };
    const scene = await start({
      tickets: [{ title: "L'interface de muscadet" }],
      mainSession: async (agent, projects) => {
        // A repository squad does not drive: an agent reading a path out of a
        // file must not be able to widen what squad may touch.
        const elsewhere = await agent.attempt("carry_repository", {
          featureId: agent.request.featureId,
          path: await createTemporaryRepository(),
        });
        expect(elsewhere.refused).toBe(true);
        found.refusal = elsewhere.text;
        // And one it does drive, named by a path as a `CLAUDE.md` would give it.
        found.carried = (await agent.call("carry_repository", {
          featureId: agent.request.featureId,
          path: projects["voisin"]?.path ?? "",
        })) as Feature;
      },
    });

    await expect.poll(() => found.carried !== null, { timeout: 10_000 }).toBe(true);
    expect(found.refusal).toContain("is not a repository squad drives");
    expect(found.carried?.repositories.map((each) => each.projectId)).toEqual([
      scene.home.id,
      scene.other.id,
      scene.stranger.id,
    ]);
  });

  it("drops a repository nothing points at, and keeps one that carries a ticket", async () => {
    const scene = await start({
      tickets: [{ title: "L'interface de muscadet", on: "raichu" }],
    });
    const featureId = (await scene.feature()).id;

    // Carried but empty: dropping it takes nothing with it.
    const carried = await scene.feature();
    expect(carried.repositories).toHaveLength(2);

    // And the one a ticket is built in stays, whatever the list says: a ticket
    // squad has nowhere to build is a ticket it could never launch.
    const refused = await squad.request("PUT", `${apiRoutes.features}/${featureId}`, {
      projectIds: [scene.home.id],
    });
    expect(refused.status).toBe(409);
    expect((await scene.feature()).repositories).toHaveLength(2);

    // The home project is carried whatever is named, since it is where the main
    // session runs and what a ticket falls back to.
    const kept = await squad.request("PUT", `${apiRoutes.features}/${featureId}`, {
      projectIds: [scene.other.id],
    });
    expect(kept.status).toBe(200);
    expect((await scene.feature()).repositories.map((each) => each.projectId)).toEqual([
      scene.home.id,
      scene.other.id,
    ]);
  });

  it("writes a red check's fix in its own repository, and blocks nothing elsewhere", async () => {
    const scene = await start({
      // Red in the first repository only: what breaks there says nothing about
      // the other, and the correction must not stop its work.
      verifyOn: { muscadet: "exit 1" },
      tickets: [
        { title: "L'interface de muscadet", criteria: ["Elle est en place"] },
        { title: "Le reste de muscadet" },
        { title: "Les appels de raichu", on: "raichu" },
      ],
      subSession: async (agent) => {
        await agent.awaitMessage();
        await commitFile(agent.request.workingDirectory, "interface.ts", "1\n", "feat: interface");
        await reportCovered(agent);
      },
    });

    await scene.launch("L'interface de muscadet");
    await scene.reaches("L'interface de muscadet", "merged");

    // The correction is born where the branch broke, and in front of what has
    // not started there.
    const fix = await expect
      .poll(async () => (await scene.graph()).tickets.find((each) => each.kind === "fix"), {
        timeout: 15_000,
      })
      .toBeDefined()
      .then(async () => (await scene.graph()).tickets.find((each) => each.kind === "fix"));
    expect(fix?.projectId).toBe(scene.home.id);
    await scene.reaches("Le reste de muscadet", "blocked");

    // And the other repository carries on: its work has nothing to do with a
    // branch that broke somewhere else.
    expect((await scene.ticket("Les appels de raichu")).state).toBe("ready");
  });

  it("merges two repositories at once and opens one pull request each", async () => {
    gh = await installGhStub();
    const directory = await mkdtemp(join(tmpdir(), "squad-check-"));
    const log = join(directory, "passes");
    const scene = await start({
      // Long enough that two checks running at once are seen doing so.
      verifyCommand: `printf 'debut\\n' >> ${log}; sleep 0.3; printf 'fin\\n' >> ${log}`,
      tickets: [
        { title: "L'interface de muscadet", criteria: ["Elle est en place"] },
        { title: "Les appels de raichu", on: "raichu", criteria: ["Ils passent"] },
      ],
      subSession: async (agent) => {
        await agent.awaitMessage();
        await commitFile(agent.request.workingDirectory, "fait.ts", "1\n", "feat: fait");
        await reportCovered(agent);
      },
    });
    await addOrigin(scene.home.path);
    await addOrigin(scene.other.path);

    await scene.launch("L'interface de muscadet");
    await scene.launch("Les appels de raichu");
    await scene.reaches("L'interface de muscadet", "merged");
    await scene.reaches("Les appels de raichu", "merged");

    // One pull request per repository, each on its own base and head.
    await expect
      .poll(
        async () =>
          (await scene.feature()).repositories.filter((each) => each.pullRequestUrl !== null)
            .length,
        { timeout: 15_000 },
      )
      .toBe(2);
    // One per repository, each describing what was built in its own: the
    // branch name is the same in both, since they are different repositories.
    const opened = await gh.callsTo("pr", "create");
    expect(opened).toHaveLength(2);
    const bodies = opened.map((args) => args[args.indexOf("--body") + 1] ?? "");
    expect(bodies.filter((body) => body.includes("L'interface de muscadet"))).toHaveLength(1);
    expect(bodies.filter((body) => body.includes("Les appels de raichu"))).toHaveLength(1);

    // The two repositories merged at once rather than one after the other:
    // their chains are their own, and only two tickets of one repository wait
    // for each other.
    const passes = (await readFile(log, "utf8")).split("\n").filter((line) => line !== "");
    expect(passes).toEqual(["debut", "debut", "fin", "fin"]);
  });
});
