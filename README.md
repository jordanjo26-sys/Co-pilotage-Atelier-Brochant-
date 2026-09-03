# Copilote Atelier Brochant — Outil de réception CSV

Première brique du « Copilote IA de gestion » décrit dans le cahier des
charges : un outil qui **reçoit, reconnaît et normalise** les exports CSV de
Synec (factures), Stripe (paiements et virements) et de la banque, pour
poser les fondations des phases suivantes (règles métier, cockpit, assistant
IA). Voir `docs/architecture.md` pour le détail du découpage en phases et
des choix techniques.

> ⚠️ **État des connecteurs** : les vrais exports **Synec** (factures),
> **payouts Stripe** et **récapitulatif de solde Stripe** ont été reçus et
> les connecteurs correspondants sont calés dessus (le format Synec réel
> s'est révélé très différent de ce qui était supposé au départ — voir
> `samples/README.md` pour le détail). Les connecteurs **paiements Stripe**
> et **relevé bancaire** restent construits sur des formats courants
> (aucun export réel de ces deux types n'a encore été fourni) — à valider
> dès réception, via le système de correspondance de colonnes **ajustable
> sans toucher au code** (voir plus bas).

## Démarrage rapide

```bash
npm install
cp .env.example .env
npx prisma migrate dev   # applique les migrations et crée la base SQLite locale
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
| `synec_factures` | Factures, clients, statut reconstitué (payée / partiellement payée / impayée) | `src/config/mappings/synec-factures.json` |
| `stripe_paiements` | Paiements CB, frais, montant net *(format hypothétique, pas encore reçu réellement)* | `src/config/mappings/stripe-payments.json` |
| `stripe_payouts` | Virements groupés Stripe | `src/config/mappings/stripe-payouts.json` |
| `stripe_solde` | Récapitulatif de solde Stripe sur une période (repère d'audit) | `src/config/mappings/stripe-solde.json` |
| `banque_releve` | Mouvements bancaires (Banque Populaire ou autre) *(format hypothétique, pas encore reçu réellement)* | `src/config/mappings/banque-releve.json` |

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

**Colonnes obligatoires « anti-ambiguïté »** : `stripe_paiements` exige une
colonne e-mail client (`clientEmail`) et `stripe_payouts` exige une colonne
banque destinataire (`destinationName`) — ce sont les seules colonnes qui
permettent de distinguer un export de paiements d'un export de payouts,
Stripe réutilisant les mêmes noms de colonnes (`id`, `Amount`,
`Created (UTC)`) dans les deux. Si votre export réel de paiements n'a pas de
colonne e-mail client, retirez `clientEmail` de `requiredFields` dans
`stripe-payments.json`.

**Cas particulier Synec** : l'export réel n'a pas de colonne statut,
échéance ni mode de paiement — tout est reconstitué à partir de la colonne
`payments`, qui empile un ou plusieurs règlements
(`date|montant|mode|note`, séparés par ` // `). Voir
`src/importers/synecFactures.ts` et `samples/README.md` pour le détail.

## API

| Route | Description |
|---|---|
| `POST /api/import` | Dépose un fichier CSV (champ `fichier`), retourne le résumé de l'import |
| `GET /api/imports` | Historique des imports (type détecté, statut, compteurs) |
| `GET /api/factures?statut=impayee` | Liste des factures normalisées |
| `GET /api/paiements` | Paiements Stripe normalisés |
| `GET /api/payouts` | Virements Stripe |
| `GET /api/payouts/:payoutRef/ventilation` | Détail des paiements composant un virement (chaîne de preuves, section 5) |
| `GET /api/recapitulatifs-solde` | Récapitulatif de solde Stripe par période (repère d'audit) |
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
type, reconstitution du statut Synec à partir de la colonne `payments`
(paiement unique, en plusieurs fois, partiel, financement Oney, avoir), et un
test de bout en bout qui rejoue le scénario de la section 5 (deux paiements
Stripe regroupés dans un virement, lui-même rapproché d'un mouvement
bancaire) sur une base SQLite temporaire. Le connecteur Synec a par ailleurs
été validé sur l'export réel complet (347 factures, sans erreur) avant
publication — voir `docs/criteres-acceptation.md`.

## Données personnelles

Les fichiers réels (Synec en particulier) contiennent des noms, e-mails et
téléphones de clients d'Atelier Brochant. Aucun fichier réel n'est commité
dans ce dépôt : `samples/` ne contient que des fixtures fictives reproduisant
la structure exacte des vrais exports (voir `samples/README.md`). Gardez la
même discipline pour vos propres tests.

## Prochaines étapes suggérées

Une fois vos vrais fichiers CSV validés avec cet outil :
1. Phase 1 — Gmail → Dext (première automatisation, section 7).
2. Phase 4 — Fournisseurs (échéances, prélèvements, sous-traitants).
3. Phase 5 — Moteur de règles et centre de validation (section 8).
4. Phase 6 — Cockpit visuel complet (section 9) et e-mail quotidien (section 10).
