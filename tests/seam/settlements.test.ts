import { afterEach, describe, expect, it } from "vitest";
import type {
  ApiErrorBody,
  FeatureGraph,
  StepReport,
  ThreadEntry,
  Ticket,
} from "../../src/shared/api";
import {
  apiRoutes,
  featureGraphRoute,
  featureRoute,
  mainSessionRoute,
  ticketSessionRoute,
  ticketSettlementRoute,
  ticketTestSheetRoute,
} from "../../src/shared/api";
import { pendingActions } from "../../src/shared/pending";
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
 * Between a step report and the developer, squad runs a pass over the test
 * sheet: a session opened for that one job, in the ticket's own worktree, which
 * runs what answers a point and hands back only what no command settles.
 *
 * What is played here is the whole of what that pass can do to a sheet, and the
 * one thing it must never do: swallow it. A pass that says nothing leaves the
 * sheet exactly as the sub-session wrote it.
 */
describe("the settling pass, between a test sheet and the developer", () => {
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

  /** What a settling session is handed: its points, with the ids to answer under. */
  function pointIdsOf(instruction: string): string[] {
    return [...instruction.matchAll(/^- \[([0-9a-f-]{36})\]/gm)].map((match) => match[1] ?? "");
  }

  /**
   * One scripted launcher for the three roles: the main session writes the
   * ticket, the sub-session builds it and reports a sheet, and the settling pass
   * answers that sheet however the scenario says.
   */
  async function start(options: {
    /** What the sub-session declares of the two criteria, in the ticket's order. */
    coverage?: Array<{ verdict: string; note?: string }>;
    suggestions?: string[];
    /** What the pass answers, by position in the sheet. Absent means it says nothing. */
    settle?: (points: string[], agent: ScriptedAgent) => Promise<void>;
    /** Whether the feature runs in go-as-recommended. */
    driven?: boolean;
  }): Promise<{
    featureId: string;
    stream: EventStream;
    ticket: Ticket;
    /** Keeps until the pass has had its say: every state below follows it. */
    settled: Promise<void>;
    /** How many passes squad has opened so far, which is bounded. */
    passes(): number;
  }> {
    const passed = gate();
    let passes = 0;
    const coverage = options.coverage ?? [
      { verdict: "automated" },
      { verdict: "judgement" },
    ];
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
        if (agent.request.role === "settling") {
          const instruction = await agent.awaitMessage();
          await options.settle?.(pointIdsOf(instruction), agent);
          passes += 1;
          passed.open();
          return;
        }
        // Reports on every message: the first is the assignment, the ones
        // after it are corrections, and a sub-session stays available for them.
        for (;;) {
          await agent.awaitMessage();
          const ticket = (await readGraph(agent.request.featureId)).tickets[0] as Ticket;
          await agent.call("report_step", {
            featureId: agent.request.featureId,
            ticketId: agent.request.ticketId,
            summary: "La base s'ouvre et les migrations tournent.",
            recommendation: "Fusionner une fois la fiche passée.",
            coverage: ticket.acceptanceCriteria.map((criterion, index) => ({
              criterionId: criterion.id,
              ...coverage[index],
            })),
            suggestions: options.suggestions ?? ["Ouvrir une base écrite par la version précédente"],
          });
        }
      }),
    });
    const { feature } = await openTestFeature(squad, "Le noyau");
    if (options.driven === true) {
      const armed = await squad.request("PUT", featureRoute(feature.id), { goAsRecommended: true });
      expect(armed.status).toBe(200);
    }
    const stream = await squad.openEventStream();
    expect((await stream.next()).type).toBe("snapshot");
    await squad.request("POST", mainSessionRoute(feature.id), { prompt: "/to-tickets" });
    await waitForEvent(stream, "graph-changed");
    return {
      featureId: feature.id,
      stream,
      ticket: await readTicket(feature.id),
      settled: passed.passed,
      passes: () => passes,
    };
  }

  /** Waits for what an event does not announce: a poll, bounded, then it fails. */
  async function until(what: string, holds: () => Promise<boolean>): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (await holds()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`waited in vain for ${what}`);
  }

  async function catchAlerts(): Promise<WebhookReceiver> {
    const receiver = await startWebhookReceiver();
    webhook = receiver;
    expect((await squad.request("PUT", apiRoutes.settings, { webhookUrl: receiver.url })).status).toBe(200);
    return receiver;
  }

  async function readGraph(featureId: string): Promise<FeatureGraph> {
    return (await (await squad.request("GET", featureGraphRoute(featureId))).json()) as FeatureGraph;
  }

  async function readTicket(featureId: string): Promise<Ticket> {
    const ticket = (await readGraph(featureId)).tickets.find((each) => each.title === "Le store");
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

  function reportOf(ticket: Ticket): StepReport {
    if (!ticket.stepReport) throw new Error(`ticket "${ticket.title}" carries no step report`);
    return ticket.stepReport;
  }

  it("fusionne sans réveiller personne quand tous les points tiennent", async () => {
    const { featureId, stream, ticket } = await start({
      // Nothing the sub-session declared beyond a command's reach, so the pass
      // may check the whole sheet off.
      coverage: [{ verdict: "automated" }, { verdict: "automated" }],
      settle: async (points, agent) => {
        await agent.call("settle_sheet", {
          featureId: agent.request.featureId,
          ticketId: agent.request.ticketId,
          points: points.map((pointId) => ({
            pointId,
            outcome: "holds",
            note: "Lancé sur une base écrite par 0.4 : les onze migrations passent, 312 lignes conservées.",
          })),
        });
      },
    });
    const receiver = await catchAlerts();

    await squad.request("POST", ticketSessionRoute(ticket.id), {});
    const merged = await waitForState(stream, featureId, ticket.id, "merged");

    // The whole point: the branch went through without a human, and what the
    // pass ran is readable next to what it concluded.
    const report = reportOf(merged);
    expect(report.sheet.map((point) => [point.verdict, point.settlement?.outcome])).toEqual([
      ["passed", "holds"],
    ]);
    expect(report.sheet[0]?.settlement?.note).toContain("onze migrations");
    expect(report.reviewedAt).not.toBeNull();
    expect(report.feedback).toBeNull();
    expect(pendingActions([await readGraph(featureId)], [])).toEqual([]);
    expect(receiver.received()).toEqual([]);
  });

  it("renvoie le ticket en correction quand la passe montre un point cassé", async () => {
    const { ticket, settled } = await start({
      coverage: [{ verdict: "automated" }, { verdict: "automated" }],
      settle: async (points, agent) => {
        await agent.call("settle_sheet", {
          featureId: agent.request.featureId,
          ticketId: agent.request.ticketId,
          points: points.map((pointId) => ({
            pointId,
            outcome: "broken",
            note: "Lancé sur une base de la version précédente : la migration 0004 échoue sur une colonne absente.",
          })),
        });
      },
    });
    const receiver = await catchAlerts();

    await squad.request("POST", ticketSessionRoute(ticket.id), {});
    await settled;
    // Back to the sub-session that built it, with the evidence, and nobody woken.
    await until("the correction to reach the sub-session", async () => {
      const thread = await readTicketThread(ticket.id);
      return thread.some(
        (entry) => entry.kind === "pilot" && entry.text.includes("la migration 0004 échoue"),
      );
    });
    // Rien n'est affirmé du rapport lui-même : la sous-session corrige et
    // rapporte une étape neuve, qui porte sa propre fiche. Ce qui compte ici est
    // que la correction soit partie, et que personne n'ait été réveillé.
    expect(receiver.received()).toEqual([]);
  });

  it("renvoie en correction avant de réveiller, même s'il reste du jugement", async () => {
    const { ticket, settled } = await start({
      coverage: [{ verdict: "automated" }, { verdict: "automated" }],
      suggestions: ["Ouvrir une base écrite par la version précédente", "Relire le libellé du bouton"],
      settle: async (points, agent) => {
        await agent.call("settle_sheet", {
          featureId: agent.request.featureId,
          ticketId: agent.request.ticketId,
          points: points.map((pointId, index) => ({
            pointId,
            outcome: index === 0 ? "broken" : "human",
            note:
              index === 0
                ? "Lancé : la migration 0004 échoue sur une colonne absente."
                : "Aucune commande ne dit si un libellé se lit bien.",
          })),
        });
      },
    });
    const receiver = await catchAlerts();

    await squad.request("POST", ticketSessionRoute(ticket.id), {});
    await settled;
    // Ce qui est prouvé faux repart tout de suite : juger la formulation d'un
    // écran qu'on sait devoir réécrire ne vaut pas d'être réveillé.
    await until("the correction to reach the sub-session", async () => {
      const thread = await readTicketThread(ticket.id);
      return thread.some(
        (entry) => entry.kind === "pilot" && entry.text.includes("la migration 0004 échoue"),
      );
    });
    // La correction est partie et personne n'a été réveillé : c'est tout ce que
    // ce scénario avance. L'état du ticket, lui, suit la sous-session qui
    // rapporte déjà l'étape suivante.
    expect(receiver.received()).toEqual([]);
  });

  it("ne remonte au développeur que ce que la passe lui laisse", async () => {
    const { featureId, stream, ticket, settled } = await start({
      coverage: [{ verdict: "automated" }, { verdict: "automated" }],
      suggestions: ["Ouvrir une base écrite par la version précédente", "Relire le libellé du bouton"],
      settle: async (points, agent) => {
        await agent.call("settle_sheet", {
          featureId: agent.request.featureId,
          ticketId: agent.request.ticketId,
          points: points.map((pointId, index) => ({
            pointId,
            outcome: index === 1 ? "human" : "holds",
            note:
              index === 1
                ? "Aucune commande ne dit si un libellé se lit bien : c'est un jugement."
                : "Lancé : les onze migrations passent sur une base de la version précédente.",
          })),
        });
      },
    });
    const receiver = await catchAlerts();

    await squad.request("POST", ticketSessionRoute(ticket.id), {});
    await settled;
    const waiting = await waitForState(stream, featureId, ticket.id, "awaiting-validation");

    const report = reportOf(waiting);
    expect(report.sheet.map((point) => point.verdict)).toEqual(["passed", "pending"]);
    expect(report.reviewedAt).toBeNull();
    // The developer is woken, once, for the one point that is theirs.
    const alert = await receiver.next();
    expect(alert.text).toMatch(/fiche de tests/i);
    // And they answer that point alone: being asked again about what the pass
    // settled would be being asked to do the work it spared.
    const answered = await squad.request("POST", ticketTestSheetRoute(ticket.id), {
      points: [{ id: report.sheet[1]?.id, passed: true, comment: "Le libellé va bien." }],
      feedback: "",
    });
    expect(answered.status).toBe(200);
    await waitForState(stream, featureId, ticket.id, "merged");
  });

  it("prend l'arbitrage recommandé sous go-as-recommandé, et ne réveille personne", async () => {
    const { featureId, stream, ticket, settled } = await start({
      driven: true,
      coverage: [{ verdict: "automated" }, { verdict: "automated" }],
      suggestions: ["L'orthographe de la clé exposée, `kind` ou `type`"],
      settle: async (points, agent) => {
        await agent.call("settle_sheet", {
          featureId: agent.request.featureId,
          ticketId: agent.request.ticketId,
          points: points.map((pointId) => ({
            pointId,
            outcome: "decision",
            note: "Rien n'est cassé : deux orthographes tiennent, il faut en choisir une.",
            recommendation: "Garder `kind`, aligné sur le reste du document.",
            scopeChanging: false,
          })),
        });
      },
    });
    const receiver = await catchAlerts();

    await squad.request("POST", ticketSessionRoute(ticket.id), {});
    await settled;
    // Un arbitrage n'est pas une vérification : le mode le tranche comme il
    // répond à une question, et le ticket poursuit sans réveiller personne.
    const merged = await waitForState(stream, featureId, ticket.id, "merged");
    expect(reportOf(merged).sheet[0]?.settlement?.outcome).toBe("decision");
    expect(reportOf(merged).sheet[0]?.settlement?.note).toContain("go-as-recommandé");
    expect(receiver.received()).toEqual([]);
  });

  it("laisse un arbitrage de périmètre au développeur, et le ticket attend une décision", async () => {
    const { featureId, stream, ticket, settled } = await start({
      driven: true,
      coverage: [{ verdict: "automated" }, { verdict: "automated" }],
      suggestions: ["L'orthographe de la clé exposée, `kind` ou `type`"],
      settle: async (points, agent) => {
        await agent.call("settle_sheet", {
          featureId: agent.request.featureId,
          ticketId: agent.request.ticketId,
          points: points.map((pointId) => ({
            pointId,
            outcome: "decision",
            note: "Deux voies, et celle que je recommande élargit ce que le ticket livre.",
            recommendation: "Traiter aussi le troisième sac d'overrides.",
            scopeChanging: true,
          })),
        });
      },
    });
    const receiver = await catchAlerts();

    await squad.request("POST", ticketSessionRoute(ticket.id), {});
    await settled;
    // Ce qui change ce qui est construit ne se décide jamais sans le
    // développeur, et le ticket le dit : il attend une décision, pas une
    // validation.
    const waiting = await waitForState(stream, featureId, ticket.id, "awaiting-decision");
    expect(reportOf(waiting).sheet.every((point) => point.verdict === "pending")).toBe(true);
    expect(pendingActions([await readGraph(featureId)], []).map((action) => action.reason)).toEqual([
      "decision",
    ]);
    expect((await receiver.next()).text).toBeTruthy();
  });

  it("laisse partir une passe qui a répondu mais ne se termine pas d'elle-même", async () => {
    // Une session en entrée continue n'a aucune raison de s'arrêter quand elle a
    // fini de parler : elle attend le message suivant, qui ne vient jamais. Une
    // sous-session est gardée en vie exprès, une session ouverte pour un seul
    // travail n'a plus rien à se voir demander. Constaté sur une exécution
    // réelle : trois passes inertes pendant une heure, onze en attente derrière.
    const jamais = gate();
    const { featureId, stream, ticket } = await start({
      coverage: [{ verdict: "automated" }, { verdict: "automated" }],
      settle: async (points, agent) => {
        await agent.call("settle_sheet", {
          featureId: agent.request.featureId,
          ticketId: agent.request.ticketId,
          points: points.map((pointId) => ({
            pointId,
            outcome: "holds",
            note: "Lancé : les onze migrations passent sur une base de la version précédente.",
          })),
        });
        await jamais.passed;
      },
    });
    const receiver = await catchAlerts();

    await squad.request("POST", ticketSessionRoute(ticket.id), {});
    // Squad ne l'attend pas : il la relâche dès qu'elle a répondu, et la suite
    // s'enchaîne comme si elle s'était terminée toute seule.
    const merged = await waitForState(stream, featureId, ticket.id, "merged");
    expect(reportOf(merged).sheet.every((point) => point.verdict === "passed")).toBe(true);
    expect(receiver.received()).toEqual([]);
  });

  it("laisse la fiche intacte quand la passe ne déclare rien", async () => {
    const { featureId, stream, ticket } = await start({});
    const receiver = await catchAlerts();

    await squad.request("POST", ticketSessionRoute(ticket.id), {});
    const waiting = await waitForState(stream, featureId, ticket.id, "awaiting-validation");

    // The fall-back goes towards the developer: a pass that said nothing is a
    // sheet nobody has been through, and it reaches them whole.
    const report = reportOf(waiting);
    expect(report.sheet.every((point) => point.verdict === "pending")).toBe(true);
    expect(report.sheet.every((point) => point.settlement === null)).toBe(true);
    expect((await receiver.next()).text).toMatch(/fiche de tests/i);
    expect(pendingActions([await readGraph(featureId)], []).map((action) => action.reason)).toEqual([
      "validation",
    ]);
  });

  it("vérifie une fiche déjà en attente quand le développeur le demande", async () => {
    // The pass says nothing on its own: the sheet reaches the developer whole,
    // which is the state every sheet reported before this pass existed is in.
    let asked = false;
    const { featureId, stream, ticket, settled } = await start({
      coverage: [{ verdict: "automated" }, { verdict: "automated" }],
      settle: async (points, agent) => {
        if (!asked) return;
        await agent.call("settle_sheet", {
          featureId: agent.request.featureId,
          ticketId: agent.request.ticketId,
          points: points.map((pointId) => ({
            pointId,
            outcome: "holds",
            note: "Lancé après coup, à la demande : les onze migrations passent.",
          })),
        });
      },
    });
    const receiver = await catchAlerts();

    await squad.request("POST", ticketSessionRoute(ticket.id), {});
    await settled;
    const waiting = await waitForState(stream, featureId, ticket.id, "awaiting-validation");
    expect(reportOf(waiting).sheet.every((point) => point.verdict === "pending")).toBe(true);
    expect((await receiver.next()).text).toMatch(/fiche de tests/i);

    // Asked for by hand, the pass goes through the same sheet and empties it.
    asked = true;
    const answer = await squad.request("POST", ticketSettlementRoute(ticket.id), {});
    expect(answer.status).toBe(200);
    const merged = await waitForState(stream, featureId, ticket.id, "merged");
    expect(reportOf(merged).sheet.map((point) => point.settlement?.outcome)).toEqual(["holds"]);

    // And a sheet nobody is waiting on any more is refused, rather than opening
    // a session with nothing to read.
    const again = await squad.request("POST", ticketSettlementRoute(ticket.id), {});
    expect(again.status).toBe(409);
    expect(((await again.json()) as ApiErrorBody).error.code).toBe("sheet_not_settleable");
  });

  it("cesse de vérifier après deux tours et rend la fiche au développeur", async () => {
    const { featureId, ticket, passes } = await start({
      coverage: [{ verdict: "automated" }, { verdict: "automated" }],
      settle: async (points, agent) => {
        await agent.call("settle_sheet", {
          featureId: agent.request.featureId,
          ticketId: agent.request.ticketId,
          points: points.map((pointId) => ({
            pointId,
            outcome: "broken",
            note: "Lancé : la migration 0004 échoue toujours sur une colonne absente.",
          })),
        });
      },
    });
    const receiver = await catchAlerts();

    await squad.request("POST", ticketSessionRoute(ticket.id), {});
    // Two passes find the same thing broken, the sub-session reports a third
    // time, and squad stops arguing with itself: the developer is woken.
    const alert = await receiver.next();

    expect(alert.text).toMatch(/fiche de tests/i);
    expect(passes()).toBe(2);
    const graph = await readGraph(featureId);
    const current = graph.tickets.find((each) => each.id === ticket.id) as Ticket;
    expect(reportOf(current).sheet.every((point) => point.verdict === "pending")).toBe(true);
    expect(reportOf(current).sheet.every((point) => point.settlement === null)).toBe(true);
  });

  it("coche un critère que la sous-session avait confié à un humain, preuve à l'appui", async () => {
    // Une sous-session qui se couvre écrit `judgement` sur ce qu'une commande
    // tranche : mesuré sur une instance réelle, 8 des 46 points en attente
    // étaient de cet ordre. Sa déclaration est un mot, pas un verdict.
    const { featureId, stream, ticket, settled } = await start({
      coverage: [{ verdict: "automated" }, { verdict: "judgement" }],
      suggestions: [],
      settle: async (points, agent) => {
        await agent.call("settle_sheet", {
          featureId: agent.request.featureId,
          ticketId: agent.request.ticketId,
          points: points.map((pointId) => ({
            pointId,
            outcome: "holds",
            note: "Lancé sur une base écrite par 0.4 : les onze migrations passent, 312 lignes conservées.",
          })),
        });
      },
    });
    const receiver = await catchAlerts();

    await squad.request("POST", ticketSessionRoute(ticket.id), {});
    await settled;
    const merged = await waitForState(stream, featureId, ticket.id, "merged");

    // Rien ne reste pour le développeur, et ce qui a été renversé se lit : le
    // critère porte toujours `judgement` à côté d'un point que squad a coché.
    const report = reportOf(merged);
    expect(report.sheet.map((point) => [point.verdict, point.settlement?.outcome])).toEqual([
      ["passed", "holds"],
    ]);
    expect(report.coverage[1]?.verdict).toBe("judgement");
    expect(report.sheet[0]?.settlement?.note).toContain("onze migrations");
    expect(receiver.received()).toEqual([]);
  });
});
