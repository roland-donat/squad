# Consignes Codex pour squad

## Charger le contexte avant de travailler

1. **Lire intégralement [CLAUDE.md](CLAUDE.md)** au début de chaque session,
   avant toute analyse ou modification du dépôt, sauf si son contenu intégral
   est déjà chargé. Ce fichier est le référentiel commun à Claude Code et Codex :
   contexte du projet, architecture, commandes, conventions, conception,
   validation, fusion et nettoyage. Toutes ses consignes s'appliquent à Codex.
2. Lire aussi `CLAUDE.local.md` s'il existe. Avant de travailler dans un
   sous-répertoire, lire les `AGENTS.md`, `CLAUDE.md` et `CLAUDE.local.md` qui
   s'appliquent à ce chemin. Les consignes plus locales précisent leur périmètre.
3. Lire explicitement les fichiers importés par une directive `@chemin`, en
   résolvant chaque chemin relatif depuis le fichier qui le référence. Suivre
   leurs propres imports sans relire un fichier déjà chargé ; une directive
   seule ne vaut pas lecture de son contenu.
4. Avant d'explorer le code, lire [CONTEXT.md](CONTEXT.md) et appliquer
   [les consignes de domaine](docs/agents/domain.md). Lire les décisions de
   [docs/adr/](docs/adr/) pertinentes pour le travail demandé.

Ce point d'entrée charge le référentiel existant pour que les évolutions de
`CLAUDE.md` bénéficient aux deux agents. Maintenir les règles communes dans
`CLAUDE.md` ; réserver `AGENTS.md` aux adaptations Codex. Les préférences personnelles
et les chemins propres au poste restent dans la configuration globale de Codex
et dans les fichiers locaux.

## Adapter les mécanismes à Codex

- **Outils** : les noms `Bash`, `Read`, `WebSearch`, `WebFetch`, `Skill` et
  `AskUserQuestion` désignent des capacités. Employer les outils disponibles
  dans la session ; pour une compétence, lire son `SKILL.md` et appliquer ses
  consignes. Vérifier la disponibilité des compétences, connecteurs et hooks
  cités par les documents Claude avant de s'appuyer dessus.
- **Questions** : employer l'outil interactif autorisé dans le mode courant,
  avec la recommandation en premier et la mention `(Recommandé)`. S'il est
  indisponible ou interdit pour ce type de question, poser une question concise
  en texte. Prendre les décisions de réalisation clairement plus fiables dans
  le périmètre déjà autorisé.
- **Revues et sous-agents** : appliquer les préférences de revue avec les
  capacités et les limites de délégation de la session. Une revue reste à faire
  même si le modèle ou l'outil cité dans une compétence n'est pas disponible.
- **RTK** : appeler `rtk` explicitement pour un résumé utile si l'outil est
  disponible. Pour une revue ou une recherche exhaustive, lire les sorties
  brutes de `git diff`, `git show` et `rg`, ou employer `rtk proxy`.
- **GitHub** : avant de manipuler les issues, lire
  [le suivi des issues](docs/agents/issue-tracker.md) ; avant de trier ou de
  modifier leurs labels, lire [les labels de triage](docs/agents/triage-labels.md).
  Les noms de commandes de plugin dans ces références se traduisent par les
  compétences disponibles et la CLI `gh` documentée.

Les adaptations portent sur l'agent qui développe squad. Les références à
claude-code dans le produit, son SDK et son stockage de conversations conservent
leur sens métier et technique.
