-- Nettoyage ponctuel : supprime les entrees de Journal historiques
-- correspondant a des doublons de pieces jointes deja connues (voir
-- commit 139a95a, qui a retire cette journalisation individuelle pour
-- les nouvelles synchronisations). Ces lignes n'ont plus aucune valeur
-- informative (le compteur agrege reste, lui, dans le resume de chaque
-- synchronisation) et ne faisaient qu'inonder l'historique affiche a
-- l'utilisateur (signale en production, capture a l'appui). Migration de
-- donnees, pas de schema : ne s'applique qu'une seule fois.
DELETE FROM "JournalEvenement"
WHERE "evenement" = 'gmail_document'
  AND "action" LIKE 'Piece jointe deja connue%';
