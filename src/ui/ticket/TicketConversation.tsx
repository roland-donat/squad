import { useEffect, useState } from "react";
import type { LaunchAngle, ThreadEntry, Ticket } from "../../shared/api";
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
 * `write` is the states where a sub-session is actually there to hear it, and
 * that is narrower than it looks. **A sub-session normally ends when it reports
 * its step**: squad writes "the sub-session ended after reporting its step" on
 * the thread, and the correction path opens a fresh launch rather than talking
 * to a session it expects to find. So `awaiting-validation` is not a state one
 * writes into, it is the state where the test sheet is the way back: what the
 * developer leaves unchecked is what returns to the session, and the column
 * says so rather than offering a box whose every press would be refused.
 *
 * Getting this wrong offered "Envoyer" on a ticket awaiting a verdict, and the
 * refusal pointed at launching or resuming, neither of which that state allows.
 */
type Mode = "write" | "resume" | "launch" | "closed";

function conversationMode(ticket: Ticket): Mode {
  if (ticket.kind === "decision") return "closed";
  if (isResumable(ticket.state)) return "resume";
  if (ticket.state === "ready") return "launch";
  return ticket.state === "running" ? "write" : "closed";
}

/**
 * Why there is nothing to write, and where the answer is instead. Never a bare
 * "nothing to do here": every one of these states has somewhere the developer
 * acts, and naming it is the whole use of saying anything at all.
 */
function closedBecause(ticket: Ticket): string {
  // A decision ticket is settled in the feature's thread, and that is the
  // glossary's rule, not this screen's.
  if (ticket.kind === "decision") return "Ce ticket se tranche dans la session principale.";
  switch (ticket.state) {
    case "blocked":
      return "Rien à dire encore : ce ticket part quand ses bloqueurs auront fusionné.";
    case "queued":
      return "Le lancement est demandé : la sous-session s'ouvrira dès qu'une place se libère.";
    case "awaiting-validation":
      return "L'étape est rapportée et la sous-session s'est arrêtée. C'est la fiche de tests, dans l'onglet Résumé, qui repart vers elle : ce que vous y laissez décoché est ce qu'elle corrigera.";
    // A build or a fix ticket reads as awaiting a decision when the only points
    // left on its sheet are arbitrations. They are taken on that sheet, a few
    // centimètres d'ici, and not in another session.
    case "awaiting-decision":
      return "Il ne reste que des arbitrages sur sa fiche de tests : ils se prennent dans l'onglet Résumé.";
    case "settling":
    case "settling-queued":
      return "Squad vérifie sa fiche lui-même : ce qui restera vous sera montré après, dans l'onglet Résumé.";
    case "merging":
      return "Sa branche revient dans la branche de feature : sa sous-session est déjà fermée.";
    case "merged":
      return "Ce ticket est fusionné. Son fil se relit, il ne se reprend plus.";
    case "discarded":
      return "Ce ticket est écarté. Son fil se relit, il ne se reprend plus.";
    default:
      return "";
  }
}

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
        {closedBecause(ticket)}
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
