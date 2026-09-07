import { afterEach, describe, expect, it } from "vitest";
import type { FeatureGraph, Ticket, ThreadEntry } from "../../src/shared/api";
import {
  featureGraphRoute,
  mainSessionMessagesRoute,
  mainSessionRoute,
} from "../../src/shared/api";
import { frontier } from "../../src/shared/graph";
import { createScriptedLauncher, type AgentScript } from "../support/scripted-launcher";
import {
  openTestFeature,
  startTestSquad,
  waitForEvent,
  type EventStream,
  type TestSquad,
} from "../support/squad";

/**
 * A decision is the one kind of ticket squad never launches: it waits in the
 * graph until the developer settles it from the main session, and settling it
 * releases whatever it was holding back. The whole cycle is played here through
 * the same surface the interface uses.
 */
describe("a decision ticket, from the graph to its conclusion", () => {
  let squad: TestSquad;

  afterEach(async () => {
    await squad.dispose();
  });

  async function start(
    script: AgentScript,
  ): Promise<{ featureId: string; stream: EventStream }> {
    squad = await startTestSquad({ launcher: createScriptedLauncher(script) });
    const { feature } = await openTestFeature(squad, "Le noyau");
    const stream = await squad.openEventStream();
    expect((await stream.next()).type).toBe("snapshot");
    return { featureId: feature.id, stream };
  }

  async function readGraph(featureId: string): Promise<FeatureGraph> {
    const response = await squad.request("GET", featureGraphRoute(featureId));
    return (await response.json()) as FeatureGraph;
  }

  /** Waits for the next line the session writes of a given kind. */
  async function waitForThreadEntry(stream: EventStream, kind: ThreadEntry["kind"]) {
    for (;;) {
      const event = await waitForEvent(stream, "thread-appended");
      if (event.entry.kind === kind) return event.entry;
    }
  }

  /** The whole thread of a feature, as a fresh connection is handed it. */
  async function readThread(featureId: string): Promise<ThreadEntry[]> {
    const stream = await squad.openEventStream();
    const snapshot = await stream.next();
    if (snapshot.type !== "snapshot") throw new Error("the first event is always a snapshot");
    return snapshot.threads.filter((entry) => entry.featureId === featureId);
  }

  function ticketNamed(graph: FeatureGraph, title: string): Ticket {
    const ticket = graph.tickets.find((each) => each.title === title);
    if (!ticket) throw new Error(`no ticket titled ${title} in the graph`);
    return ticket;
  }

  it("waits for the developer, then releases what it blocked", async () => {
    const { featureId, stream } = await start(async (agent) => {
      await agent.awaitMessage();
      const decision = (await agent.call("create_ticket", {
        featureId: agent.request.featureId,
        kind: "decision",
        title: "Quelle disposition pour le graphe",
        description: "En couches ou en radial.",
      })) as Ticket;
      await agent.call("create_ticket", {
        featureId: agent.request.featureId,
        kind: "build",
        title: "Le graphe à l'écran",
        description: "La lecture du plan.",
        blockedBy: [decision.id],
      });
      agent.say("Découpage écrit, une décision à prendre.");

      // The developer settles it in this very thread: squad reads no prose, so
      // the answer only reaches the graph as a tool call.
      const answer = await agent.awaitMessage();
      expect(answer).toContain("couches");
      await agent.call("settle_decision", {
        featureId: agent.request.featureId,
        ticketId: decision.id,
        conclusion: `En couches. ${answer}`,
      });
      agent.say("Décision consignée.");
    });

    await squad.request("POST", mainSessionRoute(featureId), { prompt: "/to-tickets" });

    // Both tickets written, and neither can be launched: the decision waits for
    // a human, and the build waits for the decision.
    await waitForEvent(stream, "graph-changed");
    await waitForEvent(stream, "graph-changed");
    const pending = await readGraph(featureId);
    expect(ticketNamed(pending, "Quelle disposition pour le graphe").state).toBe(
      "awaiting-decision",
    );
    expect(ticketNamed(pending, "Le graphe à l'écran").state).toBe("blocked");
    expect(frontier(pending)).toEqual([]);

    const sent = await squad.request("POST", mainSessionMessagesRoute(featureId), {
      text: "Va pour les couches.",
    });
    expect(sent.status).toBe(202);

    await waitForEvent(stream, "graph-changed");
    const settled = await readGraph(featureId);
    const decision = ticketNamed(settled, "Quelle disposition pour le graphe");
    expect(decision.state).toBe("merged");
    expect(decision.conclusion).toContain("En couches");
    // Settled, so it holds nothing back any more: the build is the frontier.
    expect(frontier(settled).map((ticket) => ticket.title)).toEqual(["Le graphe à l'écran"]);
  });

  it("refuses to settle a ticket that is not a decision", async () => {
    let refusal = "";
    const { featureId, stream } = await start(async (agent) => {
      await agent.awaitMessage();
      const build = (await agent.call("create_ticket", {
        featureId: agent.request.featureId,
        kind: "build",
        title: "Le store",
        description: "",
      })) as Ticket;
      const outcome = await agent.attempt("settle_decision", {
        featureId: agent.request.featureId,
        ticketId: build.id,
        conclusion: "on tranche",
      });
      expect(outcome.refused).toBe(true);
      refusal = outcome.text;
    });

    await squad.request("POST", mainSessionRoute(featureId), { prompt: "/to-tickets" });
    await waitForEvent(stream, "main-session-ended");

    expect(refusal).toContain("decision");
    const graph = await readGraph(featureId);
    expect(ticketNamed(graph, "Le store").state).toBe("ready");
    expect(ticketNamed(graph, "Le store").conclusion).toBeNull();
  });

  it("refuses to settle a decision twice", async () => {
    let refusal = "";
    const { featureId, stream } = await start(async (agent) => {
      await agent.awaitMessage();
      const decision = (await agent.call("create_ticket", {
        featureId: agent.request.featureId,
        kind: "decision",
        title: "Quelle base",
        description: "",
      })) as Ticket;
      await agent.call("settle_decision", {
        featureId: agent.request.featureId,
        ticketId: decision.id,
        conclusion: "SQLite",
      });
      const outcome = await agent.attempt("settle_decision", {
        featureId: agent.request.featureId,
        ticketId: decision.id,
        conclusion: "Postgres",
      });
      expect(outcome.refused).toBe(true);
      refusal = outcome.text;
    });

    await squad.request("POST", mainSessionRoute(featureId), { prompt: "/to-tickets" });
    await waitForEvent(stream, "main-session-ended");

    expect(refusal).toContain("already");
    const graph = await readGraph(featureId);
    expect(ticketNamed(graph, "Quelle base").conclusion).toBe("SQLite");
  });

  it("keeps the thread of the exchange, and hands it back after a restart", async () => {
    const { featureId, stream } = await start(async (agent) => {
      await agent.awaitMessage();
      const decision = (await agent.call("create_ticket", {
        featureId: agent.request.featureId,
        kind: "decision",
        title: "Quelle base",
        description: "",
      })) as Ticket;
      agent.say("Une décision à prendre.");
      await agent.awaitMessage();
      await agent.call("settle_decision", {
        featureId: agent.request.featureId,
        ticketId: decision.id,
        conclusion: "SQLite",
      });
    });

    await squad.request("POST", mainSessionRoute(featureId), { prompt: "/to-tickets" });
    const said = await waitForEvent(stream, "thread-appended");
    expect(said.entry.kind).toBe("pilot");
    expect(said.entry.text).toBe("/to-tickets");

    // The developer answers once the agent has spoken, so the thread below reads
    // in the order the exchange happened. Squad writes each line when it reaches
    // it, and a message typed over an agent still working would land mid-turn,
    // which is right but not something to assert an order on.
    await waitForThreadEntry(stream, "agent");
    await squad.request("POST", mainSessionMessagesRoute(featureId), { text: "SQLite" });
    // The script ends once the decision is settled, so its last event marks the
    // moment the whole thread has been written.
    await waitForEvent(stream, "main-session-ended");

    // The thread is stored, not held in the page: a new connection is handed
    // the whole of it, and so is one opened after the server was restarted.
    await squad.restart();
    const reconnected = await squad.openEventStream();
    const snapshot = await reconnected.next();
    if (snapshot.type !== "snapshot") throw new Error("the first event is always a snapshot");

    const thread = snapshot.threads.filter((entry) => entry.featureId === featureId);
    expect(thread.map((entry) => `${entry.kind}:${entry.text}`)).toEqual([
      "pilot:/to-tickets",
      "tool:create_ticket",
      "agent:Une décision à prendre.",
      "pilot:SQLite",
      "tool:settle_decision",
      // Why the thread stopped: a session that went quiet without saying so
      // reads exactly like one that is still thinking.
      "notice:the session ended",
    ]);
    // A tool call is folded away in the interface, so what it was called with
    // has to travel with it: nothing else would be left to unfold.
    const call = thread.find((entry) => entry.text === "settle_decision");
    expect(call?.detail).toContain("SQLite");
    // Nothing is running any more, so nothing offers to take a message.
    expect(snapshot.mainSessions).toEqual([]);
  });

  it("refuses to settle a decision that belongs to another feature", async () => {
    let refusal = "";
    const { featureId, stream } = await start(async (agent) => {
      await agent.awaitMessage();
      // A session is opened on one feature. Nothing it says should be able to
      // close a decision taken on another, whatever id it puts in the call.
      const elsewhere = (await agent.call("create_ticket", {
        featureId: agent.request.featureId,
        kind: "decision",
        title: "Chez moi",
        description: "",
      })) as Ticket;
      const outcome = await agent.attempt("settle_decision", {
        featureId: "une-autre-feature",
        ticketId: elsewhere.id,
        conclusion: "tranché depuis ailleurs",
      });
      expect(outcome.refused).toBe(true);
      refusal = outcome.text;
    });

    await squad.request("POST", mainSessionRoute(featureId), { prompt: "/to-tickets" });
    await waitForEvent(stream, "main-session-ended");

    expect(refusal).toContain("une-autre-feature");
    const graph = await readGraph(featureId);
    expect(ticketNamed(graph, "Chez moi").state).toBe("awaiting-decision");
    expect(ticketNamed(graph, "Chez moi").conclusion).toBeNull();
  });

  it("says on the thread why a session stopped answering", async () => {
    const { featureId, stream } = await start(async (agent) => {
      await agent.awaitMessage();
      throw new Error("claude-code n'a pas démarré");
    });

    await squad.request("POST", mainSessionRoute(featureId), { prompt: "/to-tickets" });
    await waitForEvent(stream, "main-session-ended");

    const thread = await readThread(featureId);
    const last = thread.at(-1);
    expect(last?.kind).toBe("notice");
    expect(last?.text).toBe("the session failed");
    // The reason, and not just the fact: a launcher that could not start at all
    // otherwise reads exactly like a session that finished its work.
    expect(last?.detail).toContain("claude-code");
  });

  it("refuses a message when no main session is running", async () => {
    const { featureId } = await start(async () => {});
    const response = await squad.request("POST", mainSessionMessagesRoute(featureId), {
      text: "bonjour",
    });
    expect(response.status).toBe(409);
  });
});
