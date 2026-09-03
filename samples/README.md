# Fichiers d'exemple

Ces fichiers ont été **construits pour reproduire la structure exacte des
exports réels** reçus d'Atelier Brochant (Synec, Stripe payouts, récapitulatif
de solde Stripe), mais avec des **données entièrement fictives**. Les vrais
fichiers reçus contiennent des noms, e-mails et téléphones de clients réels
et ne sont donc jamais commités dans ce dépôt (protection des données
personnelles, cf. section 17 du cahier des charges).

## Fichiers

| Fichier | Type détecté | Ce qu'il illustre |
|---|---|---|
| `synec-factures-exemple.csv` | `synec_factures` | Structure réelle de l'export Synec (colonnes `number`, `client_name`, `amount_with_tax`, `payments`...). Couvre les cas rencontrés dans les vrais fichiers : facture payée en une fois, facture payée en plusieurs fois, facture impayée, règlement partiel, financement Oney, avoir (facture d'annulation à montant négatif) |
| `stripe-payouts-exemple.csv` | `stripe_payouts` | Structure réelle de l'export payouts Stripe (colonnes `Arrival Date (UTC)`, `Destination Name`...) |
| `stripe-solde-exemple.csv` | `stripe_solde` | Récapitulatif de solde Stripe sur une période (aucune donnée personnelle dans ce type de fichier — structure identique au fichier réel reçu) |
| `stripe-paiements-exemple.csv` | `stripe_paiements` | Export paiements Stripe hypothétique (colonnes usuelles Stripe) — **aucun fichier réel de ce type n'a encore été fourni**, à valider dès qu'un export réel sera disponible |
| `banque-releve-exemple.csv` | `banque_releve` | Relevé bancaire générique — **aucun fichier réel de ce type n'a encore été fourni** |

## Ce que l'export Synec réel a révélé (et qui a changé l'outil)

Le premier jet de cet outil supposait un export Synec avec des colonnes
« Statut », « Date d'échéance », « Mode de règlement ». L'export réel n'a
**aucune de ces colonnes** : à la place, une colonne `payments` empile un ou
plusieurs règlements au format `date|montant|mode|note`, séparés par ` // `
quand une facture est réglée en plusieurs fois (ex :
`2025-03-31 15:39:44|500,00 €|Carte| // 2025-03-31 15:39:57|437,43 €|Chèque|`).
Le statut (payée / partiellement payée / impayée), le mode de règlement et la
détection Oney sont maintenant **reconstitués** à partir de cette colonne —
voir `src/importers/synecFactures.ts`. Il n'y a pas non plus de colonne
échéance ni bon de commande dans l'export reçu : ces champs restent vides
tant qu'une autre source ne les fournit pas.

## Comment les essayer

```bash
npm run dev
# puis, dans un autre terminal :
curl -F "fichier=@samples/synec-factures-exemple.csv" http://localhost:3000/api/import
curl -F "fichier=@samples/stripe-paiements-exemple.csv" http://localhost:3000/api/import
curl -F "fichier=@samples/stripe-payouts-exemple.csv" http://localhost:3000/api/import
curl -F "fichier=@samples/stripe-solde-exemple.csv" http://localhost:3000/api/import
curl -F "fichier=@samples/banque-releve-exemple.csv" http://localhost:3000/api/import
```

Ou plus simplement : ouvrir `http://localhost:3000` et déposer les fichiers un
par un depuis la page.

## Fichiers encore à valider sur données réelles

Le format `stripe_paiements` (paiements/charges Stripe) et `banque_releve`
(relevé Banque Populaire) n'ont pas encore été reçus en version réelle. Dès
qu'un export réel sera fourni, comparer ses en-têtes à
`src/config/mappings/stripe-payments.json` et `banque-releve.json`, et
ajuster les listes d'alias si besoin (voir le README principal, section
« Ajuster le format des CSV »).
