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
 * What the column may do on a ticket, read from the ticket rather than guessed
 * at each button.
 *
 * `write` is every state where a sub-session is there to hear it, and that
 * includes a step already reported. **A sub-session does not end when it
 * reports**: the launcher runs the SDK in streaming input mode, where a result
 * closes a turn and not the session, and the only thing that ever closes one is
 * the merge. That is why a correction is handed straight to the session that
 * built the ticket. Narrowing this to `running` took away the box the developer
 * uses to ask "pourquoi as-tu changé X ?" before ticking the sheet.
 *
 * A session may still have died on its own, and then the server refuses and
 * says so. That is the right place for it to be decided: the server knows which
 * sessions it holds, and this screen does not.
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

/**
 * Why there is nothing to write, and where the answer is instead. Never a bare
 * "nothing to do here": every one of these states has somewhere the developer
 * acts, and naming it is the whole use of saying anything at all.
 *
 * An exhaustive record rather than a switch with a fallback: a twelfth ticket
 * state would otherwise typecheck and paint an empty box, with no explanation,
 * no way to act, and nothing red anywhere.
 */
const closedBecause: Record<TicketState, string> = {
  blocked: "Rien à dire encore : ce ticket part quand ses bloqueurs auront fusionné.",
  queued: "Le lancement est demandé : la sous-session s'ouvrira dès qu'une place se libère.",
  merging: "Sa branche revient dans la branche de feature : sa sous-session est déjà fermée.",
  // A build or a fix ticket reads as awaiting a decision when the only points
  // left on its sheet are arbitrations. They are taken on that sheet, in the
  // other tab of this very modal, and not in another session.
  "awaiting-decision":
    "Il ne reste que des arbitrages sur sa fiche de tests : ils se prennent dans l'onglet Résumé.",
  merged: "Ce ticket est fusionné. Son fil se relit, il ne se reprend plus.",
  discarded: "Ce ticket est écarté. Son fil se relit, il ne se reprend plus.",
  // Every state below offers a box instead, so none of these is ever read.
  ready: "",
  running: "",
  "awaiting-validation": "",
  settling: "",
  "settling-queued": "",
  failed: "",
  interrupted: "",
  conflict: "",
};

/** What a decision ticket says instead, whatever state it is read in. */
const decisionIsSettledElsewhere = "Ce ticket se tranche dans la session principale.";

/**
 * What a draft is worth keeping in: the browser, per ticket, and squad never
 * reads it. Escape closes the modal whatever is typed, which is the one thing
 * Escape should always do, and this is what makes that harmless (ADR 0010).
 * A commodity like the panel widths, not a setting.
 */
function useDraft(ticketId: string): [string, (text: string) => void] {
  const key = `squad.ticket-draft.${ticketId}`;
  // Read once, because this hook is remounted when the ticket changes: the
  // column is keyed by ticket id. Resynchronising in an effect instead painted
  // one frame of the previous ticket's draft under the new ticket's title,
  // which is what walking back through history did.
  const [text, setText] = useState(() => window.localStorage.getItem(key) ?? "");
  return [
    text,
    (next: string) => {
      setText(next);
      if (next === "") window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, next);
    },
  ];
}

/**
 * Forgets the draft of a ticket that will never send it.
 *
 * A draft is written on every keystroke and cleared when it goes out. On a
 * ticket that merges or is discarded it goes nowhere, there is no box left to
 * empty, and nothing would ever remove it. Cleared here rather than swept from
 * elsewhere: this is the one place that knows both the ticket and its state,
 * and a sweep over the whole store cannot tell a live draft from a dead one.
 */
function useForgetDraftWhenDone(ticket: Ticket): void {
  const done = ticket.state === "merged" || ticket.state === "discarded";
  useEffect(() => {
    if (done) window.localStorage.removeItem(`squad.ticket-draft.${ticket.id}`);
  }, [done, ticket.id]);
}

function Composer({
  ticket,
  onOpenMainSession,
}: {
  ticket: Ticket;
  onOpenMainSession: () => void;
}) {
  const [text, setText] = useDraft(ticket.id);
  useForgetDraftWhenDone(ticket);
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
  // One flight for the two of them: they ask for the same launch under two
  // angles, so a second press before the first returns is refused by the server
  // for a reason the developer never caused.
  const busy = sent.busy || diagnosed.busy;

  if (mode === "closed") {
    return (
      <p className="talk__closed">
        {ticket.kind === "decision" ? decisionIsSettledElsewhere : closedBecause[ticket.state]}
        {/* Only a decision ticket is answered somewhere else entirely, so only
            it gets a way there. Everything else is answered in this modal, on
            the other side of it, and a link would send the reader away from the
            screen that holds their own answer. */}
        {ticket.kind === "decision" && (
          <>
            {" "}
            <button type="button" className="link" onClick={onOpenMainSession}>
              l'ouvrir
            </button>
          </>
        )}
      </p>
    );
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
        <button type="submit" disabled={busy || (running && text.trim() === "")}>
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
            disabled={busy}
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
