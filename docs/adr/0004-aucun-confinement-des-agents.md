# Les agents tournent sans confinement ni demande d'autorisation

Les sous-sessions sont lancées avec les autorisations d'outil désactivées, sans bac à
sable ni conteneur : plusieurs agents peuvent donc écrire partout où le compte de
l'utilisateur peut écrire, chemins absolus compris, y compris sans surveillance en mode
go-as-recommandé. Squad est par ailleurs autorisé à pousser et à fusionner seul.

## Pourquoi

Une demande d'autorisation qui reste sans réponse bloque un ticket entier pendant des
heures, ce qui est le pire mode de défaillance pour un outil dont l'intérêt est de
travailler pendant qu'on ne regarde pas. Un conteneur par ticket aurait donné une
isolation réelle, au prix d'une image à maintenir par projet, des identifiants à y
replomber, et d'un démarrage plus lent à chaque ticket.

## Conséquences

Le seul rempart est que les sessions chargent bien les `CLAUDE.md` globaux et de projet et
en respectent les consignes. Ce n'est pas une contrainte technique, c'est une consigne.

Les sessions ne doivent donc jamais être lancées en mode minimal, et les sources de
réglages utilisateur, projet et locales doivent rester explicitement actives : les couper
retirerait le dernier garde-fou sans que rien ne le signale.
