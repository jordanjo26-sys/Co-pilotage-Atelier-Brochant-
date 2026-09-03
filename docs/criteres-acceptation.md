# Critères d'acceptation V1 (section 19 du cahier des charges) — état

Seuls les critères concernant la réception et la normalisation des CSV
relèvent du périmètre de ce dépôt. Les autres (Gmail → Dext, relances,
cockpit visuel complet, assistant IA...) sont hors périmètre de cette
première brique — voir `docs/architecture.md`.

| Critère (cahier des charges, section 19) | État | Détail |
|---|---|---|
| « Le CSV Synec met à jour les factures et permet de calculer le CA de la veille et les impayés » | ✅ Fait, validé sur données réelles | `POST /api/import` + `GET /api/dashboard/summary` ; testé de bout en bout dans `tests/importPipeline.test.ts`, et rejoué sur l'export réel complet (347 factures, 0 erreur) |
| « Un payout Stripe groupé peut être ventilé jusqu'aux factures et rapproché du mouvement bancaire, frais inclus » | ⚠️ Partiel | La ventilation payout → paiements (brut/frais/net) est faite (`GET /api/payouts/:payoutRef/ventilation`). Le relevé bancaire réel confirme que les dépôts Stripe sont bien identifiables (libellé « EVI STRIPE TECHNOLOGY EU ») une fois importés, mais le rapprochement **automatique** payout ↔ mouvement bancaire (par montant/date) n'est **pas encore implémenté** — le matching reste à écrire (Phase 5, moteur de règles) |
| « Une facture / pièce déjà traitée n'est pas renvoyée » | ✅ Fait (pour les CSV) | Empreinte de fichier (SHA-256) + upsert par clé métier (référence facture, id paiement/payout, empreinte de ligne bancaire). L'équivalent pour les pièces Gmail (section 7.3) reste à faire en Phase 1 |
| « Un bon de commande payé par Stripe est reconnu comme payé ; un bon de commande non payé peut bénéficier du délai de 30 jours » | ⛔ Hors périmètre | Nécessite le moteur de règles (Phase 5) ; le champ `bonCommande` est déjà stocké sur `Facture` pour ne pas bloquer cette phase |
| « Un dossier Oney accepté n'apparaît pas comme impayé » | ✅ Fait pour l'import CSV | L'export réel encode le financement Oney comme un règlement classique (mode « Virement » + note « Oneybank ») dans la colonne `payments` : `src/importers/synecFactures.ts` le détecte et pose `financementOney=true` avec un statut « payée ». Validé sur l'export réel (1 dossier Oney détecté). Reste hors périmètre : l'agrégation avec la note interne Synec en texte libre citée par le cahier des charges, pour les cas où l'information n'apparaît pas dans `payments` |
| « Toute anomalie incertaine arrive dans le centre de validation avec une explication » | ⚠️ Partiel | Un import de type inconnu ou en erreur est tracé (`ImportBatch.statut`, `JournalEvenement`) plutôt que deviné. Le centre de validation à proprement parler (cartes actionnables, section 8) reste à construire en Phase 5 |

## Ce qui est donc solide dès maintenant

- Réception de fichiers CSV sans double saisie ni doublon.
- Détection automatique du type de fichier, ajustable sans coder.
- Normalisation en base des factures (avec reste à percevoir sur règlement
  partiel), paiements, payouts, récapitulatif de solde Stripe et mouvements
  bancaires.
- Calcul du CA de la veille et des impayés à partir des données reçues.
- Détection du financement Oney directement dans les règlements Synec.
- Journal de chaque import (traçabilité, section 14).
- Connecteurs Synec validés sur les exports réels complets (347 factures,
  480 clients).
- Relevé de compte **PDF** Banque Populaire lu directement (pas besoin de
  conversion CSV manuelle), validé sur le relevé réel complet (76
  mouvements, total recalculé identique au total imprimé par la banque).
- Enrichissement zéro double saisie : une facture retrouve automatiquement
  son client déjà connu par l'export clients, sans jamais recréer de fiche
  en double (vérifié sur les 347 factures réelles : 0 client dupliqué).

## Ce qui reste à construire pour couvrir tout le cahier des charges

Voir le plan de développement (section 18) et `docs/architecture.md` pour
l'ordre suggéré : Gmail → Dext, moteur de règles / centre de validation,
cockpit visuel, assistant IA, mémoire des décisions.
