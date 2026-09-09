import { useState, type FormEvent } from "react";
import type {
  CriterionCoverage,
  SettlementOutcome,
  StepReport,
  TestSheetPoint,
} from "../../shared/api";
import { ApiError, reviewTestSheet, settleTestSheet } from "../api";

/**
 * The test sheet of a reported step: what the agent built, what a test covers,
 * what the agent settled itself and how, and what is left for a person to
 * judge. A point is checked when it works; leaving it unchecked with a comment
 * is how the developer says what is wrong, and that comment is what goes back
 * to the sub-session.
 *
 * A sheet is gone through once. Afterwards it is read back rather than edited:
 * what was said is the record the correction is based on.
 */
export function TestSheet({ ticketId, report }: { ticketId: string; report: StepReport }) {
  // What is asked of the developer is what is still pending: squad's settling
  // pass answers the rest before they are woken, and a point it answered is
  // read with its evidence rather than asked about again.
  const waiting = report.sheet.filter((point) => point.verdict === "pending");
  return (
    <>
      <h3 className="ticket__heading">Fin d'étape</h3>
      <p className="ticket__description">{report.summary}</p>
      <p className="sheet__recommendation">
        <span className="chip">recommandation</span> {report.recommendation}
      </p>

      <Settled
        title="Couverts par un test automatique"
        entries={report.coverage.filter((entry) => entry.verdict === "automated")}
      />
      <Settled
        title="Réglés par l'agent"
        entries={report.coverage.filter((entry) => entry.verdict === "checked")}
      />

      <Settled
        title="Dépouillés par squad"
        entries={report.sheet.filter((point) => point.settlement !== null)}
      />

      <h3 className="ticket__heading">Fiche de tests</h3>
      {report.sheet.length === 0 ? (
        <p className="empty">
          Rien à juger : tous les critères sont couverts par un test ou réglés par l'agent, et il
          n'a rien suggéré de plus.
        </p>
      ) : waiting.length === 0 ? (
        <ReviewedSheet report={report} />
      ) : report.reviewedAt === null ? (
        <>
          <SettleFirst ticketId={ticketId} points={waiting} />
          <SheetForm ticketId={ticketId} points={waiting} notes={notesByCriterion(report)} />
        </>
      ) : (
        <ReviewedSheet report={report} />
      )}
    </>
  );
}

/**
 * The criteria the developer does not have to go through, and why: a test
 * covers them, or the agent settled them itself and says what it ran. Reading
 * this is what spares doing the work again, so a checked criterion shows its
 * note rather than hiding it behind the claim.
 */
function Settled({
  title,
  entries,
}: {
  title: string;
  entries: Array<CriterionCoverage | TestSheetPoint>;
}) {
  if (entries.length === 0) return null;
  return (
    <>
      <h3 className="ticket__heading">{title}</h3>
      <ul className="ticket__criteria">
        {entries.map((entry) => (
          <li key={"id" in entry ? entry.id : entry.criterionId}>
            {"settlement" in entry && entry.settlement !== null && (
              <span className="chip chip--verdict">{settlementLabels[entry.settlement.outcome]}</span>
            )}{" "}
            {entry.text}
            <Note entry={entry} />
          </li>
        ))}
      </ul>
    </>
  );
}

/** What was run, whoever wrote it down: the agent's note or the pass's. */
function Note({ entry }: { entry: CriterionCoverage | TestSheetPoint }) {
  const text =
    "settlement" in entry ? (entry.settlement?.note ?? null) : (entry.note ?? null);
  return text === null ? null : <p className="sheet__comment">{text}</p>;
}

const settlementLabels: Record<SettlementOutcome, string> = {
  holds: "tient",
  broken: "ne tient pas",
  human: "à voir",
  decision: "à trancher",
};

/**
 * What the agent already established on a criterion it still hands over: read
 * under the point, so the developer judges what is left rather than starting
 * from nothing.
 */
function notesByCriterion(report: StepReport): Record<string, string> {
  const notes: Record<string, string> = {};
  for (const entry of report.coverage) {
    if (entry.verdict === "judgement" && entry.note !== null) notes[entry.criterionId] = entry.note;
  }
  return notes;
}

/**
 * Hands the sheet back to squad before going through it. A pass runs on its own
 * after every report, so this is for a sheet reported before there was one, or
 * for a second look at points the first pass handed over.
 */
function SettleFirst({ ticketId, points }: { ticketId: string; points: TestSheetPoint[] }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const untouched = points.filter((point) => point.settlement === null).length;
  if (untouched === 0) return null;
  return (
    <p className="sheet__settle">
      <button
        type="button"
        className="link"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await settleTestSheet(ticketId);
          } catch (failure) {
            setError(failure instanceof ApiError ? failure.message : "Le serveur est injoignable.");
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "squad s'en charge…" : `Faire dépouiller ces ${untouched} point(s) par squad`}
      </button>
      {error && (
        <span className="error" role="alert">
          {error}
        </span>
      )}
    </p>
  );
}

/** What the developer fills in, one point at a time, then hands back in one go. */
function SheetForm({
  ticketId,
  points,
  notes,
}: {
  ticketId: string;
  points: TestSheetPoint[];
  notes: Record<string, string>;
}) {
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
            {point.criterionId !== null && notes[point.criterionId] !== undefined && (
              <p className="sheet__comment">{notes[point.criterionId]}</p>
            )}
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
