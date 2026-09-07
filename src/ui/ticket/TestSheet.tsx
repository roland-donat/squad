import { useState, type FormEvent } from "react";
import type { StepReport, TestSheetPoint } from "../../shared/api";
import { ApiError, reviewTestSheet } from "../api";

/**
 * The test sheet of a reported step: what the agent built, what it says an
 * automatic test covers, and what is left for a human to look at. A point is
 * checked when it works; leaving it unchecked with a comment is how the
 * developer says what is wrong, and that comment is what goes back to the
 * sub-session.
 *
 * A sheet is gone through once. Afterwards it is read back rather than edited:
 * what was said is the record the correction is based on.
 */
export function TestSheet({ ticketId, report }: { ticketId: string; report: StepReport }) {
  return (
    <>
      <h3 className="ticket__heading">Fin d'étape</h3>
      <p className="ticket__description">{report.summary}</p>
      <p className="sheet__recommendation">
        <span className="chip">recommandation</span> {report.recommendation}
      </p>

      {report.coverage.some((entry) => entry.covered) && (
        <>
          <h3 className="ticket__heading">Couverts par un test automatique</h3>
          <ul className="ticket__criteria">
            {report.coverage
              .filter((entry) => entry.covered)
              .map((entry) => (
                <li key={entry.criterionId}>{entry.text}</li>
              ))}
          </ul>
        </>
      )}

      <h3 className="ticket__heading">Fiche de tests</h3>
      {report.sheet.length === 0 ? (
        <p className="empty">
          Rien à vérifier à la main : tous les critères sont couverts par des tests automatiques et
          l'agent n'a rien suggéré de plus.
        </p>
      ) : report.reviewedAt === null ? (
        <SheetForm ticketId={ticketId} points={report.sheet} />
      ) : (
        <ReviewedSheet report={report} />
      )}
    </>
  );
}

/** What the developer fills in, one point at a time, then hands back in one go. */
function SheetForm({ ticketId, points }: { ticketId: string; points: TestSheetPoint[] }) {
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [comments, setComments] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await reviewTestSheet(ticketId, {
        points: points.map((point) => ({
          id: point.id,
          passed: checked[point.id] === true,
          comment: comments[point.id] ?? "",
        })),
        feedback,
      });
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "Le serveur est injoignable.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form sheet" onSubmit={submit}>
      <ul className="list sheet__points">
        {points.map((point) => (
          <li key={point.id} className="sheet__point">
            <label className="sheet__check">
              <input
                type="checkbox"
                checked={checked[point.id] === true}
                onChange={(event) =>
                  setChecked((current) => ({ ...current, [point.id]: event.target.checked }))
                }
              />
              <span className="sheet__text">{point.text}</span>
              <span className="chip">{originLabel(point)}</span>
            </label>
            <label className="field">
              <span>Commentaire</span>
              <input
                value={comments[point.id] ?? ""}
                onChange={(event) =>
                  setComments((current) => ({ ...current, [point.id]: event.target.value }))
                }
                placeholder="ce qui ne va pas, si quelque chose ne va pas"
              />
            </label>
          </li>
        ))}
      </ul>
      <label className="field">
        <span>Retour général</span>
        <textarea
          value={feedback}
          onChange={(event) => setFeedback(event.target.value)}
          rows={3}
          placeholder="ce qui vaut pour la fiche entière"
        />
      </label>
      <button type="submit" disabled={busy}>
        Rendre la fiche
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

/** The sheet once it has been gone through, read-only and dated. */
function ReviewedSheet({ report }: { report: StepReport }) {
  return (
    <>
      <ul className="list sheet__points">
        {report.sheet.map((point) => (
          <li key={point.id} className="sheet__point" data-verdict={point.verdict}>
            <p className="sheet__verdict">
              <span className="chip chip--verdict">
                {point.verdict === "passed" ? "vérifié" : "en échec"}
              </span>
              <span className="sheet__text">{point.text}</span>
            </p>
            {point.comment !== null && <p className="sheet__comment">{point.comment}</p>}
          </li>
        ))}
      </ul>
      {report.feedback !== null && <p className="sheet__comment">{report.feedback}</p>}
      <p className="empty">
        Fiche rendue le {new Date(report.reviewedAt ?? "").toLocaleString("fr-FR")}.
      </p>
    </>
  );
}

/** Where a point comes from, which the developer reads and never has to guess. */
function originLabel(point: TestSheetPoint): string {
  return point.criterionId === null ? "suggestion" : "critère";
}
