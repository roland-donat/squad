import { spawn } from "node:child_process";
import type { AutonomyHaltReason } from "../shared/api";
import { feature as featureRoute, routePath } from "../shared/ui-routes";
import type { Store } from "./store";

/**
 * How squad reaches the developer when progress stops. Two channels, both
 * fire-and-forget: a notification on this machine's desktop, and a message to a
 * webhook for when the developer is somewhere else.
 *
 * Nothing here ever throws back into its caller. An alert is a side effect of
 * something that already happened, and a webhook that is down must not turn a
 * reported step into a refused tool call.
 *
 * The texts are in French: they are the one part of squad's output a human reads
 * on a phone, not tool output.
 */

export interface Alert {
  /** One line, in French, that says what stopped and on which ticket. */
  text: string;
  /**
   * What the alert is about, which is where the message points. Declared rather
   * than deduced from the text: an alert is read on a phone, and its one useful
   * gesture is opening what it reports.
   */
  at: AlertTarget;
}

/** What an alert is about, said in the terms an address is built from. */
export interface AlertTarget {
  featureId: string;
  /** Null when the alert is about the feature itself rather than one ticket. */
  ticketId: string | null;
}

/** The feature an alert names, and the little of it an alert needs. */
interface AlertedFeature {
  id: string;
  title: string;
}

/** The ticket an alert names, and the little of it an alert needs. */
interface AlertedTicket {
  id: string;
  featureId: string;
  title: string;
}

const aboutFeature = (feature: AlertedFeature): AlertTarget => ({
  featureId: feature.id,
  ticketId: null,
});
const aboutTicket = (ticket: AlertedTicket): AlertTarget => ({
  featureId: ticket.featureId,
  ticketId: ticket.id,
});

/** Why the mode stopped, said in the one line a phone shows of it. */
const haltReasons: Record<AutonomyHaltReason, string> = {
  "scope-question": "une question change le périmètre",
  decision: "un ticket de décision attend d'être tranché",
  failure: "un ticket s'est arrêté",
  "depth-cap": "le plafond de profondeur d'engendrement est atteint",
};

export const alertFor = {
  questionWaiting: (question: {
    prompt: string;
    featureId: string;
    ticketId: string | null;
  }): Alert => ({
    text: `squad : un agent attend votre réponse : « ${question.prompt} »`,
    at: { featureId: question.featureId, ticketId: question.ticketId },
  }),
  autonomyHalted: (
    feature: AlertedFeature,
    reason: AutonomyHaltReason,
    detail: string,
  ): Alert => ({
    text: `squad : le go-as-recommandé de « ${feature.title} » s'interrompt, ${haltReasons[reason]} : « ${detail} ».`,
    at: aboutFeature(feature),
  }),
  testSheetWaiting: (ticket: AlertedTicket): Alert => ({
    text: `squad : la fiche de tests de « ${ticket.title} » attend une vérification.`,
    at: aboutTicket(ticket),
  }),
  subSessionStopped: (ticket: AlertedTicket): Alert => ({
    text: `squad : la sous-session de « ${ticket.title} » s'est arrêtée sans finir.`,
    at: aboutTicket(ticket),
  }),
  subSessionSilent: (ticket: AlertedTicket): Alert => ({
    text: `squad : la sous-session de « ${ticket.title} » s'est terminée sans rapporter sa fin d'étape.`,
    at: aboutTicket(ticket),
  }),
  subSessionNotTakenBack: (ticket: AlertedTicket): Alert => ({
    text: `squad : la sous-session de « ${ticket.title} » n'a pas pu être reprise.`,
    at: aboutTicket(ticket),
  }),
  subSessionNotOpened: (ticket: AlertedTicket): Alert => ({
    text: `squad : la sous-session de « ${ticket.title} » n'a pas pu être ouverte.`,
    at: aboutTicket(ticket),
  }),
  mergeConflicted: (ticket: AlertedTicket): Alert => ({
    text: `squad : la fusion de « ${ticket.title} » est en conflit, et la session de résolution n'en est pas venue à bout.`,
    at: aboutTicket(ticket),
  }),
  mergeFailed: (ticket: AlertedTicket): Alert => ({
    text: `squad : la branche de « ${ticket.title} » n'a pas pu être fusionnée.`,
    at: aboutTicket(ticket),
  }),
  integrationCheckFailed: (feature: AlertedFeature): Alert => ({
    text: `squad : la vérification d'intégration de « ${feature.title} » est rouge ; un ticket de correction bloque la suite.`,
    at: aboutFeature(feature),
  }),
  pullRequestWaiting: (feature: AlertedFeature, url: string): Alert => ({
    text: `squad : « ${feature.title} » est drainée et sa pull request attend votre relecture : ${url}`,
    at: aboutFeature(feature),
  }),
  featureNotDelivered: (feature: AlertedFeature, why: string): Alert => ({
    text: `squad : « ${feature.title} » est drainée mais n'a pas pu partir en pull request : ${why}`,
    at: aboutFeature(feature),
  }),
};

