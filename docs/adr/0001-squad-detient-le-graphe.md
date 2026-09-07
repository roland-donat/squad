# Squad détient le graphe d'exécution

La source de vérité du graphe de tickets est la base locale de squad, pas le tracker
d'issues ni les fichiers markdown que produit `/to-tickets`. Squad ne lit donc jamais un
plan écrit ailleurs : c'est lui qui fournit les outils avec lesquels le plan s'écrit.

## Alternatives écartées

**GitHub Issues comme source de vérité**, malgré ses liens de blocage natifs : un
aller-retour réseau à chaque mise à jour alors que l'affichage se veut temps réel, et
surtout aucune place pour ce que squad doit stocker par ticket (identifiant de
sous-session, fiche de tests cochée, retours par point, journal d'exécution). Ces données
auraient fini en commentaires markdown à parser.

**Les fichiers `.scratch/<feature>/issues/*.md`** : leurs arêtes de blocage sont écrites
en prose libre sous un champ « Blocked by ». Un analyseur construit dessus serait faux de
façon intermittente, c'est-à-dire de la pire façon.

## Conséquences

Le tracker devient une projection sortante optionnelle, hors du premier jalon. Le champ
d'identifiant externe existe dès le premier schéma pour que l'ajouter plus tard ne
demande aucune migration.
