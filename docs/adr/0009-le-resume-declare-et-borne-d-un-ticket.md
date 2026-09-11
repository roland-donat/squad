# Un ticket porte un résumé déclaré et borné, écrit par l'agent

Un ticket dit deux choses à deux lecteurs. La **description** s'adresse à la session qui
le construit, et reste aussi longue qu'il le faut. Le **résumé** s'adresse au
développeur : un contexte court, la problématique en une phrase, et cette problématique
montrée sur l'**exemple fil rouge** que porte la feature. Trois champs déclarés sur le
ticket, écrits par l'agent au moment de l'appel d'outil, chacun borné par le schéma.

Dans la même logique, une **option de question** cesse d'être une chaîne et devient un
objet : une étiquette courte, la conséquence de la prendre, et facultativement
l'illustration de cette conséquence sur le même exemple. Et ce qu'un rapport de fin
d'étape dit du travail accompli est borné aussi, et cesse de s'appeler `summary` pour
s'appeler `work` : un seul mot pour une seule chose.

## Pourquoi

Mesuré sur une instance réelle au 11/09/2026, avant toute borne : une `description` de
ticket faisait **3 765 caractères en moyenne** et jusqu'à 10 221, le `summary` d'un
rapport d'étape **2 856** et jusqu'à 4 350, et une option de question **175** caractères
là où le schéma demandait « une ligne que le développeur peut choisir ». Ouvrir un ticket
en attente de validation présentait environ **8 500 caractères** de prose non formatée,
dont 2 856 rendus dans un seul paragraphe au-dessus de la fiche de tests, c'est-à-dire
sur le seul écran où le développeur avait quelque chose à faire.

Trois voies étaient ouvertes, et deux ont été écartées.

**Une passe de synthèse**, où squad relit la description et en tire un résumé, est
exactement ce que l'ADR 0002 refuse : squad n'analyse pas de prose. Elle coûterait en
outre une place sous le plafond de concurrence à chaque ticket.

**Une consigne dans le briefing** ne tient pas. Le briefing d'une session principale fait
déjà près de 20 ko, et surtout la commande qui découpe un spec en tickets (`/to-tickets`)
vit dans le projet piloté, pas dans squad : squad ne peut pas changer ce qu'elle dit. La
seule instruction dont squad est certain qu'un agent la lit est **le refus de l'appel**.

D'où la borne dans le schéma Zod. Un agent qui déborde est refusé sur-le-champ, lit la
borne dans le refus, et recoupe sa prose à l'appel suivant, sans que personne n'intervienne.
C'est le mécanisme de l'ADR 0002 appliqué à la longueur.

**L'exemple fil rouge est porté par la feature et non par le ticket**, parce que le métier
est celui du chantier. Un ticket qui devait planter son propre décor ne pouvait pas rester
court, et un décor différent à chaque ticket obligeait à réapprendre une fiction nouvelle
à chaque ouverture, ce qui est précisément le coût que le résumé existe pour supprimer.

## Conséquences

`create_ticket` **refuse un ticket `build` ou `decision` sur une feature qui n'a pas
encore son exemple fil rouge**, et le refus nomme l'outil qui l'écrit. Le premier appel de
chaque nouvelle feature échoue donc, et l'agent y perd un tour. C'est payé une fois par
chantier, et c'est le prix de ne pas dépendre d'une consigne que squad ne contrôle pas.

Le schéma de `create_ticket` est une **union discriminée sur le genre** : `example` est
obligatoire sur `build` et `decision`, et absent de `fix`. Un ticket de correction n'a pas
d'exemple métier à montrer, ce qui a cassé étant une commande passée au rouge, et un
exemple inventé pour lui serait du remplissage. Squad écrit ses propres tickets `fix` sans
passer par l'outil, mais il écrit quand même leur résumé : ils se lisent sur le même écran
que les autres, et une dispense s'y verrait comme un trou.

Les colonnes sont **nullables alors que l'outil les exige**. Une colonne ne sait pas
refuser, et les 34 tickets écrits avant cette décision doivent rester lisibles : ils
portent un résumé absent, que l'interface annonce comme absent plutôt que de peindre un
résumé vide. `rewrite_ticket_summary` permet de leur en écrire un après coup.

**`rewrite_ticket_summary` ne peut pas toucher à la description**, et c'est une règle de
sûreté. La description est le contrat remis à la sous-session comme premier message : un
outil capable de la réécrire pourrait changer en silence ce qu'un ticket **en train de
tourner** était censé construire, sans que la session ni le développeur ne le voient.
Corriger ce que le développeur lit ne doit jamais pouvoir changer ce qui se construit.

Les bornes retenues sont **240 caractères pour la problématique** (une phrase), 400 pour
le contexte, 800 pour l'exemple, 600 pour le travail rapporté, 120 pour une étiquette
d'option et 400 pour sa conséquence. Ce sont des premiers chiffres, réunis en un seul
endroit (`textBounds`) : si des agents se mettent à boucler sur des refus, c'est la borne
qui est fausse et c'est là qu'elle se corrige. Ce qui n'est pas négociable est qu'une
borne existe.

Enfin le rendu, qui est arrivé dans un second temps et non avec les bornes : dire à un
agent qu'il peut écrire `**gras**` avant que quoi que ce soit ne le rende mettrait des
astérisques littérales sur l'écran même que ce chantier veut rendre lisible. Deux
sous-ensembles déclarés dans les champs eux-mêmes, en ligne seulement dans le résumé,
complet dans la description et dans les notes de preuve, où une sortie de commande a
besoin d'un bloc. Un bloc hors du sous-ensemble n'est pas jeté : son texte est gardé et
sa structure aplatie, perdre ce qu'un agent a écrit étant pire que le montrer platement.

**Le Markdown est peint en éléments React, jamais en HTML.** Passer par une chaîne HTML
et `dangerouslySetInnerHTML` reviendrait à maintenir un assainisseur pour toujours, sur
du contenu produit par un modèle, dans une page qui détient la session du développeur
face à l'API de squad. Construire des éléments supprime la question : il n'existe aucun
chemin du texte vers du balisage, donc un `<script>` dans la source est un `<script>` à
l'écran, en caractères. `marked` est pris pour son **lexer** seul, la partie difficile à
écrire juste, et c'est tout ce que squad lui emprunte : le paquet n'a aucune dépendance,
et le rendu vit chez nous, où il peut être tenu aux sous-ensembles que les outils
promettent. Un lien dont le schéma n'est ni `http`, ni `https`, ni `mailto` n'est pas
rendu cliquable : `javascript:` dans un href est le dernier moyen par lequel de la prose
d'agent pourrait agir sur cette page.
