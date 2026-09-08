import { afterEach, describe, expect, it } from "vitest";
import type { Feature, FeatureGraph, Question, ThreadEntry, Ticket, TicketKind, TicketState } from "../../src/shared/api";
import {
  apiRoutes,
  featureGraphRoute,
  featureRoute,
  mainSessionRoute,
  projectRoute,
  questionAnswerRoute,
} from "../../src/shared/api";
import { createScriptedLauncher, type ScriptedAgent } from "../support/scripted-launcher";
import { openTestFeature, startTestSquad, type TestSquad } from "../support/squad";
import { startWebhookReceiver, type WebhookReceiver } from "../support/webhook";

/**
 * Go-as-recommended: the feature moves without its developer. It launches what
 * the frontier allows, answers an agent's implementation questions with that
 * agent's own recommendation, and stops the moment it meets something nobody
 * may settle in the developer's place.
 *
 * Everything is played through the surface the interface and the agents use,
 * and everything underneath is real: the git repository, the branches, the
 * merge, and the alert crossing a webhook.
 */
describe("go-as-recommended, from the drain to what stops it", () => {
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

  /** A sub-session that stays where it is until the test lets it go. */
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

  interface TicketSpec {
    title: string;
    kind?: TicketKind;
    criteria?: string[];
    /** Titles of the tickets that must merge before this one may start. */
    blockedBy?: string[];
  }

  interface Scene {
    featureId: string;
    graph(): Promise<FeatureGraph>;
    ticket(title: string): Promise<Ticket>;
    feature(): Promise<Feature>;
    /** Arms the mode, which is the one gesture the whole of this describes. */
    arm(): Promise<Feature>;
    reaches(title: string, state: TicketState): Promise<Ticket>;
    questions(): Promise<Question[]>;
    threads(): Promise<ThreadEntry[]>;
  }

  /**
   * A project, a feature, a graph written by the main session, and one scripted
   * sub-session per ticket. The script is handed the title of the ticket its
   * session was opened for, since that is what tells one from another when
   * several run at once.
   */
  async function start(options: {
    tickets: TicketSpec[];
    featureCap?: number;
    depthCap?: number;
    subSession?: (agent: ScriptedAgent, title: string) => Promise<void>;
  }): Promise<Scene> {
    const titles = new Map<string, string>();
    squad = await startTestSquad({
      launcher: createScriptedLauncher(async (agent) => {
        if (agent.request.role === "main") {
          await agent.awaitMessage();
          const written = new Map<string, string>();
          for (const spec of options.tickets) {
            const created = (await agent.call("create_ticket", {
              featureId: agent.request.featureId,
              kind: spec.kind ?? "build",
              title: spec.title,
              description: `Ce que demande « ${spec.title} ».`,
              acceptanceCriteria: spec.criteria ?? [],
              blockedBy: (spec.blockedBy ?? []).map((blocker) => written.get(blocker) ?? blocker),
            })) as Ticket;
            written.set(spec.title, created.id);
            titles.set(created.id, created.title);
          }
          return;
        }
        await options.subSession?.(agent, titles.get(agent.request.ticketId ?? "") ?? "");
      }),
    });
    const { project, feature } = await openTestFeature(squad, "Le noyau");
    if (options.featureCap !== undefined) {
      const capped = await squad.request("PUT", projectRoute(project.id), {
        featureConcurrencyCap: options.featureCap,
      });
      expect(capped.status).toBe(200);
    }
    if (options.depthCap !== undefined) {
      const capped = await squad.request("PUT", apiRoutes.settings, {
        generationDepthCap: options.depthCap,
      });
      expect(capped.status).toBe(200);
    }
    await squad.request("POST", mainSessionRoute(feature.id), { prompt: "/to-tickets" });

    const graph = async (): Promise<FeatureGraph> => {
      const response = await squad.request("GET", featureGraphRoute(feature.id));
      return (await response.json()) as FeatureGraph;
    };
    const ticket = async (title: string): Promise<Ticket> => {
      const found = (await graph()).tickets.find((each) => each.title === title);
      if (!found) throw new Error(`no ticket titled "${title}" in the graph`);
      return found;
    };
    // The graph is written by the main session, which runs on its own: nothing
    // is armed before every ticket is there, or the drain would read half of it.
    await expect
      .poll(async () => (await graph()).tickets.length, { timeout: 10_000 })
      .toBe(options.tickets.length);

    const readFeature = async (): Promise<Feature> => {
      const response = await squad.request("GET", apiRoutes.features);
      const { features } = (await response.json()) as { features: Feature[] };
      const found = features.find((each) => each.id === feature.id);
      if (!found) throw new Error("the feature is missing from the list");
      return found;
    };
    const snapshot = async () => {
      const opened = await squad.openEventStream();
      const first = await opened.next();
      if (first.type !== "snapshot") throw new Error("the first event is always a snapshot");
      return first;
    };

    return {
      featureId: feature.id,
      graph,
      ticket,
      feature: readFeature,
      async arm() {
        const armed = await squad.request("PUT", featureRoute(feature.id), {
          goAsRecommended: true,
        });
        expect(armed.status).toBe(200);
        const { feature: read } = (await armed.json()) as { feature: Feature };
        expect(read.goAsRecommended).toBe(true);
        return read;
      },
      async reaches(title, state) {
        await expect.poll(async () => (await ticket(title)).state, { timeout: 15_000 }).toBe(state);
        return ticket(title);
      },
      async questions() {
        return (await snapshot()).questions;
      },
      async threads() {
        return (await snapshot()).threads;
      },
    };
  }

  /** Sends squad's alerts to an endpoint this test can read. */
  async function catchAlerts(): Promise<WebhookReceiver> {
    const receiver = await startWebhookReceiver();
    webhook = receiver;
    const answer = await squad.request("PUT", apiRoutes.settings, { webhookUrl: receiver.url });
    expect(answer.status).toBe(200);
    return receiver;
  }

  /** The ticket a sub-session was opened for, as the agent reads it. */
  async function ownTicket(agent: ScriptedAgent): Promise<Ticket> {
    const graph = (await agent.call("read_graph", {
      featureId: agent.request.featureId,
    })) as FeatureGraph;
    const own = graph.tickets.find((each) => each.id === agent.request.ticketId);
    if (!own) throw new Error("the sub-session's own ticket is missing from the graph");
    return own;
  }

  /** Ends a step declaring every criterion automated: nothing for a human to do. */
  async function reportCovered(agent: ScriptedAgent): Promise<void> {
    const own = await ownTicket(agent);
    await agent.call("report_step", {
      featureId: agent.request.featureId,
      ticketId: agent.request.ticketId,
      summary: `Ce que demandait « ${own.title} » est construit.`,
      coverage: own.acceptanceCriteria.map((criterion) => ({
        criterionId: criterion.id,
        verdict: "automated",
      })),
      recommendation: "Fusionner.",
    });
  }

  it("answers an implementation question with the agent's own recommendation", async () => {
    const alive = gate();
    const asking = { answer: null as Question | null };
    const scene = await start({
      tickets: [{ title: "Le store" }],
      subSession: async (agent) => {
        await agent.awaitMessage();
        asking.answer = (await agent.call("ask_question", {
          featureId: agent.request.featureId,
          ticketId: agent.request.ticketId,
          question: "Quel format pour les identifiants ?",
          options: ["UUID v4", "un entier croissant"],
          recommendation: "UUID v4",
          scopeChanging: false,
        })) as Question;
        await alive.passed;
      },
    });
    const receiver = await catchAlerts();

    // Nobody launches anything and nobody answers anything: the mode does both.
    await scene.arm();
    await scene.reaches("Le store", "running");
    await expect
      .poll(async () => asking.answer !== null, { timeout: 10_000 })
      .toBe(true);

    // The answer is the agent's own recommendation, and squad says it was squad.
    expect(asking.answer?.answer).toBe("UUID v4");
    expect(asking.answer?.answeredBy).toBe("squad");
    const [question] = await scene.questions();
    expect(question?.state).toBe("answered");
    expect(question?.answeredBy).toBe("squad");

    // What squad answered on its own is readable on the ticket, which is the
    // whole point of it being written down rather than passed along.
    const ticket = await scene.ticket("Le store");
    const said = (await scene.threads())
      .filter((entry) => entry.ticketId === ticket.id && entry.kind === "notice")
      .map((entry) => entry.text);
    expect(said).toContain("squad answered with the agent's own recommendation");

    // And nobody was woken for it: that is what the mode is for.
    await expect(receiver.next(300)).rejects.toThrow(/timed out/);
  });

  it("stops on a question that changes what is built, and launches nothing more", async () => {
    const alive = gate();
    const asking = { answer: null as Question | null };
    const scene = await start({
      tickets: [{ title: "Le store" }, { title: "Les outils MCP", blockedBy: ["Le store"] }],
      subSession: async (agent) => {
        await agent.awaitMessage();
        asking.answer = (await agent.call("ask_question", {
          featureId: agent.request.featureId,
          ticketId: agent.request.ticketId,
          question: "Faut-il aussi stocker les fils de session ?",
          options: ["oui, dans la base", "non, hors périmètre"],
          recommendation: "oui, dans la base",
          scopeChanging: true,
        })) as Question;
        await alive.passed;
      },
    });
    const receiver = await catchAlerts();

    await scene.arm();
    await scene.reaches("Le store", "running");

    // The mode is held, and it says on what.
    await expect
      .poll(async () => (await scene.feature()).autonomyHalt?.reason, { timeout: 10_000 })
      .toBe("scope-question");
    const held = await scene.feature();
    expect(held.autonomyHalt?.detail).toContain("les fils de session");
    // Armed still: what stopped is squad starting anything more by itself.
    expect(held.goAsRecommended).toBe(true);

    // The developer is told the mode stopped, and the agent is still waiting.
    const alert = await receiver.next();
    expect(alert.text).toMatch(/go-as-recommandé/i);
    expect(alert.text).toContain("Le noyau");
    expect(asking.answer).toBeNull();

    // Nothing squad could have launched is launched while it is held: a ticket
    // written now stays where it is, whatever the frontier says.
    const [pending] = await scene.questions();
    expect(pending?.state).toBe("pending");
    expect((await scene.ticket("Les outils MCP")).state).toBe("blocked");

    // Answering releases the agent, exactly as it would with the mode off.
    const given = await squad.request("POST", questionAnswerRoute(pending?.id ?? ""), {
      answer: "Non, hors périmètre : ouvre un ticket.",
    });
    expect(given.status).toBe(200);
    await expect.poll(async () => asking.answer !== null, { timeout: 10_000 }).toBe(true);
    expect(asking.answer?.answeredBy).toBe("developer");
  });

  it("drains the frontier on its own, and never past the caps", async () => {
    const parked = new Map<string, Gate>();
    const scene = await start({
      tickets: [
        { title: "Le store", criteria: ["La base s'ouvre"] },
        { title: "Les outils MCP", criteria: ["Les outils répondent"] },
        { title: "L'interface", criteria: ["Le graphe s'affiche"] },
      ],
      featureCap: 2,
      subSession: async (agent, title) => {
        await agent.awaitMessage();
        const own = parked.get(title) ?? gate();
        parked.set(title, own);
        await own.passed;
        await reportCovered(agent);
      },
    });

    // One gesture, and the frontier leaves: nobody launched a single ticket.
    await scene.arm();
    await expect
      .poll(
        async () =>
          (await scene.graph()).tickets.filter((ticket) => ticket.state === "running").length,
        { timeout: 15_000 },
      )
      .toBe(2);

    // And never more than the cap allows: the third waits for a place.
    const waiting = (await scene.graph()).tickets.filter((ticket) => ticket.state === "queued");
    expect(waiting).toHaveLength(1);
    const held = waiting[0]?.title ?? "";
    const running = (await scene.graph()).tickets
      .filter((ticket) => ticket.state === "running")
      .map((ticket) => ticket.title);

    // A step nobody has to read merges on its own, and the place it frees goes
    // to what was waiting for it: the graph drains without a single click.
    parked.get(running[0] ?? "")?.open();
    await scene.reaches(running[0] ?? "", "merged");
    await scene.reaches(held, "running");
  });

  it("stops on a ticket that stopped, while what was running carries on", async () => {
    const alive = gate();
    const scene = await start({
      tickets: [{ title: "Le store" }, { title: "Les outils MCP" }],
      subSession: async (agent, title) => {
        await agent.awaitMessage();
        if (title === "Le store") throw new Error("la sous-session est tombée");
        await alive.passed;
      },
    });
    const receiver = await catchAlerts();

    await scene.arm();
    await scene.reaches("Le store", "failed");

    // There and then, rather than once the graph has run out of work: a run
    // nobody is watching must not pile more onto a feature someone has to look
    // at. What was already running is left alone.
    await expect
      .poll(async () => (await scene.feature()).autonomyHalt?.reason, { timeout: 10_000 })
      .toBe("failure");
    expect((await scene.feature()).autonomyHalt?.detail).toBe("Le store");
    // Nothing is cancelled: the launch the mode had already accepted opens all
    // the same, and what it opens goes on working.
    await scene.reaches("Les outils MCP", "running");

    // Two things are said: the sub-session that stopped, and the night that
    // stopped with it.
    const alerts = [(await receiver.next()).text ?? "", (await receiver.next()).text ?? ""];
    expect(alerts.some((text) => /sous-session/i.test(text))).toBe(true);
    expect(alerts.some((text) => /go-as-recommandé/i.test(text))).toBe(true);
  });

  it("stops when a ticket born of a ticket reaches the declared depth", async () => {
    const alive = gate();
    const born = { ticket: null as Ticket | null };
    const scene = await start({
      tickets: [{ title: "Le store" }],
      depthCap: 1,
      subSession: async (agent) => {
        await agent.awaitMessage();
        born.ticket = (await agent.call("create_ticket", {
          featureId: agent.request.featureId,
          kind: "build",
          title: "Migrer les bases écrites par la version précédente",
          description: "Ce que le store a découvert en chemin.",
          bornOf: agent.request.ticketId,
        })) as Ticket;
        await alive.passed;
      },
    });
    const receiver = await catchAlerts();

    await scene.arm();
    await scene.reaches("Le store", "running");
    await expect.poll(async () => born.ticket !== null, { timeout: 10_000 }).toBe(true);

    // The ticket is written, and it carries how deep it was born.
    const uncovered = await scene.ticket("Migrer les bases écrites par la version précédente");
    expect(uncovered.generation).toBe(1);
    expect((await scene.ticket("Le store")).generation).toBe(0);

    // The drain is suspended and the developer is told, on the depth and on the
    // ticket that reached it.
    await expect
      .poll(async () => (await scene.feature()).autonomyHalt?.reason, { timeout: 10_000 })
      .toBe("depth-cap");
    const alert = await receiver.next();
    expect(alert.text).toMatch(/profondeur/i);

    // Nothing is undone: the ticket that was already building carries on, and
    // the one that was written is there, waiting for a developer to say go.
    expect((await scene.ticket("Le store")).state).toBe("running");
    expect(uncovered.state).toBe("ready");
    await expect
      .poll(async () => (await scene.ticket(uncovered.title)).state, { timeout: 1_000 })
      .toBe("ready");
  });

  it("stops on a decision ticket nothing can go around", async () => {
    const scene = await start({
      tickets: [
        { title: "Quelle disposition pour le graphe", kind: "decision" },
        { title: "Le graphe à l'écran", blockedBy: ["Quelle disposition pour le graphe"] },
      ],
    });
    const receiver = await catchAlerts();

    await scene.arm();

    await expect
      .poll(async () => (await scene.feature()).autonomyHalt?.reason, { timeout: 10_000 })
      .toBe("decision");
    expect((await scene.feature()).autonomyHalt?.detail).toBe("Quelle disposition pour le graphe");
    const alert = await receiver.next();
    expect(alert.text).toMatch(/décision/i);
    // Nothing was launched, since nothing could be: the decision holds the rest.
    expect((await scene.ticket("Le graphe à l'écran")).state).toBe("blocked");
  });
});
