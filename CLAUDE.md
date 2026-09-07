# CLAUDE.md

Ce fichier guide Claude Code (claude.ai/code) sur ce dépôt.

## Vue d'ensemble du projet

> **À compléter.** L'objet de `squad` n'est pas encore écrit : ce qu'il fait, pour
> qui, et le problème qu'il résout. Tant que cette section est vide, aucun agent
> ne peut arbitrer correctement une décision de conception sur ce dépôt.

**Important** : la documentation est rédigée en français accentué, le code et tout
ce qui l'accompagne restent en anglais (noms de variables et de fonctions,
commentaires, docstrings, messages de commit, messages d'erreur, sortie des outils
et des jobs CI).

## Pile technique

> **À décider.** Aucune pile n'est arrêtée à ce jour. Le dépôt ne contient que la
> licence, le `.gitignore` et cette documentation.
>
> Une fois la pile choisie, remplir un tableau `| Couche | Technologie |` sur le
> modèle des autres projets, et renseigner la section « Commandes » ci-dessous.

## Commandes

> **À compléter** en même temps que la pile. Y faire figurer, au minimum :
> installation des dépendances, lancement en développement, tests, build et
> linting.

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
LICENSE                  # MIT
README.md                # présentation courte
CLAUDE.md                # ce fichier
CONTEXT.md               # glossaire du domaine
docs/adr/                # décisions d'architecture
docs/agents/             # configuration lue par les skills d'ingénierie
.gitignore
```
