import { useState } from "react";
import type { Feature, Question, ThreadEntry } from "../../shared/api";
import { sendMainSessionMessage, startMainSession } from "../api";
import { Questions } from "../question/Questions";
import { Failure, useSubmission } from "../submission";
import { Thread } from "./Thread";

/**
 * The thread of a feature's main session, and the one box that both opens it and
 * writes to it. This is where the spec is pasted, the breakdown adjusted and the
 * decisions settled; the tickets themselves are built elsewhere.
 */

export function MainSessionView({
  feature,
  thread,
  questions,
  running,
}: {
  feature: Feature;
  thread: ThreadEntry[];
  questions: Question[];
  running: boolean;
}) {
  return (
    <>
      <p className="panel__context">
        de <strong>{feature.title}</strong>
        <span className={running ? "badge badge--live" : "badge"}>
          {running ? "en cours" : "arrêtée"}
        </span>
      </p>
      <Questions questions={questions} />
      <Thread
        entries={thread}
        empty={
          <>
            Fil vide. Coller le spec puis lancer <code>/to-tickets</code> pour faire naître le
            graphe.
          </>
        }
      />
      <Composer feature={feature} running={running} />
    </>
  );
}

/**
 * The two commands this thread exists for, as one click each. They are typed
 * often, they are typed exactly, and a command misspelt is a turn spent finding
 * out: `/to-spec` turns what was said into a spec, `/to-tickets` cuts a spec
 * into the graph. Nothing else is offered here, because nothing else is worth
 * taking the developer's own words out of their hands.
 */
const shortcuts = [
  // What each one is for, since the label is the command itself. `/to-spec`
  // synthesises what has already been said, which is why it is worth a click on
  // a thread resumed from a conversation squad did not write.
  { command: "/to-spec", hint: "Écrire le spec de ce qui a déjà été dit" },
  { command: "/to-tickets", hint: "Découper le spec en tickets" },
] as const;

/**
 * One box for both cases. Opening the session and writing to it are the same
 * gesture for the developer, so they are the same field here: the difference is
 * which request the message goes out on, and the shortcuts go out the same way.
 */
function Composer({ feature, running }: { feature: Feature; running: boolean }) {
  const [text, setText] = useState("");
  const send = async (said: string) => {
    if (running) await sendMainSessionMessage(feature.id, { text: said });
    else await startMainSession(feature.id, { prompt: said });
  };
  const written = useSubmission(async () => {
    await send(text);
    setText("");
  });

  return (
    <form className="form composer" onSubmit={written.submit}>
      <div className="composer__shortcuts">
        {shortcuts.map((shortcut) => (
          <Shortcut
            key={shortcut.command}
            command={shortcut.command}
            hint={shortcut.hint}
            send={send}
          />
        ))}
      </div>
      <label className="field">
        <span>{running ? "Message à la session" : "Premier message de la session"}</span>
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="le spec à coller, ou ce qu'il faut ajuster dans le découpage"
          rows={4}
          required
        />
      </label>
      <button type="submit" disabled={written.busy}>
        {running ? "Envoyer" : "Ouvrir la session principale"}
      </button>
      <Failure message={written.error} />
    </form>
  );
}

/**
 * One command, handed to the session as if it had been typed. It opens the
 * session when none is running, exactly as the box below it does: for the
 * developer, starting the thread with `/to-tickets` and sending `/to-tickets`
 * to a thread already open are the same intention.
 */
function Shortcut({
  command,
  hint,
  send,
}: {
  command: string;
  hint: string;
  send: (said: string) => Promise<void>;
}) {
  const sending = useSubmission(() => send(command));
  return (
    // Each shortcut in a box of its own: a refusal reads under the button it
    // came from, where a bare fragment would drop it between the two buttons,
    // the row being a flex line.
    <span className="composer__shortcut">
      <button
        type="button"
        className="button--secondary"
        disabled={sending.busy}
        title={hint}
        onClick={() => void sending.run()}
      >
        {command}
      </button>
      <Failure message={sending.error} />
    </span>
  );
}
