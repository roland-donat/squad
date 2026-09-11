# CLAUDE.md

Ce fichier guide Claude Code (claude.ai/code) sur ce dépôt.

## Vue d'ensemble du projet

`squad` est un poste de pilotage local pour agents claude-code. Il détient le plan
d'exécution d'une feature sous forme de graphe de tickets, lance les sous-sessions qui
construisent chaque tranche dans leur propre worktree, et ne rend à l'utilisateur que
les décisions qu'il ne peut pas déléguer. Le vocabulaire du domaine est fixé dans
[`CONTEXT.md`](CONTEXT.md), les décisions structurantes dans `docs/adr/`, le périmètre
du premier jalon dans l'issue #1.

Un serveur Node local détient la base, expose l'API et sert l'interface ; le navigateur
ne touche jamais le disque. Squad tourne sur le poste de son utilisateur : pas
d'authentification, pas de comptes, pas d'exécution distante.

**Important** : la documentation est rédigée en français accentué, le code et tout
ce qui l'accompagne restent en anglais (noms de variables et de fonctions,
commentaires, docstrings, messages de commit, messages d'erreur, sortie des outils
et des jobs CI).

## Pile technique

| Couche | Technologie |
|---|---|
| Langage | TypeScript 7 en mode strict, ESM |
| Exécution | Node 22 ou plus, `tsx` comme runtime |
| Paquets | pnpm |
| Serveur HTTP | Express 5 |
| Flux d'événements | SSE, une seule route `/api/events` |
| Validation | Zod 4, schémas partagés entre serveur et interface |
| Outils agents | Serveur MCP (`@modelcontextprotocol/sdk`), monté sur la même origine |
| Sessions agents | SDK agent officiel (`@anthropic-ai/claude-agent-sdk`), en entrée en flux |
| Base | SQLite (`better-sqlite3`), sous le répertoire de données de l'utilisateur |
| Schéma et migrations | Drizzle ORM, migrations générées sous `drizzle/` |
| Interface | React 19, Vite |
| Tests au seam | Vitest |
| Test navigateur | Playwright |

Le serveur sert lui-même l'interface, en mode intergiciel Vite pendant le
développement et depuis `dist/ui` en production : une seule origine, un seul port,
aucun proxy propre au développement. Voir `docs/adr/0005`.

## Commandes

```bash
pnpm install          # dépendances ; les scripts de build natifs sont autorisés dans pnpm-workspace.yaml
pnpm dev              # démarre le serveur et sert l'interface (la commande unique)
pnpm verify           # typage puis tests au seam : la commande de vérification du projet
pnpm typecheck        # typage seul
pnpm test             # tests au seam seuls
pnpm test:browser     # test navigateur Playwright (démarre son propre serveur)
pnpm build            # construit l'interface dans dist/ui
pnpm start            # sert l'interface construite, sans Vite
pnpm db:generate      # génère une migration après modification du schéma
```

**Relire toute migration générée avant de la garder.** Quand un même changement
recrée une table (contrainte `check` modifiée) et lui ajoute des colonnes,
`drizzle-kit` copie l'ancienne table en sélectionnant les colonnes nouvelles,
qui n'y existent pas encore : la migration échoue au démarrage sur une base
existante, et jamais sur une base neuve. C'est le cas de `drizzle/0004`, de
`drizzle/0011` et de `drizzle/0015`, corrigés à la main. Une suite verte ne l'attrape pas : la vérifier sur une base écrite par
la version précédente.

Réglages par variable d'environnement : `SQUAD_PORT` (7300 par défaut) et
`SQUAD_DATA_DIR` (par défaut `~/.local/share/squad`, jamais dans un dépôt piloté).

Le reste des réglages vit dans la base, s'édite par l'API et se lit sur l'écran
de réglages de l'interface. `GET` et `PUT` sur `/api/settings` pour ce qui vaut à
l'échelle de la machine : l'URL du webhook d'alerte, le canal de notification de
bureau, le plafond de sous-sessions simultanées, le plafond de profondeur
d'engendrement et le thème de l'interface. `PUT` sur `/api/projects/<id>` pour ce qui est propre à un projet :
le chemin du dépôt, la branche par défaut, le plafond de sous-sessions simultanées
d'une de ses features, et la commande de vérification lancée sur la branche de
feature après chaque fusion. `PUT` sur `/api/features/<id>` pour ce qui est propre
à une feature : le go-as-recommandé et les dépôts qu'elle porte. Le plus restrictif des deux plafonds de
concurrence s'applique. Rien n'est lu dans l'environnement, de sorte que ce qui est
en vigueur se relit par la même surface que le reste.

