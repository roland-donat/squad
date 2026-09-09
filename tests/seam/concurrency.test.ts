import { afterEach, expect, describe, it } from "vitest";
import {
  apiRoutes,
  featureGraphRoute,
  mainSessionRoute,
  projectRoute,
  ticketSessionRoute,
  type FeatureGraph,
  type SquadEvent,
  type ThreadEntry,
  type Ticket,
} from "../../src/shared/api";
import { listWorktrees } from "../support/git";
import { connectToSquadTools } from "../support/mcp";
import { createScriptedLauncher, type ScriptedAgent } from "../support/scripted-launcher";
import {
  openTestFeature,
  startTestSquad,
  waitForEvent,
  type EventStream,
  type TestSquad,
} from "../support/squad";

/**
 * Several tickets of the frontier run at the same time, each in its own
 * worktree, and never more than the declared caps allow. What a cap holds back
 * is not refused: the launch waits its turn and leaves as soon as a place
 * frees, which is the whole difference between a queue and a wall.
 */
describe("running several tickets at once, under the declared caps", () => {
  let squad: TestSquad;
  const gates = new Map<string, Gate>();
  const watchers: Watcher[] = [];

  afterEach(async () => {
    // Let go of every parked sub-session before the server goes down, and tell
    // them not to report: the server they would report to is on its way out.
    for (const gate of gates.values()) gate.abandon();
    gates.clear();
    // Stopped here as well as in the scenarios, so a scenario that fails before
    // its own stop() does not leave a reader on a stream that is about to go.
    for (const watcher of watchers) watcher.stop();
    watchers.length = 0;
    await squad.dispose();
  });

  /**
   * A sub-session parked until the test lets it go. Opened, it ends its step
   * and frees its place; abandoned, it simply stops.
   */
  interface Gate {
    passed: Promise<boolean>;
    open(): void;
    abandon(): void;
  }

  function gate(ticketId: string): Gate {
    const known = gates.get(ticketId);
    if (known) return known;
    let release = (_reported: boolean) => {};
    const passed = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    const created = { passed, open: () => release(true), abandon: () => release(false) };
    gates.set(ticketId, created);
    return created;
  }

  /**
   * What the sub-sessions did, in the order they did it: `open:<ticket>` when
   * squad opened one, `report:<ticket>` when one ended its step. The order is
   * the whole point. Reading a ticket's state at a chosen moment would say
   * nothing, since a launch squad decided to hold and one it is still checking
   * out both read as waiting; what tells them apart is that the held one only
   * ever opens after a place comes back.
   */
  let timeline: string[] = [];

  /**
   * A feature whose main session writes one ticket per title, none blocking any
   * other: every one of them is on the frontier from the start, which is what
   * puts the caps in charge of what actually runs.
   */
  async function start(titles: string[]): Promise<Scenario> {
    timeline = [];
    squad = await startTestSquad({
      launcher: createScriptedLauncher(async (agent) => {
        if (agent.request.role === "main") {
          await agent.awaitMessage();
          for (const title of titles) {
            await agent.call("create_ticket", {
              featureId: agent.request.featureId,
              kind: "build",
              title,
              description: `Ce que fait ${title}.`,
            });
          }
          return;
        }
        // A settling pass this scenario does not script: it ends without
        // answering, so the sheet reaches the developer untouched, which is
        // what these scenarios are about.
        if (agent.request.role === "settling") return;
        await runTicket(agent);
      }),
    });
    const { project, feature, repository } = await openTestFeature(squad, "Le parallélisme");
    const stream = await squad.openEventStream();
    expect((await stream.next()).type).toBe("snapshot");
    return { projectId: project.id, featureId: feature.id, repository, stream };
  }

  interface Scenario {
    projectId: string;
    featureId: string;
    repository: string;
    stream: EventStream;
  }

  /**
   * What every sub-session of these scenarios does: announce itself, wait to be
   * let go, then end its step so its place comes back to the frontier.
   */
  async function runTicket(agent: ScriptedAgent): Promise<void> {
    const ticketId = agent.request.ticketId ?? "";
    timeline.push(`open:${ticketId}`);
    await agent.awaitMessage();
    if (!(await gate(ticketId).passed)) return;
    await agent.call("report_step", {
      featureId: agent.request.featureId,
      ticketId,
      summary: "C'est fait.",
      coverage: [],
      recommendation: "Fusionner.",
    });
    timeline.push(`report:${ticketId}`);
  }

  /** Writes the graph, and hands back the tickets it holds, in the order asked. */
  async function writeGraph(scenario: Scenario, titles: string[]): Promise<Ticket[]> {
    await squad.request("POST", mainSessionRoute(scenario.featureId), { prompt: "/to-tickets" });
    for (let written = 0; written < titles.length; written += 1) {
      await waitForEvent(scenario.stream, "graph-changed");
    }
    const graph = await readGraph(scenario.featureId);
    return titles.map((title) => {
      const ticket = graph.tickets.find((each) => each.title === title);
      if (!ticket) throw new Error(`no ticket titled ${title} in the graph`);
      return ticket;
    });
  }

  /** The caps as the developer declares them: one machine-wide, one per feature. */
  async function declareCaps(
    scenario: Scenario,
    caps: { machine: number; feature: number },
  ): Promise<void> {
    const machine = await squad.request("PUT", apiRoutes.settings, {
      machineConcurrencyCap: caps.machine,
    });
    expect(machine.status).toBe(200);
    const feature = await squad.request("PUT", projectRoute(scenario.projectId), {
      featureConcurrencyCap: caps.feature,
    });
    expect(feature.status).toBe(200);
  }

  async function readGraph(featureId: string): Promise<FeatureGraph> {
    const response = await squad.request("GET", featureGraphRoute(featureId));
    return (await response.json()) as FeatureGraph;
  }

  async function readTicket(featureId: string, ticketId: string): Promise<Ticket> {
    const ticket = (await readGraph(featureId)).tickets.find((each) => each.id === ticketId);
    if (!ticket) throw new Error(`no ticket with id ${ticketId} in the graph`);
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
   * Watches every graph squad publishes, on a connection of its own, and keeps
   * the highest number of sub-sessions it ever saw running at the same time.
   * The caps are a promise about that number and about nothing else, so this is
   * what says whether they held: a state read at a chosen instant would only
   * ever say what had happened to be true by then.
   */
  async function watchRunning(): Promise<Watcher> {
    const stream = await squad.openEventStream();
    const graphs = new Map<string, FeatureGraph>();
    let peak = 0;
    const peakByFeature = new Map<string, number>();
    let watching = true;
    void (async () => {
      while (watching) {
        let event: SquadEvent;
        try {
          // Short waits rather than one long one: nothing is lost, since the
          // stream keeps what arrives while nobody is reading, and the watcher
          // stops soon after it is told to.
          event = await stream.next(100);
        } catch {
          continue;
        }
        if (event.type === "snapshot") {
          for (const graph of event.graphs) graphs.set(graph.featureId, graph);
        } else if (event.type === "graph-changed") {
          graphs.set(event.graph.featureId, event.graph);
        } else {
          continue;
        }
        let machine = 0;
        for (const graph of graphs.values()) {
          const running = graph.tickets.filter((ticket) => ticket.state === "running").length;
          machine += running;
          peakByFeature.set(
            graph.featureId,
            Math.max(peakByFeature.get(graph.featureId) ?? 0, running),
          );
        }
        peak = Math.max(peak, machine);
      }
    })();
    const watcher: Watcher = {
      peak: () => peak,
      peakOf: (featureId) => peakByFeature.get(featureId) ?? 0,
      stop: () => {
        watching = false;
      },
    };
    watchers.push(watcher);
    return watcher;
  }

  interface Watcher {
    /** The most sub-sessions ever running at the same time, all features together. */
    peak(): number;
    /** The most ever running at the same time on one feature. */
    peakOf(featureId: string): number;
    stop(): void;
  }

  /** A feature of the same project, with one ticket per title on its frontier. */
  async function openAnotherFeature(
    scenario: Scenario,
    titles: string[],
  ): Promise<{ featureId: string; tickets: Ticket[] }> {
    const opening = await squad.request("POST", apiRoutes.features, {
      projectId: scenario.projectId,
      title: "Une autre feature",
    });
    const { feature } = (await opening.json()) as { feature: { id: string } };
    await squad.request("POST", mainSessionRoute(feature.id), { prompt: "/to-tickets" });
    for (let written = 0; written < titles.length; written += 1) {
      await waitForEvent(scenario.stream, "graph-changed");
    }
    return { featureId: feature.id, tickets: (await readGraph(feature.id)).tickets };
  }

  /** Asks for a launch, and hands back the ticket as squad answered it. */
  async function launch(ticketId: string): Promise<Ticket> {
    const response = await squad.request("POST", ticketSessionRoute(ticketId), {});
    expect(response.status).toBe(202);
    const { ticket } = (await response.json()) as { ticket: Ticket };
    return ticket;
  }

  /**
   * Waits until a ticket reaches a state, reading the graph once before
   * listening: a state squad reached while nobody was connected is still a
   * state it reached.
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

  it("runs three tickets at once, holds the fourth, and starts it as a place frees", async () => {
    const titles = ["Le store", "Les outils MCP", "Le lanceur", "L'ordonnanceur"];
    const scenario = await start(titles);
    await declareCaps(scenario, { machine: 3, feature: 5 });
    const watcher = await watchRunning();
    const [first, second, third, fourth] = await writeGraph(scenario, titles);

    for (const ticket of [first, second, third, fourth]) await launch(ticket!.id);

    // One at a time: a stream hands each event to a single reader, so waiting
    // on three of them at once would let one waiter eat another's event.
    const running: Ticket[] = [];
    for (const ticket of [first, second, third]) {
      running.push(await waitForState(scenario.stream, scenario.featureId, ticket!.id, "running"));
    }

    // Three sub-sessions in flight, each in a checkout of its own, and git says
    // so rather than squad: two agents sharing a worktree would overwrite each
    // other without anything in the graph showing it.
    const paths = running.map((ticket) => ticket.worktree?.path ?? "");
    expect(new Set(paths).size).toBe(3);
    const checkouts = await listWorktrees(scenario.repository);
    for (const path of paths) expect(checkouts).toContain(path);

    // Each with its own thread, on its own session: that is what makes clicking
    // a node open the thread of that ticket and no other.
    const sessions = running.map((ticket) => ticket.sessionId);
    expect(new Set(sessions).size).toBe(3);
    for (const ticket of running) {
      const thread = await readTicketThread(ticket.id);
      expect(thread.length).toBeGreaterThan(0);
      expect(thread.every((entry) => entry.sessionId === ticket.sessionId)).toBe(true);
    }

    // The fourth was accepted, not refused: it waits for a place, and nothing
    // has been checked out for it.
    const waiting = await readTicket(scenario.featureId, fourth!.id);
    expect(waiting.state).toBe("queued");
    expect(waiting.sessionId).toBeNull();
    expect(waiting.worktree).toBeNull();

    // A place frees the moment a step ends, and the one that waited takes it.
    // These tickets carry no acceptance criterion, so their sheet comes back
    // empty and the step goes all the way through on its own: `merged` is where
    // it comes to rest, and waiting for anything it only passes through would
    // be waiting for a state that may already be behind us.
    gate(first!.id).open();
    await waitForState(scenario.stream, scenario.featureId, first!.id, "merged");
    const started = await waitForState(
      scenario.stream,
      scenario.featureId,
      fourth!.id,
      "running",
    );
    expect(started.sessionId).not.toBeNull();

    // Three at once and never four, over the whole scenario: that is the whole
    // of what the machine cap promises.
    watcher.stop();
    expect(watcher.peak()).toBe(3);

    // Three sub-sessions, then the fourth and only after a step ended: the
    // order is what says the cap held it back rather than the clock.
    expect(timeline).toEqual([
      `open:${first!.id}`,
      `open:${second!.id}`,
      `open:${third!.id}`,
      `report:${first!.id}`,
      `open:${fourth!.id}`,
    ]);
  });

  it("applies the feature cap when it is the more restrictive of the two", async () => {
    const titles = ["Le store", "Les outils MCP", "Le lanceur"];
    const scenario = await start(titles);
    await declareCaps(scenario, { machine: 8, feature: 2 });
    const watcher = await watchRunning();
    const [first, second, third] = await writeGraph(scenario, titles);

    for (const ticket of [first, second, third]) await launch(ticket!.id);
    await waitForState(scenario.stream, scenario.featureId, first!.id, "running");
    await waitForState(scenario.stream, scenario.featureId, second!.id, "running");

    // A ticket of another feature, asked for last and running first. It says
    // the machine had places to spare, and it is also what makes the check
    // below mean something: checkouts are made one at a time and in the order
    // they were asked for, so a third sub-session on the first feature, had
    // squad opened one, would have opened before this one.
    const elsewhere = await openAnotherFeature(scenario, ["Le graphe à l'écran"]);
    await launch(elsewhere.tickets[0]!.id);
    await waitForState(scenario.stream, elsewhere.featureId, elsewhere.tickets[0]!.id, "running");

    expect((await readTicket(scenario.featureId, third!.id)).state).toBe("queued");
    // Two at a time on this feature, and three on the machine: what held the
    // third back is the cap its project declares for one feature, and the
    // machine-wide one was not even close.
    expect(watcher.peakOf(scenario.featureId)).toBe(2);
    expect(watcher.peak()).toBe(3);

    // And the place that comes back is this feature's own.
    gate(second!.id).open();
    await waitForState(scenario.stream, scenario.featureId, third!.id, "running");
    watcher.stop();
    expect(watcher.peakOf(scenario.featureId)).toBe(2);
  });

  it("applies the machine cap across features, whatever each feature allows", async () => {
    const titles = ["Le store", "Les outils MCP"];
    const scenario = await start(titles);
    await declareCaps(scenario, { machine: 1, feature: 5 });
    const watcher = await watchRunning();
    const [first] = await writeGraph(scenario, titles);

    const elsewhere = await openAnotherFeature(scenario, ["Le graphe à l'écran"]);
    await launch(first!.id);
    await waitForState(scenario.stream, scenario.featureId, first!.id, "running");
    await launch(elsewhere.tickets[0]!.id);

    // Nothing else can run to stand as a barrier here, the machine having one
    // place and it being taken. A cap is a promise not to act, and nothing
    // observable ever says "I have not acted": leaving the time for the action
    // and finding it did not happen is the only honest way to check one.
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Its own feature allows five and holds nothing back; the other feature has
    // not even been checked out, since that is part of opening a sub-session.
    const waiting = await readTicket(elsewhere.featureId, elsewhere.tickets[0]!.id);
    expect(waiting.state).toBe("queued");
    expect(waiting.worktree).toBeNull();
    expect(watcher.peak()).toBe(1);

    gate(first!.id).open();
    await waitForState(scenario.stream, elsewhere.featureId, elsewhere.tickets[0]!.id, "running");
    watcher.stop();
    // One at a time throughout, across two features that each allowed five.
    expect(watcher.peak()).toBe(1);
    expect(timeline).toEqual([
      `open:${first!.id}`,
      `report:${first!.id}`,
      `open:${elsewhere.tickets[0]!.id}`,
    ]);
  });

  it("refuses a second launch of a ticket that is already waiting for a place", async () => {
    const titles = ["Le store", "Les outils MCP"];
    const scenario = await start(titles);
    await declareCaps(scenario, { machine: 1, feature: 5 });
    const [first, second] = await writeGraph(scenario, titles);

    await launch(first!.id);
    await waitForState(scenario.stream, scenario.featureId, first!.id, "running");
    await launch(second!.id);

    // A second click on a ticket already waiting must not queue it twice: two
    // sub-sessions on one branch is exactly what the caps are there to prevent.
    const again = await squad.request("POST", ticketSessionRoute(second!.id), {});
    expect(again.status).toBe(409);

    gate(first!.id).open();
    await waitForState(scenario.stream, scenario.featureId, second!.id, "running");
    // One sub-session for the second ticket, not two: a ticket queued twice
    // would open twice the moment a place came back.
    expect(timeline.filter((step) => step === `open:${second!.id}`)).toHaveLength(1);
  });

  it("starts a waiting launch as soon as a cap is raised", async () => {
    const titles = ["Le store", "Les outils MCP"];
    const scenario = await start(titles);
    await declareCaps(scenario, { machine: 1, feature: 5 });
    const [first, second] = await writeGraph(scenario, titles);

    await launch(first!.id);
    await waitForState(scenario.stream, scenario.featureId, first!.id, "running");
    await launch(second!.id);
    expect((await readTicket(scenario.featureId, second!.id)).state).toBe("queued");

    // A place also comes back when the developer decides the machine can take
    // one more, and what waits must not sit there until something else moves.
    const raised = await squad.request("PUT", apiRoutes.settings, { machineConcurrencyCap: 2 });
    expect(raised.status).toBe(200);

    await waitForState(scenario.stream, scenario.featureId, second!.id, "running");
  });

  it("takes the interrupted sub-session back first, and forgets no launch", async () => {
    const titles = ["Le store", "Les outils MCP"];
    const scenario = await start(titles);
    await declareCaps(scenario, { machine: 1, feature: 5 });
    const [first, second] = await writeGraph(scenario, titles);

    await launch(first!.id);
    const before = await waitForState(scenario.stream, scenario.featureId, first!.id, "running");
    await launch(second!.id);
    expect((await readTicket(scenario.featureId, second!.id)).state).toBe("queued");

    // The queue is squad's own record, not a list held in memory: a restart
    // owes the developer the launch it accepted before it.
    await squad.restart();
    const after = await squad.openEventStream();
    expect((await after.next()).type).toBe("snapshot");

    // The one place goes back to the sub-session that was cut off, on its own
    // session, rather than to the launch that had merely been waiting: a
    // restart costs the turn in flight and nothing more.
    const back = await waitForState(after, scenario.featureId, first!.id, "running");
    expect(back.sessionId).toBe(before.sessionId);
    expect((await readTicket(scenario.featureId, second!.id)).state).toBe("queued");

    // And the launch accepted before the restart still goes, when its turn comes.
    gate(first!.id).open();
    await waitForState(after, scenario.featureId, second!.id, "running");
  });

  it("starts a launch a decision was holding back, once the decision is settled", async () => {
    const titles = ["Le store", "Les outils MCP"];
    const scenario = await start(titles);
    await declareCaps(scenario, { machine: 1, feature: 5 });
    const [first, second] = await writeGraph(scenario, titles);

    await launch(first!.id);
    await waitForState(scenario.stream, scenario.featureId, first!.id, "running");
    await launch(second!.id);

    // A decision posted in front of a launch that is already waiting. The
    // request is not thrown away: the ticket reads as blocked while its blocker
    // stands, since a place is not what it is waiting for any more.
    const tools = await connectToSquadTools(squad.url);
    const decision = (await tools.call("create_ticket", {
      featureId: scenario.featureId,
      kind: "decision",
      title: "Quelle base",
      description: "SQLite ou Postgres.",
      blocks: [second!.id],
    })) as Ticket;
    expect((await readTicket(scenario.featureId, second!.id)).state).toBe("blocked");

    // The place comes back, and it stays free: what holds this launch is the
    // decision, not the machine.
    gate(first!.id).open();
    await waitForState(scenario.stream, scenario.featureId, first!.id, "merged");
    expect((await readTicket(scenario.featureId, second!.id)).state).toBe("blocked");

    // Settling releases what it blocked, and the launch asked for long before
    // goes without anyone having to ask again.
    await tools.call("settle_decision", {
      featureId: scenario.featureId,
      ticketId: decision.id,
      conclusion: "SQLite, pour rester local.",
    });
    await waitForState(scenario.stream, scenario.featureId, second!.id, "running");
    await tools.close();
  });
});
