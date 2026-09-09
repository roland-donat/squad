/**
 * The mark a node carries to say which repository builds it, on a feature
 * carrying several. Initials of the name's segments rather than its first
 * letters: a feature carrying `cod3s-platform` and `cod3s-raichu` would get
 * "COD" on both, and a mark that names two things names neither.
 *
 * The full name stays in the tooltip and in the accessible label; this is only
 * what fits in the corner of a node 176 px wide.
 */
export function shortRepositoryLabels(names: ReadonlyMap<string, string>): Map<string, string> {
  const short = new Map<string, string>();
  for (const [id, name] of names) short.set(id, initials(name));

  // Two names can still meet, `raichu-core` and `raichu-cli` both giving "RC".
  // Numbering them is ugly and unambiguous, which is the right way round for a
  // mark whose only job is to tell two repositories apart.
  const byLabel = new Map<string, string[]>();
  for (const [id, label] of short) byLabel.set(label, [...(byLabel.get(label) ?? []), id]);
  for (const [label, ids] of byLabel) {
    if (ids.length === 1) continue;
    ids.forEach((id, index) => short.set(id, `${label}${index + 1}`));
  }
  return short;
}

function initials(name: string): string {
  const segments = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const letters = segments.length > 1 ? segments.map((segment) => segment[0]).join("") : name.slice(0, 2);
  return letters.slice(0, 3).toUpperCase();
}
