# Critères d'acceptation V1 (section 19 du cahier des charges) — état

Les critères concernant la réception CSV/PDF et le pipeline Gmail → Dext
relèvent du périmètre de ce dépôt. Les autres (relances, moteur de règles
complet, cockpit visuel complet, assistant IA...) restent hors périmètre —
voir `docs/architecture.md`.

| Critère (cahier des charges, section 19) | État | Détail |
|---|---|---|
| « Le CSV Synec met à jour les factures et permet de calculer le CA de la veille et les impayés » | ✅ Fait, validé sur données réelles | `POST /api/import` + `GET /api/dashboard/summary` ; testé de bout en bout dans `tests/importPipeline.test.ts`, et rejoué sur l'export réel complet (347 factures, 0 erreur) |
| « Une facture fournisseur reçue dans Gmail est reconnue, contrôlée contre les doublons et transmise automatiquement à Dext » | ✅ Fait, pas encore validé en conditions réelles | Pipeline complet construit (`src/services/gmailSync.ts`) : classification déterministe, déduplication par empreinte de fichier, transfert automatique. Non testé sur une vraie boîte Gmail : nécessite la connexion OAuth (`docs/mise-en-service.md`), qui ne peut être faite que par vous |
| « Un bon d'enlèvement n'est jamais envoyé à Dext comme facture » | ✅ Fait | `classifierPieceJointe` distingue bon d'enlèvement / relevé / avoir / facture par règles explicites ; seule une facture déclenche un transfert vers Dext (`src/services/gmailClassify.ts`, testé) |
| « Un relevé de factures fournisseur est utilisé comme contrôle et non comme facture détaillée » | ⚠️ Partiel | Le relevé est reconnu et archivé séparément (`statutDext: archive`), jamais transmis à Dext. Le contrôle croisé avec les factures détaillées correspondantes (section 6.3) reste à construire (Phase 5) |
| « Un payout Stripe groupé peut être ventilé jusqu'aux factures et rapproché du mouvement bancaire, frais inclus » | ⚠️ Partiel | La ventilation payout → paiements (brut/frais/net) est faite (`GET /api/payouts/:payoutRef/ventilation`). Le relevé bancaire réel confirme que les dépôts Stripe sont bien identifiables (libellé « EVI STRIPE TECHNOLOGY EU ») une fois importés, mais le rapprochement **automatique** payout ↔ mouvement bancaire (par montant/date) n'est **pas encore implémenté** — le matching reste à écrire (Phase 5, moteur de règles) |
| « Une facture / pièce déjà traitée n'est pas renvoyée » | ✅ Fait (CSV et Gmail) | Empreinte de fichier (SHA-256) pour les CSV et pour les pièces jointes Gmail, upsert par clé métier (référence facture, id paiement/payout, empreinte de ligne bancaire) |
| « Un bon de commande payé par Stripe est reconnu comme payé ; un bon de commande non payé peut bénéficier du délai de 30 jours » | ⛔ Hors périmètre | Nécessite le moteur de règles (Phase 5) ; le champ `bonCommande` est déjà stocké sur `Facture` pour ne pas bloquer cette phase |
| « Un dossier Oney accepté n'apparaît pas comme impayé » | ✅ Fait pour l'import CSV | L'export réel encode le financement Oney comme un règlement classique (mode « Virement » + note « Oneybank ») dans la colonne `payments` : `src/importers/synecFactures.ts` le détecte et pose `financementOney=true` avec un statut « payée ». Validé sur l'export réel (1 dossier Oney détecté). Reste hors périmètre : l'agrégation avec la note interne Synec en texte libre citée par le cahier des charges, pour les cas où l'information n'apparaît pas dans `payments` |
| « Toute anomalie incertaine arrive dans le centre de validation avec une explication » | ⚠️ Partiel | Un import de type inconnu, une erreur, ou une pièce jointe Gmail ambiguë sont tous tracés dans `Anomalie`/`JournalEvenement` plutôt que devinés (`GET /api/anomalies`). Le centre de validation à proprement parler (cartes actionnables avec bouton valider/corriger, section 8) reste à construire en Phase 5 |

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
- Pipeline Gmail → Dext complet et testé unitairement (classification,
  choix d'adresse, déduplication, chiffrement du jeton) — **en attente de
  la connexion OAuth réelle** pour une validation en conditions de
  production (voir `docs/mise-en-service.md`).

## Ce qui reste à construire pour couvrir tout le cahier des charges

Voir le plan de développement (section 18) et `docs/architecture.md` pour
l'ordre suggéré : API Stripe, fournisseurs, moteur de règles / agents /
centre de validation complet, cockpit visuel, mail quotidien, assistant IA,
mémoire des décisions.
