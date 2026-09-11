import { useEffect, useState } from "react";
import type { LaunchAngle, ThreadEntry, Ticket, TicketState } from "../../shared/api";
import { isResumable } from "../../shared/graph";
import { launchTicket, sendTicketMessage } from "../api";
import { Thread } from "../session/Thread";
import { Failure, useSubmission } from "../submission";

/**
 * The conversation with the ticket's own sub-session, alongside whichever tab is
 * open. It is the session that knows this ticket's worktree and its code; the
 * feature's main session is talked to in the bar behind the modal, and keeping
 * the two apart is what spares having to ask who one is addressing (ADR 0010).
 *
 * What the column offers follows the ticket, and **the button always names what
 * pressing it will do**. That is not a nicety: writing into a ticket that has
 * never run must not open a sub-session, which takes a place under the
 * concurrency cap and starts work on the machine. A gesture that costs those
 * says so on its own label.
 */
export function TicketConversation({
  ticket,
  thread,
  onOpenMainSession,
}: {
  ticket: Ticket;
  thread: ThreadEntry[];
  /** Where a decision is settled, since it is never settled here. */
  onOpenMainSession: () => void;
}) {
  return (
    <aside className="talk" aria-label="Sous-session du ticket">
      <h3 className="talk__title">
        Sous-session
        {ticket.state === "running" && <span className="badge badge--live">en cours</span>}
      </h3>
      <Thread entries={thread} empty={<Empty ticket={ticket} />} />
      <Composer ticket={ticket} onOpenMainSession={onOpenMainSession} />
    </aside>
  );
}

function Empty({ ticket }: { ticket: Ticket }) {
  if (ticket.kind === "decision") {
    return <>Un ticket de décision n'ouvre pas de sous-session : il se tranche dans la session principale.</>;
  }
  return <>Aucune sous-session pour l'instant.</>;
}

/**
 * What the column may do on a ticket, and it is read from the ticket rather
 * than guessed at each button.
 *
 * `write` is every state where the sub-session is still there to hear it, and
 * that includes a step already reported: the glossary is explicit that
 * reporting does not destroy the session, since it is the thread the correction
 * will be made on. Getting this wrong told the developer a ticket awaiting
 * their verdict was finished, on the very screen where they were about to give
 * it.
 */
type Mode = "write" | "resume" | "launch" | "closed";

function conversationMode(ticket: Ticket): Mode {
  if (ticket.kind === "decision") return "closed";
  if (isResumable(ticket.state)) return "resume";
  if (ticket.state === "ready") return "launch";
  switch (ticket.state) {
    case "running":
    case "awaiting-validation":
    case "settling":
    case "settling-queued":
      return "write";
    default:
      return "closed";
  }
}

/** Why there is nothing to write, said in the terms of the state that says so. */
const closedBecause: Record<TicketState, string> = {
  blocked: "Rien à dire encore : ce ticket part quand ses bloqueurs auront fusionné.",
  queued: "Le lancement est demandé : la sous-session s'ouvrira dès qu'une place se libère.",
  merging: "Sa branche revient dans la branche de feature : sa sous-session est déjà fermée.",
  "awaiting-decision": "Ce ticket se tranche dans la session principale.",
  merged: "Ce ticket est fusionné. Son fil se relit, il ne se reprend plus.",
  discarded: "Ce ticket est écarté. Son fil se relit, il ne se reprend plus.",
  // Reached only if a state stops being one of the above: the column says
  // nothing rather than claiming something false about the session.
  ready: "",
  running: "",
  "awaiting-validation": "",
  settling: "",
  "settling-queued": "",
  failed: "",
  interrupted: "",
  conflict: "",
};

/**
 * What a draft is worth keeping in: the browser, per ticket, and squad never
 * reads it. Escape closes the modal whatever is typed, which is the one thing
 * Escape should always do, and this is what makes that harmless (ADR 0010).
 * A commodity like the panel widths, not a setting.
 */
function useDraft(ticketId: string): [string, (text: string) => void] {
  const key = `squad.ticket-draft.${ticketId}`;
  const [text, setText] = useState(() => window.localStorage.getItem(key) ?? "");
  useEffect(() => {
    setText(window.localStorage.getItem(key) ?? "");
  }, [key]);
  return [
    text,
    (next: string) => {
      setText(next);
      if (next === "") window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, next);
    },
  ];
}

function Composer({
  ticket,
  onOpenMainSession,
}: {
  ticket: Ticket;
  onOpenMainSession: () => void;
}) {
  const [text, setText] = useDraft(ticket.id);
  const mode = conversationMode(ticket);
  const running = mode === "write";
  const resumable = mode === "resume";

  const act = async (angle: LaunchAngle) => {
    if (running) await sendTicketMessage(ticket.id, { text });
    else await launchTicket(ticket.id, angle, text.trim() === "" ? undefined : text);
    setText("");
  };
  const sent = useSubmission(() => act("implement"));
  const diagnosed = useSubmission(() => act("diagnose"));

  // Settled where the glossary says it is settled, and the column says so
  // rather than offering a box that would write into nothing.
  if (ticket.kind === "decision") {
    return (
      <p className="talk__closed">
        Ce ticket se tranche dans la session principale.{" "}
        <button type="button" className="link" onClick={onOpenMainSession}>
          l'ouvrir
        </button>
      </p>
    );
  }

  if (mode === "closed") {
    return <p className="talk__closed">{closedBecause[ticket.state]}</p>;
  }

  return (
    <form className="form composer" onSubmit={sent.submit}>
      <label className="field">
        <span>
          {running
            ? "Message à la sous-session"
            : resumable
              ? "Ce qu'elle doit savoir en reprenant"
              : "Ce qu'elle doit savoir en partant"}
        </span>
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={3}
          placeholder={
            running
              ? "ce qu'il faut ajuster"
              : "facultatif : ce que vous avez constaté, ou ce par quoi commencer"
          }
        />
      </label>
      <div className="talk__actions">
        <button type="submit" disabled={sent.busy || (running && text.trim() === "")}>
          {running
            ? "Envoyer"
            : resumable
              ? text.trim() === ""
                ? "Reprendre l'implémentation"
                : "Reprendre avec ce message"
              : text.trim() === ""
                ? "Lancer le ticket"
                : "Lancer avec ce message"}
        </button>
        {resumable && (
          <button
            type="button"
            className="button--secondary"
            disabled={diagnosed.busy}
            onClick={() => void diagnosed.run()}
          >
            Basculer en diagnostic
          </button>
        )}
      </div>
      <Failure message={sent.error} />
      <Failure message={diagnosed.error} />
    </form>
  );
}
