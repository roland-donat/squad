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
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
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
      className="dialog"
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
        <h2>{title}</h2>
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
