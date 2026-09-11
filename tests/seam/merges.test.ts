import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Feature, FeatureGraph, Ticket, TicketState } from "../../src/shared/api";
import {
  apiRoutes,
  featureGraphRoute,
  mainSessionRoute,
  ticketSessionRoute,
  ticketTestSheetRoute,
} from "../../src/shared/api";
import { pendingActions } from "../../src/shared/pending";
import {
  addOrigin,
  commitFile,
  commitSubjects,
  currentBranch,
  deleteBranchIn,
  detach,
  fileOnBranch,
  listBranches,
  mergeInto,
  pathExists,
  resolveConflictWith,
} from "../support/git";
import { installGhStub, type GhStub } from "../support/gh";
import { connectToSquadTools, writeTicket } from "../support/mcp";
import { createScriptedLauncher, type ScriptedAgent } from "../support/scripted-launcher";
import {
  onlyRepository,
  openTestFeature,
  startTestSquad,
  type TestSquad,
} from "../support/squad";
import { startWebhookReceiver, type WebhookReceiver } from "../support/webhook";

/**
 * What happens once a step has been reported: the sheet is gone through or came
 * back empty, the branch goes home, the feature branch is checked, and a drained
 * graph leaves as a pull request. Everything is played through the surface the
 * interface and the agents use, and everything underneath is real: the git
 * repository, the branches, the merges, the verification command, and a `gh` on
 * the path that answers like the forge's own.
 */
