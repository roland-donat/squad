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
existante, et jamais sur une base neuve. C'est le cas de `drizzle/0004`, corrigé
à la main. Une suite verte ne l'attrape pas : la vérifier sur une base écrite par
la version précédente.

Réglages par variable d'environnement : `SQUAD_PORT` (7300 par défaut) et
`SQUAD_DATA_DIR` (par défaut `~/.local/share/squad`, jamais dans un dépôt piloté).

Le reste des réglages vit dans la base, s'édite par l'API et se lit sur l'écran
de réglages de l'interface. `GET` et `PUT` sur `/api/settings` pour ce qui vaut à
l'échelle de la machine : l'URL du webhook d'alerte, le canal de notification de
bureau, le plafond de sous-sessions simultanées et le plafond de profondeur
d'engendrement. `PUT` sur `/api/projects/<id>` pour ce qui est propre à un projet :
le chemin du dépôt, la branche par défaut, le plafond de sous-sessions simultanées
d'une de ses features, et la commande de vérification lancée sur la branche de
feature après chaque fusion. `PUT` sur `/api/features/<id>` pour ce qui est propre
à une feature : le go-as-recommandé. Le plus restrictif des deux plafonds de
concurrence s'applique. Rien n'est lu dans l'environnement, de sorte que ce qui est
en vigueur se relit par la même surface que le reste.

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
src/server/                # serveur : base, store, git, événements, routes HTTP, outils MCP
src/server/db/             # schéma drizzle et ouverture de la base
src/server/agents/         # lanceur d'agent : l'interface étroite et son repli
src/server/alerts.ts       # bureau et webhook, quand la progression s'arrête
src/server/questions.ts    # ce qu'un agent demande, et l'attente que ça ouvre
src/server/autonomy.ts     # go-as-recommandé : ce qui part seul, et ce qui l'arrête
src/server/scheduler.ts    # ce qui part maintenant : fonction pure du graphe et des plafonds
src/server/validations.ts  # ce qui suit une fiche : fusionner, corriger, ou attendre
src/server/merges.ts       # la chaîne de fusion, sérialisée par projet, jusqu'à la livraison
src/server/integration.ts  # la commande de vérification du projet, sur la branche de feature
src/server/forge.ts        # la ligne de commande `gh` : pousser, ouvrir, faire fusionner
src/server/command.ts      # lancer un outil en ligne de commande et rapporter ce qu'il a dit
src/server/pull-request.ts # la description d'une pull request, écrite depuis le graphe
src/server/fix-ticket.ts   # le ticket qu'écrit une vérification d'intégration rouge
src/ui/                    # interface React servie par le serveur
src/ui/graph/              # disposition en couches et rendu du graphe
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
sous son propre répertoire de données, `<données>/worktrees/<feature>/feature`
pour la branche de feature et `<données>/worktrees/<feature>/tickets/<ticket>`
pour chaque branche de ticket. Le dépôt garde donc exactement la forme que son
propriétaire lui a laissée, et le checkout principal ne quitte jamais la branche
par défaut. La branche et le chemin sont **écrits sur la ligne** de la feature et
du ticket, pas recalculés depuis leur titre : un ticket renommé demain doit
retrouver le worktree qu'il a ouvert aujourd'hui.

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
