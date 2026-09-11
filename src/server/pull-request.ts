import type { Feature, FeatureGraph, Ticket } from "../shared/api";

/**
 * What a feature's pull request says, written from its graph and nowhere else.
 * The tickets carry what was asked, their step reports carry what was built, and
 * their test sheets carry what a human checked: a description written from them
 * says exactly what happened, and it says it without anyone having to write it
 * again.
 *
 * In French, like everything squad puts in front of a person. What it quotes
 * from the graph is in whatever language the tickets were written in.
 */
export function pullRequestBody(feature: Feature, graph: FeatureGraph): string {
  const built = graph.tickets.filter((ticket) => ticket.kind !== "decision");
  const settled = graph.tickets.filter((ticket) => ticket.conclusion !== null);
  return [
    `Feature « ${feature.title} », pilotée par squad : ${count(built.length, "ticket construit", "tickets construits")} sur cette branche.`,
    "",
    ...built.flatMap(describeTicket),
    ...(settled.length === 0
      ? []
      : ["## Décisions tranchées", "", ...settled.map((ticket) => `- **${ticket.title}** : ${ticket.conclusion}`), ""]),
    "---",
    "",
    "Description écrite par squad depuis le graphe de la feature : un ticket par tranche, et pour chacune ce que sa sous-session a rapporté et ce qui a été vérifié à la main.",
  ].join("\n");
}

function describeTicket(ticket: Ticket): string[] {
  const report = ticket.stepReport;
  const checked = (report?.sheet ?? []).filter((point) => point.verdict === "passed");
  return [
    `## ${ticket.title}${ticket.kind === "fix" ? " (correction)" : ""}`,
    "",
    ...(report === null ? ["_Aucun rapport de fin d'étape._", ""] : [report.work, ""]),
    ...(checked.length === 0
      ? []
      : [
          "Vérifié à la main :",
          ...checked.map((point) => `- ${point.text}`),
          "",
        ]),
    ...(report?.feedback === null || report?.feedback === undefined
      ? []
      : [`Retour du développeur : ${report.feedback}`, ""]),
  ];
}

function count(howMany: number, one: string, several: string): string {
  return `${howMany} ${howMany > 1 ? several : one}`;
}
