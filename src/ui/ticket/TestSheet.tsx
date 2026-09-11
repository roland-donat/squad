import { useState, type FormEvent } from "react";
import type {
  CriterionCoverage,
  SettlementOutcome,
  StepReport,
  TestSheetPoint,
} from "../../shared/api";
import { pointsAwaitingDeveloper } from "../../shared/validation";
import { ApiError, reviewTestSheet, settleTestSheet } from "../api";
import { Markdown, MarkdownText } from "../markdown/Markdown";

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
  // What is asked of the developer is what waits on them, read from the one
  // rule that decides it: the points nobody has been through, plus, on a sheet
  // squad may no longer send back, the ones it showed false. Worked out here
  // once, which is how the server and this form came to disagree about the
  // last round.
  const waiting = pointsAwaitingDeveloper(report);
  // Only the pending ones can be handed to another pass: a point squad has
  // already run something on is not one to run again.
  const pending = report.sheet.filter((point) => point.verdict === "pending");
  return (
    <>
      <h3 className="ticket__heading">Fin d'étape</h3>
      <Markdown text={report.work} subset="inline" className="ticket__description" />
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

      {/* What squad settled and is not handing over. A point it showed false on
          a sheet it may no longer correct appears in the form below instead:
          listed in both, the same point would read as two things to judge. */}
      <Settled
        title="Vérifiés par squad"
        entries={report.sheet.filter(
          (point) =>
            point.settlement !== null && !waiting.some((each) => each.id === point.id),
        )}
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
          <SettleFirst ticketId={ticketId} points={pending} />
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
            <MarkdownText text={entry.text} />
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
  // Full subset: a note is where a command's output lands, and a fenced block
  // is the difference between reading evidence and re-establishing it.
  return text === null ? null : <Markdown text={text} subset="full" className="sheet__comment" />;
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
 * Hands the sheet back to squad before going through it.
 *
 * A pass runs on its own after every report, so this is for a sheet reported
 * before there was one, and for asking again on one that has already been
 * through: the rules the pass applies change, and a sheet settled under the old
 * ones keeps what those left. Offered on anything still pending for that
 * reason, not only on points no pass ever read.
 */
function SettleFirst({ ticketId, points }: { ticketId: string; points: TestSheetPoint[] }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const untouched = points.filter((point) => point.settlement === null).length;
  if (points.length === 0) return null;
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
        {busy
          ? "squad s'en charge…"
          : untouched === 0
            ? `Refaire vérifier ces ${points.length} point(s) par squad`
            : `Faire vérifier ces ${points.length} point(s) par squad`}
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
              <span className="sheet__text">
                <MarkdownText text={point.text} />
              </span>
              <span className="chip">{originLabel(point)}</span>
              {/* What squad's pass concluded on this point, next to the point
                  it hands over. Shown here and not only in the settled list
                  above, which no longer holds it: an arbitration without its
                  recommended road is a bare line, which is precisely what the
                  pass exists to replace, and a broken point without its
                  evidence is a claim the developer has to re-establish. */}
              {point.settlement !== null && (
                <span className="chip chip--verdict">
                  {settlementLabels[point.settlement.outcome]}
                </span>
              )}
            </label>
            {point.settlement !== null && (
              <Markdown text={point.settlement.note} subset="full" className="sheet__comment" />
            )}
            {point.settlement?.recommendation != null && (
              <p className="sheet__verdict">
                <span className="chip">recommandé</span>
                <span className="sheet__text">
                  <MarkdownText text={point.settlement.recommendation} />
                </span>
              </p>
            )}
            {point.settlement === null &&
              point.criterionId !== null &&
              notes[point.criterionId] !== undefined && (
                <Markdown
                  text={notes[point.criterionId] ?? ""}
                  subset="full"
                  className="sheet__comment"
                />
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
      {report.feedback !== null && (
        <Markdown text={report.feedback} subset="full" className="sheet__comment" />
      )}
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
