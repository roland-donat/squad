import { useState } from "react";
import type { LaunchAngle, ThreadEntry, Ticket, TicketKind, TicketState } from "../../shared/api";
import { isResumable } from "../../shared/graph";
import { ApiError, launchTicket } from "../api";
import { Thread } from "../session/Thread";
import { TestSheet } from "./TestSheet";

/**
 * What a node opens: the whole of what the ticket asks for, the thread of its
 * sub-session, and the one action its state allows. Nothing here edits the
 * graph, which is written from the main session and nowhere else.
 */

const kindLabels: Record<TicketKind, string> = {
  build: "construction",
  decision: "décision",
  fix: "correction",
};

/** Why a ticket is where it is, said in full since there is room for it here. */
const stateExplanations: Record<TicketState, string> = {
  blocked: "Bloqué : il partira quand tous ses bloqueurs auront fusionné.",
  ready: "Prêt : tous ses bloqueurs ont fusionné, il peut partir maintenant.",
  queued:
    "En attente d'une place : le lancement est demandé, et la sous-session s'ouvrira dès qu'un plafond de concurrence le permettra.",
  running: "En cours : sa sous-session travaille dans son worktree.",
  "awaiting-validation":
    "Étape rapportée : la fiche de tests ci-dessous attend d'être passée en revue. La sous-session n'est pas détruite, elle reste le fil où la correction se fera.",
  failed:
    "Arrêté : sa sous-session a échoué, ou s'est terminée sans rapporter sa fin d'étape ; le fil dit lequel. Son worktree, sa branche et sa sous-session sont conservés.",
  interrupted: "Interrompu : squad s'est arrêté pendant que sa sous-session travaillait.",
  "awaiting-decision": "À trancher : cela se fait dans la session principale, pas ici.",
  merged: "Fusionné.",
};

export function TicketPanel({
  ticket,
  thread,
  onClose,
}: {
  ticket: Ticket;
  thread: ThreadEntry[];
  onClose: () => void;
}) {
  return (
    <>
      <p className="panel__context">
        <strong>{ticket.title}</strong>
        <span className="badge">{kindLabels[ticket.kind]}</span>
        <button type="button" className="link" onClick={onClose}>
          fermer
        </button>
      </p>
      <p className="ticket__state">{stateExplanations[ticket.state]}</p>

      {ticket.description !== "" && <p className="ticket__description">{ticket.description}</p>}

      {ticket.acceptanceCriteria.length > 0 && (
        <>
          <h3 className="ticket__heading">Critères d'acceptation</h3>
          <ul className="ticket__criteria">
            {ticket.acceptanceCriteria.map((criterion) => (
              <li key={criterion.id}>{criterion.text}</li>
            ))}
          </ul>
        </>
      )}

      {ticket.conclusion !== null && (
        <>
          <h3 className="ticket__heading">Conclusion</h3>
          <p className="ticket__description">{ticket.conclusion}</p>
        </>
      )}

      {ticket.stepReport !== null && (
        <TestSheet ticketId={ticket.id} report={ticket.stepReport} />
      )}

      {ticket.worktree !== null && (
        <p className="ticket__worktree">
          <span className="row__detail">{ticket.worktree.branch}</span>
          <span className="row__detail">{ticket.worktree.path}</span>
        </p>
      )}

      <Launcher ticket={ticket} />

      <h3 className="ticket__heading">Sous-session</h3>
      <Thread
        entries={thread}
        empty={
          ticket.kind === "decision"
            ? "Un ticket de décision n'ouvre pas de sous-session : il se tranche dans la session principale."
            : "Aucune sous-session pour l'instant."
        }
      />
    </>
  );
}

/**
 * The actions a state allows, and no others. A failed or interrupted ticket is
 * the only place the angle is offered: resuming and stepping back to diagnose
 * are two different jobs for a session that already knows the ground.
 */
function Launcher({ ticket }: { ticket: Ticket }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function launch(angle: LaunchAngle) {
    setBusy(true);
    setError(null);
    try {
      await launchTicket(ticket.id, angle);
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "Le serveur est injoignable.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ticket__actions">
      {ticket.state === "ready" && (
        <button type="button" disabled={busy} onClick={() => void launch("implement")}>
          Lancer le ticket
        </button>
      )}
      {isResumable(ticket.state) && (
        <>
          <button type="button" disabled={busy} onClick={() => void launch("implement")}>
            Reprendre l'implémentation
          </button>
          <button
            type="button"
            className="button--secondary"
            disabled={busy}
            onClick={() => void launch("diagnose")}
          >
            Basculer en diagnostic
          </button>
        </>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
