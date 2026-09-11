import type { FeatureGraph, Ticket } from "../shared/api";
import type { CreateTicketInput } from "./store";
import type { IntegrationCheck } from "./integration";

/**
 * The ticket a red integration check writes. Like a pull request description, it
 * is content squad puts in front of a person and hands to an agent, so it is in
 * French like the rest of the graph, and it lives beside the other thing squad
 * writes rather than inside the chain that merges.
 */
export function fixTicketFor(
  graph: FeatureGraph,
  merged: Ticket,
  command: string,
  check: IntegrationCheck,
): CreateTicketInput {
  return {
    featureId: graph.featureId,
    // In the repository whose verification went red, which is the one the
    // correction is made in.
    projectId: merged.projectId,
    kind: "fix",
    title: `Vérification d'intégration rouge après « ${merged.title} »`,
    // Squad writes its own summary here rather than being let off it: this
    // ticket is read on the same screen as the ones an agent wrote, and an
    // exemption would show there as a hole. It costs no interpretation of
    // prose, which squad does not do: everything below is what squad just saw
    // happen. No example, as on any fix ticket: what broke is a red command.
    summary: {
      context: `La branche de feature du dépôt vient de recevoir « ${merged.title} », et squad y a lancé la vérification du projet comme après chaque fusion.`,
      problem: `La commande \`${command}\` ne passe plus sur la branche de feature depuis cette fusion.`,
      example: null,
    },
    description: [
      `La branche de feature ne passe plus la vérification du projet depuis la fusion de « ${merged.title} ».`,
      "",
      `Commande : \`${command}\``,
      "",
      "Sortie :",
      "",
      "```",
      check.output,
      "```",
      "",
      "Ce ticket a été créé par squad, pas par la session principale : la casse vient de la rencontre de deux tranches vertes séparément, et elle se corrige avant que quoi que ce soit d'autre s'empile dessus.",
    ].join("\n"),
    acceptanceCriteria: [`La commande \`${command}\` repasse au vert sur la branche de feature.`],
    blockedBy: [],
    blocks: notStarted(graph, merged.projectId),
    // One generation deeper than what broke the branch: a check that comes back
    // red on the correction of a correction is a cascade, and the depth cap is
    // what stops it from running all night on its own.
    bornOf: merged.id,
  };
}

/**
 * The tickets no sub-session has ever opened, in the repository whose branch is
 * broken: work piled on a broken feature branch is work to do twice. Read from
 * the session written on the row rather than from the state: a ticket waiting
 * for a place reads as `queued` and has never run, while one that failed has a
 * branch of its own and blocking it would only strand it.
 *
 * Only that repository's tickets. A branch that no longer passes its own
 * verification says nothing about another repository, and holding its work back
 * would stop what the breakage has nothing to do with.
 *
 * Decision tickets are left out. They are questions for the developer and
 * nothing is built on their answer until squad is told it, so blocking them
 * would only stop the developer from answering.
 */
function notStarted(graph: FeatureGraph, projectId: string): string[] {
  return graph.tickets
    .filter(
      (ticket) =>
        ticket.projectId === projectId &&
        ticket.sessionId === null &&
        ticket.kind !== "decision",
    )
    .map((ticket) => ticket.id);
}
