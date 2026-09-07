# squad

Poste de pilotage local pour agents claude-code. Squad détient le plan d'exécution
d'une feature sous forme de graphe, lance les sessions qui construisent chaque
tranche, et rend à l'utilisateur les seules décisions qu'il ne peut pas déléguer.

Chaque terme donne entre parenthèses son identifiant en code : la documentation est
en français, le code reste en anglais.

## Le graphe

**Ticket** (`Ticket`) :
L'unité de travail de squad, et le seul type de nœud du graphe. Porte un genre déclaré.
_Éviter_ : issue, tâche, étape, story, carte

**Genre** (`TicketKind`) :
Ce qu'un ticket demande : `build` (une tranche verticale à construire), `decision`
(une question à trancher, qui ne s'exécute pas), `fix` (une correction née d'un test
manuel en échec ou d'une vérification d'intégration rouge).
_Éviter_ : type, catégorie, nature

**Arête de blocage** (`BlockingEdge`) :
La relation orientée « A doit être fusionné avant que B puisse partir ». C'est la
seule relation du graphe, donc la seule chose que puisse signifier une flèche.
_Éviter_ : dépendance, lien, parent, enfant, sous-tâche

**Frontière** (`frontier`) :
L'ensemble des tickets dont tous les bloqueurs sont fusionnés. C'est ce que squad
peut lancer à l'instant présent.
_Éviter_ : file d'attente, backlog, tickets prêts, prochaine vague

**Feature** (`Feature`) :
Un chantier sur un projet, du spec jusqu'à la fusion dans la branche par défaut.
Une feature possède un graphe et une session principale.
_Éviter_ : chantier, epic, lot, sprint

**Projet** (`Project`) :
Un dépôt git piloté par squad. Un projet peut porter plusieurs features en vol.
_Éviter_ : dépôt, espace de travail, application

## Les sessions

**Session principale** (`MainSession`) :
Le fil de pilotage d'une feature, un par feature, vivant du début à la fin. C'est là
que se tiennent le découpage en tickets, les questions, les décisions et les échanges
avec `/ask-matt`. Elle dialogue, elle n'ordonnance pas.
_Éviter_ : session de feature, session parente, conversation

**Sous-session** (`SubSession`) :
La session claude-code d'un seul ticket, ouverte vierge dans son propre worktree.
Détruite à la validation du ticket, conservée en cas d'échec pour permettre la reprise.
_Éviter_ : session de ticket, exécuteur, agent, tâche

**Étape** (`Step`) :
Le passage d'un ticket par sa sous-session, du lancement à la validation. Une étape
se termine par un rapport de fin d'étape, jamais par un simple commit.
_Éviter_ : itération, phase, passe, cycle

## La validation

**Fiche de tests** (`TestSheet`) :
La liste des points qu'un humain doit vérifier à la main en fin d'étape : les critères
d'acceptation du ticket qu'aucun test automatique ne couvre, augmentés des suggestions
libres de l'agent. Une fiche non validée interdit la fusion.
_Éviter_ : checklist, plan de test, recette, QA

**Vérification d'intégration** (`IntegrationCheck`) :
La passe de typage et de tests lancée sur la branche de feature après chaque fusion de
ticket. Elle existe parce que deux tickets verts séparément peuvent être rouges ensemble,
ce qu'aucune sous-session ne peut voir depuis son worktree.
_Éviter_ : CI locale, test de fumée, build

## L'autonomie

**Go-as-recommandé** (`goAsRecommended`) :
Le mode où squad draine la frontière sans solliciter l'utilisateur et répond aux questions
de l'agent par sa propre recommandation. Il s'interrompt sur une question structurante, un
ticket de décision, un échec, ou un plafond atteint.
_Éviter_ : mode automatique, pilote automatique, sans surveillance

**Question structurante** (`scopeChanging`) :
Une question dont la réponse change ce qui est construit, par opposition à comment
c'est construit. Une question structurante reste bloquante même en go-as-recommandé.
_Éviter_ : question importante, question bloquante, question critique

**Plafond de concurrence** (`concurrencyCap`) :
Le nombre maximal de sous-sessions simultanées. Déclaré à l'échelle de la machine et
par feature, le plus restrictif l'emportant.

**Plafond de profondeur** (`generationDepthCap`) :
Le nombre maximal de générations successives de tickets engendrés automatiquement par
les agents. Il borne la cascade, pas le nombre total de tickets.

## Relations

- Un **projet** porte plusieurs **features**, simultanément possible.
- Une **feature** possède un **graphe** de **tickets** et une **session principale**.
- Un **ticket** de genre `build` ou `fix` s'exécute dans une **sous-session** ; un ticket
  de genre `decision` ne s'exécute pas et se tranche dans la session principale.
- Une **étape** produit une **fiche de tests**, qui verrouille la fusion du ticket.
- Chaque fusion de ticket déclenche une **vérification d'intégration**, dont l'échec
  engendre un ticket de genre `fix` posé en bloqueur de la suite.

## Ambiguïtés levées

- « étape ou ticket » désignait deux graphes distincts, l'un de blocage et l'autre de
  séquence temporelle. Résolu : le graphe ne contient que des **tickets** et ses flèches
  ne signifient que du **blocage** ; l'**étape** est le passage d'un ticket par sa
  sous-session, et n'est pas un nœud.
- « la session » désignait indifféremment le fil de la feature et celui d'un ticket.
  Résolu : **session principale** et **sous-session**, deux natures aux durées de vie
  opposées.
- « compaction à chaque début d'étape » supposait une session unique par feature, que
  l'exécution parallèle rend impossible. Résolu : une sous-session naît vierge, donc il
  n'y a rien à compacter ; seule la session principale dure, et elle s'en remet à la
  compaction automatique native de claude-code.
