import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Feature, Ticket } from "../../src/shared/api";
import { textBounds } from "../../src/server/mcp";
import {
  aSummary,
  connectToSquadTools,
  testRunningExample,
  type McpConnection,
  writeTicket,
} from "../support/mcp";
import { openTestFeature, startTestSquad, type TestSquad } from "../support/squad";

/**
 * What a ticket says to the developer, as opposed to what it says to the
 * session that builds it.
 *
 * Everything here is exercised through the tools, over the wire, because the
 * whole design rests on the tool refusing: a bound that only lived in a
 * briefing would be a bound kept by politeness, and these are the tests that
 * say it is not (ADR 0009).
 */
describe("the summary a ticket carries, and the decor it is shown on", () => {
  let squad: TestSquad;
  let tools: McpConnection;
  let feature: Feature;

  beforeEach(async () => {
    squad = await startTestSquad();
    tools = await connectToSquadTools(squad.url);
    feature = (await openTestFeature(squad, "La caisse de la librairie")).feature;
  });

  afterEach(async () => {
    await tools.close();
    await squad.dispose();
  });

  async function setDecor(): Promise<void> {
    await tools.call("set_running_example", {
      featureId: feature.id,
      runningExample: testRunningExample,
    });
  }

  /**
   * The one test that would have caught the mistake this design nearly shipped
   * with: `create_ticket` was first written against a `z.discriminatedUnion` on
   * the kind, which validates perfectly and publishes **nothing**. Every other
   * test passed, because a test calls a tool with arguments it already knows.
   * An agent does not: it reads this schema, and an empty one would have left
   * it guessing every field name and every bound, which is the whole of what
   * this chantier is about (ADR 0009).
   */
  it("publishes a schema an agent can read, with the bounds spelled out in it", async () => {
    const schema = await tools.toolSchema("create_ticket");

    expect(schema.fields).toContain("summary");
    expect(schema.fields).toContain("description");
    expect(schema.fields).toContain("kind");
    // The bound is in the text an agent reads, not only in the validator that
    // refuses: a refusal teaches after the fact, a description teaches before.
    expect(schema.describe("summary")).toContain(String(textBounds.problem));
    expect(schema.describe("summary")).toContain(String(textBounds.context));
    // And the rule the flat shape cannot state structurally is stated in words.
    expect(schema.describe("summary")).toContain("fix");
  });

  it("refuses the first ticket of a feature that has no running example, and names the tool", async () => {
    const outcome = await tools.attempt("create_ticket", {
      featureId: feature.id,
      kind: "build",
      title: "La caisse",
      summary: aSummary(),
      description: "",
    });

    expect(outcome.refused).toBe(true);
    // Named, not hinted at: the refusal is the only instruction squad is sure
    // an agent reads, the skill that cuts a spec up living in another project.
    expect(outcome.text).toContain("set_running_example");
    expect(outcome.text).toContain("La caisse de la librairie");
  });

  it("takes the ticket once the decor is written, and hands the summary back on the graph", async () => {
    await setDecor();
    const ticket = (await tools.call("create_ticket", {
      featureId: feature.id,
      kind: "build",
      title: "La caisse",
      summary: aSummary(),
      description: "Le détail, aussi long qu'il le faut.",
    })) as Ticket;

    expect(ticket.summary?.problem).toContain("deux ventes");
    expect(ticket.summary?.example).toContain("Camille");
    // The detail is untouched by any of this: two readers, two texts.
    expect(ticket.description).toBe("Le détail, aussi long qu'il le faut.");
  });

  it("refuses a summary field that overruns its bound, and says what the bound is", async () => {
    await setDecor();
    const outcome = await tools.attempt("create_ticket", {
      featureId: feature.id,
      kind: "build",
      title: "La caisse",
      summary: { ...aSummary(), problem: "x".repeat(textBounds.problem + 1) },
      description: "",
    });

    expect(outcome.refused).toBe(true);
    expect(outcome.text).toContain(String(textBounds.problem));
  });

  it("requires an example on a build ticket and refuses one on a fix ticket", async () => {
    await setDecor();
    const withoutExample = await tools.attempt("create_ticket", {
      featureId: feature.id,
      kind: "build",
      title: "Sans exemple",
      summary: aSummary("fix"),
      description: "",
    });
    expect(withoutExample.refused).toBe(true);

    // A fix ticket's breakage is a red command: an invented business example
    // would be filler, so the schema has no room for one.
    const fix = (await tools.call("create_ticket", {
      featureId: feature.id,
      kind: "fix",
      title: "La vérification est rouge",
      summary: aSummary("fix"),
      description: "",
    })) as Ticket;
    expect(fix.summary?.example).toBeNull();
  });

  it("rewrites a summary without being able to touch the description", async () => {
    await setDecor();
    const ticket = (await writeTicket(tools, {
      featureId: feature.id,
      kind: "build",
      title: "La caisse",
      description: "Le contrat remis à la sous-session.",
    })) as Ticket;

    const rewritten = (await tools.call("rewrite_ticket_summary", {
      featureId: feature.id,
      ticketId: ticket.id,
      summary: {
        context: "La caisse est tenue sur un cahier.",
        problem: "Deux ventes simultanées font diverger le cahier du rayon.",
        example: "Camille vend le dernier « Bel-Ami » pendant que Dominique en range un autre.",
        // Passing a description here changes nothing: the tool has no such
        // field, and that is the point. Rewriting what the developer reads must
        // never be able to change what a running ticket was asked to build.
        description: "Autre chose",
      },
    })) as Ticket;

    expect(rewritten.summary?.context).toContain("cahier");
    expect(rewritten.description).toBe("Le contrat remis à la sous-session.");
  });

  it("refuses an option that says what it is without saying what it costs", async () => {
    await setDecor();
    const ticket = (await writeTicket(tools, {
      featureId: feature.id,
      kind: "build",
      title: "La caisse",
      description: "",
    })) as Ticket;

    const outcome = await tools.attempt("ask_question", {
      featureId: feature.id,
      ticketId: ticket.id,
      question: "Où tenir le stock ?",
      options: [{ label: "en base" }, { label: "dans un fichier" }],
      recommendation: "en base",
      scopeChanging: false,
    });

    expect(outcome.refused).toBe(true);
    expect(outcome.text).toContain("consequence");
  });

  it("refuses an option label long enough to be a consequence in disguise", async () => {
    await setDecor();
    const outcome = await tools.attempt("ask_question", {
      featureId: feature.id,
      question: "Où tenir le stock ?",
      options: [
        { label: "x".repeat(textBounds.optionLabel + 1), consequence: "Une conséquence." },
        { label: "dans un fichier", consequence: "Une autre conséquence." },
      ],
      recommendation: "dans un fichier",
      scopeChanging: false,
    });

    expect(outcome.refused).toBe(true);
    expect(outcome.text).toContain(String(textBounds.optionLabel));
  });

  it("hands the summary to the sub-session along with the description", async () => {
    await setDecor();
    const ticket = (await writeTicket(tools, {
      featureId: feature.id,
      kind: "build",
      title: "La caisse",
      description: "Le détail.",
    })) as Ticket;

    const response = await squad.request("GET", `/api/features/${feature.id}/graph`);
    const graph = (await response.json()) as { tickets: Ticket[] };
    const written = graph.tickets.find((each) => each.id === ticket.id);

    // Read back off the graph rather than off the answer: what a sub-session is
    // handed is built from the row, and a summary the graph does not carry is a
    // summary the session would never see.
    expect(written?.summary?.context).toContain("librairie");
  });
});
