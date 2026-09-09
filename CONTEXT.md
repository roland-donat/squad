# squad

Poste de pilotage local pour agents claude-code. Squad détient le plan d'exécution
d'une feature sous forme de graphe, lance les sessions qui construisent chaque
tranche, et rend à l'utilisateur les seules décisions qu'il ne peut pas déléguer.

Chaque terme donne entre parenthèses son identifiant en code : la documentation est
en français, le code reste en anglais.

## Le graphe

**Ticket** (`Ticket`) :
L'unité de travail de squad, et le seul type de nœud du graphe. Porte un genre déclaré
et le **dépôt porté** dans lequel il se construit, celui d'attache de sa feature à
défaut.
_Éviter_ : issue, tâche, étape, story, carte

**Genre** (`TicketKind`) :
Ce qu'un ticket demande : `build` (une tranche verticale à construire), `decision`
(une question à trancher, qui ne s'exécute pas), `fix` (une correction née d'un test
manuel en échec ou d'une vérification d'intégration rouge).
_Éviter_ : type, catégorie, nature

**Arête de blocage** (`BlockingEdge`) :
La relation orientée « A doit être fusionné avant que B puisse partir ». C'est la
seule relation du graphe, donc la seule chose que puisse signifier une flèche. Elle
relie deux tickets d'une même feature, y compris quand ils se construisent dans deux
dépôts différents : c'est ce qui rend un ordre inter-dépôts exprimable.
_Éviter_ : dépendance, lien, parent, enfant, sous-tâche

**Frontière** (`frontier`) :
L'ensemble des tickets dont tous les bloqueurs sont fusionnés. C'est ce que squad
peut lancer à l'instant présent.
_Éviter_ : file d'attente, backlog, tickets prêts, prochaine vague

**Feature** (`Feature`) :
Un chantier, du spec jusqu'à la fusion dans les branches par défaut. Une feature
possède un graphe et une session principale, et porte un ou plusieurs **dépôts
portés**. Son **projet d'attache** est celui où tourne sa session principale et où
se construisent ses tickets qui ne disent rien d'autre.
_Éviter_ : chantier, epic, lot, sprint

**Dépôt porté** (`FeatureRepository`) :
Un des dépôts qu'une feature a le droit de toucher, avec ce que squad y a ouvert :
sa branche de feature, son worktree et sa pull request. Une feature en porte
plusieurs quand le travail en traverse plusieurs, une interface changée ici et ses
appelants là. Chacun est sorti en worktree au premier ticket qui le touche, et pas
avant. Un ticket qui nomme un dépôt non porté est refusé à l'écriture ; la liste se
déclare à l'ouverture de la feature, et la session principale peut l'étendre par
appel d'outil à un dépôt que squad pilote déjà.
_Éviter_ : sous-projet, module, dépendance

**Projet** (`Project`) :
Un dépôt git piloté par squad. Un projet peut porter plusieurs features en vol, et
être porté par des features attachées ailleurs.
_Éviter_ : dépôt, espace de travail, application

## Les sessions

**Session principale** (`MainSession`) :
Le fil de pilotage d'une feature, un par feature, vivant du début à la fin. C'est là
que se tiennent le découpage en tickets, les questions, les décisions et les échanges
avec `/ask-matt`. Elle dialogue, elle n'ordonnance pas.
_Éviter_ : session de feature, session parente, conversation

**Session enregistrée** (`RecordedSession`) :
Une conversation claude-code déjà menée, que squad lit dans le stockage de claude-code pour
en faire le point de départ d'une feature. La rattacher ouvre une feature dont la session
principale est cette conversation, reprise sur son identifiant : le grilling et le spec
écrits au terminal sont donc encore en tête. Squad n'en lit que ce qui l'identifie, le dépôt
où elle a tourné, la branche, son titre et le premier message ; ce qui s'y est dit ne devient
jamais un état de squad. Une conversation appartient à une seule feature.
_Éviter_ : historique, archive, transcript, log

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
Ce que remet une sous-session quand son étape se termine : ce qu'elle a construit, le
verdict de règlement déclaré critère par critère, les points qu'elle suggère de faire
juger, et ce qu'elle recommande de faire ensuite. Il arrive par un appel d'outil, jamais
en prose, et c'est lui qui engendre la fiche de tests.
_Éviter_ : compte rendu, résumé de fin, livrable

