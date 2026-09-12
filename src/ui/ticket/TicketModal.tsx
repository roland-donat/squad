import { useEffect, useState } from "react";
import type { Feature, Question, ThreadEntry, Ticket, TicketKind, TicketState, TicketSummary } from "../../shared/api";
import { Dialog } from "../Dialog";
import { Markdown, MarkdownText } from "../markdown/Markdown";
import { Questions } from "../question/Questions";
import { TestSheetEvidence, TestSheetForm, sheetAwaitsDeveloper } from "./TestSheet";
import { TicketConversation } from "./TicketConversation";

/**
 * Treating a ticket, in a surface of its own.
 *
 * Three areas, and the split between them answers one question: what is being
 * asked of me, and what is this about. **What is read** is on the left, on two
 * tabs: **Résumé** carries the state, the context and the problem, plus the
 * evidence of a reported step, folded; **Détail** carries what one reads when
 * the summary was not enough. **What is acted on** is the column on the right,
 * and nothing else is in it: the question waiting for an answer, or the points
 * of a test sheet waiting for a verdict. The **conversation** with the
 * sub-session runs as a band under both, because reading and replying to the
 * session that wrote it is one movement (ADR 0010).
 *
 * The action used to live at the bottom of the Résumé tab, after everything
 * already settled. Measured on the instance that opened this: taking one
 * arbitration meant scrolling past 11 000 characters of prose nobody had to
 * judge. A column of its own is what makes the sheet fit on a screen, and the
 * action no longer belongs to a tab: it stays in view while the detail is
 * consulted, which is the movement it was hiding.
 *
 * A modal and no longer a drawer: a drawer supposes that looking at a ticket is
 * a glance taken while reading the map, and treating one is not a glance. What
 * remains a glance is the map itself, which already says where the work stands.
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
    "Étape rapportée : la fiche de tests ci-dessous attend d'être passée en revue. La sous-session n'est pas détruite, elle reste le fil où la correction se fera, et la colonne de droite lui parle.",
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
  // Said by the kind and not by the state alone: only a `decision` ticket is
  // settled in the main session. A build or a fix reads as awaiting a decision
  // when the only points left on its sheet are arbitrations, and those are
  // taken right here. Saying otherwise contradicted, side by side, the
  // conversation column pointing back at this tab.
  "awaiting-decision": "",
  discarded:
    "Écarté : ce ticket ne sera pas construit, et la raison est écrite sur son fil. Il ne retient plus rien : ce qu'il bloquait est reparti.",
  merged: "Fusionné.",
};

/** Why a ticket is where it is, and for `awaiting-decision`, by whose account. */
function explain(ticket: Ticket): string {
  if (ticket.state !== "awaiting-decision") return stateExplanations[ticket.state];
  return ticket.kind === "decision"
    ? "À trancher : cela se fait dans la session principale, pas ici."
    : "À trancher : il ne reste que des arbitrages sur sa fiche de tests, ci-dessous.";
}

type Tab = "summary" | "detail";

