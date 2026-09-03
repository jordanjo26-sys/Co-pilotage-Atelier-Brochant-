# Critères d'acceptation V1 (section 19 du cahier des charges) — état

Seuls les critères concernant la réception et la normalisation des CSV
relèvent du périmètre de ce dépôt. Les autres (Gmail → Dext, relances,
cockpit visuel complet, assistant IA...) sont hors périmètre de cette
première brique — voir `docs/architecture.md`.

| Critère (cahier des charges, section 19) | État | Détail |
|---|---|---|
| « Le CSV Synec met à jour les factures et permet de calculer le CA de la veille et les impayés » | ✅ Fait | `POST /api/import` + `GET /api/dashboard/summary` ; testé de bout en bout dans `tests/importPipeline.test.ts` |
| « Un payout Stripe groupé peut être ventilé jusqu'aux factures et rapproché du mouvement bancaire, frais inclus » | ⚠️ Partiel | La ventilation payout → paiements (brut/frais/net) est faite (`GET /api/payouts/:payoutRef/ventilation`). Le rapprochement automatique payout ↔ mouvement bancaire (par montant/date) n'est **pas encore implémenté** — `MouvementBancaire` et `Payout` sont stockés et reliables, mais le matching reste à écrire (Phase 5, moteur de règles) |
| « Une facture / pièce déjà traitée n'est pas renvoyée » | ✅ Fait (pour les CSV) | Empreinte de fichier (SHA-256) + upsert par clé métier (référence facture, id paiement/payout, empreinte de ligne bancaire). L'équivalent pour les pièces Gmail (section 7.3) reste à faire en Phase 1 |
| « Un bon de commande payé par Stripe est reconnu comme payé ; un bon de commande non payé peut bénéficier du délai de 30 jours » | ⛔ Hors périmètre | Nécessite le moteur de règles (Phase 5) ; le champ `bonCommande` est déjà stocké sur `Facture` pour ne pas bloquer cette phase |
| « Un dossier Oney accepté n'apparaît pas comme impayé » | ⛔ Hors périmètre | Le champ `financementOney` existe sur `Facture` mais aucun import ne le renseigne encore (l'information Oney arrive aujourd'hui via note interne Synec en texte libre, non structurée dans un export CSV) |
| « Toute anomalie incertaine arrive dans le centre de validation avec une explication » | ⚠️ Partiel | Un import de type inconnu ou en erreur est tracé (`ImportBatch.statut`, `JournalEvenement`) plutôt que deviné. Le centre de validation à proprement parler (cartes actionnables, section 8) reste à construire en Phase 5 |

## Ce qui est donc solide dès maintenant

- Réception de fichiers CSV sans double saisie ni doublon.
- Détection automatique du type de fichier, ajustable sans coder.
- Normalisation en base des factures, paiements, payouts et mouvements
  bancaires.
- Calcul du CA de la veille et des impayés à partir des données reçues.
- Journal de chaque import (traçabilité, section 14).

## Ce qui reste à construire pour couvrir tout le cahier des charges

Voir le plan de développement (section 18) et `docs/architecture.md` pour
l'ordre suggéré : Gmail → Dext, moteur de règles / centre de validation,
cockpit visuel, assistant IA, mémoire des décisions.