Ce qui n'est **pas** un réglage vit dans le navigateur et n'est jamais envoyé au
serveur : la largeur du panneau de ticket, la hauteur du tiroir, et le dernier
répertoire atteint en parcourant. Squad n'en lit aucun, et les deux premiers
diffèrent légitimement d'une fenêtre à l'autre. Ce sont des commodités, pas des
réglages, et c'est ce qui les distingue du thème, que le serveur lit pour
peindre la page avant que React ne monte.

Le thème fait exception sur un point, et un seul : sa commande est dans l'en-tête
plutôt que sur l'écran de réglages, parce qu'on s'aperçoit qu'un thème ne va pas
en regardant autre chose, et que devoir naviguer pour le corriger est toute la
gêne. Il reste un réglage comme les autres, tenu en base et diffusé sur le flux ;
le navigateur n'en garde qu'une copie, lue avant le montage de React pour ne pas
peindre le mauvais fond le temps d'un aller-retour, et que rien ne relit jamais
dans squad.

Le chemin d'un projet ne change pas tant qu'une de ses features a un worktree
sorti : les branches de squad partent du dépôt que le projet nomme et y
refusionnent, et déplacer le projet sous elles enverrait une fusion dans un autre
dépôt.

**La commande de vérification n'est facultative que dans le schéma.** Sans elle,
rien ne tourne après une fusion et rien n'est donc jamais rouge : c'est le seul
filet qui attrape ce que deux tranches vertes séparément cassent ensemble, et sur
un dépôt sans intégration continue c'est aussi le seul qui précède la fusion
automatique de la pull request.

## Conventions

- **Langue** : documentation et interface en français accentué, code en anglais.
- **Typographie** : jamais de cadratin `—` ni de demi-cadratin `–`, y compris dans
  les messages de commit et les commentaires. Utiliser `:`, `,`, `(...)` ou couper
  la phrase.
- **Lexique** : ne pas écrire *asserter*, *adresser un problème*, *supporter* au
  sens de *to support*, ni *harnais de test*. Écrire respectivement *supposer* ou
  *considérer*, *traiter*, *prendre en charge*, et *banc d'essai* ou *montage de
  test*.
- **Secrets** : aucun secret en clair dans le dépôt, dans une sortie ou dans un
  journal. Les référencer par nom de variable d'environnement, les valeurs vivant
  hors du dépôt.
- **Artefacts de debug** : captures, dumps, traces et journaux ad-hoc s'écrivent
  sous `/tmp/`, jamais à la racine du projet.
- **Maquettes d'interface** : sous `docs/mockups/`, gitignoré. Ce sont des
  artefacts jetables, les versionner reviendrait à publier une intention comme si
  c'était une spécification.
- **Charte** : palette EdgeMind (EMBlue `#1f416d`, EMOrange `#ef7b26`, EMGray
  `#c9d4e6`) et Open Sans, embarquée sous `src/ui/fonts/` plutôt qu'empruntée à
  la machine. Une couleur porte un sens et le garde dans les deux thèmes, seule
  sa valeur change, ce que `light-dark()` tient en une déclaration par jeton :
  l'accent est EMBlue, et EMOrange ne marque que ce qui attend une action du
  développeur. La marque est **un seul dessin** (`src/ui/brand/`), servi à
  l'en-tête, au favicon et au README ; son bleu est en `currentColor`, donc elle
  suit le thème sans second fichier.

## Conception

Face à deux options, l'une minimale et l'autre plus durable, **retenir la plus
durable** quand les deux s'opposent réellement : contrat explicite, découplage de
premier ordre, propriétés déclarées plutôt que conventions implicites, même au prix
d'un coût initial (nouveau champ, migration, plomberie). La dette de couplage
implicite coûte plus cher à terme.

Cette préférence porte sur la **qualité structurelle** de ce qu'on construit de
toute façon, pas sur le périmètre : YAGNI reste valable pour les fonctionnalités
spéculatives.

## Travail sur le dépôt

- **Un worktree git dédié par chantier** dès que plusieurs travaux peuvent se
  mener en parallèle :
  ```bash
  git worktree add ../worktrees/<sujet> -b <type>/<sujet>
  ```
  Le checkout principal ne quitte jamais `main` : ce qui pointe vers lui
  (instances, liens symboliques, scripts de déploiement) sert alors toujours ce
  qu'on croit qu'il sert.