export function TicketModal({
  ticket,
  feature,
  thread,
  questions,
  repository,
  onClose,
  onOpenMainSession,
}: {
  ticket: Ticket;
  feature: Feature;
  thread: ThreadEntry[];
  questions: Question[];
  /** The repository this ticket is built in, or null on a feature carrying one. */
  repository: string | null;
  onClose: () => void;
  onOpenMainSession: () => void;
}) {
  // Not in the address, deliberately: everything that is answered lives on the
  // summary tab, so no alert would have a reason to point at the other one, and
  // a query parameter nobody writes is a parameter nobody needs (ADR 0010).
  // A ticket with no summary opens on the detail, since there is nothing else.
  const [tab, setTab] = useState<Tab>(ticket.summary === null ? "detail" : "summary");
  useEffect(() => {
    setTab(ticket.summary === null ? "detail" : "summary");
  }, [ticket.id, ticket.summary === null]);
  // Whether the action column has anything to hold. Open on nothing, it would
  // take a third of the modal to say there is nothing to do.
  const waiting =
    questions.some((question) => question.state === "pending") ||
    (ticket.stepReport !== null && sheetAwaitsDeveloper(ticket.stepReport));

  return (
    <Dialog
      title={ticket.title}
      variant="full"
      open
      onClose={onClose}
      heading={
        <>
          {ticket.title}
          <span className="badge">{kindLabels[ticket.kind]}</span>
          {repository !== null && <span className="badge">{repository}</span>}
        </>
      }
      headerExtra={
        <div className="tabs" role="tablist" aria-label="Ce que le ticket dit">
          <Tab id="summary" current={tab} onPick={setTab} label="Résumé" />
          <Tab id="detail" current={tab} onPick={setTab} label="Détail" />
        </div>
      }
    >
      <div className={waiting ? "ticket-modal ticket-modal--acting" : "ticket-modal"}>
        <section className="ticket-modal__reading" role="tabpanel" aria-label={tab === "summary" ? "Résumé" : "Détail"}>
          {tab === "summary" ? (
            <SummaryTab ticket={ticket} feature={feature} />
          ) : (
            <DetailTab ticket={ticket} questions={questions} />
          )}
        </section>
        {waiting && (
          <section className="ticket-modal__action" aria-label="Ce qu'on vous demande">
            <Questions questions={questions} only="waiting" />
            {ticket.stepReport !== null && (
              <TestSheetForm ticketId={ticket.id} report={ticket.stepReport} />
            )}
          </section>
        )}
        {/* Keyed by ticket: walking back through history between two ticket
            addresses changes the ticket without remounting, and a band that
            survived it would carry the previous draft into the new box. */}
        <TicketConversation
          key={ticket.id}
          ticket={ticket}
          thread={thread}
          onOpenMainSession={onOpenMainSession}
        />
      </div>
    </Dialog>
  );
}

function Tab({
  id,
  current,
  onPick,
  label,
}: {
  id: Tab;
  current: Tab;
  onPick: (tab: Tab) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={current === id}
      className={current === id ? "tabs__tab tabs__tab--on" : "tabs__tab"}
      onClick={() => onPick(id)}
    >
      {label}
    </button>
  );
}

/**
 * What this is about: the state in one line, the feature's decor folded, the
 * summary, and the evidence of a reported step. What is asked of the developer
 * is not here any more but in the column beside it, which is what lets this one
 * be read at leisure and that one be acted on without scrolling.
 */
function SummaryTab({ ticket, feature }: { ticket: Ticket; feature: Feature }) {
  return (
    <>
      <p className="ticket__state">{explain(ticket)}</p>
      <RunningExample text={feature.runningExample} />
      <Summary summary={ticket.summary} />
      {ticket.conclusion !== null && (
        <>
          <h3 className="ticket__heading">Conclusion</h3>
          <Markdown text={ticket.conclusion} subset="full" className="ticket__description" />
        </>
      )}
      {ticket.stepReport !== null && <TestSheetEvidence report={ticket.stepReport} />}
    </>
  );
}

/**
 * The decor of the whole feature, folded away.
 *
 * It is what makes a ticket's own illustration readable, so it has to be within
 * reach of that illustration. It is also learnt once per chantier: unfolded on
 * the twelfth ticket it is noise, which is why it arrives closed (ADR 0009).
 */
function RunningExample({ text }: { text: string | null }) {
  if (text === null) return null;
  return (
    <details className="decor">
      <summary>L'exemple de la feature</summary>
      <Markdown text={text} subset="inline" className="decor__body" />
    </details>
  );
}

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
      <Markdown text={summary.problem} subset="inline" className="ticket__problem" />
      <Markdown text={summary.context} subset="inline" className="ticket__context" />
      {summary.example !== null && (
        <Markdown text={summary.example} subset="inline" className="ticket__example" />
      )}
    </div>
  );
}

/** What one reads when the summary was not enough. */
function DetailTab({ ticket, questions }: { ticket: Ticket; questions: Question[] }) {
  return (
    <>
      {ticket.description !== "" ? (
        <Markdown text={ticket.description} subset="full" className="ticket__description" />
      ) : (
        <p className="empty">Aucune description n'a été écrite sur ce ticket.</p>
      )}

      {ticket.acceptanceCriteria.length > 0 && (
        <>
          <h3 className="ticket__heading">Critères d'acceptation</h3>
          <ul className="ticket__criteria">
            {ticket.acceptanceCriteria.map((criterion) => (
              <li key={criterion.id}>
                <MarkdownText text={criterion.text} />
              </li>
            ))}
          </ul>
        </>
      )}

      <Questions questions={questions} only="settled" />

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
    </>
  );
}
