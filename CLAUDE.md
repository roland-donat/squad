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
pnpm install          # dépendances ; les scripts de build natifs sont déjà autorisés
pnpm dev              # démarre le serveur et sert l'interface (la commande unique)
pnpm verify           # typage puis tests au seam : la commande de vérification du projet
pnpm typecheck        # typage seul
pnpm test             # tests au seam seuls
pnpm test:browser     # test navigateur Playwright (démarre son propre serveur)
pnpm build            # construit l'interface dans dist/ui
pnpm start            # sert l'interface construite, sans Vite
pnpm db:generate      # génère une migration après modification du schéma
```

Réglages par variable d'environnement : `SQUAD_PORT` (7300 par défaut) et
`SQUAD_DATA_DIR` (par défaut `~/.local/share/squad`, jamais dans un dépôt piloté).

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
src/shared/            # contrat API partagé serveur et interface, sans dépendance node
src/server/            # serveur : base, store, git, événements, routes HTTP, outils MCP
src/server/db/         # schéma drizzle et ouverture de la base
src/server/agents/     # lanceur d'agent : l'interface étroite et son repli
src/ui/                # interface React servie par le serveur
src/ui/graph/          # disposition en couches et rendu du graphe
src/ui/ticket/         # le panneau qu'ouvre un nœud du graphe
drizzle/               # migrations générées, versionnées
tests/seam/            # tests au seam : HTTP, flux d'événements et outils MCP
tests/support/         # instance de test, dépôts git temporaires, double du lanceur
tests/browser/         # test navigateur unique, parcours nominal
docs/adr/              # décisions d'architecture
docs/agents/           # configuration lue par les skills d'ingénierie
CONTEXT.md             # glossaire du domaine
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

### Le double du lanceur d'agent

Le seul double de la suite. Au lieu de démarrer un processus claude-code, il rejoue un
scénario scripté d'appels d'outils et de messages, puis se termine. Il appelle les outils
par HTTP comme le ferait un agent : le transport, la base et le dépôt git restent réels,
seul le non-déterminisme du modèle est retiré. Voir `tests/support/scripted-launcher.ts`.

### Où écrire un test

Le seul seam est l'API du serveur, flux d'événements et outils MCP compris : un test
pilote squad comme le font l'interface et les agents, jamais en atteignant un module de
l'intérieur. Un test qui casse à
la première réorganisation de modules teste la mauvaise chose. Le test navigateur est
unique et prouve le câblage de l'interface, il ne duplique pas la couverture métier.
