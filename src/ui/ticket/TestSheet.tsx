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
 * A reported step, split where the modal is split: what is **read** on the left,
 * what is **acted on** on the right.
 *
 * The two used to be one column, in the order they were written: the work, then
 * everything squad had already settled, then, at the bottom, the one point
 * waiting on a person. Measured on the instance that opened this: taking a
 * single arbitration meant scrolling past 11 000 characters, of which 6 700
 * were notes on points nobody had to judge. Evidence is not the work; it is what
 * spares doing the work again, and it belongs beside the decision rather than in
 * front of it.
 *
 * A sheet is gone through once. Afterwards it is read back rather than edited:
 * what was said is the record the correction is based on.
 */

/** Whether anything on this sheet is waiting on a person, which is what opens the action column. */
export function sheetAwaitsDeveloper(report: StepReport): boolean {
  return pointsAwaitingDeveloper(report).length > 0;
}

/**
 * What is read of a step: what the session built, what was settled without the
 * developer, and the sheet itself once it has been gone through.
 *
 * Everything squad settled arrives **folded**. It is the evidence that spares
 * re-establishing a claim, so it has to be within reach; it is also what nobody
 * has to judge, so unfolded it is the wall that hides the one thing they do.
 */
export function TestSheetEvidence({ report }: { report: StepReport }) {
  const waiting = pointsAwaitingDeveloper(report);
  const automated = report.coverage.filter((entry) => entry.verdict === "automated");
  const checked = report.coverage.filter((entry) => entry.verdict === "checked");
  // What squad settled and is not handing over. A point it showed false on a
  // sheet it may no longer correct appears in the form instead: listed in both,
  // the same point would read as two things to judge.
  const settled = report.sheet.filter(
    (point) => point.settlement !== null && !waiting.some((each) => each.id === point.id),
  );
  return (
    <>
      <h3 className="ticket__heading">Fin d'étape</h3>
      <Markdown text={report.work} subset="inline" className="ticket__description" />
      <p className="sheet__recommendation">
        <span className="chip">recommandation</span>{" "}
        <MarkdownText text={report.recommendation} />
      </p>

      <Settled title="Couverts par un test automatique" entries={automated} />
      <Settled title="Réglés par l'agent" entries={checked} />
      <Settled title="Vérifiés par squad" entries={settled} />

      {report.reviewedAt !== null && <ReviewedSheet report={report} />}
      {report.reviewedAt === null && report.sheet.length === 0 && (
        <p className="empty">
          Rien à juger : tous les critères sont couverts par un test ou réglés par l'agent, et il
          n'a rien suggéré de plus.
        </p>
      )}
    </>
  );
}

/**
 * The criteria the developer does not have to go through, and why: a test
 * covers them, or an agent settled them itself and says what it ran.
 *
 * Folded, and saying how many it holds: a reader opens it when a claim
 * surprises them, which is the only moment its notes are worth their length.
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
    <details className="evidence">
      <summary>
        {title} <span className="evidence__count">{entries.length}</span>
      </summary>
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
    </details>
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
 * An arbitration is a road squad measured and recommends; a verification is
 * something it is asking a person to have looked at. The two are held apart
 * everywhere in squad, and here that difference is what decides whether an
 * answer may be filled in ahead of the reader: agreeing with a recommendation
 * must cost one click, and no default may ever sign off a screen nobody opened.
 */
function isArbitration(point: TestSheetPoint): boolean {
  return point.settlement?.outcome === "decision" && point.settlement.recommendation !== null;
}

/**
 * What is asked of the developer on this step, and nothing else.
 *
 * Null when the sheet waits on nobody, which is what closes the action column:
 * a column that stayed open holding "rien à faire" would take a third of the
 * modal to say nothing.
 */
export function TestSheetForm({ ticketId, report }: { ticketId: string; report: StepReport }) {
  // What is asked of the developer is what waits on them, read from the one
  // rule that decides it: the points nobody has been through, plus, on a sheet
  // squad may no longer send back, the ones it showed false. Worked out here
  // once, which is how the server and this form came to disagree about the
  // last round.
  const waiting = pointsAwaitingDeveloper(report);
  if (waiting.length === 0 || report.reviewedAt !== null) return null;
  // Only the pending ones can be handed to another pass: a point squad has
  // already run something on is not one to run again.
  const pending = report.sheet.filter((point) => point.verdict === "pending");
  return (
    <>
      <h3 className="ticket__heading">Fiche de tests</h3>
      <SettleFirst ticketId={ticketId} points={pending} />
      <SheetForm
        key={report.id}
        ticketId={ticketId}
        points={waiting}
        notes={notesByCriterion(report)}
      />
    </>
  );
}

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