describe("validating, merging, checking and delivering", () => {
  let squad: TestSquad;
  let webhook: WebhookReceiver | null = null;
  let gh: GhStub | null = null;
  const gates: Gate[] = [];

  afterEach(async () => {
    for (const gate of gates) gate.open();
    gates.length = 0;
    await squad.dispose();
    await webhook?.close();
    webhook = null;
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
    criteria: string[];
    /** Titles of the tickets that must merge before this one may start. */
    blockedBy?: string[];
  }

  interface Scene {
    featureId: string;
    repository: string;
    /** Feature branch and worktree, known once a ticket has been launched. */
    feature(): Promise<Feature>;
    graph(): Promise<FeatureGraph>;
    ticket(title: string): Promise<Ticket>;
    launch(title: string): Promise<void>;
    reaches(title: string, state: TicketState): Promise<Ticket>;
  }

  /**
   * A project, a feature, a graph written by the main session, and one scripted
   * sub-session per ticket. The script is handed the title of the ticket its
   * session was opened for, since that is what tells one from another when
   * several run at once.
   */
  async function start(options: {
    tickets: TicketSpec[];
    verifyCommand?: string;
    subSession: (agent: ScriptedAgent, title: string) => Promise<void>;
  }): Promise<Scene> {
    const titles = new Map<string, string>();
    squad = await startTestSquad({
      launcher: createScriptedLauncher(async (agent) => {
        if (agent.request.role === "main") {
          await agent.awaitMessage();
          const written = new Map<string, string>();
          for (const spec of options.tickets) {
            const created = (await writeTicket(agent, {
              featureId: agent.request.featureId,
              kind: "build",
              title: spec.title,
              description: `Ce que demande « ${spec.title} ».`,
              acceptanceCriteria: spec.criteria,
              blockedBy: (spec.blockedBy ?? []).map((blocker) => written.get(blocker) ?? blocker),
            })) as Ticket;
            written.set(spec.title, created.id);
            titles.set(created.id, created.title);
          }
          return;
        }
        // A settling pass this scenario does not script: it ends without
        // answering, so the sheet reaches the developer untouched, which is
        // what these scenarios are about.
        if (agent.request.role === "settling") return;
        const title = titles.get(agent.request.ticketId ?? "") ?? "";
        await options.subSession(agent, title);
      }),
    });
    const { project, feature, repository } = await openTestFeature(squad, "Le noyau");
    if (options.verifyCommand !== undefined) {
      const declared = await squad.request("PUT", `${apiRoutes.projects}/${project.id}`, {
        verifyCommand: options.verifyCommand,
      });
      expect(declared.status).toBe(200);
    }
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
    // The graph is written by the main session, which runs on its own: nothing
    // else can be asked of the feature until every ticket is there.
    await expect
      .poll(async () => (await graph()).tickets.length, { timeout: 10_000 })
      .toBe(options.tickets.length);

    return {
      featureId: feature.id,
      repository,
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
        await expect
          .poll(async () => (await ticket(title)).state, { timeout: 15_000 })
          .toBe(state);
        return ticket(title);
      },
    };
  }

  /** Sends squad's alerts to an endpoint this test can read. */
  async function catchAlerts(): Promise<WebhookReceiver> {
    const receiver = await startWebhookReceiver();
    webhook = receiver;
    const answer = await squad.request("PUT", apiRoutes.settings, { webhookUrl: receiver.url });
    expect(answer.status).toBe(200);
    return receiver;
  }

  /** The ticket a sub-session was opened for, as the agent reads it. */
  async function ownTicket(agent: ScriptedAgent): Promise<Ticket> {
    const graph = (await agent.call("read_graph", {
      featureId: agent.request.featureId,
    })) as FeatureGraph;
    const own = graph.tickets.find((each) => each.id === agent.request.ticketId);
    if (!own) throw new Error("the sub-session's own ticket is missing from the graph");
    return own;
  }

  /** Ends a step declaring every criterion automated: nothing for a human to do. */
  async function reportCovered(agent: ScriptedAgent, work: string): Promise<void> {
    const own = await ownTicket(agent);
    await agent.call("report_step", {
      featureId: agent.request.featureId,
      ticketId: agent.request.ticketId,
      work,
      coverage: own.acceptanceCriteria.map((criterion) => ({
        criterionId: criterion.id,
        verdict: "automated",
      })),
      recommendation: "Fusionner.",
    });
  }

  /** Ends a step declaring nothing automated: every criterion becomes a point. */
  async function reportUncovered(agent: ScriptedAgent, work: string): Promise<void> {
    const own = await ownTicket(agent);
    await agent.call("report_step", {
      featureId: agent.request.featureId,
      ticketId: agent.request.ticketId,
      work,
      coverage: own.acceptanceCriteria.map((criterion) => ({
        criterionId: criterion.id,
        verdict: "judgement",
      })),
      recommendation: "À vérifier à la main.",
    });
  }

  /** Goes through a test sheet as the developer would, from the interface. */
  async function review(
    ticket: Ticket,
    verdicts: Array<{ passed: boolean; comment?: string }>,
    feedback = "",
  ): Promise<Response> {
    const sheet = ticket.stepReport?.sheet ?? [];
    return squad.request("POST", ticketTestSheetRoute(ticket.id), {
      points: sheet.map((point, index) => ({
        id: point.id,
        passed: verdicts[index]?.passed ?? true,
        comment: verdicts[index]?.comment ?? "",
      })),
      feedback,
    });
  }

  it("fusionne une étape que personne n'a à relire, et rend son worktree", async () => {
    const worktrees: string[] = [];
    const branches: string[] = [];
    const scene = await start({
      // Two tickets, one launched: this scenario is about a step nobody has to
      // read, not about a feature that has come back whole.
      tickets: [
        { title: "Le store", criteria: ["La base s'ouvre"] },
        { title: "L'API", criteria: ["Les routes répondent"] },
      ],
      subSession: async (agent) => {
        await agent.awaitMessage();
        const directory = agent.request.workingDirectory;
        worktrees.push(directory);
        branches.push(await currentBranch(directory));
        await commitFile(directory, "store.ts", "export const store = 1;\n", "feat: the store");
        await reportCovered(agent, "Tout est couvert par les tests au seam.");
      },
    });
    const receiver = await catchAlerts();

    await scene.launch("Le store");
    const merged = await scene.reaches("Le store", "merged");

    // The work is on the feature branch, and it got there as its own merge
    // commit rather than by fast-forward: the branch says which ticket did what.
    const featureBranch = onlyRepository(await scene.feature()).worktree?.branch ?? "";
    expect(await fileOnBranch(scene.repository, featureBranch, "store.ts")).toContain(
      "export const store",
    );
    expect(await commitSubjects(scene.repository, featureBranch)).toContain(
      'Merge ticket "Le store" into ' + featureBranch,
    );

    // And what carried it is gone: the checkout off the disk, the branch out of
    // the repository, and the two columns that named them off the row.
    expect(await pathExists(worktrees[0] ?? "")).toBe(false);
    expect(await listBranches(scene.repository)).not.toContain(branches[0]);
    expect(merged.worktree).toBeNull();
    // Nobody was woken: an empty sheet is a step nobody had to look at.
    expect(receiver.received()).toEqual([]);
    expect(pendingActions([await scene.graph()], [])).toEqual([]);
  });

  it("renvoie un point non coché dans la sous-session, qui corrige et resignale", async () => {
    const handed: string[] = [];
    const scene = await start({
      tickets: [{ title: "Le store", criteria: ["La base s'ouvre"] }],
      subSession: async (agent) => {
        handed.push(await agent.awaitMessage());
        const directory = agent.request.workingDirectory;
        await commitFile(directory, "store.ts", "premier jet\n", "feat: the store");
        await reportUncovered(agent, "Fait, à vérifier à la main.");
        // Alive after reporting, which is exactly what the correction needs.
        handed.push(await agent.awaitMessage());
        await commitFile(directory, "store.ts", "corrigé\n", "fix: after the sheet");
        await reportCovered(agent, "Corrigé, et couvert par un test cette fois.");
      },
    });

    await scene.launch("Le store");
    const waiting = await scene.reaches("Le store", "awaiting-validation");
    const answered = await review(
      waiting,
      [{ passed: false, comment: "La base ne s'ouvre pas sur un fichier écrit hier." }],
      "Le reste tient.",
    );
    expect(answered.status).toBe(200);

    // The comment goes back to the session that wrote the step, which is still
    // the one on the ticket: it corrects and reports again, and that report is
    // what merges.
    const merged = await scene.reaches("Le store", "merged");
    expect(handed[1]).toContain("La base ne s'ouvre pas");
    expect(handed[1]).toContain("Le reste tient.");
    expect(merged.sessionId).toBe(waiting.sessionId);
    expect(merged.stepReport?.work).toContain("Corrigé");
    const featureBranch = onlyRepository(await scene.feature()).worktree?.branch ?? "";
    expect(await fileOnBranch(scene.repository, featureBranch, "store.ts")).toBe("corrigé\n");
  });

  it("ne fusionne jamais un ticket dont la fiche n'est pas validée", async () => {
    const stuck = gate();
    const scene = await start({
      tickets: [{ title: "Le store", criteria: ["La base s'ouvre"] }],
      subSession: async (agent) => {
        await agent.awaitMessage();
        await commitFile(agent.request.workingDirectory, "store.ts", "jamais\n", "feat: the store");
        await reportUncovered(agent, "Fait.");
        await stuck.passed;
      },
    });

    await scene.launch("Le store");
    const waiting = await scene.reaches("Le store", "awaiting-validation");
    const featureBranch = onlyRepository(await scene.feature()).worktree?.branch ?? "";
    // A sheet nobody has been through: the branch stays where it is.
    expect(await fileOnBranch(scene.repository, featureBranch, "store.ts")).toBeNull();

    // Gone through and rejected: the ticket goes back to being a step in
    // progress, and still nothing merges.
    expect((await review(waiting, [{ passed: false, comment: "Non." }])).status).toBe(200);
    const corrected = await scene.reaches("Le store", "running");
    expect(corrected.worktree).not.toBeNull();
    expect(await fileOnBranch(scene.repository, featureBranch, "store.ts")).toBeNull();
    expect(await commitSubjects(scene.repository, featureBranch)).toEqual(["initial"]);
  });

  it("lance la vérification du projet sur le worktree de feature, après la fusion", async () => {
    const directory = await mkdtemp(join(tmpdir(), "squad-check-"));
    const where = join(directory, "ou");
    const scene = await start({
      // Green only if it runs where the merge just landed: the file it looks
      // for is on the feature branch and nowhere else, and the directory it
      // records is read back below.
      verifyCommand: `pwd > ${where} && test -f store.ts`,
      tickets: [
        { title: "Le store", criteria: ["La base s'ouvre"] },
        { title: "L'API", criteria: ["Les routes répondent"] },
      ],
      subSession: async (agent) => {
        await agent.awaitMessage();
        await commitFile(agent.request.workingDirectory, "store.ts", "1\n", "feat: the store");
        await reportCovered(agent, "Fait.");
      },
    });

    await scene.launch("Le store");
    await scene.reaches("Le store", "merged");
    await expect.poll(async () => await pathExists(where), { timeout: 15_000 }).toBe(true);

    const featureWorktree = onlyRepository(await scene.feature()).worktree?.path ?? "";
    expect((await readFile(where, "utf8")).trim()).toBe(featureWorktree);
    // Green, so nothing was posted in front of the rest: the ticket that had not
    // started is still on the frontier.
    expect((await scene.graph()).tickets.map((ticket) => ticket.kind)).toEqual(["build", "build"]);
    expect((await scene.ticket("L'API")).state).toBe("ready");
  });

  it("engendre un ticket de correction quand la vérification d'intégration est rouge", async () => {
    const scene = await start({
      // Red until something writes the file, which the ticket below never does.
      verifyCommand: "test -f jalon.txt",
      tickets: [
        { title: "Le store", criteria: ["La base s'ouvre"] },
        { title: "L'API", criteria: ["Les routes répondent"] },
      ],
      subSession: async (agent) => {
        await agent.awaitMessage();
        await commitFile(agent.request.workingDirectory, "store.ts", "1\n", "feat: the store");
        await reportCovered(agent, "Fait.");
      },
    });
    const receiver = await catchAlerts();

    await scene.launch("Le store");
    await scene.reaches("Le store", "merged");

    // The merge stands: what is red is the feature branch, not the ticket.
    const graph = await expect
      .poll(async () => (await scene.graph()).tickets, { timeout: 15_000 })
      .toHaveLength(3)
      .then(() => scene.graph());
    const fix = graph.tickets.find((ticket) => ticket.kind === "fix");
    expect(fix?.title).toContain("Le store");
    expect(fix?.description).toContain("test -f jalon.txt");
    expect(fix?.state).toBe("ready");

    // And it is in front of what had not started: the ticket nobody launched
    // leaves the frontier until the correction merges.
    expect(graph.edges).toContainEqual({
      featureId: scene.featureId,
      blockerId: fix?.id,
      blockedId: (await scene.ticket("L'API")).id,
    });
    expect((await scene.ticket("L'API")).state).toBe("blocked");
    const alert = await receiver.next();
    expect(alert.text).toMatch(/vérification d'intégration/i);
  });

  it("ouvre une session de résolution dans le worktree du ticket, puis retente la fusion", async () => {
    const second = gate();
    const resolutions: string[] = [];
    const scene = await start({
      tickets: [
        { title: "Le store", criteria: ["La base s'ouvre"] },
        { title: "L'API", criteria: ["Les routes répondent"] },
      ],
      subSession: async (agent, title) => {
        const message = await agent.awaitMessage();
        const directory = agent.request.workingDirectory;
        // A resolution session is told one thing, and this is that thing: it is
        // not the ticket's sub-session, and it has no report to make.
        if (message.startsWith("Merge the branch")) {
          resolutions.push(directory);
          const branch = message.split("`")[1] ?? "";
          expect(await mergeInto(directory, branch)).toBe(false);
          await resolveConflictWith(directory, "les deux côtés\n");
          return;
        }
        await commitFile(directory, "partage.ts", `${title}\n`, `feat: ${title}`);
        if (title === "L'API") await second.passed;
        await reportCovered(agent, `Fait pour ${title}.`);
      },
    });

    // Both branches are cut from the feature branch before either merges, which
    // is what makes them meet on the same lines.
    await scene.launch("Le store");
    await scene.launch("L'API");
    await scene.reaches("Le store", "merged");
    second.open();
    const merged = await scene.reaches("L'API", "merged");

    expect(resolutions).toHaveLength(1);
    expect(merged.sessionId).not.toBeNull();
    const featureBranch = onlyRepository(await scene.feature()).worktree?.branch ?? "";
    expect(await fileOnBranch(scene.repository, featureBranch, "partage.ts")).toBe(
      "les deux côtés\n",
    );
  });

  it("constate au redémarrage la fusion qu'une résolution avait déjà faite, plutôt que d'échouer dessus", async () => {
    const second = gate();
    const held = gate();
    let featurePath = "";
    const scene = await start({
      tickets: [
        { title: "Le store", criteria: ["La base s'ouvre"] },
        { title: "L'API", criteria: ["Les routes répondent"] },
      ],
      subSession: async (agent, title) => {
        const message = await agent.awaitMessage();
        const directory = agent.request.workingDirectory;
        if (message.startsWith("Merge the branch")) {
          const branch = message.split("`")[1] ?? "";
          expect(await mergeInto(directory, branch)).toBe(false);
          await resolveConflictWith(directory, "les deux côtés\n");
          // Then it goes further than it was asked, as one did on a real run:
          // it reads squad's own failing command in the notice, replays it into
          // the feature branch, and deletes the ticket branch behind it.
          // Nothing confines it, and that is a decision (ADR 0004).
          const ticketBranch = await currentBranch(directory);
          expect(await mergeInto(featurePath, ticketBranch)).toBe(true);
          await detach(directory);
          await deleteBranchIn(featurePath, ticketBranch);
          // Still in flight when squad goes down: no ending is recorded, so the
          // ticket is left saying `merging` and the next start takes it back.
          await held.passed;
          return;
        }
        await commitFile(directory, "partage.ts", `${title}\n`, `feat: ${title}`);
        if (title === "L'API") await second.passed;
        await reportCovered(agent, `Fait pour ${title}.`);
      },
    });

    await scene.launch("Le store");
    await scene.launch("L'API");
    await scene.reaches("Le store", "merged");
    featurePath = onlyRepository(await scene.feature()).worktree?.path ?? "";
    second.open();

    const featureBranch = onlyRepository(await scene.feature()).worktree?.branch ?? "";
    await expect
      .poll(async () => fileOnBranch(scene.repository, featureBranch, "partage.ts"), {
        timeout: 10_000,
      })
      .toBe("les deux côtés\n");

    // Squad restarts on a ticket left saying `merging`, whose branch is gone and
    // whose work is in. Git answers "not something we can merge", which is not a
    // failure: a graph that says failed on merged work is worse than no graph.
    held.open();
    await squad.restart();
    const merged = await scene.reaches("L'API", "merged");
    expect(merged.worktree).toBeNull();
    expect(await fileOnBranch(scene.repository, featureBranch, "partage.ts")).toBe(
      "les deux côtés\n",
    );
  });

  it("compte la session de résolution dans le plafond, comme les autres", async () => {
    const second = gate();
    const resolving = gate();
    const held = gate();
    const scene = await start({
      tickets: [
        { title: "Le store", criteria: ["La base s'ouvre"] },
        { title: "L'API", criteria: ["Les routes répondent"] },
        { title: "Le troisième", criteria: ["Il attend son tour"] },
      ],
      subSession: async (agent, title) => {
        const message = await agent.awaitMessage();
        // The resolution session, held open: what is being watched is the place
        // it takes while it runs.
        if (message.startsWith("Merge the branch")) {
          resolving.open();
          await held.passed;
          return;
        }
        const directory = agent.request.workingDirectory;
        if (title !== "Le troisième") {
          await commitFile(directory, "partage.ts", `${title}\n`, `feat: ${title}`);
        }
        if (title === "L'API") await second.passed;
        await reportCovered(agent, `Fait pour ${title}.`);
      },
    });

    // Both branch before either merges, which is what makes the second one
    // conflict; the cap comes down once the resolution session is open.
    await scene.launch("Le store");
    await scene.launch("L'API");
    await scene.reaches("Le store", "merged");
    second.open();
    await resolving.passed;

    // One place for the whole machine, and the resolution session is holding it.
    expect(
      (await squad.request("PUT", apiRoutes.settings, { machineConcurrencyCap: 1 })).status,
    ).toBe(200);

    // Asked for while the resolution holds the only place: accepted, and
    // waiting, exactly like a launch behind a sub-session.
    await scene.launch("Le troisième");
    expect((await scene.ticket("Le troisième")).state).toBe("queued");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await scene.ticket("Le troisième")).state).toBe("queued");

    // The place comes back when the session ends, and what was behind it takes it.
    held.open();
    await scene.reaches("Le troisième", "merged");
  });

  it("passe le ticket en conflit et alerte quand la résolution n'aboutit pas", async () => {
    const second = gate();
    const worktrees = new Map<string, string>();
    const scene = await start({
      tickets: [
        { title: "Le store", criteria: ["La base s'ouvre"] },
        { title: "L'API", criteria: ["Les routes répondent"] },
      ],
      subSession: async (agent, title) => {
        const message = await agent.awaitMessage();
        // The resolution session gives up rather than guessing, which is what
        // the instruction it is given tells it to do.
        if (message.startsWith("Merge the branch")) return;
        const directory = agent.request.workingDirectory;
        worktrees.set(title, directory);
        await commitFile(directory, "partage.ts", `${title}\n`, `feat: ${title}`);
        if (title === "L'API") await second.passed;
        await reportCovered(agent, `Fait pour ${title}.`);
      },
    });
    const receiver = await catchAlerts();

    await scene.launch("Le store");
    await scene.launch("L'API");
    await scene.reaches("Le store", "merged");
    second.open();
    const conflicted = await scene.reaches("L'API", "conflict");

    // Nothing is cleaned up: the work is on the branch, the worktree is where
    // the conflict is, and taking the sub-session back is the way out.
    expect(conflicted.worktree).not.toBeNull();
    expect(await pathExists(worktrees.get("L'API") ?? "")).toBe(true);
    expect(await listBranches(scene.repository)).toContain(conflicted.worktree?.branch);
    // The feature branch is left clean rather than sitting on a half merge.
    const featureBranch = onlyRepository(await scene.feature()).worktree?.branch ?? "";
    expect(await fileOnBranch(scene.repository, featureBranch, "partage.ts")).toBe("Le store\n");

    const alert = await receiver.next();
    expect(alert.text).toContain("L'API");
    expect(alert.text).toMatch(/conflit/i);
    expect(pendingActions([await scene.graph()], [])).toContainEqual({
      featureId: scene.featureId,
      ticketId: conflicted.id,
      title: "L'API",
      reason: "conflict",
    });
  });

  it("pousse la branche et ouvre une pull request dès que le graphe est drainé", async () => {
    gh = await installGhStub();
    const second = gate();
    const scene = await start({
      // Two tickets: the first to merge drains nothing, and that is what says
      // the pull request waits for the graph rather than for a merge.
      tickets: [
        { title: "Le store", criteria: ["La base s'ouvre"] },
        { title: "L'API", criteria: ["Les routes répondent"] },
      ],
      subSession: async (agent, title) => {
        await agent.awaitMessage();
        await commitFile(
          agent.request.workingDirectory,
          title === "Le store" ? "store.ts" : "api.ts",
          "1\n",
          `feat: ${title}`,
        );
        if (title === "L'API") await second.passed;
        await reportCovered(
          agent,
          title === "Le store" ? "La base s'ouvre et les migrations tournent." : "Les routes répondent.",
        );
      },
    });
    const remote = await addOrigin(scene.repository);

    await scene.launch("Le store");
    await scene.launch("L'API");
    await scene.reaches("Le store", "merged");
    expect(onlyRepository(await scene.feature()).pullRequestUrl).toBeNull();

    second.open();
    await scene.reaches("L'API", "merged");
    await expect
      .poll(async () => onlyRepository(await scene.feature()).pullRequestUrl, { timeout: 15_000 })
      .toBe("https://forge.test/squad/pull/1");

    const featureBranch = onlyRepository(await scene.feature()).worktree?.branch ?? "";
    expect(await listBranches(remote)).toContain(featureBranch);

    // One pull request and not two: the first merge drained nothing, so it
    // opened nothing.
    const created = await gh.callsTo("pr", "create");
    expect(created).toHaveLength(1);
    const [opened] = created;
    expect(opened?.[(opened?.indexOf("--base") ?? -1) + 1]).toBe("main");
    expect(opened?.[(opened?.indexOf("--head") ?? -1) + 1]).toBe(featureBranch);
    expect(opened?.[(opened?.indexOf("--title") ?? -1) + 1]).toBe("Le noyau");
    // Described from the graph: one section per ticket, with what its
    // sub-session reported.
    const body = opened?.[(opened?.indexOf("--body") ?? -1) + 1] ?? "";
    expect(body).toContain("Le store");
    expect(body).toContain("les migrations tournent");
    expect(body).toContain("L'API");
    expect(body).toContain("Les routes répondent.");

    // Nothing of this feature went through anyone's hands, so nobody is waiting
    // on it: the forge is asked to merge it as soon as its checks allow. Asked
    // for after the address is written down, hence waited for here.
    await expect
      .poll(async () => (await gh?.callsTo("pr", "merge"))?.length, { timeout: 15_000 })
      .toBe(1);
    expect((await gh.callsTo("pr", "merge"))[0]).toContain("--auto");
  });

  it("draine aussi une feature dont la dernière décision vient d'être tranchée", async () => {
    gh = await installGhStub();
    const scene = await start({
      tickets: [{ title: "Le store", criteria: ["La base s'ouvre"] }],
      subSession: async (agent) => {
        await agent.awaitMessage();
        await commitFile(agent.request.workingDirectory, "store.ts", "1\n", "feat: the store");
        await reportCovered(agent, "Fait.");
      },
    });
    await addOrigin(scene.repository);

    // A decision nobody has settled: it holds nothing back, and it is not
    // merged either, so the graph has not come back whole.
    const tools = await connectToSquadTools(squad.url);
    const decision = (await writeTicket(tools, {
      featureId: scene.featureId,
      kind: "decision",
      title: "Quelle base",
      description: "SQLite ou Postgres.",
    })) as Ticket;

    await scene.launch("Le store");
    await scene.reaches("Le store", "merged");
    expect(onlyRepository(await scene.feature()).pullRequestUrl).toBeNull();

    // Settling it merges nothing and releases nobody, and it is still the
    // moment the last node of this graph comes to rest.
    await tools.call("settle_decision", {
      featureId: scene.featureId,
      ticketId: decision.id,
      conclusion: "SQLite, pour rester local.",
    });
    await tools.close();

    await expect
      .poll(async () => onlyRepository(await scene.feature()).pullRequestUrl, { timeout: 15_000 })
      .toBe("https://forge.test/squad/pull/1");
    const [opened] = await gh.callsTo("pr", "create");
    const body = opened?.[(opened?.indexOf("--body") ?? -1) + 1] ?? "";
    expect(body).toContain("SQLite, pour rester local.");
  });

  it("laisse la pull request attendre dès qu'un test manuel a été demandé", async () => {
    gh = await installGhStub();
    const scene = await start({
      tickets: [{ title: "Le store", criteria: ["La base s'ouvre"] }],
      subSession: async (agent) => {
        await agent.awaitMessage();
        await commitFile(agent.request.workingDirectory, "store.ts", "1\n", "feat: the store");
        await reportUncovered(agent, "Fait, à vérifier à l'œil.");
      },
    });
    await addOrigin(scene.repository);
    const receiver = await catchAlerts();

    await scene.launch("Le store");
    const waiting = await scene.reaches("Le store", "awaiting-validation");
    expect((await review(waiting, [{ passed: true }])).status).toBe(200);
    await scene.reaches("Le store", "merged");

    await expect
      .poll(async () => onlyRepository(await scene.feature()).pullRequestUrl, { timeout: 15_000 })
      .toBe("https://forge.test/squad/pull/1");

    // Waited for first: the alert is raised where squad decides not to merge on
    // its own, so reading it is what says the decision has been taken. Checking
    // the forge before that would pass whatever squad went on to do.
    const alerts = await Promise.all([receiver.next(), receiver.next()]);
    expect(alerts.map((alert) => alert.text).join("\n")).toContain(
      "https://forge.test/squad/pull/1",
    );
    // A person looked at this work, so a person decides when it goes in.
    expect(await gh.callsTo("pr", "merge")).toEqual([]);
    // And what they checked is in the description, beside what the agent said.
    const [opened] = await gh.callsTo("pr", "create");
    const body = opened?.[(opened?.indexOf("--body") ?? -1) + 1] ?? "";
    expect(body).toContain("Vérifié à la main");
    expect(body).toContain("La base s'ouvre");
  });

  it("dit ce que la forge a répondu, sans y recopier la description", async () => {
    gh = await installGhStub();
    await gh.refuse("pr create", "GraphQL: Resource not accessible by personal access token");
    const scene = await start({
      tickets: [{ title: "Le store", criteria: ["La base s'ouvre"] }],
      subSession: async (agent) => {
        await agent.awaitMessage();
        await commitFile(agent.request.workingDirectory, "store.ts", "1\n", "feat: the store");
        await reportCovered(agent, "La base s'ouvre et les migrations tournent.");
      },
    });
    await addOrigin(scene.repository);
    const receiver = await catchAlerts();

    await scene.launch("Le store");
    await scene.reaches("Le store", "merged");

    // The alert is read on a phone: it carries what the forge said and not the
    // pull request description squad had handed it, which is thousands of
    // characters of markdown.
    const alert = await receiver.next();
    expect(alert.text).toContain("personal access token");
    expect(alert.text).not.toContain("les migrations tournent");
    expect((alert.text ?? "").length).toBeLessThan(300);
    expect(onlyRepository(await scene.feature()).pullRequestUrl).toBeNull();
  });

  it("laisse la pull request ouverte quand la forge refuse de la fusionner seule", async () => {
    gh = await installGhStub();
    await gh.refuse("pr merge", "auto-merge is not enabled on this repository");
    const scene = await start({
      tickets: [{ title: "Le store", criteria: ["La base s'ouvre"] }],
      subSession: async (agent) => {
        await agent.awaitMessage();
        await commitFile(agent.request.workingDirectory, "store.ts", "1\n", "feat: the store");
        await reportCovered(agent, "Fait.");
      },
    });
    await addOrigin(scene.repository);
    const receiver = await catchAlerts();

    await scene.launch("Le store");
    await scene.reaches("Le store", "merged");
    await expect
      .poll(async () => onlyRepository(await scene.feature()).pullRequestUrl, { timeout: 15_000 })
      .toBe("https://forge.test/squad/pull/1");

    // The branch is pushed and the pull request is open: what did not happen is
    // the merge, and that is what the developer is told about.
    const alert = await receiver.next();
    expect(alert.text).toContain("https://forge.test/squad/pull/1");
    expect(alert.text).not.toMatch(/n'a pas pu partir/);
    // Two addresses, and they say two different things: the pull request on the
    // forge, and the feature in squad. This alert hangs on no ticket, so squad's
    // own address names the feature and opens its thread, which is where a
    // feature is spoken to.
    const feature = await scene.feature();
    expect(alert.text).toContain(`${squad.url}/features/${feature.id}?thread=open`);
    expect(alert.text).not.toContain("/tickets/");
  });

  it("sérialise les fusions d'un même projet, une seule à la fois", async () => {
    const directory = await mkdtemp(join(tmpdir(), "squad-check-"));
    const log = join(directory, "passes");
    const scene = await start({
      // Long enough that two checks running at once would be seen doing so.
      verifyCommand: `printf 'debut\\n' >> ${log}; sleep 0.3; printf 'fin\\n' >> ${log}`,
      tickets: [
        { title: "Le store", criteria: ["La base s'ouvre"] },
        { title: "L'API", criteria: ["Les routes répondent"] },
      ],
      subSession: async (agent, title) => {
        await agent.awaitMessage();
        await commitFile(
          agent.request.workingDirectory,
          `${title === "Le store" ? "store" : "api"}.ts`,
          "1\n",
          `feat: ${title}`,
        );
        await reportCovered(agent, `Fait pour ${title}.`);
      },
    });

    await scene.launch("Le store");
    await scene.launch("L'API");
    await scene.reaches("Le store", "merged");
    await scene.reaches("L'API", "merged");

    // Two merges, two checks, and never two at once: the second one waited.
    // The check runs after the ticket reads merged, so it is waited for here.
    const passes = async () =>
      (await readFile(log, "utf8")).split("\n").filter((line) => line !== "");
    await expect.poll(async () => (await passes()).length, { timeout: 15_000 }).toBe(4);
    expect(await passes()).toEqual(["debut", "fin", "debut", "fin"]);
  });

  it("mène deux features du même projet de front, et sérialise leurs livraisons", async () => {
    gh = await installGhStub();
    const titles = new Map<string, string>();
    squad = await startTestSquad({
      launcher: createScriptedLauncher(async (agent) => {
        if (agent.request.role === "main") {
          const spec = await agent.awaitMessage();
          const created = (await writeTicket(agent, {
            featureId: agent.request.featureId,
            kind: "build",
            title: `Le ticket de ${spec}`,
            description: "Une tranche.",
            acceptanceCriteria: ["Ça marche"],
          })) as Ticket;
          titles.set(created.id, created.title);
          return;
        }
        // A settling pass this scenario does not script: it ends without
        // answering, so the sheet reaches the developer untouched, which is
        // what these scenarios are about.
        if (agent.request.role === "settling") return;
        await agent.awaitMessage();
        const title = titles.get(agent.request.ticketId ?? "") ?? "";
        await commitFile(
          agent.request.workingDirectory,
          `${title.endsWith("A") ? "a" : "b"}.ts`,
          "1\n",
          `feat: ${title}`,
        );
        await reportCovered(agent, `Fait pour ${title}.`);
      }),
    });
    const { project, repository } = await openTestFeature(squad, "A");
    await addOrigin(repository);
    const second = await squad.request("POST", apiRoutes.features, {
      projectId: project.id,
      title: "B",
    });
    expect(second.status).toBe(201);

    const features = async (): Promise<Feature[]> => {
      const response = await squad.request("GET", apiRoutes.features);
      return ((await response.json()) as { features: Feature[] }).features;
    };
    for (const feature of await features()) {
      await squad.request("POST", mainSessionRoute(feature.id), { prompt: feature.title });
    }
    // Both graphs are written before either ticket is launched, so the two
    // features really do run side by side.
    await expect
      .poll(async () => (await tickets()).length, { timeout: 10_000 })
      .toBe(2);
    for (const ticket of await tickets()) {
      const response = await squad.request("POST", ticketSessionRoute(ticket.id), {});
      expect(response.status).toBe(202);
    }

    async function tickets(): Promise<Ticket[]> {
      const found: Ticket[] = [];
      for (const feature of await features()) {
        const response = await squad.request("GET", featureGraphRoute(feature.id));
        found.push(...((await response.json()) as FeatureGraph).tickets);
      }
      return found;
    }

    await expect
      .poll(async () => (await tickets()).filter((each) => each.state === "merged").length, {
        timeout: 20_000,
      })
      .toBe(2);
    await expect
      .poll(async () => (await features()).filter((each) => onlyRepository(each).pullRequestUrl !== null).length, {
        timeout: 20_000,
      })
      .toBe(2);

    // Two pull requests, and the forge was never asked for two at once: the
    // merges of one project queue behind one another whatever feature they come
    // from.
    expect(await gh.callsTo("pr", "create")).toHaveLength(2);
    expect(await gh.overlapped()).toBe(false);
  });
});
