# Le go-as-recommandé tranche aussi le périmètre, et lève une alerte pour le dire

Sous go-as-recommandé, squad prend la route qu'un agent recommande **y compris quand elle
change ce qui est construit**. Ce qui distinguait un arbitrage de périmètre n'est plus s'il
peut être tranché seul, mais si le développeur est réveillé pour apprendre qu'il l'a été :
une décision de périmètre prise en son absence lève une **alerte** nommant le ticket et la
route retenue, là où un arbitrage ordinaire n'a que sa note sur le fil.

La règle vaut pour les deux canaux, l'arbitrage relevé sur une fiche de tests et la question
qu'un agent pose avec `ask_question`. Ils ne diffèrent que par le chemin emprunté pour
demander.

## Pourquoi

La règle précédente était explicite et défendue : le périmètre est la seule chose que squad
ne tranche jamais seul. Elle reste juste sur le fond, et son remède était faux.

Relevé sur l'instance du 12 au 14/09/2026 : **59 arbitrages enregistrés, dont 49 que le mode
a pris seul et 10 de périmètre**, six pour la seule journée du 14. Un chantier qui négocie
des contrats entre trois dépôts en produit un toutes les une à deux heures de travail
d'agent. Chacun arrêtait le mode jusqu'à ce qu'une personne réponde, et le relancer sans
répondre le ré-arrêtait sur le même point : le mode passait plus de temps arrêté qu'en
marche, et l'utilisateur le lisait comme un bouton mort.

**Un mode qu'il faut relancer toutes les heures n'est pas un mode autonome.** Le
go-as-recommandé existe pour porter une nuit que personne ne regarde ; s'arrêter sur la
première question de contrat le ramène à un mode assisté, c'est-à-dire à rien.

**Ce qui est perdu est réel, et c'est ce que l'alerte rachète.** Squad décide désormais des
choses qui engagent un contrat sans personne. Ce que la décision doit au développeur, ce
n'est pas d'être bloquée, c'est d'être **sue** : une note sur un fil se lit le jour où l'on
va la chercher, une alerte arrive. Elle porte l'adresse du ticket, donc elle atterrit là où
la décision se défait.

**`scopeChanging` garde son sens et change de conséquence.** Le drapeau dit toujours « ce
choix change ce qui est construit » ; il ne décide plus si squad peut répondre, il décide
si la réponse vaut un réveil. Les descriptions des outils le disent aux agents dans ces
termes, parce qu'un drapeau dont la conséquence a changé sans que son texte bouge est un
drapeau qui sera mal déclaré.

## Conséquences

**L'arrêt `scope-question` n'est plus levé par rien.** Il reste dans le vocabulaire et dans
l'interface : des arrêts déjà enregistrés le portent, et une nuit qui s'est arrêtée doit
continuer à dire pourquoi. Les trois autres raisons d'arrêt sont inchangées, un ticket
arrêté, une décision que rien ne contourne, le plafond de profondeur atteint.

**Le verdict `halt` disparaît du contrat interne**, n'ayant plus de producteur. Ce qui n'est
pas répondu est `wait`, comme avant lorsque personne ne pilotait.

**Le balayage des arbitrages ouverts se simplifie.** Il lisait les points ordinaires de tous
les tickets avant le premier point de périmètre, parce que celui-ci arrêtait le mode et
gelait tout ce qui le suivait : l'ordre du graphe décidait alors de ce qui était répondu.
Une seule passe suffit désormais, et une fiche se lit dans l'ordre où elle est écrite.

**La présélection dans le formulaire ne change pas.** Un arbitrage de périmètre y arrive
toujours sur aucune route, et la raison n'est plus que squad refuse de le trancher : c'est
que ce formulaire est ce qu'on utilise **mode éteint**. Armer le mode est la façon de
déléguer, et c'est la seule ; qui relit une fiche mode éteint décide pour lui-même, et une
décision de contrat vaut le geste de cocher.
