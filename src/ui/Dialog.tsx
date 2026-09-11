import { type ReactNode, useEffect, useRef } from "react";

/**
 * What squad is set up with, asked for in a dialog rather than laid out on the
 * page: registering a repository, opening a feature and resuming a conversation
 * are done once, and the shell has a fixed height it owes to piloting.
 *
 * The native element, not a hand-built one: the modal state, the focus trap,
 * the backdrop and closing on Escape all come from the browser, and the three
 * of them are what a hand-built dialog gets wrong.
 */
export function Dialog({
  title,
  open,
  onClose,
  children,
  variant = "panel",
  heading,
  headerExtra,
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /**
   * `panel` is the small centred box squad is set up with. `full` is the one a
   * ticket is treated in: nearly the whole window, because two tabs beside a
   * conversation need the width, and a bounded box would only move the ticket
   * drawer's own problem a few hundred pixels (ADR 0010).
   */
  variant?: "panel" | "full";
  /** What stands in for the title when the title is not a bare string. */
  heading?: ReactNode;
  /** What sits in the header beside the title: the tabs of a ticket. */
  headerExtra?: ReactNode;
}) {
  const element = useRef<HTMLDialogElement>(null);
  // Where the press that is about to become a click started. A click fires on
  // the nearest common ancestor of press and release, so a selection dragged
  // from inside the dialog and released past its edge arrives as a click on the
  // backdrop: without this, copying the path one is reading closes the dialog.
  const pressedOn = useRef<EventTarget | null>(null);

  useEffect(() => {
    const dialog = element.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      className={variant === "full" ? "dialog dialog--full" : "dialog"}
      ref={element}
      aria-label={title}
      onClose={onClose}
      // The backdrop is painted by the dialog itself, so a press landing on the
      // element rather than on anything inside it is a press outside.
      onMouseDown={(event) => {
        pressedOn.current = event.target;
      }}
      onClick={(event) => {
        if (event.target === element.current && pressedOn.current === element.current) onClose();
      }}
    >
      <header className="dialog__header">
        <h2>{heading ?? title}</h2>
        {headerExtra}
        <button type="button" className="link" onClick={onClose}>
          fermer
        </button>
      </header>
      {/* Mounted only while open, so a form comes back empty rather than
          holding what was typed and abandoned the time before. */}
      {open && <div className="dialog__body">{children}</div>}
    </dialog>
  );
}
