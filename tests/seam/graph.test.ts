import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Feature, FeatureGraph, Ticket } from "../../src/shared/api";
import { featureGraphRoute } from "../../src/shared/api";
import { frontier } from "../../src/shared/graph";
import {
  aSummary,
  connectToSquadTools,
  testRunningExample,
  type McpConnection,
  writeTicket,
} from "../support/mcp";
import { openTestFeature, startTestSquad, type TestSquad } from "../support/squad";

describe("the graph an agent writes through the MCP tools", () => {
  let squad: TestSquad;
  let tools: McpConnection;
  let feature: Feature;

  beforeEach(async () => {
    squad = await startTestSquad();
    tools = await connectToSquadTools(squad.url);
    feature = (await openTestFeature(squad, "Le noyau")).feature;
    // What a main session does before writing its first ticket. Set here as
    // well as inside `writeTicket`, because the tests that go straight to
    // `attempt` to read a refusal must get past this one to reach theirs.
    await tools.call("set_running_example", {
      featureId: feature.id,
      runningExample: testRunningExample,
    });
  });

  afterEach(async () => {
    await tools.close();
    await squad.dispose();
  });

  async function createTicket(
    ticket: { title: string; blockedBy?: string[]; blocks?: string[] },
  ): Promise<Ticket> {
    return (await writeTicket(tools, {
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
    expect(await tools.listTools()).toEqual([
      "ask_question",
      "carry_repository",
      "create_ticket",
      "discard_ticket",
      "read_graph",
      "report_step",
      "rewrite_ticket_summary",
      "set_running_example",
      "settle_decision",
      "settle_sheet",
    ]);
  });

  it("writes a ticket with its kind, its criteria and its reserved external identifier", async () => {
    const created = (await writeTicket(tools, {
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
    await writeTicket(tools, {
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
      summary: aSummary(),
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
      summary: aSummary(),
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

  it("écarte un ticket mort et rend leur route à ceux qu'il bloquait", async () => {
    const dead = (await createTicket({ title: "Doublon" })) as Ticket;
    const waiting = (await createTicket({ title: "La suite", blockedBy: [dead.id] })) as Ticket;
    expect(stateOf(await readGraphFromApi(), waiting.id)).toBe("blocked");

    const dropped = (await tools.call("discard_ticket", {
      featureId: feature.id,
      ticketId: dead.id,
      reason: "Doublon de « La suite » : rien à construire ici, tout est dans l'autre.",
    })) as Ticket;

    // Un noeud mort qui retient ses successeurs arrête le graphe pour une raison
    // sur laquelle personne ne peut agir : il ne retient plus rien. Et il se lit
    // écarté, jamais fusionné, puisque rien n'en a été construit.
    expect(dropped.state).toBe("discarded");
    expect(dropped.conclusion).toContain("Doublon");
    const graph = await readGraphFromApi();
    expect(stateOf(graph, dead.id)).toBe("discarded");
    expect(stateOf(graph, waiting.id)).toBe("ready");
    expect(frontier(graph).map((ticket) => ticket.id)).toEqual([waiting.id]);
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
      summary: aSummary(),
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
    const foreign = (await writeTicket(tools, {
      featureId: elsewhere.id,
      kind: "build",
      title: "Ailleurs",
      description: "",
    })) as Ticket;

    const outcome = await tools.attempt("create_ticket", {
      featureId: feature.id,
      kind: "build",
      title: "Ici",
      summary: aSummary(),
      description: "",
      blockedBy: [foreign.id],
    });

    expect(outcome.refused).toBe(true);
    expect(outcome.text).toContain("same feature");
  });
});
