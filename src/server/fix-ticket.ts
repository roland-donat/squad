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
    kind: "fix",
    title: `Vérification d'intégration rouge après « ${merged.title} »`,
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
    blocks: notStarted(graph),
  };
}

/**
 * The tickets no sub-session has ever opened, which is what a correction is
 * posted in front of: work piled on a broken feature branch is work to do twice.
 * Read from the session written on the row rather than from the state: a ticket
 * waiting for a place reads as `queued` and has never run, while one that failed
 * has a branch of its own and blocking it would only strand it.
 *
 * Decision tickets are left out. They are questions for the developer and
 * nothing is built on their answer until squad is told it, so blocking them
 * would only stop the developer from answering.
 */
function notStarted(graph: FeatureGraph): string[] {
  return graph.tickets
    .filter((ticket) => ticket.sessionId === null && ticket.kind !== "decision")
    .map((ticket) => ticket.id);
}
