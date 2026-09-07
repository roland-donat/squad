import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Feature, FeatureGraph, Ticket } from "../../src/shared/api";
import { featureGraphRoute } from "../../src/shared/api";
import { frontier } from "../../src/shared/graph";
import { connectToSquadTools, type McpConnection } from "../support/mcp";
import { openTestFeature, startTestSquad, type TestSquad } from "../support/squad";

describe("the graph an agent writes through the MCP tools", () => {
  let squad: TestSquad;
  let tools: McpConnection;
  let feature: Feature;

  beforeEach(async () => {
    squad = await startTestSquad();
    tools = await connectToSquadTools(squad.url);
    feature = (await openTestFeature(squad, "Le noyau")).feature;
  });

  afterEach(async () => {
    await tools.close();
    await squad.dispose();
  });

  async function createTicket(
    ticket: { title: string; blockedBy?: string[]; blocks?: string[] },
  ): Promise<Ticket> {
    return (await tools.call("create_ticket", {
      featureId: feature.id,
      kind: "build",
      description: "",
      blockedBy: [],
      blocks: [],
      ...ticket,
    })) as Ticket;
  }

  function stateOf(graph: FeatureGraph, ticketId: string): string | undefined {
    return graph.tickets.find((ticket) => ticket.id === ticketId)?.state;
  }

  async function readGraphFromApi(): Promise<FeatureGraph> {
    const response = await squad.request("GET", featureGraphRoute(feature.id));
    expect(response.status).toBe(200);
    return (await response.json()) as FeatureGraph;
  }

  it("exposes the tools an agent needs to write and read the graph", async () => {
    expect(await tools.listTools()).toEqual(["create_ticket", "read_graph", "settle_decision"]);
  });

  it("writes a ticket with its kind, its criteria and its reserved external identifier", async () => {
    const created = (await tools.call("create_ticket", {
      featureId: feature.id,
      kind: "build",
      title: "Le lanceur d'agent",
      description: "L'interface étroite par laquelle entre le non-déterminisme.",
      acceptanceCriteria: ["Ouvrir une session", "Émettre un flux d'événements"],
    })) as Ticket;

    expect(created.kind).toBe("build");
    expect(created.title).toBe("Le lanceur d'agent");
    expect(created.acceptanceCriteria.map((criterion) => criterion.text)).toEqual([
      "Ouvrir une session",
      "Émettre un flux d'événements",
    ]);
    // Reserved for a projection towards a tracker, and left alone until then.
    expect(created.externalId).toBeNull();

    const graph = await readGraphFromApi();
    expect(graph.tickets).toEqual([created]);
    expect(graph.edges).toEqual([]);
  });

  it("hands the same graph to the agent as to the interface", async () => {
    await tools.call("create_ticket", {
      featureId: feature.id,
      kind: "decision",
      title: "Quel format de fiche de tests",
      description: "À trancher dans la session principale.",
    });

    const seenByTheAgent = await tools.call("read_graph", { featureId: feature.id });
    expect(seenByTheAgent).toEqual(await readGraphFromApi());
  });

  it("refuses a ticket on a feature that does not exist", async () => {
    const outcome = await tools.attempt("create_ticket", {
      featureId: "unknown",
      kind: "build",
      title: "Orphelin",
      description: "",
    });

    expect(outcome.refused).toBe(true);
    expect(outcome.text).toContain("unknown");
  });

  it("refuses a ticket whose kind is not one of the three declared ones", async () => {
    const outcome = await tools.attempt("create_ticket", {
      featureId: feature.id,
      kind: "chore",
      title: "Genre inventé",
      description: "",
    });

    expect(outcome.refused).toBe(true);
  });

  it("blocks a ticket until its blocker is merged, and leaves the rest ready", async () => {
    const foundation = (await createTicket({ title: "Fondation" })) as Ticket;
    const core = (await createTicket({ title: "Noyau", blockedBy: [foundation.id] })) as Ticket;

    const graph = await readGraphFromApi();
    expect(stateOf(graph, foundation.id)).toBe("ready");
    expect(stateOf(graph, core.id)).toBe("blocked");
    expect(graph.edges).toEqual([
      { featureId: feature.id, blockerId: foundation.id, blockedId: core.id },
    ]);
    // The frontier is what can be launched now: the blocker alone.
    expect(frontier(graph).map((ticket) => ticket.id)).toEqual([foundation.id]);
  });

  it("lets a ticket declare what it blocks, which is how a fix lands in front of pending work", async () => {
    const pending = (await createTicket({ title: "Suite" })) as Ticket;
    const repair = (await createTicket({ title: "Correctif", blocks: [pending.id] })) as Ticket;

    const graph = await readGraphFromApi();
    expect(stateOf(graph, repair.id)).toBe("ready");
    expect(stateOf(graph, pending.id)).toBe("blocked");
  });

  it("refuses an edge that would close a loop, and names the loop", async () => {
    const first = (await createTicket({ title: "Premier" })) as Ticket;
    const second = (await createTicket({ title: "Second", blockedBy: [first.id] })) as Ticket;

    // "Troisième" would be blocked by the second and would block the first,
    // which closes Premier -> Second -> Troisième -> Premier.
    const outcome = await tools.attempt("create_ticket", {
      featureId: feature.id,
      kind: "build",
      title: "Troisième",
      description: "",
      blockedBy: [second.id],
      blocks: [first.id],
    });

    expect(outcome.refused).toBe(true);
    expect(outcome.text).toContain("cycle");
    expect(outcome.text).toContain("Premier");
    expect(outcome.text).toContain("Second");
    expect(outcome.text).toContain("Troisième");

    // Refused at the write: nothing of the ticket survives the refusal.
    const graph = await readGraphFromApi();
    expect(graph.tickets.map((ticket) => ticket.title)).toEqual(["Premier", "Second"]);
    expect(graph.edges).toHaveLength(1);
  });

  it("refuses an edge onto a ticket of another feature", async () => {
    const { feature: elsewhere } = await openTestFeature(squad, "Un autre chantier");
    const foreign = (await tools.call("create_ticket", {
      featureId: elsewhere.id,
      kind: "build",
      title: "Ailleurs",
      description: "",
    })) as Ticket;

    const outcome = await tools.attempt("create_ticket", {
      featureId: feature.id,
      kind: "build",
      title: "Ici",
      description: "",
      blockedBy: [foreign.id],
    });

    expect(outcome.refused).toBe(true);
    expect(outcome.text).toContain("same feature");
  });
});