export class Alerts {
  constructor(
    private readonly store: Store,
    /**
     * Squad's own address for a path of the interface, or null while it has
     * none: it only learns the port it listens on once it is listening, and a
     * run takes back what the previous one left before that.
     */
    private readonly uiUrl: (path: string) => string | null,
  ) {}

  /**
   * Raises an alert on every channel the settings leave open. Returns nothing to
   * await on purpose: the caller has already done its work, and how long a
   * webhook takes to answer is none of its business.
   */
  raise(alert: Alert): void {
    const { webhookUrl, desktopNotifications } = this.store.settings();
    const link = this.linkTo(alert.at);
    // On its own line: both channels show it as it is, and a message that
    // already ends in an address, the pull request one, stays readable.
    const text = link === null ? alert.text : `${alert.text}\n${link}`;
    if (desktopNotifications) notifyDesktop(text);
    if (webhookUrl !== null) void postToWebhook(webhookUrl, text);
  }

  /**
   * The address of what an alert is about. Null when the feature is gone, which
   * is a link squad does without rather than an alert it drops: what stopped is
   * worth saying even when there is nothing left to open.
   */
  private linkTo(at: AlertTarget): string | null {
    const alerted = this.store.feature(at.featureId);
    if (alerted === null) return null;
    return this.uiUrl(
      routePath(
        featureRoute(alerted.id, {
          ticketId: at.ticketId,
          // An alert about the feature itself, a question its main session
          // asked among them, lands with the thread open: that thread is where
          // the feature is spoken to, and an alert whose one useful gesture is
          // answering must open on the place the answer is typed.
          threadOpen: at.ticketId === null,
        }),
      ),
    );
  }
}

/**
 * The default payload is the one Google Workspace chat expects: a lone `text`
 * field. It is also the simplest thing any other endpoint can read, so it is
 * what squad sends whatever the URL points at.
 */
async function postToWebhook(url: string, text: string): Promise<void> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      // Bounded, so a webhook that never answers cannot keep the process alive
      // after everything else has stopped.
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      console.error(`the alert webhook answered ${response.status}`);
    }
  } catch (failure) {
    console.error("the alert webhook could not be reached", failure);
  }
}

/**
 * A desktop notification through whatever this platform offers, and nothing at
 * all where it offers nothing. A machine without the command is not an error to
 * report: the webhook is the channel that carries when this one cannot.
 */
function notifyDesktop(text: string): void {
  const command = desktopCommand(text);
  if (command === null) return;
  try {
    const child = spawn(command.file, command.args, { stdio: "ignore" });
    // A missing notify-send raises here rather than throwing: swallowed, since
    // an alert that cannot be shown must not take the server down with it.
    child.on("error", () => {});
    child.unref();
  } catch {
    // Same reason: this channel is best effort by design.
  }
}

function desktopCommand(text: string): { file: string; args: string[] } | null {
  if (process.platform === "linux") {
    return { file: "notify-send", args: ["--app-name=squad", "squad", text] };
  }
  if (process.platform === "darwin") {
    return {
      file: "osascript",
      args: ["-e", `display notification ${quoted(text)} with title "squad"`],
    };
  }
  return null;
}

/** An AppleScript string literal: the two characters that end one, escaped. */
function quoted(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
