import type { PendingAction, PendingReason } from "../../shared/pending";

/** What each reason means for the developer, said as the thing they have to do. */
export const reasonLabels: Record<PendingReason, string> = {
  question: "question d'un agent",
  validation: "fiche de tests à vérifier",
  decision: "décision à trancher",
  failure: "sous-session arrêtée",
  interruption: "sous-session interrompue",
  conflict: "conflit de fusion à démêler",
};

/**
 * What waits on the developer in this feature. It holds nothing of its own:
 * what is listed follows from the graph, so an entry leaves the moment the
 * thing it points at stops waiting.
 *
 * This feature and no other. What waits everywhere at once is read on the home
 * screen, which is the screen one opens to decide where to go; a tab devoted to
 * one piece of work that listed the blockages of three others would be the
 * catch-all these screens exist to replace.
 */
export function WaitingPanel({
  actions,
  openedTicketId,
  onOpen,
}: {
  actions: PendingAction[];
  /** What is already open, so the list says where one already is. */
  openedTicketId: string | null;
  onOpen: (action: PendingAction) => void;
}) {
  return (
    <section className="panel panel--waiting" aria-labelledby="titre-attente">
      <h2 id="titre-attente">
        Actions en attente
        {actions.length > 0 && <span className="count">{actions.length}</span>}
      </h2>
      {actions.length === 0 ? (
        <p className="empty">Rien n'attend d'action de ma part sur cette feature.</p>
      ) : (
        <ul className="list">
          {actions.map((action) => (
            <li key={`${action.reason}:${action.ticketId ?? action.featureId}:${action.title}`}>
              <button
                type="button"
                className={
                  action.ticketId !== null && action.ticketId === openedTicketId
                    ? "row row--selected"
                    : "row"
                }
                onClick={() => onOpen(action)}
              >
                <span className="row__title">{action.title}</span>
                <span className="row__meta">{reasonLabels[action.reason]}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
