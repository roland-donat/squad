import { useState, type ReactNode } from "react";
import type { Question } from "../../shared/api";
import { answerQuestion } from "../api";
import { Failure, useSubmission } from "../submission";

/**
 * The questions of a session: the one waiting for an answer, and the ones
 * already settled. A waiting question is an agent standing still, so it is
 * shown before anything else the panel has to say; a settled one stays on
 * screen because what was answered, and by whom, is the record of what was
 * decided without the developer.
 */
export function Questions({ questions }: { questions: Question[] }): ReactNode {
  if (questions.length === 0) return null;
  const waiting = questions.filter((question) => question.state === "pending");
  const settled = questions.filter((question) => question.state !== "pending");

  return (
    <>
      <h3 className="ticket__heading">Questions</h3>
      {waiting.map((question) => (
        <AskedQuestion key={question.id} question={question} />
      ))}
      {settled.map((question) => (
        <SettledQuestion key={question.id} question={question} />
      ))}
    </>
  );
}

/**
 * What the developer answers on. The agent's recommendation is picked to start
 * with, since it is the answer squad would give itself in go-as-recommandé:
 * agreeing with it must cost one click, and disagreeing must stay possible.
 *
 * The last choice is free text on purpose: the options are what the agent
 * thought of, and the answer it did not think of is exactly the one worth being
 * able to give.
 */
function AskedQuestion({ question }: { question: Question }) {
  // Null is the answer the agent did not offer, which is why it is not one of
  // the options: an empty string would be a option that reads as absent.
  const [choice, setChoice] = useState<string | null>(question.recommendation);
  const [free, setFree] = useState("");
  const answer = choice ?? free.trim();
  const { busy, error, submit } = useSubmission(() => answerQuestion(question.id, { answer }));

  return (
    <form className="form question" onSubmit={submit}>
      <p className="question__prompt">
        {question.prompt}
        {question.scopeChanging && <span className="chip chip--scope">périmètre</span>}
      </p>
      <ul className="list question__options">
        {[...question.options, null].map((option) => (
          <li key={option?.label ?? "autre"}>
            <label className="question__option">
              <input
                type="radio"
                name={`question-${question.id}`}
                checked={choice === (option?.label ?? null)}
                onChange={() => setChoice(option?.label ?? null)}
              />
              <span className="sheet__text">{option?.label ?? "Autre réponse"}</span>
              {option !== null && option.label === question.recommendation && (
                <span className="chip">recommandé</span>
              )}
            </label>
            {/* What the road costs, under the road itself. Absent only on the
                options written before the agents were asked for it; padding
                that gap would read as "this one costs nothing". */}
            {option !== null && option.consequence !== null && (
              <p className="question__consequence">{option.consequence}</p>
            )}
            {option !== null && option.illustration !== null && (
              <p className="question__illustration">{option.illustration}</p>
            )}
          </li>
        ))}
      </ul>
      {choice === null && (
        <label className="field">
          <span>Ma réponse</span>
          <textarea
            value={free}
            onChange={(event) => setFree(event.target.value)}
            rows={2}
            placeholder="ce que l'agent n'avait pas envisagé"
          />
        </label>
      )}
      <button type="submit" disabled={busy || answer === ""}>
        Répondre
      </button>
      <Failure message={error} />
    </form>
  );
}

/** A question that is no longer waiting: what was answered, and by whom. */
function SettledQuestion({ question }: { question: Question }) {
  return (
    <div className="question question--settled">
      <p className="question__prompt">{question.prompt}</p>
      {question.state === "abandoned" ? (
        <p className="sheet__comment">
          Abandonnée : squad s'est arrêté pendant qu'elle attendait, et la session qui l'avait posée
          n'est plus là.
        </p>
      ) : (
        <p className="sheet__verdict">
          <span className="chip chip--verdict">
            {question.answeredBy === "squad" ? "répondu par squad" : "répondu"}
          </span>
          <span className="sheet__text">{question.answer}</span>
        </p>
      )}
    </div>
  );
}