- **Une suite de tests verte ne suffit pas** à déclarer un correctif terminé quand
  le changement peut toucher le déploiement : valider sur une instance réelle.

### Fin de chantier : fusionner sans demander

Quand une étape, un ticket ou une feature est terminé, **fusionner dans `main`
sans poser la question**, dès lors que les quatre conditions sont réunies :

- la revue de code est passée et ses constats sont traités ;
- la vérification du projet est verte (`pnpm verify`), test navigateur compris
  dès que le changement touche l'interface ;
- le changement a été validé sur une instance réelle quand il peut toucher le
  déploiement ;
- il ne reste **rien à faire vérifier à la main** par l'utilisateur.

Nettoyer dans la foulée, de sorte qu'il ne reste que `main` et ce qui tourne
encore :

```bash
git merge --no-ff <type>/<sujet> -m "Merge branch '<type>/<sujet>'"
git worktree remove ../worktrees/<sujet>
git branch -d <type>/<sujet>
```

**L'exception, et elle seule** : s'il reste un point à faire vérifier à l'œil, un
critère d'acceptation qu'aucun test ne couvre, ou un arbitrage ouvert, ne pas
fusionner. Livrer la branche, dire ce qui reste à vérifier, et attendre.

## Agent skills

### Suivi des issues

Les issues vivent dans GitHub Issues (`roland-donat/squad`), pilotées par la CLI
`gh`. Voir `docs/agents/issue-tracker.md`.

### Labels de triage

Les cinq rôles canoniques, chaque label portant le nom de son rôle. Voir
`docs/agents/triage-labels.md`.

### Documentation de domaine

Contexte unique : `CONTEXT.md` et `docs/adr/` à la racine. Voir
`docs/agents/domain.md`.

### Langue

Les fichiers `docs/agents/` sont repris tels quels des modèles du plugin, donc en
anglais : ce sont des références de commandes, les recopier fidèlement évite d'y
introduire une faute. **Toute communication destinée à un humain suit en revanche
la règle de langue ci-dessus** : titres et corps d'issues, questions posées,
comptes rendus et fiches de tests s'écrivent en français accentué. Les messages de
commit restent en anglais.

## Structure

```
src/shared/                # contrat API partagé serveur et interface, sans dépendance node
src/shared/state-family.ts # les onze états d'un ticket, ramenés aux cinq que peint la carte
src/server/mcp.ts          # le contrat avec les agents, et les bornes de ce qu'ils écrivent
src/server/                # serveur : base, store, git, événements, routes HTTP, outils MCP
src/server/db/             # schéma drizzle et ouverture de la base
src/server/agents/         # lanceur d'agent : l'interface étroite et son repli
src/server/directories.ts  # la marche dans les répertoires de la machine, en lecture seule
src/server/alerts.ts       # bureau et webhook, avec l'adresse de ce qu'ils rapportent
src/server/questions.ts    # ce qu'un agent demande, et l'attente que ça ouvre
src/server/recorded-sessions.ts # les conversations claude-code, lues et jamais interprétées
src/server/resumptions.ts  # une conversation enregistrée devient une feature
src/server/autonomy.ts     # go-as-recommandé : ce qui part seul, et ce qui l'arrête
src/server/scheduler.ts    # ce qui part maintenant : fonction pure du graphe et des plafonds
src/server/dispatch.ts     # la boucle qui ouvre ce que l'ordonnanceur a choisi, les trois sortes
src/server/validations.ts  # ce qui suit une fiche : fusionner, corriger, ou attendre
src/server/settlements.ts  # la vérification préalable : ce qu'une commande tranche, lancé
src/server/merges.ts       # la chaîne de fusion, sérialisée par projet, jusqu'à la livraison
src/server/integration.ts  # la commande de vérification du projet, sur la branche de feature
src/server/forge.ts        # la ligne de commande `gh` : pousser, ouvrir, faire fusionner
src/server/command.ts      # lancer un outil en ligne de commande et rapporter ce qu'il a dit
src/server/pull-request.ts # la description d'une pull request, écrite depuis le graphe
src/server/fix-ticket.ts   # le ticket qu'écrit une vérification d'intégration rouge
src/ui/                    # interface React servie par le serveur
src/ui/route.ts            # l'adresse : ce qui est regardé, tenu dans l'URL
src/ui/tab.ts              # l'onglet d'une feature, nommé d'après elle
src/ui/geometry.ts         # les tailles de panneau, tenues par le navigateur seul
src/ui/home/               # l'accueil et la création d'une feature
src/ui/repository/         # choisir un dépôt en le parcourant, servi par squad
src/ui/Dialog.tsx          # le dialogue natif : état modal, piège à focus et Échap
src/ui/feature/            # l'écran de travail : attente, carte, ticket, tiroir du fil
src/ui/theme.ts            # le thème sur la page, et la copie que lit le premier rendu
src/ui/brand/              # la marque : un seul dessin, pour l'en-tête, le favicon et le README
src/ui/fonts/              # Open Sans sous-ensemblée, la police de la charte EdgeMind
src/ui/graph/              # la carte : couches enveloppées, nœuds à glyphe et anneau
src/ui/graph/viewport.ts   # le pan et le zoom de la carte, et ce qui décide du cadrage
src/ui/question/           # une question d'agent, ses options et sa réponse
src/ui/settings/           # l'écran de réglages, machine et projets
src/ui/ticket/             # le panneau d'un nœud du graphe, fiche de tests comprise
drizzle/                   # migrations générées, versionnées
tests/seam/                # tests au seam : HTTP, flux d'événements et outils MCP
tests/support/             # instance de test, dépôts git temporaires, double du lanceur
tests/browser/             # test navigateur unique, parcours nominal
docs/adr/                  # décisions d'architecture
docs/agents/               # configuration lue par les skills d'ingénierie
CONTEXT.md                 # glossaire du domaine
```

