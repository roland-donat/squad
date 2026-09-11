import type { AutonomyHaltReason, Feature } from "../../shared/api";
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
export function AutonomySwitch({ feature }: { feature: Feature }) {
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
          <span className="autonomy__halt">
            {haltLabels[halt.reason]} : « {halt.detail} »
          </span>
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
