import { spawn } from "node:child_process";
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
}

export const alertTexts = {
  testSheetWaiting: (ticketTitle: string): Alert => ({
    text: `squad : la fiche de tests de « ${ticketTitle} » attend une vérification.`,
  }),
  subSessionStopped: (ticketTitle: string): Alert => ({
    text: `squad : la sous-session de « ${ticketTitle} » s'est arrêtée sans finir.`,
  }),
  subSessionSilent: (ticketTitle: string): Alert => ({
    text: `squad : la sous-session de « ${ticketTitle} » s'est terminée sans rapporter sa fin d'étape.`,
  }),
  subSessionNotTakenBack: (ticketTitle: string): Alert => ({
    text: `squad : la sous-session de « ${ticketTitle} » n'a pas pu être reprise.`,
  }),
};

export class Alerts {
  constructor(private readonly store: Store) {}

  /**
   * Raises an alert on every channel the settings leave open. Returns nothing to
   * await on purpose: the caller has already done its work, and how long a
   * webhook takes to answer is none of its business.
   */
  raise(alert: Alert): void {
    const { webhookUrl, desktopNotifications } = this.store.settings();
    if (desktopNotifications) notifyDesktop(alert.text);
    if (webhookUrl !== null) void postToWebhook(webhookUrl, alert.text);
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