**Verdict de règlement** (`CriterionVerdict`) :
Comment un critère d'acceptation a été réglé, déclaré par la sous-session : `automated`
quand un test le couvre et continuera de le couvrir, `checked` quand aucun test ne le
couvre mais que l'agent l'a réglé lui-même en lançant quelque chose, `judgement` quand
seul un humain peut trancher. Trois verdicts et non deux, parce qu'entre « un test le
couvre » et « seul un humain peut le dire » se trouve tout ce qu'un agent règle en
lançant une commande, et c'en est la plus grande part. Un `checked` porte
obligatoirement la note de ce qui a été lancé et de ce que ça a répondu : sans elle, le
développeur ne distingue pas une vérification d'une affirmation, et refaire le travail
est son seul recours.
_Éviter_ : couverture (le mot ne nomme que le premier des trois)

**Fiche de tests** (`TestSheet`) :
La liste des points qu'un humain doit juger en fin d'étape : les critères d'acceptation
déclarés `judgement`, augmentés des suggestions libres de l'agent. Ce qu'une commande, un
test ou un script tranche n'y figure pas : le porter reviendrait à rendre au développeur
le travail qui lui a été délégué, sous la seule forme qu'il ne peut pas traiter. Écrite
une fois pour toutes au moment du rapport, et non recalculée depuis le ticket : des
critères retouchés après coup ne doivent pas changer ce qui a été mis sous les yeux du
développeur. Une fiche non validée interdit la fusion.
_Éviter_ : checklist, plan de test, recette, QA

**Dépouillement** (`Settlement`) :
La passe que squad fait sur une fiche de tests avant de réveiller qui que ce soit : une
session ouverte pour ce seul travail, dans le worktree du ticket, qui lance ce qui répond
à un point et ne rend que ce qu'aucune commande ne tranche. Elle ne modifie rien, ne
commite pas et ne fusionne pas ; ce qu'elle trouve cassé repart à la sous-session qui l'a
construit. Trois issues par point : `holds`, le point tient, `broken`, il ne tient pas,
`human`, seul un humain peut le dire, et seule la dernière arrive au développeur. Chaque
issue porte obligatoirement la note de ce qui a été lancé, ou de pourquoi rien ne peut
l'être. **Le repli va vers l'humain** : une passe qui échoue, qui se termine sans rien
déclarer ou que squad n'a pas pu ouvrir laisse la fiche exactement telle que la
sous-session l'a écrite.
La passe part d'elle-même après chaque rapport de fin d'étape, et se demande aussi à la
main sur une fiche déjà en attente : pour celles rapportées avant qu'elle existe, et pour
un second regard sur ce qu'un premier passage a rendu. Demandée, elle ignore la borne de
deux tours, qui n'est là que pour empêcher squad de se contredire tout seul.
_Éviter_ : relecture, revue, contrôle qualité, filtre

**Point de vérification** (`TestSheetPoint`) :
Une ligne de la fiche. Elle vient soit d'un critère d'acceptation que seul un humain peut
trancher, et elle le nomme, soit d'une suggestion libre de l'agent, et elle n'en nomme
aucun : un champ déclaré les distingue, jamais leur formulation. Cochée, elle est
vérifiée ; laissée décochée avec un commentaire, c'est ce commentaire qui repart dans la
sous-session. Le dépouillement écrit sur elle avant le développeur, dans un champ à part :
le verdict reste le mot du développeur, l'issue du dépouillement est celui de squad, et
lire les deux dit qui a conclu quoi. Un point qu'une passe a réglé n'est plus demandé au
développeur, sa preuve est lue à la place.
_Éviter_ : item, case, entrée

**Alerte** (`Alert`) :
Ce que squad envoie au moment où la progression s'arrête : une notification sur le bureau
de la machine, et un message vers un webhook pour joindre le développeur ailleurs. Deux
canaux best effort, jamais bloquants : une alerte qui ne part pas ne doit rien faire
échouer. Chaque alerte déclare ce dont elle parle, et porte l'adresse de squad pour cette
feature ou ce ticket : elle se lit sur un téléphone, et son seul geste utile est d'ouvrir
ce qu'elle rapporte.
_Éviter_ : notification (le mot désigne un seul des deux canaux)

**Actions en attente** (`PendingAction`) :
Ce qui attend une action **du développeur**, toutes features confondues : une fiche de
tests non passée en revue, une décision à trancher, une sous-session arrêtée ou
interrompue. Ce ne sont pas les tickets que squad n'a pas encore lancés : un ticket
qu'une arête de blocage retient attend une fusion, pas une personne, et ne figure donc
pas ici. Déduit du graphe et jamais stocké, de sorte qu'une attente qui se résout quitte
la liste sans écriture.
_Éviter_ : file d'attente, todo, notifications, tickets en attente

**Vérification d'intégration** (`IntegrationCheck`) :
La passe de typage et de tests lancée sur la branche de feature après chaque fusion de
ticket. Elle existe parce que deux tickets verts séparément peuvent être rouges ensemble,
ce qu'aucune sous-session ne peut voir depuis son worktree.
_Éviter_ : CI locale, test de fumée, build

