import { useRef, useState } from "react";

/**
 * A field a walk writes into and a person may write over.
 *
 * The rule is not "fill it if it is empty". A name left behind by a previous
 * walk was chosen by nobody, and testing for emptiness would keep it: walk to
 * `alpha`, see it was the wrong repository, walk to `beta`, and the project is
 * registered under `alpha` while the path says `beta`. What must be preserved is
 * what a person typed, and that is what this tells apart, by remembering what
 * was last proposed.
 */
export interface ProposedField {
  value: string;
  /** What a person typed, which from then on is theirs and not the walk's. */
  onChange: (value: string) => void;
  /** What the walk found, written only over emptiness or its own last word. */
  propose: (proposed: string | null) => void;
}

export function useProposedField(): ProposedField {
  const [value, setValue] = useState("");
  const proposed = useRef<string | null>(null);

  return {
    value,
    onChange(next) {
      setValue(next);
      // Typed over, so there is nothing of the walk's left to overwrite. An
      // empty field is nobody's either, which is what lets the next walk fill
      // a field someone has just cleared.
      proposed.current = null;
    },
    propose(next) {
      if (next === null) return;
      if (value.trim() !== "" && value !== proposed.current) return;
      proposed.current = next;
      setValue(next);
    },
  };
}