### Où vivent les worktrees

Squad ne crée jamais de checkout dans le dépôt piloté ni à côté de lui : tout va
sous son propre répertoire de données,
`<données>/worktrees/<feature>/repositories/<projet>/feature` pour la branche de
feature d'un dépôt porté, et `<données>/worktrees/<feature>/tickets/<ticket>`
pour chaque branche de ticket. Une feature qui porte trois dépôts a donc trois
branches de feature, une par dépôt, sorties chacune au premier ticket qui la
touche. Le dépôt garde exactement la forme que son propriétaire lui a laissée, et
le checkout principal ne quitte jamais la branche par défaut. La branche et le
chemin sont **écrits sur la ligne** du dépôt porté et du ticket, pas recalculés
depuis leur titre : un ticket renommé demain doit retrouver le worktree qu'il a
ouvert aujourd'hui.

**Un checkout absent se rouvre, une branche absente ne s'invente pas.** Le
répertoire de données voyage d'une machine à l'autre par la synchronisation du
poste, les checkouts non : un seul worktree raichu porte 1,3 Go de sortie de
compilation. Squad rouvre donc un checkout manquant depuis la branche que la
ligne nomme, à l'endroit qu'elle nomme, au moment où quelque chose en a besoin.
Si la branche a disparu elle aussi, il **refuse** : le dépôt en face n'est pas
celui où ce ticket a été construit, et repartir de la branche par défaut rendrait
un ticket qui a l'air repris et qui est vide.

### Quatre écrans, et un onglet par feature

L'accueil (`/`) liste les features à plat, tous dépôts confondus, avec ce qui
attend sur chacune. La création (`/features/new`) ouvre un chantier, de rien ou
d'une conversation claude-code déjà menée. Une feature a **son propre onglet**,
`/features/<feature>` et `/features/<feature>/tickets/<ticket>`, ouvert par un
`window.open` nommé de sorte qu'y entrer deux fois ramène l'onglet plutôt que
d'en ouvrir un second. Les réglages restent sous `/settings`. Voir l'ADR 0007.

Le projet n'est **pas** un niveau de navigation : une feature porte plusieurs
dépôts, donc la ranger sous l'un d'eux serait une approximation. Les segments
sont en anglais comme les routes de l'API, une adresse étant un identifiant
technique.

L'ouverture du tiroir de la session principale est dans l'adresse, en paramètre
de requête (`?thread=open`) : le tiroir est orthogonal au ticket ouvert, les
deux peuvent l'être en même temps, et une alerte sur une question de la session
principale doit pointer un endroit où cette question se répond.

L'adresse est corrigée, jamais subie. Une adresse de l'ancienne forme,
`/projects/<projet>/features/<feature>`, est **toujours lue** : des alertes en
portent et se cliquent des jours plus tard. Elle est réécrite dans la forme
actuelle une fois la page chargée, et depuis l'adresse vivante, jamais depuis une
route tenue dans un rendu, sans quoi un déplacement en cours serait défait. Une
feature que squad ne connaît pas renvoie à l'accueil **en le disant** : avec un
onglet par chantier, le repli silencieux sur la première feature venue ferait
atterrir sur un travail qui n'est pas celui qu'une alerte désignait.

