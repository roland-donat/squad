import { useState, type FormEvent } from "react";
import { ApiError } from "./api";

/**
 * What every action of the interface shares: whether it is in flight, the
 * failure it may come back with, and whether the last one went through. The
 * failure is worded from the error code the server sent, so a refusal reads as
 * something to do rather than as a status line.
 */
export function useSubmission(action: () => Promise<unknown>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function run(): Promise<void> {
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      await action();
      setDone(true);
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "Le serveur est injoignable.");
    } finally {
      setBusy(false);
    }
  }

  /** The same thing, on a form: the page must not reload under the action. */
  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    await run();
  }

  return { busy, error, done, run, submit };
}

export function Failure({ message }: { message: string | null }) {
  if (message === null) return null;
  return (
    <p className="error" role="alert">
      {message}
    </p>
  );
}
