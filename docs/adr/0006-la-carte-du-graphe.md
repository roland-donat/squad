# La carte du graphe

Le graphe d'une feature se lit comme une **carte de situation** : on y répond à
« où en est le chantier et à qui est le tour », pas « que dit ce ticket ». Le
détail d'un ticket est à un clic, dans son panneau. Trois choix découlent de
cette lecture et sont coûteux à défaire.

## La disposition est une fonction du graphe, et de rien d'autre

Aucune coordonnée n'est stockée, et la largeur de la fenêtre n'entre pas dans le
calcul. Une couche, c'est-à-dire tout ce qu'aucun bloqueur ne retient au même
rang, est enveloppée en un bloc de `ceil(racine(n))` colonnes.

Mesuré sur une feature réelle de 27 tickets et 14 arêtes : la couche 0 en portait
15, soit une rangée unique de **3 872 px** dans une colonne qui en offrait 850.
Enveloppée, la même couche devient un bloc de 4 sur 4, et la carte entière tient
en **764 x 1 120 px**.

Une largeur déduite du viewport aurait mieux rempli l'écran. Elle a été écartée :
la même feature se lirait autrement sur deux écrans, chaque redimensionnement
déplacerait tous les nœuds, et la mémoire spatiale ne s'installerait jamais. Or
c'est elle, et rien d'autre, qui fait qu'une carte sert à quelque chose.

Corollaire assumé : **le cadrage ne vit pas dans l'adresse**. L'URL de squad dit
ce qui est regardé, pas où se pose l'œil ; un lien qui transporterait un cadrage
serait faux dès le ticket suivant. Le cadrage se refait à l'ouverture d'une
feature, jamais sur une mise à jour du graphe, faute de quoi un ticket écrit par
la session principale recadrerait la vue pendant qu'on lit.

## Le pan et le zoom sont écrits ici

Une transformation CSS, des événements de pointeur, un écouteur `wheel` non
passif. Pas de bibliothèque.

React Flow a été envisagé et écarté : il ne sait pas produire cette disposition,
il ne dessine pas ces nœuds, et il impose son modèle de données par-dessus celui
de squad. On paierait 100 ko pour en désactiver la moitié. `d3-zoom` traite les
cas tordus du pavé tactile, ce qui est réel, mais pour une centaine de lignes sur
un problème fermé, dans un projet qui n'a aucune dépendance d'interface hors
React.

Ce qu'on accepte : les cas tordus sont à nous. Notamment, la molette zoome sans
modificateur, donc sur pavé tactile le défilement à deux doigts zoome ; et rien
ne distingue de façon fiable une molette d'un pavé.

## L'interface est une coque, pas un document

Hauteur fixe, aucun défilement de page, les panneaux défilant chacun chez eux.

C'est ce qui rend la molette disponible pour le zoom : dans une page longue, une
carte qui capte la molette empêche de défiler tant que le pointeur est dessus,
et c'est la gêne classique d'une carte posée dans un document. C'est aussi ce
qu'est un poste de pilotage. Le coût est que les panneaux de mise en route,
enregistrer un projet, ouvrir une feature, reprendre une conversation, quittent
le bas de la page pour des dialogues ouverts depuis la barre latérale.

## Ce que la carte ne code jamais par la seule couleur

Un genre est une silhouette pleine, une famille d'état est un anneau dont le
tracé dit laquelle. La couleur ne fait que redire. EMOrange ne marque que la
famille **attend une personne**, ce qui a fait perdre au genre `decision` le
liseré orange qu'il portait : un ticket de décision que personne n'attend encore
n'a pas à être chaud.

Le nœud garde son titre, tronqué à deux lignes. Des nœuds muets à formes
variées, où le losange dirait `decision`, ont été envisagés : trois genres et
onze états font trente-trois combinaisons qu'aucun jeu de formes ne porte, et un
losange tient très mal deux lignes de texte.
