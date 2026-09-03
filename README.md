# Copilote Atelier Brochant — Outil de réception CSV

Première brique du « Copilote IA de gestion » décrit dans le cahier des
charges : un outil qui **reçoit, reconnaît et normalise** les exports CSV de
Synec (factures), Stripe (paiements et virements) et de la banque, pour
poser les fondations des phases suivantes (règles métier, cockpit, assistant
IA). Voir `docs/architecture.md` pour le détail du découpage en phases et
des choix techniques.

> ⚠️ **À savoir avant de commencer** : le message initial mentionnait des
> exemples de fichiers CSV, mais **seul le cahier des charges (.docx) a été
> reçu** — aucun CSV n'était réellement joint. Les connecteurs ci-dessous
> sont donc construits sur des formats courants (export Stripe officiel,
> export bancaire français, structure Synec déduite du cahier des charges)
> avec un système de correspondance de colonnes **ajustable sans toucher au
> code**. Dès que vous pourrez fournir vos vrais exports, il faudra
> probablement adapter `src/config/mappings/*.json` (voir plus bas) — cinq
> minutes de travail, pas une réécriture.

## Démarrage rapide

```bash
npm install
cp .env.example .env
npx prisma migrate dev --name init   # crée la base SQLite locale
npm run dev
```

Ouvrir http://localhost:3000 : une page permet de déposer un CSV et affiche
le cockpit (CA de la veille, impayés), la liste des imports et les factures
impayées.

Pour essayer immédiatement sans vos propres fichiers, des CSV d'exemple
(fictifs) sont fournis dans `samples/` — voir `samples/README.md`.

## Types de fichiers reconnus

| Type détecté | Alimente | Fichier de mapping |
|---|---|---|
| `synec_factures` | Factures, clients, statuts payé/impayé | `src/config/mappings/synec-factures.json` |
| `stripe_paiements` | Paiements CB, frais, montant net | `src/config/mappings/stripe-payments.json` |
| `stripe_payouts` | Virements groupés Stripe | `src/config/mappings/stripe-payouts.json` |
| `banque_releve` | Mouvements bancaires (Banque Populaire ou autre) | `src/config/mappings/banque-releve.json` |

Le type est détecté automatiquement à partir des intitulés de colonnes du
fichier déposé — inutile de le préciser au moment de l'import.

## Ajuster le format des CSV

Si un de vos fichiers réels n'est pas reconnu (statut `type_inconnu`), ou est
mal reconnu, ouvrez le fichier `src/config/mappings/<type>.json`
correspondant et ajoutez l'intitulé exact de vos colonnes dans la liste
`fields.<champ>` concernée. Exemple : si votre export Synec utilise la
colonne « Réf. facture » au lieu de « N° Facture » :

```json
"reference": ["n facture", "numero facture", "reference", "réf. facture"]
```

Les intitulés sont comparés sans tenir compte des accents, majuscules ou
ponctuation, donc « Réf. facture » et « ref facture » sont équivalents. Aucun
redémarrage du serveur n'est nécessaire au-delà d'un simple `npm run dev`
(le cache de mapping se recharge au démarrage).

## API

| Route | Description |
|---|---|
| `POST /api/import` | Dépose un fichier CSV (champ `fichier`), retourne le résumé de l'import |
| `GET /api/imports` | Historique des imports (type détecté, statut, compteurs) |
| `GET /api/factures?statut=impayee` | Liste des factures normalisées |
| `GET /api/paiements` | Paiements Stripe normalisés |
| `GET /api/payouts` | Virements Stripe |
| `GET /api/payouts/:payoutRef/ventilation` | Détail des paiements composant un virement (chaîne de preuves, section 5) |
| `GET /api/mouvements-bancaires` | Mouvements bancaires importés |
| `GET /api/journal` | Journal des événements (section 12) |
| `GET /api/dashboard/summary` | CA de la veille, impayés, alertes (cockpit, section 9) |

## Modèle de données

`prisma/schema.prisma` reprend la section 15 du cahier des charges
(« Données principales à stocker ») : `Client`, `Facture`, `Paiement`,
`Payout`, `MouvementBancaire`, `Fournisseur`, `DocumentFournisseur`,
`FactureFournisseur`, `Decision`, `Anomalie`, `JournalEvenement`, en plus de
`ImportBatch` qui trace chaque fichier reçu.

Base SQLite par défaut (aucune installation requise). Pour la production
(OVHcloud, section 16), passer à PostgreSQL : changer `provider` dans
`prisma/schema.prisma` et `DATABASE_URL` dans `.env`.

## Tests

```bash
npm test
```

Couvre : lecture CSV (BOM, séparateurs, montants FR/US, dates), détection de
type, et un test de bout en bout qui rejoue le scénario de la section 5
(deux paiements Stripe regroupés dans un virement, lui-même rapproché d'un
mouvement bancaire) sur une base SQLite temporaire.

## Prochaines étapes suggérées

Une fois vos vrais fichiers CSV validés avec cet outil :
1. Phase 1 — Gmail → Dext (première automatisation, section 7).
2. Phase 4 — Fournisseurs (échéances, prélèvements, sous-traitants).
3. Phase 5 — Moteur de règles et centre de validation (section 8).
4. Phase 6 — Cockpit visuel complet (section 9) et e-mail quotidien (section 10).