Le serveur écrit ces adresses autant que l'interface les lit, d'où leur place
dans `src/shared/ui-routes.ts` : une alerte porte l'adresse de la feature ou du
ticket dont elle parle, et les deux côtés ne peuvent pas diverger sur la forme
d'un chemin. `src/ui/route.ts` ne garde que ce qui tient au navigateur,
l'historique et l'abonnement à la barre d'adresse.

### Le stockage de claude-code, lu et jamais écrit

Squad lit les conversations que claude-code range sous `~/.claude/projects`, un
répertoire par projet et un `.jsonl` par session, pour proposer d'en reprendre
une. Trois règles tiennent cette lecture :

- **Seules les sessions**, c'est-à-dire `<projet>/<session>.jsonl`. Ce qui vit
  sous `<session>/subagents/` est le fil d'un agent qu'une session a lancé : sur
  un poste réel, 169 sessions cohabitent avec 1250 de ces fils, et aucun ne se
  reprend comme session principale.
- **Seulement l'en-tête.** Les transcripts atteignent 79 Mo pièce, 1,6 Go au
  total ; tout ce que squad affiche (identifiant, chemin, branche, titre,
  premier message) tient dans les premières lignes. Elles sont lues dans un
  tampon de 16 ko ouvert sur le fichier, jamais par un `readFile` qu'on
  tronquerait ensuite : mesuré sur le poste, 168 sessions listées en 71 ms pour
  19 Mo de mémoire, là où lire les fichiers entiers coûtait 1,9 s et 280 Mo.
- **En mode dégradé.** C'est le stockage privé d'un autre programme, non
  documenté : un répertoire absent, un fichier illisible ou une ligne d'une
  forme inconnue donnent moins de sessions, jamais une erreur.

Rattacher une conversation n'ouvre aucune session : une session claude-code
reprise sans rien à dire n'a rien à faire et se termine aussitôt. Le
rattachement écrit ce à quoi la feature est liée, et c'est le premier message
envoyé dans le fil qui reprend la conversation. La reprise vaut ensuite pour
tous les démarrages de cette feature, pas seulement le premier : une session
vit le temps de son processus, et celle qui lui succède est le même fil de
travail.

Squad lit ce qui identifie une conversation, l'identifiant, le chemin, la
branche, le titre et le début du premier message, qui sert à nommer la feature.
Le corps de la conversation n'est jamais lu, et rien de ce qui s'y trouve ne
devient un état de squad. Ce que la conversation contient, c'est à la session
reprise de le dire, par un appel d'outil, jamais à squad de l'analyser
(ADR 0002).

### Les alertes pendant les tests

Squad lève une notification de bureau chaque fois que la progression s'arrête, et
la suite au seam tourne sur le bureau d'un développeur. `startTestSquad` coupe
donc ce canal par un `PUT /api/settings`, comme le ferait un utilisateur : c'est
un réglage, pas une trappe de test. Un scénario qui veut observer une alerte
branche un vrai webhook (`tests/support/webhook.ts`) et lit ce qui y arrive.

### La forge pendant les tests

Squad atteint GitHub par la ligne de commande `gh`, jamais par son API HTTP :
`gh` détient déjà les identifiants du développeur, et squad n'a pas à devenir un
endroit où un jeton est stocké. Les tests placent donc un vrai exécutable `gh` en
tête de `PATH` (`tests/support/gh.ts`) : squad lance un processus, lui passe des
arguments et lit ce qu'il écrit, exactement comme avec le vrai. Ce qui est retiré
est le réseau et un compte, pas le contrat. Même esprit que le webhook d'alerte,
et ce n'est pas un double d'un module de squad.

### Le double du lanceur d'agent

Le seul double d'un module de squad, et il le reste : le webhook d'alerte et la ligne de
commande `gh` sont de vrais programmes qui tiennent la place de services extérieurs, pas
des doubles. Au lieu de démarrer un processus claude-code, celui-ci rejoue un scénario
scripté d'appels d'outils et de messages, puis se termine. Il appelle les outils par HTTP
comme le ferait un agent : le transport, la base et le dépôt git restent réels, seul le
non-déterminisme du modèle est retiré. Voir `tests/support/scripted-launcher.ts`.

### Où écrire un test

Le seul seam est l'API du serveur, flux d'événements et outils MCP compris : un test
pilote squad comme le font l'interface et les agents, jamais en atteignant un module de
l'intérieur. Un test qui casse à
la première réorganisation de modules teste la mauvaise chose. Le test navigateur est
unique et prouve le câblage de l'interface, il ne duplique pas la couverture métier.
