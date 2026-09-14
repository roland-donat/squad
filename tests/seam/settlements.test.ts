import { afterEach, describe, expect, it } from "vitest";
import type {
  ApiErrorBody,
  Feature,
  FeatureGraph,
  StepReport,
  TestSheetPoint,
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
import { connectToSquadTools, writeTicket } from "../support/mcp";

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
    /** The tickets the main session writes, by title. One, unless said otherwise. */
    titles?: string[];
  }): Promise<{
    featureId: string;
    stream: EventStream;
    ticket: Ticket;
    /** Every ticket the main session wrote, in the order it wrote them. */
    tickets: Ticket[];
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
          for (const title of options.titles ?? ["Le store"]) {
            await writeTicket(agent, {
              featureId: agent.request.featureId,
              kind: "build",
              title,
              description: "La base et ses migrations.",
              acceptanceCriteria: ["La base s'ouvre", "Les migrations s'appliquent"],
            });
          }
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
          const ticket = (await readGraph(agent.request.featureId)).tickets.find(
            (each) => each.id === agent.request.ticketId,
          ) as Ticket;
          await agent.call("report_step", {
            featureId: agent.request.featureId,
            ticketId: agent.request.ticketId,
            work: "La base s'ouvre et les migrations tournent.",
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
    // Every ticket asked for, and not merely the first event: one
    // `graph-changed` is one ticket written, so reading the graph on it left a
    // two-ticket scenario running against one.
    const expected = (options.titles ?? ["Le store"]).length;
    let written: Ticket[] = [];
    await until(`les ${expected} ticket(s) du scénario`, async () => {
      written = (await readGraph(feature.id)).tickets;
      return written.length === expected;
    });
    return {
      featureId: feature.id,
      stream,
      ticket: written[0] as Ticket,
      tickets: written,
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

  /** The feature as the interface reads it, with what the mode is doing. */
  async function readFeature(featureId: string): Promise<Feature> {
    const { features } = (await (await squad.request("GET", apiRoutes.features)).json()) as {
      features: Feature[];
    };
    const found = features.find((each) => each.id === featureId);
    if (!found) throw new Error("the feature is missing from the list");
    return found;
  }

  async function readGraph(featureId: string): Promise<FeatureGraph> {
    return (await (await squad.request("GET", featureGraphRoute(featureId))).json()) as FeatureGraph;
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

  it("reprend les arbitrages restés ouverts quand le mode est relancé", async () => {
    // Un arbitrage posé sur une feature déjà arrêtée reçoit « attends », et rien
    // ne le redemandait jamais. Mesuré sur l'instance : un arbitrage de
    // périmètre en avait gelé sept que squad avait le droit de prendre.
    const { featureId, stream, ticket, settled } = await start({
      coverage: [{ verdict: "automated" }, { verdict: "automated" }],
      suggestions: ["L'orthographe de la clé exposée, `kind` ou `type`"],
      settle: async (points, agent) => {
        await agent.call("settle_sheet", {
          featureId: agent.request.featureId,
          ticketId: agent.request.ticketId,
          points: points.map((pointId) => ({
            pointId,
            outcome: "decision",
            note: "Rien n'est cassé : deux orthographes tiennent.",
            recommendation: "Garder `kind`, aligné sur le reste du document.",
            scopeChanging: false,
          })),
        });
      },
    });

    await squad.request("POST", ticketSessionRoute(ticket.id), {});
    await settled;
    // Le mode n'est pas armé : l'arbitrage reste sur la fiche, et le ticket dit
    // qu'il attend une décision.
    const waiting = await waitForState(stream, featureId, ticket.id, "awaiting-decision");
    expect(reportOf(waiting).sheet.every((point) => point.verdict === "pending")).toBe(true);

    // Armer le mode, c'est redemander : ce qui dormait est pris, sans qu'aucune
    // passe ne soit rouverte.
    const armed = await squad.request("PUT", featureRoute(featureId), { goAsRecommended: true });
    expect(armed.status).toBe(200);
    const merged = await waitForState(stream, featureId, ticket.id, "merged");
    expect(reportOf(merged).sheet[0]?.settlement?.note).toContain("go-as-recommandé");
  });

  it("prend ce qui ne change rien même quand un arbitrage de périmètre attend", async () => {
    // Un arbitrage de périmètre arrête le mode. Lu dans l'ordre de la fiche, il
    // gèle tout ce qui le suit, et squad rendrait au développeur des décisions
    // qu'il avait le droit de prendre. Mesuré sur l'instance : 25 arbitrages
    // ouverts, dont une majorité que rien ne reprenait.
    const { featureId, stream, ticket, settled } = await start({
      driven: true,
      coverage: [{ verdict: "automated" }, { verdict: "automated" }],
      suggestions: ["Le périmètre", "L'orthographe de la clé"],
      settle: async (points, agent) => {
        await agent.call("settle_sheet", {
          featureId: agent.request.featureId,
          ticketId: agent.request.ticketId,
          points: points.map((pointId, index) => ({
            pointId,
            outcome: "decision",
            note: "Deux voies tiennent.",
            recommendation: index === 0 ? "Élargir le périmètre" : "Garder `kind`",
            // Celui qui change le périmètre arrive EN PREMIER dans la fiche.
            scopeChanging: index === 0,
          })),
        });
      },
    });

    await squad.request("POST", ticketSessionRoute(ticket.id), {});
    await settled;
    const waiting = await waitForState(stream, featureId, ticket.id, "awaiting-decision");

    // Le second est pris malgré le premier, et seul le premier reste.
    const sheet = reportOf(waiting).sheet;
    expect(sheet.filter((point) => point.verdict === "pending")).toHaveLength(1);
    expect(sheet.find((point) => point.verdict === "passed")?.settlement?.note).toContain(
      "go-as-recommandé",
    );
  });

  it("prend les arbitrages ordinaires de tous les tickets, pas du seul premier lu", async () => {
    // Le tri par ticket ne suffit pas, et c'est mesuré sur l'instance : deux
    // tickets portaient chacun un arbitrage de périmètre et un ordinaire. Le
    // premier lu prenait le sien, s'arrêtait sur son point de périmètre, et le
    // second repartait avec un arbitrage que squad avait le droit de prendre.
    // Aucun ordre entre tickets n'y répond, puisque celui qui passe en premier
    // gèle les suivants : il faut lire tous les points ordinaires avant qu'un
    // seul point de périmètre ne soit lu.
    const { featureId, stream, tickets, passes } = await start({
      titles: ["Le store", "Le flux"],
      coverage: [{ verdict: "automated" }, { verdict: "automated" }],
      suggestions: ["Le périmètre", "L'orthographe de la clé"],
      settle: async (points, agent) => {
        await agent.call("settle_sheet", {
          featureId: agent.request.featureId,
          ticketId: agent.request.ticketId,
          points: points.map((pointId, index) => ({
            pointId,
            outcome: "decision",
            note: "Deux voies tiennent.",
            recommendation: index === 0 ? "Élargir le périmètre" : "Garder `kind`",
            scopeChanging: index === 0,
          })),
        });
      },
    });

    for (const ticket of tickets) {
      await squad.request("POST", ticketSessionRoute(ticket.id), {});
    }
    await until("les deux passes", async () => passes() === 2);
    for (const ticket of tickets) {
      await waitForState(stream, featureId, ticket.id, "awaiting-decision");
    }

    // Le mode n'était pas armé : les quatre arbitrages dorment. L'armer, c'est
    // les redemander tous, et chacun des deux tickets ne doit garder que celui
    // que squad ne prend jamais.
    expect(
      (await squad.request("PUT", featureRoute(featureId), { goAsRecommended: true })).status,
    ).toBe(200);
    await until("les deux arbitrages ordinaires pris", async () => {
      const graph = await readGraph(featureId);
      return tickets.every((ticket) => {
        const found = graph.tickets.find((each) => each.id === ticket.id) as Ticket;
        const sheet = reportOf(found).sheet;
        return (
          sheet.filter((point) => point.verdict === "pending").length === 1 &&
          sheet.some((point) => point.verdict === "passed")
        );
      });
    });
    // Et celui qui reste est bien le point de périmètre, sur les deux.
    const graph = await readGraph(featureId);
    for (const ticket of tickets) {
      const found = graph.tickets.find((each) => each.id === ticket.id) as Ticket;
      const left = reportOf(found).sheet.filter((point) => point.verdict === "pending");
      expect(left[0]?.settlement?.scopeChanging).toBe(true);
    }
  });

  it("prend un arbitrage seul, sans faire signer les vérifications de la même fiche", async () => {
    // Mesuré sur l'instance : cinq arbitrages de périmètre attendaient derrière
    // des points demandant si une formulation allait bien et si un écran était
    // correct. La revue exigeant la fiche entière, prendre la décision revenait
    // à déclarer avoir lu ce que personne n'avait ouvert.
    const { featureId, stream, ticket, settled } = await start({
      coverage: [{ verdict: "automated" }, { verdict: "automated" }],
      suggestions: ["Le périmètre", "La formulation du libellé"],
      settle: async (points, agent) => {
        await agent.call("settle_sheet", {
          featureId: agent.request.featureId,
          ticketId: agent.request.ticketId,
          points: points.map((pointId, index) =>
            index === 0
              ? {
                  pointId,
                  outcome: "decision",
                  note: "Deux voies tiennent, et celle que je recommande élargit le ticket.",
                  recommendation: "Élargir le périmètre",
                  scopeChanging: true,
                }
              : {
                  pointId,
                  outcome: "human",
                  note: "Rien ne juge une formulation : à lire.",
                },
          ),
        });
      },
    });

    await squad.request("POST", ticketSessionRoute(ticket.id), {});
    await settled;
    // Une fiche qui porte les deux se lit comme une validation, la plus lourde
    // des deux, puisque le développeur doit venir de toute façon.
    const waiting = await waitForState(stream, featureId, ticket.id, "awaiting-validation");
    const sheet = reportOf(waiting).sheet;
    const arbitrage = sheet.find((point) => point.settlement?.outcome === "decision") as TestSheetPoint;
    const verification = sheet.find((point) => point.settlement?.outcome === "human") as TestSheetPoint;

    // Une vérification ne se prend pas seule : elle se répond avec la fiche.
    const seule = await squad.request("POST", ticketTestSheetRoute(ticket.id), {
      points: [{ id: verification.id, passed: true, comment: "" }],
      feedback: "",
    });
    expect(seule.status).toBe(400);
    expect(((await seule.json()) as ApiErrorBody).error.code).toBe("not_an_arbitration");

    // L'arbitrage, lui, se prend seul.
    const pris = await squad.request("POST", ticketTestSheetRoute(ticket.id), {
      points: [{ id: arbitrage.id, passed: true, comment: "Route retenue : Élargir le périmètre" }],
      feedback: "",
    });
    expect(pris.status).toBe(200);

    // La décision est écrite, la vérification attend toujours, et la fiche
    // n'est pas datée : rien ne suit une fiche tant qu'il reste quelque chose
    // dessus, sinon une décision prise tôt ferait fusionner une étape dont
    // personne n'a lu les vérifications.
    const apres = (await readGraph(featureId)).tickets.find(
      (each) => each.id === ticket.id,
    ) as Ticket;
    expect(apres.state).toBe("awaiting-validation");
    const relu = reportOf(apres);
    expect(relu.reviewedAt).toBeNull();
    expect(relu.sheet.find((point) => point.id === arbitrage.id)?.verdict).toBe("passed");
    expect(relu.sheet.find((point) => point.id === verification.id)?.verdict).toBe("pending");
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

  it("cesse de renvoyer après deux tours, et type tout de même la fiche qu'elle rend", async () => {
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

    // Three passes and not two: what the cap stops is the sending back, never
    // the typing, which corrects nothing and risks nothing. So the sheet the
    // developer reads carries what squad ran on every point rather than the
    // bare lines the sub-session wrote.
    await until("la troisième passe", async () => passes() === 3);
    const graph = await readGraph(featureId);
    const current = graph.tickets.find((each) => each.id === ticket.id) as Ticket;
    expect(reportOf(current).correctable).toBe(false);
    expect(reportOf(current).sheet.every((point) => point.verdict === "failed")).toBe(true);
    expect(
      reportOf(current).sheet.every((point) => point.settlement?.outcome === "broken"),
    ).toBe(true);
    // And it is waiting on them, which is what keeps a step squad has stopped
    // correcting from being waited on by nobody at all.
    expect(
      pendingActions([graph], []).some(
        (action) => action.ticketId === ticket.id && action.reason === "validation",
      ),
    ).toBe(true);
  });

  it("laisse le développeur répondre à la fiche du dernier tour qu'il est le seul à pouvoir traiter", async () => {
    // Le point que le test précédent ne posait pas : la fiche est bien annoncée
    // comme attendant une personne, mais cette personne peut-elle agir ? Au
    // dernier tour, une passe qui casse tout ne laisse aucun point `pending`,
    // et c'est ce qui date le rapport. Un rapport daté est une fiche que
    // l'interface rend en lecture seule et que le serveur refuse de reprendre.
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

    await squad.request("POST", ticketSessionRoute(ticket.id), {});
    await until("la troisième passe", async () => passes() === 3);

    const graph = await readGraph(featureId);
    const current = graph.tickets.find((each) => each.id === ticket.id) as Ticket;
    const report = reportOf(current);
    expect(report.correctable).toBe(false);

    // Squad dit qu'elle attend le développeur.
    expect(
      pendingActions([graph], []).some(
        (action) => action.ticketId === ticket.id && action.reason === "validation",
      ),
    ).toBe(true);

    // Donc le développeur doit pouvoir la traiter. Il répond sur les points que
    // la passe a cassés : ce sont les seuls qui restent, et les juger est
    // exactement ce que squad lui demande.
    const answered = await squad.request("POST", ticketTestSheetRoute(ticket.id), {
      points: report.sheet.map((point) => ({ id: point.id, passed: true })),
      feedback: "Vérifié à la main : c'est bon chez moi.",
    });
    expect(answered.status).toBe(200);

    // Et une fois répondu, plus rien ne l'attend.
    expect(pendingActions([await readGraph(featureId)], [])).toEqual([]);
  });

  it("type encore l'arbitrage du dernier tour, et go-as-recommandé le prend", async () => {
    // Le fond de l'affaire, mesuré sur l'instance : trois fiches non typées
    // portaient 15 des 33 points en attente, arbitrages compris. Un arbitrage
    // sans recommandation n'est pas prenable, donc le mode s'arrêtait sur ce
    // que le plafond avait simplement cessé de regarder.
    let round = 0;
    const { featureId, stream, ticket, passes } = await start({
      driven: true,
      coverage: [{ verdict: "automated" }, { verdict: "automated" }],
      suggestions: ["L'orthographe de la clé exposée, `kind` ou `type`"],
      settle: async (points, agent) => {
        round += 1;
        const last = round > 2;
        await agent.call("settle_sheet", {
          featureId: agent.request.featureId,
          ticketId: agent.request.ticketId,
          points: points.map((pointId) => ({
            pointId,
            ...(last
              ? {
                  outcome: "decision",
                  note: "Rien n'est cassé : deux orthographes tiennent, il faut en choisir une.",
                  recommendation: "Garder `kind`, aligné sur le reste du document.",
                  scopeChanging: false,
                }
              : {
                  outcome: "broken",
                  note: "Lancé : la migration 0004 échoue sur une colonne absente.",
                }),
          })),
        });
      },
    });
    const receiver = await catchAlerts();

    await squad.request("POST", ticketSessionRoute(ticket.id), {});
    const merged = await waitForState(stream, featureId, ticket.id, "merged");
    expect(passes()).toBe(3);
    expect(reportOf(merged).sheet[0]?.settlement?.outcome).toBe("decision");
    expect(receiver.received()).toEqual([]);
  });

  it("laisse répondre la fiche dont le mode vient de prendre le dernier arbitrage", async () => {
    // Le même blocage que plus haut, par l'autre porte. Au dernier tour, une
    // passe qui casse un point et en soumet un autre à l'arbitrage laisse, une
    // fois le mode passé, un point cassé et rien en attente. C'est ce « rien en
    // attente » qui datait le rapport, et un rapport daté est une fiche que le
    // serveur refuse de reprendre.
    let round = 0;
    const { featureId, stream, ticket, passes } = await start({
      driven: true,
      coverage: [{ verdict: "automated" }, { verdict: "automated" }],
      suggestions: ["Le point qui casse", "L'orthographe de la clé exposée"],
      settle: async (points, agent) => {
        round += 1;
        const last = round > 2;
        await agent.call("settle_sheet", {
          featureId: agent.request.featureId,
          ticketId: agent.request.ticketId,
          points: points.map((pointId, index) => ({
            pointId,
            ...(last && index === 1
              ? {
                  outcome: "decision",
                  note: "Rien n'est cassé : deux orthographes tiennent.",
                  recommendation: "Garder `kind`.",
                  scopeChanging: false,
                }
              : {
                  outcome: "broken",
                  note: "Lancé : la migration 0004 échoue sur une colonne absente.",
                }),
          })),
        });
      },
    });

    await squad.request("POST", ticketSessionRoute(ticket.id), {});
    await until("la troisième passe", async () => passes() === 3);
    const waiting = await waitForState(stream, featureId, ticket.id, "awaiting-validation");
    const report = reportOf(waiting);
    expect(report.correctable).toBe(false);
    // Le mode a bien pris son arbitrage, et le point cassé reste.
    expect(report.sheet.some((point) => point.verdict === "passed")).toBe(true);
    expect(report.sheet.some((point) => point.verdict === "failed")).toBe(true);

    // Donc la fiche attend une personne, et cette personne peut répondre.
    expect(
      pendingActions([await readGraph(featureId)], []).some(
        (action) => action.ticketId === ticket.id && action.reason === "validation",
      ),
    ).toBe(true);
    const answered = await squad.request("POST", ticketTestSheetRoute(ticket.id), {
      points: report.sheet
        .filter((point) => point.verdict === "failed")
        .map((point) => ({ id: point.id, passed: true })),
      feedback: "Vérifié à la main.",
    });
    expect(answered.status).toBe(200);
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
  /**
   * An arbitration left on the sheet of a ticket that came to rest decides
   * nothing, so it holds nothing.
   *
   * A dropped ticket keeps its sheet, and a scope arbitration on it is never
   * answered: squad will not take that one alone, and the developer has no
   * reason to go through the sheet of something that will not be built. The
   * sweep read it all the same, so the mode stopped on it at every arming, for
   * ever. Measured on the instance twice in three days, both times on a ticket
   * dropped as a duplicate of its twin in another repository, and both times
   * read as a button that would not restart the mode.
   */
  it("ne s'arrête pas sur l'arbitrage resté au dos d'un ticket écarté", async () => {
    const { featureId, ticket, settled } = await start({
      driven: true,
      coverage: [{ verdict: "automated" }, { verdict: "automated" }],
      settle: async (points, agent) => {
        await agent.call("settle_sheet", {
          featureId: agent.request.featureId,
          ticketId: agent.request.ticketId,
          points: points.map((pointId) => ({
            pointId,
            outcome: "decision",
            note: "Trois routes se défendent, et celle qu'on prend engage un autre dépôt.",
            recommendation: "La clé explicite, avec son ticket compagnon.",
            scopeChanging: true,
          })),
        });
      },
    });

    await squad.request("POST", ticketSessionRoute(ticket.id), {});
    await settled;
    // The mode stops, which is right: a perimeter arbitration is never squad's.
    await until("l'arrêt du mode sur l'arbitrage de périmètre", async () => {
      const feature = await readFeature(featureId);
      return feature.autonomyHalt?.reason === "scope-question";
    });

    // The ticket is dropped without its sheet being gone through, which is the
    // ordinary way a duplicate ends.
    const tools = await connectToSquadTools(squad.url);
    await tools.call("discard_ticket", {
      featureId,
      ticketId: ticket.id,
      reason: "Doublon déposé sur le mauvais dépôt : son jumeau porte le travail.",
    });
    await tools.close();

    // Arming again now holds: nothing is left that squad refuses to decide, the
    // only thing that was being read belonging to a ticket nobody will build.
    const armed = await squad.request("PUT", featureRoute(featureId), { goAsRecommended: true });
    expect(armed.status).toBe(200);
    await until("le mode reparti sans arrêt", async () => {
      const feature = await readFeature(featureId);
      return feature.goAsRecommended && feature.autonomyHalt === null;
    });
    // And it stays: the sweep runs at every arming, so a halt would come back
    // within one of them rather than never.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await readFeature(featureId)).autonomyHalt).toBeNull();
  });
  /**
   * And what came to rest is not merged again.
   *
   * A dropped ticket keeps its sheet, and that sheet may well hold throughout:
   * it was gone through, or it never had a point at all. Going through it then
   * asks for a merge, and the merge read the sheet and not the ticket, so a
   * ticket nobody will build came back as `merging`, holding its successors
   * again and sending a branch through the chain twice.
   */
  it("refuse de fusionner un ticket écarté, quelle que soit sa fiche", async () => {
    const { featureId, ticket, settled } = await start({
      coverage: [{ verdict: "automated" }, { verdict: "judgement" }],
      settle: async () => {},
    });

    await squad.request("POST", ticketSessionRoute(ticket.id), {});
    await settled;
    await until("la fiche rendue au développeur", async () => {
      const current = (await readGraph(featureId)).tickets[0] as Ticket;
      return current.state === "awaiting-validation";
    });

    const tools = await connectToSquadTools(squad.url);
    await tools.call("discard_ticket", {
      featureId,
      ticketId: ticket.id,
      reason: "Doublon déposé sur le mauvais dépôt : son jumeau porte le travail.",
    });
    await tools.close();

    // Everything checked, which on a live ticket is exactly what merges it.
    const sheet = ((await readGraph(featureId)).tickets[0] as Ticket).stepReport?.sheet ?? [];
    const reviewed = await squad.request("POST", ticketTestSheetRoute(ticket.id), {
      points: sheet.map((point) => ({ id: point.id, passed: true, comment: "" })),
      feedback: "",
    });
    expect(reviewed.status).toBe(200);

    // It stays dropped, and its conclusion is still the only thing written on
    // it: nothing of it was built, so there is nothing to merge.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const dropped = (await readGraph(featureId)).tickets[0] as Ticket;
    expect(dropped.state).toBe("discarded");
    expect(dropped.conclusion).toContain("Doublon déposé");
  });

  /**
   * And the other road out of a sheet does not take it back either.
   *
   * A sheet comes to rest in two ways that are squad's, the merge and the
   * correction, and a dropped ticket keeps its sheet for both. Handing that
   * sheet back with a point unchecked asked for a correction on something
   * nobody will build: the ticket came back as `running`, held its successors a
   * second time, and carried on wearing the reason it was dropped as its
   * conclusion.
   */
  it("refuse de reprendre un ticket écarté, même sur un point laissé décoché", async () => {
    const { featureId, ticket, settled } = await start({
      coverage: [{ verdict: "automated" }, { verdict: "judgement" }],
      settle: async () => {},
    });

    await squad.request("POST", ticketSessionRoute(ticket.id), {});
    await settled;
    await until("la fiche rendue au développeur", async () => {
      const current = (await readGraph(featureId)).tickets[0] as Ticket;
      return current.state === "awaiting-validation";
    });

    const tools = await connectToSquadTools(squad.url);
    await tools.call("discard_ticket", {
      featureId,
      ticketId: ticket.id,
      reason: "Doublon déposé sur le mauvais dépôt : son jumeau porte le travail.",
    });
    await tools.close();

    // A point left unchecked, which on a live ticket is exactly what hands the
    // sheet back to the sub-session that reported it.
    const sheet = ((await readGraph(featureId)).tickets[0] as Ticket).stepReport?.sheet ?? [];
    await squad.request("POST", ticketTestSheetRoute(ticket.id), {
      points: sheet.map((point) => ({
        id: point.id,
        passed: false,
        comment: "Le message parle d'une table, pas de la base.",
      })),
      feedback: "",
    });

    await new Promise((resolve) => setTimeout(resolve, 300));
    const dropped = (await readGraph(featureId)).tickets[0] as Ticket;
    expect(dropped.state).toBe("discarded");
    expect(dropped.conclusion).toContain("Doublon déposé");
  });
});
