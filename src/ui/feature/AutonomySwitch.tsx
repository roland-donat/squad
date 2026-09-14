import type { AutonomyHalt, AutonomyHaltReason, Feature } from "../../shared/api";
import { setGoAsRecommended } from "../api";
import { Failure, useSubmission } from "../submission";

/** Why the mode stopped, said as the thing the developer has to look at. */
const haltLabels: Record<AutonomyHaltReason, string> = {
  "scope-question": "une question change le périmètre",
  decision: "un ticket de décision attend d'être tranché",
  failure: "un ticket s'est arrêté",
  "depth-cap": "le plafond de profondeur d'engendrement est atteint",
};

/**
 * Go-as-recommended on the feature it drives: squad launches what the frontier
 * allows and answers implementation questions with the agent's own
 * recommendation. What stopped it is read here, and starting it again is what
 * says that is dealt with: nothing else restarts a night of autonomy.
 *
 * In the header of the feature's own tab, because it is the one standing
 * decision taken on this screen: how much of this piece of work runs without
 * me. It used to hang under a row in a list of features, where it was read as a
 * detail of the row rather than as the state the whole screen is in.
 *
 * One control per state rather than one control that means three things: arming
 * it, taking it back after a stop and stopping it are three decisions, and a
 * button whose meaning depends on what it says is a button read wrong.
 */
/**
 * Where the account of a halt leads, or null when it leads nowhere it can
 * promise.
 *
 * Three cases, and the third is why this is asked rather than assumed. A halt
 * naming a ticket the graph still holds opens that ticket. One naming none can
 * only be a question of the main session, answered in the feature's thread, and
 * only a scope question can be one: a stopped ticket, a decision or a depth cap
 * always had a ticket, so a halt of those recorded without one was written
 * before the ticket was carried, and squad no longer knows which. A halt naming
 * a ticket that is gone is the same kind of ignorance. In both, the account
 * stays prose: a button that navigates nowhere, silently, is worse than none.
 */
function leadsTo(
  halt: { reason: AutonomyHaltReason; ticketId: string | null },
  ticketIds: ReadonlySet<string>,
): "ticket" | "thread" | null {
  if (halt.ticketId !== null) return ticketIds.has(halt.ticketId) ? "ticket" : null;
  return halt.reason === "scope-question" ? "thread" : null;
}

export function AutonomySwitch({
  feature,
  ticketIds,
  onOpenHalt,
}: {
  feature: Feature;
  /** The tickets the graph holds, so the account only offers what it can open. */
  ticketIds: ReadonlySet<string>;
  /**
   * Opens what the mode stopped on: the ticket, or the feature's own thread
   * when a question of the main session is what stopped it. The same gesture
   * the waiting list makes, and for the same reason: what is named has to be
   * reachable from where it is read.
   */
  onOpenHalt: (ticketId: string | null) => void;
}) {
  const halt = feature.autonomyHalt;
  const arming = useSubmission(() => setGoAsRecommended(feature.id, true));
  const stopping = useSubmission(() => setGoAsRecommended(feature.id, false));
  const busy = arming.busy || stopping.busy;

  return (
    <span className="autonomy">
      {!feature.goAsRecommended && (
        <button type="button" className="chip" disabled={busy} onClick={() => void arming.run()}>
          go-as-recommandé : arrêté
        </button>
      )}
      {feature.goAsRecommended && halt !== null && (
        <>
          {/* The whole account on the button, and not only on the prose beside
              it: the line is cut where it stops fitting, and on a narrow window
              it is not shown at all. The button is the one thing always there,
              so it is what has to be able to give the account back. */}
          <button
            type="button"
            className="chip"
            disabled={busy}
            title={`${haltLabels[halt.reason]} : ${halt.detail}`}
            onClick={() => void arming.run()}
          >
            go-as-recommandé : interrompu, relancer
          </button>
          {/* What it stopped on, and the way to it. Relaunching without dealing
              with the cause stops the mode again on the same thing, which reads
              as a button that does nothing: the account of the halt is
              therefore what opens the ticket where it is dealt with. It stays
              prose when there is nowhere it can promise to go. */}
          <Account halt={halt} to={leadsTo(halt, ticketIds)} onOpen={onOpenHalt} />
        </>
      )}
      {feature.goAsRecommended && halt === null && (
        <span className="chip chip--armed">go-as-recommandé : en cours</span>
      )}
      {feature.goAsRecommended && (
        <button type="button" className="link" disabled={busy} onClick={() => void stopping.run()}>
          arrêter
        </button>
      )}
      <Failure message={arming.error ?? stopping.error} />
    </span>
  );
}

/** What the mode stopped on, clickable exactly when it leads somewhere. */
function Account({
  halt,
  to,
  onOpen,
}: {
  halt: AutonomyHalt;
  to: "ticket" | "thread" | null;
  onOpen: (ticketId: string | null) => void;
}) {
  const said = (
    <>
      <span className="autonomy__reason">{haltLabels[halt.reason]}</span>
      <span className="autonomy__detail"> : « {halt.detail} »</span>
    </>
  );
  if (to === null) return <span className="autonomy__halt autonomy__halt--flat">{said}</span>;
  return (
    <button
      type="button"
      className="autonomy__halt"
      title={to === "ticket" ? "ouvrir le ticket" : "ouvrir le fil de la session principale"}
      onClick={() => onOpen(to === "ticket" ? halt.ticketId : null)}
    >
      {said}
    </button>
  );
}