**Feature drainée** (`drained`) :
Une feature dont tous les tickets du graphe sont fusionnés, tous dépôts confondus.
C'est ce qui déclenche sa livraison : chaque dépôt porté voit sa branche poussée et
une pull request ouverte, décrite depuis les tickets de ce dépôt et leurs fiches
validées. Une par dépôt, sans coordination entre elles : ce sont des branches
distinctes sur des dépôts distincts, et chacune part dès que sa propre intégration
continue le permet.
_Éviter_ : feature finie, feature complète, feature livrée

**Pull request** (`pullRequestUrl`) :
La demande de fusion de la branche de feature dans la branche par défaut. Squad l'ouvre
seul et n'en ouvre qu'une, l'adresse étant écrite sur la feature. Il demande à la forge
de la fusionner dès que l'intégration continue le permet, mais seulement si aucun test
manuel n'a été demandé sur la feature : dès qu'un point de fiche a été mis sous les yeux
de quelqu'un, c'est cette personne qui décide de la suite.
_Éviter_ : PR, merge request, demande de tirage

## L'autonomie

**Question** (`Question`) :
Ce qu'un agent demande au développeur : un énoncé, au moins deux options, celle qu'il
recommande, et un drapeau disant si la réponse change le périmètre. L'appel d'outil qui la
pose ne rend la main qu'une fois la question répondue, ce qui fait de l'interface le lieu où
elle se tranche, sans terminal ni second mécanisme. La réponse est libre : les options sont
ce que l'agent a envisagé, et la réponse qu'il n'a pas envisagée est justement celle qui vaut
d'être possible. Qui a répondu est consigné (`answeredBy`), le développeur ou squad.
_Éviter_ : demande, prompt, sollicitation, interaction

**Go-as-recommandé** (`goAsRecommended`) :
Le mode, déclaré par feature, où squad lance seul ce que la frontière permet et répond aux
questions d'implémentation par la recommandation de l'agent qui les pose. Il s'interrompt
sur une question structurante, sur un plafond de profondeur atteint, et, dès lors qu'il n'a
plus rien à lancer ni rien en vol, sur ce qui le bloque : un ticket de décision, un ticket
arrêté ou en conflit. S'interrompre n'annule rien : ce qui tourne continue, et seul le
développeur relance le mode.
_Éviter_ : mode automatique, pilote automatique, sans surveillance

**Interruption du mode** (`AutonomyHalt`) :
Ce qui a arrêté le go-as-recommandé, écrit sur la feature : la raison et ce sur quoi il a
buté. Le mode reste armé, et le réarmer est ce qui dit que la raison est traitée.
_Éviter_ : pause, suspension, erreur

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
les agents. Il borne la cascade, pas le nombre total de tickets. Chaque ticket porte sa
profondeur (`generation`) : zéro pour ce qu'écrit la session principale, une de plus que
le ticket dont le travail l'a fait apparaître. L'atteindre suspend le drain et alerte ;
le ticket est écrit quand même et rien de ce qui tourne n'est annulé.

## Relations

- Un **projet** porte plusieurs **features**, simultanément possible.
- Une **feature** possède un **graphe** de **tickets** et une **session principale**,
  et porte un ou plusieurs **dépôts portés** ; chaque **ticket** se construit dans
  l'un d'eux, et une **arête** relie deux tickets de la feature quels que soient
  leurs dépôts.
- Un **ticket** de genre `build` ou `fix` s'exécute dans une **sous-session** ; un ticket
  de genre `decision` ne s'exécute pas et se tranche dans la session principale.
- Une **étape** se termine par un **rapport de fin d'étape**, qui produit une **fiche de
  tests**, laquelle verrouille la fusion du ticket. Une sous-session qui s'arrête sans
  rapporter ne conclut rien : squad lui redemande son rapport.
- Chaque fusion de ticket déclenche une **vérification d'intégration**, dont l'échec
  engendre un ticket de genre `fix` posé en bloqueur de la suite.
- Les fusions d'un même **projet** sont sérialisées, une seule à la fois, qu'elles
  viennent d'un ticket ou d'une **feature drainée**. Deux tickets d'une même feature
  qui vivent dans deux dépôts fusionnent donc de front.
- Une **feature drainée** part en **pull request** ; un conflit ouvre une **session de
  résolution** avant de retenter, et un conflit qui persiste arrête le ticket.
- Une **question** est posée par une session, sur son ticket pour une sous-session, sur la
  feature pour la session principale. En **go-as-recommandé**, une question d'implémentation
  reçoit la recommandation de l'agent ; une **question structurante** interrompt le mode et
  attend le développeur.

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
