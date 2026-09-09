import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { Feature, FeatureGraph, ThreadEntry, Ticket } from "../../src/shared/api";
import {
  apiRoutes,
  featureGraphRoute,
  mainSessionRoute,
  ticketSessionRoute,
} from "../../src/shared/api";
import {
  currentBranch,
  isAncestor,
  listBranches,
  listWorktrees,
  pathExists,
} from "../support/git";
import { createScriptedLauncher, type ScriptedAgent } from "../support/scripted-launcher";
import {
  onlyRepository,
  openTestFeature,
  startTestSquad,
  waitForEvent,
  type EventStream,
  type TestSquad,
} from "../support/squad";

/**
 * A ticket leaves the graph and becomes work: its own worktree, its own blank
 * sub-session, and a state the graph shows live. What matters here is that the
 * git repository really moves, so every scenario reads it back with git rather
 * than trusting what squad says about itself.
 */
describe("launching a ticket, failing, and resuming", () => {
  let squad: TestSquad;
  const gates: Gate[] = [];

  afterEach(async () => {
    // Opened before the server goes down, so a sub-session parked on a gate is
    // not left pending after the test that parked it.
    for (const gate of gates) gate.open();
    gates.length = 0;
    await squad.dispose();
  });

  /** A sub-session that stays alive until the test lets it go. */
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

  /** What the sub-sessions of a scenario do, once the graph has been written. */
  type SubSessionScript = (agent: ScriptedAgent) => Promise<void>;

  /**
   * One scripted launcher for both roles: the main session writes the tickets
   * the scenario needs, and every sub-session squad opens afterwards runs the
   * script the scenario handed in.
   */
  async function start(
    writeGraph: (agent: ScriptedAgent) => Promise<void>,
    runTicket: SubSessionScript = async () => {},
  ): Promise<{ featureId: string; repository: string; stream: EventStream }> {
    squad = await startTestSquad({
      launcher: createScriptedLauncher(async (agent) => {
        if (agent.request.role === "main") {
          await agent.awaitMessage();
          await writeGraph(agent);
          return;
        }
        // A settling pass this scenario does not script: it ends without
        // answering, so the sheet reaches the developer untouched, which is
        // what these scenarios are about.
        if (agent.request.role === "settling") return;
        await runTicket(agent);
      }),
    });
    const { feature, repository } = await openTestFeature(squad, "Le noyau");
    const stream = await squad.openEventStream();
    expect((await stream.next()).type).toBe("snapshot");
    return { featureId: feature.id, repository, stream };
  }

  async function readGraph(featureId: string): Promise<FeatureGraph> {
    const response = await squad.request("GET", featureGraphRoute(featureId));
    return (await response.json()) as FeatureGraph;
  }

  /** The feature as the interface reads it, worktree and branch included. */
  async function readFeature(featureId: string): Promise<Feature> {
    const response = await squad.request("GET", apiRoutes.features);
    const { features } = (await response.json()) as { features: Feature[] };
    const feature = features.find((each) => each.id === featureId);
    if (!feature) throw new Error(`no feature with id ${featureId}`);
    return feature;
  }

  async function readTicket(featureId: string, title: string): Promise<Ticket> {
    const graph = await readGraph(featureId);
    const ticket = graph.tickets.find((each) => each.title === title);
    if (!ticket) throw new Error(`no ticket titled ${title} in the graph`);
    return ticket;
  }

  /** The whole thread of a ticket, as a fresh connection is handed it. */
  async function readTicketThread(ticketId: string): Promise<ThreadEntry[]> {
    const stream = await squad.openEventStream();
    const snapshot = await stream.next();
    if (snapshot.type !== "snapshot") throw new Error("the first event is always a snapshot");
    return snapshot.threads.filter((entry) => entry.ticketId === ticketId);
  }

  /**
   * Waits until a ticket reaches a state. The graph is read once before
   * listening, because a state squad reached while nobody was connected is
   * still a state it reached: a scenario that restarts the server would
   * otherwise wait for an event that was published before it opened its stream.
   */
  async function waitForState(
    stream: EventStream,
    featureId: string,
    ticketId: string,
    state: Ticket["state"],
  ): Promise<Ticket> {
    const known = (await readGraph(featureId)).tickets.find((each) => each.id === ticketId);
    if (known?.state === state) return known;
    for (;;) {
      const event = await waitForEvent(stream, "graph-changed");
      const ticket = event.graph.tickets.find((each) => each.id === ticketId);
      if (ticket?.state === state) return ticket;
    }
  }

  /** The one ticket every scenario starts from: on the frontier, nothing before it. */
  async function writeOneTicket(agent: ScriptedAgent): Promise<void> {
    await agent.call("create_ticket", {
      featureId: agent.request.featureId,
      kind: "build",
      title: "Le store",
      description: "La base et ses migrations.",
      acceptanceCriteria: ["La base s'ouvre", "Les migrations s'appliquent"],
    });
  }

  async function launch(ticketId: string, angle?: string): Promise<Response> {
    return squad.request(
      "POST",
      ticketSessionRoute(ticketId),
      angle === undefined ? {} : { angle },
    );
  }

  it("opens a blank sub-session in a worktree of its own, and leaves the main checkout alone", async () => {
    const working = gate();
    let assignment = "";
    let workingDirectory = "";
    const { featureId, repository, stream } = await start(writeOneTicket, async (agent) => {
      assignment = await agent.awaitMessage();
      workingDirectory = agent.request.workingDirectory;
      agent.say("Au travail.");
      await working.passed;
    });

    await squad.request("POST", mainSessionRoute(featureId), { prompt: "/to-tickets" });
    await waitForEvent(stream, "graph-changed");
    const ready = await readTicket(featureId, "Le store");
    expect(ready.state).toBe("ready");

    const accepted = await launch(ready.id);
    expect(accepted.status).toBe(202);

    // The graph says so live, and it says so to anyone connected.
    const running = await waitForState(stream, featureId, ready.id, "running");
    expect(running.sessionId).not.toBeNull();

    // Two checkouts beside the main one, one per stage of the merge: the feature
    // branch is where the ticket branches will come back together, the ticket
    // branch is where the work happens.
    const feature = await readFeature(featureId);
    const worktrees = await listWorktrees(repository);
    expect(worktrees).toHaveLength(3);
    expect(worktrees[0]).toBe(repository);
    expect(worktrees).toContain(onlyRepository(feature).worktree?.path);
    expect(worktrees).toContain(running.worktree?.path);
    expect(await currentBranch(onlyRepository(feature).worktree?.path ?? "")).toBe(onlyRepository(feature).worktree?.branch);
    expect(await currentBranch(running.worktree?.path ?? "")).toBe(running.worktree?.branch);
    // The ticket branch starts from the feature branch, and the main checkout
    // never moved: what points at it still serves what it is thought to serve.
    expect(await isAncestor(repository, onlyRepository(feature).worktree?.branch ?? "", running.worktree?.branch ?? "")).toBe(true);
    expect(await currentBranch(repository)).toBe("main");

    // Blank, in the worktree, and told what the ticket asks for: the sub-session
    // never reads the graph to find out what it is building.
    expect(workingDirectory).toBe(running.worktree?.path);
    expect(assignment).toContain("Le store");
    expect(assignment).toContain("La base et ses migrations.");
    expect(assignment).toContain("Les migrations s'appliquent");

    // The thread of the sub-session is the ticket's own, not the feature's.
    const thread = await readTicketThread(ready.id);
    expect(thread.map((entry) => `${entry.kind}:${entry.text}`)).toContain("agent:Au travail.");
    expect(thread.every((entry) => entry.sessionId === running.sessionId)).toBe(true);
  });

  it("keeps the worktree, the branch and the session of a ticket whose sub-session failed", async () => {
    const { featureId, repository, stream } = await start(writeOneTicket, async (agent) => {
      await agent.awaitMessage();
      throw new Error("les tests ne passent pas");
    });

    await squad.request("POST", mainSessionRoute(featureId), { prompt: "/to-tickets" });
    await waitForEvent(stream, "graph-changed");
    const ready = await readTicket(featureId, "Le store");
    await launch(ready.id);

    const failed = await waitForState(stream, featureId, ready.id, "failed");
    expect(failed.worktree).not.toBeNull();
    expect(failed.sessionId).not.toBeNull();
    // Nothing is cleaned up on a failure: this is what the developer resumes on.
    expect(await pathExists(failed.worktree?.path ?? "")).toBe(true);
    expect(await listBranches(repository)).toContain(failed.worktree?.branch);

    // Why it stopped, on the thread, rather than a node that simply went quiet.
    const thread = await readTicketThread(ready.id);
    const last = thread.at(-1);
    expect(last?.kind).toBe("notice");
    expect(last?.detail).toContain("les tests ne passent pas");
  });

  it("resumes a failed ticket on its own session, under the angle the developer chose", async () => {
    const secondRun = gate();
    const openings: Array<{ resumed: string | undefined; message: string }> = [];
    const { featureId, stream } = await start(writeOneTicket, async (agent) => {
      const message = await agent.awaitMessage();
      openings.push({ resumed: agent.request.resumeSessionId, message });
      if (openings.length === 1) throw new Error("les tests ne passent pas");
      await secondRun.passed;
    });

    await squad.request("POST", mainSessionRoute(featureId), { prompt: "/to-tickets" });
    await waitForEvent(stream, "graph-changed");
    const ready = await readTicket(featureId, "Le store");
    await launch(ready.id);
    const failed = await waitForState(stream, featureId, ready.id, "failed");

    const relaunched = await launch(ready.id, "diagnose");
    expect(relaunched.status).toBe(202);
    const running = await waitForState(stream, featureId, ready.id, "running");

    // The same session, the same worktree, the same branch: a relaunch that
    // opened a blank session would throw away everything the failure taught it.
    expect(running.sessionId).toBe(failed.sessionId);
    expect(running.worktree).toEqual(failed.worktree);
    expect(openings).toHaveLength(2);
    expect(openings[0]?.resumed).toBeUndefined();
    expect(openings[1]?.resumed).toBe(failed.sessionId);
    // The angle is what the second message says, and it is not the first one.
    expect(openings[1]?.message).toMatch(/diagnos/i);
    expect(openings[0]?.message).not.toMatch(/diagnos/i);
  });

  it("resumes an implementation that failed, rather than starting it over", async () => {
    const secondRun = gate();
    const messages: string[] = [];
    const { featureId, stream } = await start(writeOneTicket, async (agent) => {
      messages.push(await agent.awaitMessage());
      if (messages.length === 1) throw new Error("interrompu en plein travail");
      await secondRun.passed;
    });

    await squad.request("POST", mainSessionRoute(featureId), { prompt: "/to-tickets" });
    await waitForEvent(stream, "graph-changed");
    const ready = await readTicket(featureId, "Le store");
    await launch(ready.id);
    await waitForState(stream, featureId, ready.id, "failed");

    await launch(ready.id, "implement");
    await waitForState(stream, featureId, ready.id, "running");

    expect(messages[1]).not.toMatch(/diagnos/i);
    expect(messages[1]).toMatch(/carry on|resume/i);
  });

  it("takes a ticket the server left running back on its own session", async () => {
    const resumed = gate();
    const openings: Array<string | undefined> = [];
    const { featureId, stream } = await start(writeOneTicket, async (agent) => {
      await agent.awaitMessage();
      openings.push(agent.request.resumeSessionId);
      if (openings.length === 1) await new Promise<void>(() => {});
      else await resumed.passed;
    });

    await squad.request("POST", mainSessionRoute(featureId), { prompt: "/to-tickets" });
    await waitForEvent(stream, "graph-changed");
    const ready = await readTicket(featureId, "Le store");
    await launch(ready.id);
    const before = await waitForState(stream, featureId, ready.id, "running");

    // The process disappears with the server. What squad wrote down is that the
    // ticket was running, which is exactly what the next start has to reconcile.
    await squad.restart();

    const after = await squad.openEventStream();
    expect((await after.next()).type).toBe("snapshot");
    const running = await waitForState(after, featureId, ready.id, "running");
    expect(running.sessionId).toBe(before.sessionId);
    expect(openings[1]).toBe(before.sessionId);

    // The interruption is on the record, so the developer reading the thread
    // knows the restart cost a turn rather than wondering what the agent did.
    const thread = await readTicketThread(ready.id);
    expect(thread.some((entry) => entry.kind === "notice" && /interrupt/i.test(entry.text))).toBe(
      true,
    );
  });

  it("leaves a ticket interrupted when its worktree cannot be reopened", async () => {
    const { featureId, repository, stream } = await start(writeOneTicket, async (agent) => {
      await agent.awaitMessage();
      await new Promise<void>(() => {});
    });

    await squad.request("POST", mainSessionRoute(featureId), { prompt: "/to-tickets" });
    await waitForEvent(stream, "graph-changed");
    const ready = await readTicket(featureId, "Le store");
    await launch(ready.id);
    const running = await waitForState(stream, featureId, ready.id, "running");

    // The repository and the checkout are both gone by the time squad comes
    // back up, so taking the sub-session back cannot even begin.
    await rm(repository, { recursive: true, force: true });
    await rm(running.worktree?.path ?? "", { recursive: true, force: true });
    await squad.restart();

    const after = await squad.openEventStream();
    expect((await after.next()).type).toBe("snapshot");
    // Left where the restart put it, which is the truth: nothing is running and
    // the work is still on its branch. Reading it as a fresh failure would
    // suggest an attempt was made and lost.
    const interrupted = await waitForState(after, featureId, ready.id, "interrupted");
    expect(interrupted.sessionId).toBe(running.sessionId);
    const thread = await readTicketThread(ready.id);
    expect(
      thread.some((entry) => entry.kind === "notice" && /could not take/i.test(entry.text)),
    ).toBe(true);
  });

  it("refuses to launch a ticket whose blockers are not all merged", async () => {
    const { featureId, stream } = await start(async (agent) => {
      const store = (await agent.call("create_ticket", {
        featureId: agent.request.featureId,
        kind: "build",
        title: "Le store",
        description: "",
      })) as Ticket;
      await agent.call("create_ticket", {
        featureId: agent.request.featureId,
        kind: "build",
        title: "Les outils MCP",
        description: "",
        blockedBy: [store.id],
      });
    });

    await squad.request("POST", mainSessionRoute(featureId), { prompt: "/to-tickets" });
    await waitForEvent(stream, "graph-changed");
    await waitForEvent(stream, "graph-changed");
    const blocked = await readTicket(featureId, "Les outils MCP");
    expect(blocked.state).toBe("blocked");

    const refused = await launch(blocked.id);
    expect(refused.status).toBe(409);
    expect((await readTicket(featureId, "Les outils MCP")).state).toBe("blocked");
  });

  it("refuses to launch a decision, which is settled and never implemented", async () => {
    const { featureId, stream } = await start(async (agent) => {
      await agent.call("create_ticket", {
        featureId: agent.request.featureId,
        kind: "decision",
        title: "Quelle base",
        description: "",
      });
    });

    await squad.request("POST", mainSessionRoute(featureId), { prompt: "/to-tickets" });
    await waitForEvent(stream, "graph-changed");
    const decision = await readTicket(featureId, "Quelle base");

    const refused = await launch(decision.id);
    expect(refused.status).toBe(409);
    expect((await readTicket(featureId, "Quelle base")).state).toBe("awaiting-decision");
  });

  it("refuses to launch a ticket that is already running", async () => {
    const working = gate();
    const { featureId, stream } = await start(writeOneTicket, async (agent) => {
      await agent.awaitMessage();
      await working.passed;
    });

    await squad.request("POST", mainSessionRoute(featureId), { prompt: "/to-tickets" });
    await waitForEvent(stream, "graph-changed");
    const ready = await readTicket(featureId, "Le store");
    await launch(ready.id);
    await waitForState(stream, featureId, ready.id, "running");

    const refused = await launch(ready.id);
    expect(refused.status).toBe(409);
  });

  it("opens one sub-session when two launches of the same ticket race", async () => {
    const working = gate();
    let opened = 0;
    const { featureId, stream } = await start(writeOneTicket, async (agent) => {
      opened += 1;
      await agent.awaitMessage();
      await working.passed;
    });

    await squad.request("POST", mainSessionRoute(featureId), { prompt: "/to-tickets" });
    await waitForEvent(stream, "graph-changed");
    const ready = await readTicket(featureId, "Le store");

    // A double click, or two clients. Opening a sub-session takes a checkout
    // and a process, and both requests arrive well inside that window.
    const answers = await Promise.all([launch(ready.id), launch(ready.id)]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([202, 409]);
    await waitForState(stream, featureId, ready.id, "running");
    expect(opened).toBe(1);
  });

  it("announces the feature worktree it checked out", async () => {
    const working = gate();
    const { featureId, stream } = await start(writeOneTicket, async (agent) => {
      await agent.awaitMessage();
      await working.passed;
    });

    await squad.request("POST", mainSessionRoute(featureId), { prompt: "/to-tickets" });
    await waitForEvent(stream, "graph-changed");
    const ready = await readTicket(featureId, "Le store");
    await launch(ready.id);

    // A client that only listens to this stream holds the whole state: the
    // feature gains a branch on its first launch, and it has to hear about it.
    const changed = await waitForEvent(stream, "feature-changed");
    expect(changed.feature.id).toBe(featureId);
    expect(onlyRepository(changed.feature).worktree?.branch).toContain("squad/feature/");
  });

  it("refuses to launch a ticket that does not exist", async () => {
    const { featureId } = await start(writeOneTicket);
    expect(featureId).toBeTruthy();
    const refused = await launch("inconnu");
    expect(refused.status).toBe(404);
  });

  it("recreates a ticket worktree that was removed from disk", async () => {
    const secondRun = gate();
    let opened = 0;
    const { featureId, repository, stream } = await start(writeOneTicket, async (agent) => {
      opened += 1;
      await agent.awaitMessage();
      if (opened === 1) throw new Error("échec");
      await secondRun.passed;
    });

    await squad.request("POST", mainSessionRoute(featureId), { prompt: "/to-tickets" });
    await waitForEvent(stream, "graph-changed");
    const ready = await readTicket(featureId, "Le store");
    await launch(ready.id);
    const failed = await waitForState(stream, featureId, ready.id, "failed");

    // A developer who cleaned up their temporary directories should not be told
    // the ticket is beyond saving: the branch still holds the work.
    await rm(failed.worktree?.path ?? "", { recursive: true, force: true });
    await launch(ready.id);
    const running = await waitForState(stream, featureId, ready.id, "running");

    expect(running.worktree?.branch).toBe(failed.worktree?.branch);
    expect(await pathExists(running.worktree?.path ?? "")).toBe(true);
    expect(await listWorktrees(repository)).toContain(running.worktree?.path);
  });
});

