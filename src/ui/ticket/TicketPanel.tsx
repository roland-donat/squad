import { useState } from "react";
import type {
  LaunchAngle,
  Question,
  ThreadEntry,
  Ticket,
  TicketKind,
  TicketState,
  TicketSummary,
} from "../../shared/api";
import { isResumable } from "../../shared/graph";
import { ApiError, launchTicket } from "../api";
import { Questions } from "../question/Questions";
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
  settling:
    "Squad vérifie : avant de vous montrer la fiche, il lance lui-même tout ce qu'une commande, un test ou un navigateur peut trancher. Ce qui reste après est ce dont vous serez averti.",
  "settling-queued":
    "Vérification en attente : elle est demandée, et s'ouvrira dès qu'un plafond de concurrence le permettra. La fiche vous sera montrée après, pas avant.",
  merging:
    "En fusion : sa sous-session est fermée, sa branche revient dans la branche de feature, puis la vérification d'intégration tourne dessus.",
  failed:
    "Arrêté : sa sous-session a échoué, s'est terminée sans rapporter sa fin d'étape, ou sa branche n'a pas pu être fusionnée ; le fil dit lequel. Son worktree, sa branche et sa sous-session sont conservés.",
  interrupted: "Interrompu : squad s'est arrêté pendant que sa sous-session travaillait.",
  conflict:
    "En conflit : la fusion de sa branche dans la branche de feature s'est heurtée aux mêmes lignes, et la session de résolution n'en est pas venue à bout. Le reprendre rouvre sa sous-session là où elle en était.",
  "awaiting-decision": "À trancher : cela se fait dans la session principale, pas ici.",
  discarded:
    "Écarté : ce ticket ne sera pas construit, et la raison est écrite sur son fil. Il ne retient plus rien : ce qu'il bloquait est reparti.",
  merged: "Fusionné.",
};

export function TicketPanel({
  ticket,
  thread,
  questions,
  repository,
  onClose,
}: {
  ticket: Ticket;
  thread: ThreadEntry[];
  questions: Question[];
  /** The repository this ticket is built in, or null on a feature carrying one. */
  repository: string | null;
  onClose: () => void;
}) {
  return (
    <>
      <p className="panel__context">
        <strong>{ticket.title}</strong>
        <span className="badge">{kindLabels[ticket.kind]}</span>
        {repository !== null && <span className="badge">{repository}</span>}
        <button type="button" className="link" onClick={onClose}>
          fermer
        </button>
      </p>
      <p className="ticket__state">{stateExplanations[ticket.state]}</p>

      {/* Before anything else: an unanswered question is a sub-session standing
          still, where everything below is work already done. */}
      <Questions questions={questions} />

      <Summary summary={ticket.summary} />

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

      {ticket.generation > 0 && (
        <p className="ticket__state">
          Ticket engendré : il est né du travail d'un autre, à {ticket.generation} génération
          {ticket.generation > 1 ? "s" : ""} de ce que la session principale a écrit.
        </p>
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
 * What the ticket says to the developer, before what it says to the session
 * that builds it. Three short blocks, in the order they are read: where we
 * stand, what is wrong, and what that looks like on this feature's own example.
 *
 * An absent summary is said and not hidden. The tickets written before summaries
 * existed carry none, and painting nothing there would read as a ticket with
 * nothing to say rather than as one whose summary was never written; the
 * difference decides whether it is worth asking for one.
 */
function Summary({ summary }: { summary: TicketSummary | null }) {
  if (summary === null) {
    return (
      <p className="ticket__state">
        Pas de résumé : ce ticket a été écrit avant qu'ils existent. Le demander à la session
        principale en écrit un, sans toucher à ce qui se construit.
      </p>
    );
  }
  return (
    <div className="ticket__summary">
      <p className="ticket__problem">{summary.problem}</p>
      <p className="ticket__context">{summary.context}</p>
      {summary.example !== null && <p className="ticket__example">{summary.example}</p>}
    </div>
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
