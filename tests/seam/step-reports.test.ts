import { afterEach, describe, expect, it } from "vitest";
import type { FeatureGraph, StepReport, ThreadEntry, Ticket } from "../../src/shared/api";
import {
  apiRoutes,
  defaultConcurrencyCaps,
  defaultGenerationDepthCap,
  featureGraphRoute,
  mainSessionRoute,
  ticketSessionRoute,
  ticketTestSheetRoute,
} from "../../src/shared/api";
import { pendingActions } from "../../src/shared/pending";
import { connectToSquadTools } from "../support/mcp";
import { createScriptedLauncher, type ScriptedAgent } from "../support/scripted-launcher";
import {
  openTestFeature,
  startTestSquad,
  waitForEvent,
  type EventStream,
  type TestSquad,
} from "../support/squad";
import { startWebhookReceiver, type WebhookReceiver } from "../support/webhook";

/**
 * A step ends with a report, never with a commit. The report says what an
 * automatic test covers and what it does not, and what it does not becomes the
 * test sheet a human goes through. Everything here is played through the same
 * surface the interface and the agents use: the tools over MCP, the routes over
 * HTTP, and the alert over a real webhook.
 */
describe("ending a step, its test sheet and its alerts", () => {
  let squad: TestSquad;
  let webhook: WebhookReceiver | null = null;
  const gates: Gate[] = [];

  afterEach(async () => {
    for (const gate of gates) gate.open();
    gates.length = 0;
    await squad.dispose();
    await webhook?.close();
    webhook = null;
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

  /**
   * One scripted launcher for both roles: the main session writes the ticket
   * every scenario starts from, and every sub-session runs the script handed in.
   */
  async function start(
    runTicket: (agent: ScriptedAgent) => Promise<void>,
  ): Promise<{ featureId: string; stream: EventStream; ticket: Ticket }> {
    squad = await startTestSquad({
      launcher: createScriptedLauncher(async (agent) => {
        if (agent.request.role === "main") {
          await agent.awaitMessage();
          await agent.call("create_ticket", {
            featureId: agent.request.featureId,
            kind: "build",
            title: "Le store",
            description: "La base et ses migrations.",
            acceptanceCriteria: ["La base s'ouvre", "Les migrations s'appliquent"],
          });
          return;
        }
        await runTicket(agent);
      }),
    });
    const { feature } = await openTestFeature(squad, "Le noyau");
    const stream = await squad.openEventStream();
    expect((await stream.next()).type).toBe("snapshot");
    await squad.request("POST", mainSessionRoute(feature.id), { prompt: "/to-tickets" });
    await waitForEvent(stream, "graph-changed");
    return { featureId: feature.id, stream, ticket: await readTicket(feature.id) };
  }

  /** Sends squad's alerts to an endpoint this test can read. */
  async function catchAlerts(): Promise<WebhookReceiver> {
    const receiver = await startWebhookReceiver();
    webhook = receiver;
    const answer = await squad.request("PUT", apiRoutes.settings, { webhookUrl: receiver.url });
    expect(answer.status).toBe(200);
    return receiver;
  }

  async function readGraph(featureId: string): Promise<FeatureGraph> {
    const response = await squad.request("GET", featureGraphRoute(featureId));
    return (await response.json()) as FeatureGraph;
  }

  async function readTicket(featureId: string): Promise<Ticket> {
    const graph = await readGraph(featureId);
    const ticket = graph.tickets.find((each) => each.title === "Le store");
    if (!ticket) throw new Error("the ticket the main session wrote is missing from the graph");
    return ticket;
  }

  async function readTicketThread(ticketId: string): Promise<ThreadEntry[]> {
    const stream = await squad.openEventStream();
    const snapshot = await stream.next();
    if (snapshot.type !== "snapshot") throw new Error("the first event is always a snapshot");
    return snapshot.threads.filter((entry) => entry.ticketId === ticketId);
  }

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

  /** The report on a ticket, which is what the interface renders as a sheet. */
  function reportOf(ticket: Ticket): StepReport {
    if (!ticket.stepReport) throw new Error(`ticket "${ticket.title}" carries no step report`);
    return ticket.stepReport;
  }

  /** What the ticket's assignment named its criteria, as the agent reads them. */
  function criterionIds(ticket: Ticket): string[] {
    return ticket.acceptanceCriteria.map((criterion) => criterion.id);
  }

  it("turns the criteria no test covers into a sheet, and says so on the webhook", async () => {
    const alive = gate();
    let answer: unknown;
    const { featureId, stream, ticket } = await start(async (agent) => {
      await agent.awaitMessage();
      const [opens, migrations] = criterionIds(
        (await readGraph(agent.request.featureId)).tickets[0] as Ticket,
      );
      answer = await agent.call("report_step", {
        featureId: agent.request.featureId,
        ticketId: agent.request.ticketId,
        summary: "La base s'ouvre et les migrations tournent au démarrage.",
        coverage: [
          { criterionId: opens, covered: true },
          { criterionId: migrations, covered: false },
        ],
        suggestions: ["Ouvrir une base écrite par la version précédente"],
        recommendation: "Fusionner une fois la fiche passée.",
      });
      // Alive after reporting: what a point fails on comes back to this session.
      await alive.passed;
    });
    const receiver = await catchAlerts();

    await squad.request("POST", ticketSessionRoute(ticket.id), {});
    const waiting = await waitForState(stream, featureId, ticket.id, "awaiting-validation");

    // The sheet is what nobody automated, then what the agent suggested. The
    // covered criterion is not on it, and the coverage still records that claim.
    const report = reportOf(waiting);
    expect(report.sheet.map((point) => point.text)).toEqual([
      "Les migrations s'appliquent",
      "Ouvrir une base écrite par la version précédente",
    ]);
    expect(report.sheet[0]?.criterionId).toBe(criterionIds(ticket)[1]);
    expect(report.sheet[1]?.criterionId).toBeNull();
    expect(report.sheet.every((point) => point.verdict === "pending")).toBe(true);
    expect(report.coverage.map((entry) => [entry.text, entry.covered])).toEqual([
      ["La base s'ouvre", true],
      ["Les migrations s'appliquent", false],
    ]);
    expect(report.summary).toContain("les migrations tournent");
    expect(report.recommendation).toContain("Fusionner");
    expect(report.reviewedAt).toBeNull();
    // The tool hands the ticket back, so the agent sees what will be checked.
    expect((answer as Ticket).state).toBe("awaiting-validation");

    // The developer is told, wherever they are, and told where: an alert is read
    // on a phone, and squad's own address for what it reports is what makes it
    // worth more than a notification saying something happened.
    const alert = await receiver.next();
    expect(alert.text).toContain("Le store");
    expect(alert.text).toMatch(/fiche de tests/i);
    expect(alert.text).toContain(
      `${squad.url}/projects/${ticket.projectId}/features/${featureId}/tickets/${ticket.id}`,
    );

    // And the ticket is listed as waiting on them, which is what the indicator reads.
    expect(pendingActions([await readGraph(featureId)], [])).toEqual([
      { featureId, ticketId: ticket.id, title: "Le store", reason: "validation" },
    ]);
  });

  it("reports an empty sheet without waking anyone, and it goes on to merge", async () => {
    const alive = gate();
    const { featureId, stream, ticket } = await start(async (agent) => {
      await agent.awaitMessage();
      const covered = criterionIds(
        (await readGraph(agent.request.featureId)).tickets[0] as Ticket,
      ).map((criterionId) => ({ criterionId, covered: true }));
      await agent.call("report_step", {
        featureId: agent.request.featureId,
        ticketId: agent.request.ticketId,
        summary: "Tout est couvert par les tests au seam.",
        coverage: covered,
        recommendation: "Fusionner.",
      });
      await alive.passed;
    });
    const receiver = await catchAlerts();

    await squad.request("POST", ticketSessionRoute(ticket.id), {});
    // Nothing to check by hand is nothing to stop for: the sheet is empty, and
    // the ticket goes through validation without anyone touching it, which is
    // what makes a run nobody watches mean something.
    const merged = await waitForState(stream, featureId, ticket.id, "merged");

    expect(reportOf(merged).sheet).toEqual([]);
    // And nobody was woken: no alert, and nothing in the list of what waits on
    // the developer.
    expect(pendingActions([await readGraph(featureId)], [])).toEqual([]);
    expect(receiver.received()).toEqual([]);
  });

  it("asks a sub-session that ended without reporting, rather than concluding it is done", async () => {
    const reported = gate();
    const messages: string[] = [];
    const openings: Array<string | undefined> = [];
    const { featureId, stream, ticket } = await start(async (agent) => {
      openings.push(agent.request.resumeSessionId);
      messages.push(await agent.awaitMessage());
      if (messages.length === 1) return;
      const covered = criterionIds(
        (await readGraph(agent.request.featureId)).tickets[0] as Ticket,
      ).map((criterionId) => ({ criterionId, covered: true }));
      await agent.call("report_step", {
        featureId: agent.request.featureId,
        ticketId: agent.request.ticketId,
        summary: "Fini, et rapporté cette fois.",
        coverage: covered,
        recommendation: "Fusionner.",
      });
      await reported.passed;
    });

    await squad.request("POST", ticketSessionRoute(ticket.id), {});
    // The second report covers every criterion, so its sheet is empty and the
    // ticket comes to rest merged rather than waiting for a reader.
    const waiting = await waitForState(stream, featureId, ticket.id, "merged");
    expect(reportOf(waiting).summary).toContain("rapporté cette fois");

    // The same session, asked again: nothing failed, and the ticket was never
    // read as done because a process stopped.
    expect(openings).toHaveLength(2);
    expect(openings[1]).toBe(waiting.sessionId);
    expect(messages[1]).toMatch(/report/i);
    const thread = await readTicketThread(ticket.id);
    expect(
      thread.some((entry) => entry.kind === "notice" && /without reporting/i.test(entry.text)),
    ).toBe(true);
  });

  it("stops a sub-session that goes quiet a second time, rather than asking forever", async () => {
    let openings = 0;
    const { featureId, stream, ticket } = await start(async (agent) => {
      openings += 1;
      await agent.awaitMessage();
    });
    const receiver = await catchAlerts();

    await squad.request("POST", ticketSessionRoute(ticket.id), {});
    const stopped = await waitForState(stream, featureId, ticket.id, "failed");

    expect(openings).toBe(2);
    // Kept, like any other stop: the branch and the session are what a resume
    // starts from.
    expect(stopped.worktree).not.toBeNull();
    expect(stopped.sessionId).not.toBeNull();
    const alert = await receiver.next();
    expect(alert.text).toContain("Le store");
    expect(pendingActions([await readGraph(featureId)], []).map((action) => action.reason)).toEqual([
      "failure",
    ]);
  });

  it("records what the developer checked, commented and answered in general", async () => {
    const alive = gate();
    const { featureId, stream, ticket } = await start(async (agent) => {
      await agent.awaitMessage();
      const [opens, migrations] = criterionIds(
        (await readGraph(agent.request.featureId)).tickets[0] as Ticket,
      );
      await agent.call("report_step", {
        featureId: agent.request.featureId,
        ticketId: agent.request.ticketId,
        summary: "Fait.",
        coverage: [
          { criterionId: opens, covered: false },
          { criterionId: migrations, covered: false },
        ],
        recommendation: "À vérifier à la main.",
      });
      await alive.passed;
    });

    await squad.request("POST", ticketSessionRoute(ticket.id), {});
    const waiting = await waitForState(stream, featureId, ticket.id, "awaiting-validation");
    const sheet = reportOf(waiting).sheet;

    const answered = await squad.request("POST", ticketTestSheetRoute(ticket.id), {
      points: [
        { id: sheet[0]?.id, passed: true, comment: "" },
        { id: sheet[1]?.id, passed: false, comment: "La migration 0004 casse sur une base écrite hier." },
      ],
      feedback: "Le reste tient, il ne manque que la reprise de base existante.",
    });
    expect(answered.status).toBe(200);

    const reviewed = reportOf((await readGraph(featureId)).tickets[0] as Ticket);
    expect(reviewed.sheet.map((point) => point.verdict)).toEqual(["passed", "failed"]);
    expect(reviewed.sheet[0]?.comment).toBeNull();
    expect(reviewed.sheet[1]?.comment).toContain("0004");
    expect(reviewed.feedback).toContain("reprise de base existante");
    expect(reviewed.reviewedAt).not.toBeNull();

    // Gone through once: nothing waits on the developer any more, and a second
    // answer on the same sheet is refused rather than silently overwriting it.
    expect(pendingActions([await readGraph(featureId)], [])).toEqual([]);
    const again = await squad.request("POST", ticketTestSheetRoute(ticket.id), {
      points: sheet.map((point) => ({ id: point.id, passed: true })),
    });
    expect(again.status).toBe(409);
  });

  it("refuses a report that does not say something about every criterion", async () => {
    const alive = gate();
    let refusal = "";
    const { stream, featureId, ticket } = await start(async (agent) => {
      await agent.awaitMessage();
      const [opens] = criterionIds((await readGraph(agent.request.featureId)).tickets[0] as Ticket);
      const outcome = await agent.attempt("report_step", {
        featureId: agent.request.featureId,
        ticketId: agent.request.ticketId,
        summary: "Fait.",
        coverage: [{ criterionId: opens, covered: true }],
        recommendation: "Fusionner.",
      });
      refusal = outcome.refused ? outcome.text : "";
      await alive.passed;
    });

    await squad.request("POST", ticketSessionRoute(ticket.id), {});
    const running = await waitForState(stream, featureId, ticket.id, "running");

    // Refused on the spot, with the criterion it said nothing about named: the
    // agent is meant to read the reason and call again.
    await expect
      .poll(() => refusal, { timeout: 5_000 })
      .toContain("Les migrations s'appliquent");
    expect(running.stepReport).toBeNull();
  });

  it("changes the alert setting it was given and leaves the other one alone", async () => {
    await start(async () => {});
    const receiver = await startWebhookReceiver();
    webhook = receiver;

    // The desktop channel was turned off when this squad started. Setting the
    // webhook must not turn it back on: a partial change is a change to what it
    // names, and a setting nobody touched is a setting nobody meant to change.
    await squad.request("PUT", apiRoutes.settings, { webhookUrl: receiver.url });
    const read = await squad.request("GET", apiRoutes.settings);
    expect(await read.json()).toEqual({
      settings: {
        webhookUrl: receiver.url,
        desktopNotifications: false,
        machineConcurrencyCap: defaultConcurrencyCaps.machine,
        generationDepthCap: defaultGenerationDepthCap,
        theme: "system",
      },
    });

    const refused = await squad.request("PUT", apiRoutes.settings, { webhookUrl: "pas une url" });
    expect(refused.status).toBe(400);
  });

  it("refuses a report on a ticket no sub-session is running", async () => {
    const { featureId, ticket } = await start(async () => {});
    const graph = await readGraph(featureId);
    expect(graph.tickets[0]?.state).toBe("ready");

    const tools = await connectToSquadTools(squad.url);
    const outcome = await tools.attempt("report_step", {
      featureId,
      ticketId: ticket.id,
      summary: "Fait.",
      coverage: [],
      recommendation: "Fusionner.",
    });
    await tools.close();

    expect(outcome.refused).toBe(true);
    expect(outcome.text).toMatch(/ready/);
  });
});
