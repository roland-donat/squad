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

**Session de résolution** (`resolveConflict`) :
La session ouverte pour un seul travail, démêler un conflit de fusion, dans le worktree
du ticket concerné et non dans celui de la feature. Ce n'est pas la sous-session du
ticket : elle ne rapporte rien, ne devient pas celle que reprend le ticket, et ce qui
dit si elle a réussi est git, quand squad retente la fusion.
_Éviter_ : sous-session de conflit, agent de merge, session de rattrapage

**Angle de lancement** (`LaunchAngle`) :
Sous quel angle une sous-session est lancée : `implement` pour construire, `diagnose`
pour chercher ce qui cloche avant de retoucher quoi que ce soit. L'angle ne se pose
qu'à la reprise d'un ticket arrêté ; un premier lancement construit.
_Éviter_ : mode, stratégie, intention

**Étape** (`Step`) :
Le passage d'un ticket par sa sous-session, du lancement à la validation. Une étape
se termine par un rapport de fin d'étape, jamais par un simple commit.
_Éviter_ : itération, phase, passe, cycle

## La validation

**Rapport de fin d'étape** (`StepReport`) :
Ce que remet une sous-session quand son étape se termine : ce qu'elle a construit, la
couverture automatique déclarée critère par critère, les points qu'elle suggère de
vérifier à l'œil, et ce qu'elle recommande de faire ensuite. Il arrive par un appel
d'outil, jamais en prose, et c'est lui qui engendre la fiche de tests.
_Éviter_ : compte rendu, résumé de fin, livrable

**Fiche de tests** (`TestSheet`) :
La liste des points qu'un humain doit vérifier à la main en fin d'étape : les critères
d'acceptation du ticket qu'aucun test automatique ne couvre, augmentés des suggestions
libres de l'agent. Écrite une fois pour toutes au moment du rapport, et non recalculée
depuis le ticket : des critères retouchés après coup ne doivent pas changer ce qui a été
mis sous les yeux du développeur. Une fiche non validée interdit la fusion.
_Éviter_ : checklist, plan de test, recette, QA

**Point de vérification** (`TestSheetPoint`) :
Une ligne de la fiche. Elle vient soit d'un critère d'acceptation non couvert, et elle le
nomme, soit d'une suggestion libre de l'agent, et elle n'en nomme aucun : un champ déclaré
les distingue, jamais leur formulation. Cochée, elle est vérifiée ; laissée décochée avec
un commentaire, c'est ce commentaire qui repart dans la sous-session.
_Éviter_ : item, case, entrée

**Alerte** (`Alert`) :
Ce que squad envoie au moment où la progression s'arrête : une notification sur le bureau
de la machine, et un message vers un webhook pour joindre le développeur ailleurs. Deux
canaux best effort, jamais bloquants : une alerte qui ne part pas ne doit rien faire
échouer.
_Éviter_ : notification (le mot désigne un seul des deux canaux)

**En attente de moi** (`PendingAction`) :
Ce qui attend une action du développeur, toutes features confondues : une fiche de tests
non passée en revue, une décision à trancher, une sous-session arrêtée ou interrompue.
Déduit du graphe et jamais stocké, de sorte qu'une attente qui se résout quitte la liste
sans écriture.
_Éviter_ : file d'attente, todo, notifications

**Vérification d'intégration** (`IntegrationCheck`) :
La passe de typage et de tests lancée sur la branche de feature après chaque fusion de
ticket. Elle existe parce que deux tickets verts séparément peuvent être rouges ensemble,
ce qu'aucune sous-session ne peut voir depuis son worktree.
_Éviter_ : CI locale, test de fumée, build

**Feature drainée** (`drained`) :
Une feature dont tous les tickets du graphe sont fusionnés. C'est ce qui déclenche sa
livraison : sa branche est poussée et une pull request est ouverte, décrite depuis ses
tickets et leurs fiches validées.
_Éviter_ : feature finie, feature complète, feature livrée

**Pull request** (`pullRequestUrl`) :
La demande de fusion de la branche de feature dans la branche par défaut. Squad l'ouvre
seul et n'en ouvre qu'une, l'adresse étant écrite sur la feature. Il demande à la forge
de la fusionner dès que l'intégration continue le permet, mais seulement si aucun test
manuel n'a été demandé sur la feature : dès qu'un point de fiche a été mis sous les yeux
de quelqu'un, c'est cette personne qui décide de la suite.
_Éviter_ : PR, merge request, demande de tirage

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
Le nombre maximal de sous-sessions simultanées. Déclaré à l'échelle de la machine dans
les réglages, et par feature sur le projet qui la porte, le plus restrictif l'emportant.
Un lancement demandé alors que les plafonds sont pleins n'est pas refusé : il est
accepté et attend (état `queued`), puis part dès qu'une place se libère. Le refuser
rendrait le développeur responsable de revenir cliquer.

**Ordonnanceur** (`nextLaunches`) :
Ce qui décide des lancements à effectuer : une fonction de l'état des graphes et des
plafonds, sans effet de bord ni appel de modèle. Squad ordonnance, jamais un agent.
Une reprise passe avant un premier lancement, le travail étant déjà sur sa branche ;
à égalité, le lancement qui attend depuis le plus longtemps part le premier.

**Plafond de profondeur** (`generationDepthCap`) :
Le nombre maximal de générations successives de tickets engendrés automatiquement par
les agents. Il borne la cascade, pas le nombre total de tickets.

## Relations

- Un **projet** porte plusieurs **features**, simultanément possible.
- Une **feature** possède un **graphe** de **tickets** et une **session principale**.
- Un **ticket** de genre `build` ou `fix` s'exécute dans une **sous-session** ; un ticket
  de genre `decision` ne s'exécute pas et se tranche dans la session principale.
- Une **étape** se termine par un **rapport de fin d'étape**, qui produit une **fiche de
  tests**, laquelle verrouille la fusion du ticket. Une sous-session qui s'arrête sans
  rapporter ne conclut rien : squad lui redemande son rapport.
- Chaque fusion de ticket déclenche une **vérification d'intégration**, dont l'échec
  engendre un ticket de genre `fix` posé en bloqueur de la suite.
- Les fusions d'un même **projet** sont sérialisées, une seule à la fois, qu'elles
  viennent d'un ticket ou d'une **feature drainée**.
- Une **feature drainée** part en **pull request** ; un conflit ouvre une **session de
  résolution** avant de retenter, et un conflit qui persiste arrête le ticket.

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
