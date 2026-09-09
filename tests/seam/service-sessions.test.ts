import { afterEach, describe, expect, it } from "vitest";
import type { FeatureGraph, Ticket } from "../../src/shared/api";
import {
  apiRoutes,
  featureGraphRoute,
  mainSessionRoute,
  ticketSessionRoute,
  ticketSettlementRoute,
} from "../../src/shared/api";
import { pendingActions } from "../../src/shared/pending";
import { familyOf } from "../../src/shared/state-family";
import { createScriptedLauncher } from "../support/scripted-launcher";
import {
  openTestFeature,
  startTestSquad,
  waitForEvent,
  type EventStream,
  type TestSquad,
} from "../support/squad";

/**
 * The sessions squad opens for one job of its own, settling a test sheet and
 * untangling a merge conflict, against the concurrency caps.
 *
 * They used to be opened where they were needed and counted by nobody: ten
 * sheets waiting on a real instance meant ten clicks could open ten claude-code
 * sessions at once, each free to run a test suite. What is played here is the
 * cap holding them, the queue that follows, and the fact that a ticket squad is
 * working on does not read as waiting on the developer.
 */
describe("the sessions squad opens for itself, under the concurrency caps", () => {
  let squad: TestSquad;
  const gates: Gate[] = [];

  afterEach(async () => {
    for (const gate of gates) gate.open();
    gates.length = 0;
    await squad.dispose();
  });

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

  /**
   * Two tickets nothing blocks, each reporting a sheet with a point only a
   * person could settle. The pass that follows each report says nothing, so
   * both sheets come to rest waiting on the developer, which is the state the
   * incident was measured in.
   */
  async function start(held: Gate): Promise<{
    featureId: string;
    stream: EventStream;
    /** How many settling sessions have ever been open at the same time. */
    peak(): number;
  }> {
    let open = 0;
    let peak = 0;
    let passes = 0;
    squad = await startTestSquad({
      launcher: createScriptedLauncher(async (agent) => {
        if (agent.request.role === "main") {
          await agent.awaitMessage();
          for (const title of ["Le store", "L'API"]) {
            await agent.call("create_ticket", {
              featureId: agent.request.featureId,
              kind: "build",
              title,
              description: `${title}, à construire.`,
              acceptanceCriteria: [`${title} répond`],
            });
          }
          return;
        }
        if (agent.request.role === "settling") {
          await agent.awaitMessage();
          passes += 1;
          open += 1;
          peak = Math.max(peak, open);
          // The two passes that follow the reports say nothing and end at once;
          // the ones the test asks for by hand are held, so their place is held
          // with them.
          if (passes > 2) await held.passed;
          open -= 1;
          return;
        }
        await agent.awaitMessage();
        await agent.call("report_step", {
          featureId: agent.request.featureId,
          ticketId: agent.request.ticketId,
          summary: "Fait.",
          recommendation: "À juger.",
          coverage: (await ticketOf(agent.request.featureId, agent.request.ticketId ?? ""))
            .acceptanceCriteria.map((criterion) => ({
              criterionId: criterion.id,
              verdict: "judgement" as const,
            })),
          suggestions: [],
        });
        // Kept alive: a sub-session stays available for a correction, and one
        // that ends would change the state the test is watching.
        await new Promise(() => {});
      }),
    });
    const { feature } = await openTestFeature(squad, "Le noyau");
    const stream = await squad.openEventStream();
    expect((await stream.next()).type).toBe("snapshot");
    await squad.request("POST", mainSessionRoute(feature.id), { prompt: "/to-tickets" });
    await waitForEvent(stream, "graph-changed");
    return { featureId: feature.id, stream, peak: () => peak };
  }

  async function graphOf(featureId: string): Promise<FeatureGraph> {
    return (await (await squad.request("GET", featureGraphRoute(featureId))).json()) as FeatureGraph;
  }

  async function ticketOf(featureId: string, ticketId: string): Promise<Ticket> {
    const ticket = (await graphOf(featureId)).tickets.find((each) => each.id === ticketId);
    if (!ticket) throw new Error(`no ticket ${ticketId} in the graph of ${featureId}`);
    return ticket;
  }

  async function titled(featureId: string, title: string): Promise<Ticket> {
    const ticket = (await graphOf(featureId)).tickets.find((each) => each.title === title);
    if (!ticket) throw new Error(`no ticket titled "${title}" in the graph`);
    return ticket;
  }

  /** Waits for what no event announces on its own: a poll, bounded, then it fails. */
  async function until(what: string, holds: () => Promise<boolean>): Promise<void> {
    for (let attempt = 0; attempt < 250; attempt += 1) {
      if (await holds()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`waited in vain for ${what}`);
  }

  it("tient deux dépouillements demandés coup sur coup sous le plafond", async () => {
    const held = gate();
    const { featureId, peak } = await start(held);

    for (const title of ["Le store", "L'API"]) {
      const ticket = await titled(featureId, title);
      await squad.request("POST", ticketSessionRoute(ticket.id), {});
    }
    await until("both sheets to come to rest waiting on the developer", async () =>
      (await graphOf(featureId)).tickets.every((ticket) => ticket.state === "awaiting-validation"),
    );

    // One place for the whole machine, which is what turns ten clicks into ten
    // sessions if nothing counts them.
    expect((await squad.request("PUT", apiRoutes.settings, { machineConcurrencyCap: 1 })).status).toBe(200);

    const first = await titled(featureId, "Le store");
    const second = await titled(featureId, "L'API");
    // Not awaited: a pass that got a place answers when it has had its say, and
    // this one is held. The second click lands while it is still open, which is
    // the whole point.
    const answering = squad.request("POST", ticketSettlementRoute(first.id), {});
    await until("the first pass to take the place", async () =>
      (await ticketOf(featureId, first.id)).state === "settling",
    );
    const queued = await (await squad.request("POST", ticketSettlementRoute(second.id), {})).json();

    // Asked for and waiting for a place, rather than refused: the developer
    // clicked, and a refusal would send them back to click again.
    expect((queued as { ticket: Ticket }).ticket.state).toBe("settling-queued");
    expect((await ticketOf(featureId, second.id)).state).toBe("settling-queued");
    expect(peak()).toBe(1);

    // And neither of them reads as waiting on the developer while squad is on
    // it: the pass is what decides whether anything is left for a person.
    expect(pendingActions([await graphOf(featureId)], [])).toEqual([]);

    // Painted as work in flight, never as something waiting on a person: the
    // map reads the same list the indicator does, and squad is on this one.
    expect(familyOf(await ticketOf(featureId, first.id), new Set())).toBe("running");
    expect(familyOf(await ticketOf(featureId, second.id), new Set())).toBe("ready");

    held.open();
    await answering;
    await until("the queued pass to take the place that freed", async () =>
      (await ticketOf(featureId, second.id)).state !== "settling-queued",
    );
    expect(peak()).toBe(1);
    await until("both sheets to come back to the developer", async () =>
      (await graphOf(featureId)).tickets.every((ticket) => ticket.state === "awaiting-validation"),
    );
    expect(pendingActions([await graphOf(featureId)], [])).toHaveLength(2);
  });
});
