import { afterEach, describe, expect, it } from "vitest";
import type { Feature, FeatureGraph, Ticket } from "../../src/shared/api";
import { featureGraphRoute, mainSessionRoute } from "../../src/shared/api";
import { frontier } from "../../src/shared/graph";
import { createScriptedLauncher, type AgentScript } from "../support/scripted-launcher";
import { aSummary, writeTicket } from "../support/mcp";
import {
  openTestFeature,
  startTestSquad,
  waitForEvent,
  type EventStream,
  type TestSquad,
} from "../support/squad";

/**
 * The scenario every later ticket imitates: an agent, and nothing but an agent,
 * builds the graph through squad's tools, and squad hands it back the same way
 * the interface reads it.
 */
describe("a scripted session building the graph", () => {
  let squad: TestSquad;

  afterEach(async () => {
    await squad.dispose();
  });

  async function startWith(script: AgentScript): Promise<{ feature: Feature; stream: EventStream }> {
    squad = await startTestSquad({ launcher: createScriptedLauncher(script) });
    const { feature } = await openTestFeature(squad, "Le noyau");
    const stream = await squad.openEventStream();
    expect((await stream.next()).type).toBe("snapshot");
    return { feature, stream };
  }

  it("writes a graph of several tickets and their blocking edges", async () => {
    const { feature, stream } = await startWith(async (agent) => {
      const prompt = await agent.awaitMessage();
      expect(prompt).toContain("/to-tickets");

      const store = (await writeTicket(agent, {
        featureId: agent.request.featureId,
        kind: "build",
        title: "Le store",
        description: "La base et ses migrations.",
        acceptanceCriteria: ["La base s'ouvre", "Les migrations s'appliquent"],
      })) as Ticket;
      const tools = (await writeTicket(agent, {
        featureId: agent.request.featureId,
        kind: "build",
        title: "Les outils MCP",
        description: "Le contrat avec les agents.",
        blockedBy: [store.id],
      })) as Ticket;
      await writeTicket(agent, {
        featureId: agent.request.featureId,
        kind: "build",
        title: "Le graphe à l'écran",
        description: "La lecture du plan.",
        blockedBy: [tools.id],
      });
      agent.say("Découpage écrit.");
    });

    const accepted = await squad.request("POST", mainSessionRoute(feature.id), {
      prompt: "/to-tickets sur le spec collé plus haut",
    });
    expect(accepted.status).toBe(202);

    const started = await waitForEvent(stream, "main-session-started");
    expect(started.type === "main-session-started" && started.featureId).toBe(feature.id);

    const ended = await waitForEvent(stream, "main-session-ended");
    if (ended.type !== "main-session-ended") throw new Error("unreachable");
    expect(ended.outcome).toBe("completed");

    const response = await squad.request("GET", featureGraphRoute(feature.id));
    const graph = (await response.json()) as FeatureGraph;
    expect(graph.tickets.map((ticket) => ticket.title)).toEqual([
      "Le store",
      "Les outils MCP",
      "Le graphe à l'écran",
    ]);
    expect(graph.edges).toHaveLength(2);
    // Nothing is merged yet, so only the root of the graph can be launched.
    expect(frontier(graph).map((ticket) => ticket.title)).toEqual(["Le store"]);
    expect(graph.tickets.map((ticket) => ticket.state)).toEqual(["ready", "blocked", "blocked"]);
  });

  it("shows the graph growing while the session is still working", async () => {
    const { feature, stream } = await startWith(async (agent) => {
      await agent.awaitMessage();
      for (const title of ["Premier", "Deuxième"]) {
        await writeTicket(agent, {
          featureId: agent.request.featureId,
          kind: "build",
          title,
          description: "",
        });
      }
    });

    await squad.request("POST", mainSessionRoute(feature.id), { prompt: "/to-tickets" });

    const first = await waitForEvent(stream, "graph-changed");
    if (first.type !== "graph-changed") throw new Error("unreachable");
    expect(first.graph.tickets.map((ticket) => ticket.title)).toEqual(["Premier"]);

    const second = await waitForEvent(stream, "graph-changed");
    if (second.type !== "graph-changed") throw new Error("unreachable");
    expect(second.graph.tickets.map((ticket) => ticket.title)).toEqual(["Premier", "Deuxième"]);
  });

  it("refuses a blocking edge that would close a loop, and tells the agent why", async () => {
    let refusal = "";
    const { feature, stream } = await startWith(async (agent) => {
      await agent.awaitMessage();
      const first = (await writeTicket(agent, {
        featureId: agent.request.featureId,
        kind: "build",
        title: "Premier",
        description: "",
      })) as Ticket;
      const second = (await writeTicket(agent, {
        featureId: agent.request.featureId,
        kind: "build",
        title: "Second",
        description: "",
        blockedBy: [first.id],
      })) as Ticket;
      const outcome = await agent.attempt("create_ticket", {
        featureId: agent.request.featureId,
        kind: "build",
        title: "Troisième",
        summary: aSummary(),
        description: "",
        blockedBy: [second.id],
        blocks: [first.id],
      });
      expect(outcome.refused).toBe(true);
      refusal = outcome.text;
    });

    await squad.request("POST", mainSessionRoute(feature.id), { prompt: "/to-tickets" });
    await waitForEvent(stream, "main-session-ended");

    expect(refusal).toContain("cycle");
    const response = await squad.request("GET", featureGraphRoute(feature.id));
    const graph = (await response.json()) as FeatureGraph;
    expect(graph.tickets.map((ticket) => ticket.title)).toEqual(["Premier", "Second"]);
  });

  it("tells the session which feature it is on and where its work is written", async () => {
    // Without this, a session has no way to know the id its tools ask for, and
    // `/to-tickets` publishes to whatever tracker the repository configures
    // rather than to the graph the developer is watching.
    const { feature, stream } = await startWith(async (agent) => {
      await agent.awaitMessage();
      agent.say(agent.request.briefing);
    });

    await squad.request("POST", mainSessionRoute(feature.id), { prompt: "/to-tickets" });
    await waitForEvent(stream, "main-session-ended");

    const briefing = await readBriefing(feature.id);
    expect(briefing).toContain(feature.id);
    expect(briefing).toContain("Le noyau");
    expect(briefing).toContain("mcp__squad__create_ticket");
    expect(briefing).toContain("mcp__squad__settle_decision");
  });

  /** The briefing as the session received it, which it repeated on its thread. */
  async function readBriefing(featureId: string): Promise<string> {
    const stream = await squad.openEventStream();
    const snapshot = await stream.next();
    if (snapshot.type !== "snapshot") throw new Error("the first event is always a snapshot");
    const said = snapshot.threads.find(
      (entry) => entry.featureId === featureId && entry.kind === "agent",
    );
    return said?.text ?? "";
  }

  it("refuses to open a second main session on a feature that already has one", async () => {
    const { feature } = await startWith(async (agent) => {
      // Never returns on its own: the session stays alive until squad stops it.
      await agent.awaitMessage();
      await agent.awaitMessage();
    });

    await squad.request("POST", mainSessionRoute(feature.id), { prompt: "/to-tickets" });
    const again = await squad.request("POST", mainSessionRoute(feature.id), { prompt: "encore" });

    expect(again.status).toBe(409);
  });

  it("refuses to open a main session on a feature that does not exist", async () => {
    const { feature } = await startWith(async () => {});
    expect(feature.id).toBeTruthy();

    const response = await squad.request("POST", mainSessionRoute("unknown"), { prompt: "x" });
    expect(response.status).toBe(404);
  });
});