/**
 * Takes the road squad recommends on one arbitration, without the rest of the
 * sheet.
 *
 * An arbitration is not a verification, and squad holds the two apart
 * everywhere: it types them apart, it answers one and not the other under
 * go-as-recommended, and it sweeps the ones it left open when the mode comes
 * back. Only the form made them one block to sign, so a decision of perimeter
 * waited behind a point asking whether a wording read well. What is left
 * untouched stays on the sheet, which is not gone through until it is empty.
 *
 * Offered only on a sheet that also holds verifications. Where every waiting
 * point is an arbitration, the form below already takes them all in one click,
 * and two buttons doing the same thing is a choice nobody asked for.
 */
function TakeRoad({ ticketId, point }: { ticketId: string; point: TestSheetPoint }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const road = point.settlement?.recommendation ?? "";
  return (
    <>
      <button
        type="button"
        className="link"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await reviewTestSheet(ticketId, {
              points: [{ id: point.id, passed: true, comment: `Route retenue : ${road}` }],
              feedback: "",
            });
          } catch (failure) {
            setError(failure instanceof ApiError ? failure.message : "Le serveur est injoignable.");
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "squad l'enregistre…" : "Trancher seulement celui-ci"}
      </button>
      {error && (
        <span className="error" role="alert">
          {error}
        </span>
      )}
    </>
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
  // An arbitration starts on the road squad recommends, a verification starts
  // on nothing. Mounted from the points rather than kept in step with them: the
  // form is keyed by the report, so a new sheet is a new form.
  const [checked, setChecked] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(points.filter(isArbitration).map((point) => [point.id, true])),
  );
  const [comments, setComments] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A partial review takes arbitrations and nothing else, so taking one apart
  // is only worth offering when there is a rest to leave behind.
  const mixed = points.some((point) => !isArbitration(point));

  /**
   * What goes back to the sub-session on a point. What the developer typed
   * always wins; on an arbitration left on its recommended road, the road
   * itself is written down, so the record says which one was taken rather than
   * that something was ticked.
   */
  function commentFor(point: TestSheetPoint): string {
    const typed = (comments[point.id] ?? "").trim();
    if (typed !== "") return typed;
    if (isArbitration(point) && checked[point.id] === true) {
      return `Route retenue : ${point.settlement?.recommendation ?? ""}`;
    }
    return "";
  }

  /**
   * Leaving the recommended road without saying which one to take instead
   * hands the sub-session a correction with nothing in it. The same guard an
   * agent's question carries on its free answer, for the same reason: the
   * choice squad did not offer is exactly the one worth being able to give,
   * and it only exists once it is written.
   */
  const unsaid = points.some(
    (point) =>
      isArbitration(point) &&
      checked[point.id] !== true &&
      (comments[point.id] ?? "").trim() === "",
  );

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await reviewTestSheet(ticketId, {
        points: points.map((point) => ({
          id: point.id,
          passed: checked[point.id] === true,
          comment: commentFor(point),
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
        {points.map((point) =>
          isArbitration(point) ? (
            <Arbitration
              key={point.id}
              point={point}
              ticketId={ticketId}
              alone={!mixed}
              taken={checked[point.id] === true}
              onTake={(take) => setChecked((current) => ({ ...current, [point.id]: take }))}
              comment={comments[point.id] ?? ""}
              onComment={(text) => setComments((current) => ({ ...current, [point.id]: text }))}
            />
          ) : (
            <Verification
              key={point.id}
              point={point}
              note={point.criterionId === null ? undefined : notes[point.criterionId]}
              passed={checked[point.id] === true}
              onPass={(pass) => setChecked((current) => ({ ...current, [point.id]: pass }))}
              comment={comments[point.id] ?? ""}
              onComment={(text) => setComments((current) => ({ ...current, [point.id]: text }))}
            />
          ),
        )}
      </ul>
      <label className="field">
        <span>Retour général</span>
        <textarea
          value={feedback}
          onChange={(event) => setFeedback(event.target.value)}
          rows={2}
          placeholder="ce qui vaut pour la fiche entière"
        />
      </label>
      {/* Held at the foot of the column rather than at the end of the prose:
          with the recommended road already taken, agreeing is one click, and it
          must not cost a scroll through the evidence of why it is recommended. */}
      <div className="sheet__commit">
        <button type="submit" disabled={busy || unsaid}>
          Rendre la fiche
        </button>
        {unsaid && (
          <span className="sheet__blocked">
            Dites quelle route prendre à la place, et la fiche part.
          </span>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
    </form>
  );
}

/**
 * One arbitration: two roads, the recommended one already taken.
 *
 * The same shape as an agent's question, and for the same reason, written there
 * first: the recommendation is the answer squad would give itself under
 * go-as-recommended, so agreeing must cost one click and disagreeing must stay
 * possible. Leaving the recommended road hands the point back to the
 * sub-session with what to do instead, which is what an unchecked point has
 * always meant.
 */
function Arbitration({
  point,
  ticketId,
  alone,
  taken,
  onTake,
  comment,
  onComment,
}: {
  point: TestSheetPoint;
  ticketId: string;
  alone: boolean;
  taken: boolean;
  onTake: (taken: boolean) => void;
  comment: string;
  onComment: (text: string) => void;
}) {
  return (
    <li className="sheet__point sheet__point--arbitration">
      <p className="sheet__prompt">
        <span className="sheet__text">
          <MarkdownText text={point.text} />
        </span>
        <span className="chip chip--verdict">à trancher</span>
      </p>
      <Measured note={point.settlement?.note ?? null} />
      <ul className="list question__options">
        <li>
          <label className="question__option">
            <input
              type="radio"
              name={`point-${point.id}`}
              checked={taken}
              onChange={() => onTake(true)}
            />
            <span className="sheet__text">Prendre la route recommandée</span>
            <span className="chip">recommandé</span>
          </label>
          <Markdown
            text={point.settlement?.recommendation ?? ""}
            subset="inline"
            className="question__consequence"
          />
        </li>
        <li>
          <label className="question__option">
            <input
              type="radio"
              name={`point-${point.id}`}
              checked={!taken}
              onChange={() => onTake(false)}
            />
            <span className="sheet__text">Prendre une autre route</span>
          </label>
          {!taken && (
            <label className="field">
              <span>Laquelle</span>
              <textarea
                value={comment}
                onChange={(event) => onComment(event.target.value)}
                rows={2}
                placeholder="ce qu'il faut faire à la place ; la sous-session le reçoit tel quel"
              />
            </label>
          )}
        </li>
      </ul>
      {alone ? null : (
        <p className="sheet__settle">
          <TakeRoad ticketId={ticketId} point={point} />
        </p>
      )}
    </li>
  );
}

/**
 * One verification: something to have looked at, checked when it holds.
 *
 * Nothing is ticked ahead of the reader here, and that is the whole difference
 * with an arbitration above: a default answer on a point asking whether a
 * screen reads right would sign off a screen nobody opened.
 */
function Verification({
  point,
  note,
  passed,
  onPass,
  comment,
  onComment,
}: {
  point: TestSheetPoint;
  note: string | undefined;
  passed: boolean;
  onPass: (passed: boolean) => void;
  comment: string;
  onComment: (text: string) => void;
}) {
  return (
    <li className="sheet__point">
      <label className="sheet__check">
        <input
          type="checkbox"
          checked={passed}
          onChange={(event) => onPass(event.target.checked)}
        />
        <span className="sheet__text">
          <MarkdownText text={point.text} />
        </span>
        <span className="chip">{originLabel(point)}</span>
        {point.settlement !== null && (
          <span className="chip chip--verdict">{settlementLabels[point.settlement.outcome]}</span>
        )}
      </label>
      <Measured note={point.settlement?.note ?? note ?? null} />
      <label className="field">
        <span>Commentaire</span>
        <input
          value={comment}
          onChange={(event) => onComment(event.target.value)}
          placeholder="ce qui ne va pas, si quelque chose ne va pas"
        />
      </label>
    </li>
  );
}

/**
 * What squad ran on a point it still hands over, folded.
 *
 * It is the evidence the decision rests on, so it cannot be dropped; it also
 * runs to several thousand characters, so unfolded it buries the two lines the
 * developer came to read. Measured on the instance that opened this: one
 * arbitration carried a 3 424-character note above its own choices.
 */
function Measured({ note }: { note: string | null }) {
  if (note === null || note === "") return null;
  return (
    <details className="evidence evidence--inline">
      <summary>Ce que squad a mesuré</summary>
      <Markdown text={note} subset="full" className="sheet__comment" />
    </details>
  );
}

/** The sheet once it has been gone through, read-only and dated. */
function ReviewedSheet({ report }: { report: StepReport }) {
  return (
    <>
      <h3 className="ticket__heading">Fiche de tests</h3>
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
