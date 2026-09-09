import { useRef } from "react";
import { themes, type Theme } from "../shared/api";
import { updateSettings } from "./api";
// The lockup itself, not a copy of it in JSX: one drawing serves the header,
// the favicon and the README, and a second one would drift from it in silence.
import lockup from "./brand/squad-lockup.svg?raw";
import { Failure, useSubmission } from "./submission";

/**
 * What every screen carries in its header, whichever screen it is: the mark,
 * whether squad is still talking to us, which ground the interface is drawn on,
 * and the way to what squad is configured with.
 */

/** The mark, drawn once. Cliquable everywhere but on the screen it leads to. */
export function Brand({ onClick }: { onClick?: () => void }) {
  const mark = (
    <span className="brand" aria-hidden="true" dangerouslySetInnerHTML={{ __html: lockup }} />
  );
  if (onClick === undefined) return mark;
  return (
    // Named for what it is rather than for what it does, so it does not read as
    // a second copy of the screen's own way back: the mark is squad, and
    // clicking a product's mark going home is a convention nobody has to learn.
    <button type="button" className="brand__link" onClick={onClick} title="squad, accueil">
      {mark}
      <span className="visually-hidden">squad, accueil</span>
    </button>
  );
}

export function Connection({ connected }: { connected: boolean }) {
  return (
    <span className={connected ? "badge badge--live" : "badge"}>
      {connected ? "connecté" : "hors ligne"}
    </span>
  );
}

/** The three grounds, in the order they are offered. */
const themeLabels: Record<Theme, string> = {
  system: "système",
  light: "clair",
  dark: "sombre",
};

/**
 * Which ground the interface is drawn on. The choice is a squad setting like
 * any other, so it goes to the server and comes back on the event stream: the
 * switch shows what is in force, never what was clicked.
 *
 * Three native radios rather than hand-written ARIA: the arrow keys, the group
 * semantics and the announced state all come for free.
 */
export function ThemeSwitch({ theme }: { theme: Theme }) {
  // What was just clicked. A ref rather than state, since the submission reads
  // it when it runs and nothing renders from it.
  const chosen = useRef<Theme>(theme);
  const { error, run } = useSubmission(() => updateSettings({ theme: chosen.current }));

  return (
    <>
      <fieldset className="theme">
        <legend className="visually-hidden">Thème de l'interface</legend>
        {themes.map((option) => (
          <label className="theme__option" key={option}>
            <input
              type="radio"
              name="theme"
              value={option}
              checked={option === theme}
              onChange={() => {
                chosen.current = option;
                void run();
              }}
            />
            <span>{themeLabels[option]}</span>
          </label>
        ))}
      </fieldset>
      <Failure message={error} />
    </>
  );
}
