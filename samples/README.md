# Fichiers d'exemple

Ces fichiers ont été **construits pour reproduire la structure exacte des
exports réels** reçus d'Atelier Brochant (Synec factures et clients, relevé
Banque Populaire, récapitulatif de solde Stripe), mais avec des **données
entièrement fictives**. Les vrais fichiers reçus contiennent des noms,
e-mails, téléphones et adresses de clients réels et ne sont donc jamais
commités dans ce dépôt (protection des données personnelles, cf. section 17
du cahier des charges) — y compris le relevé de compte PDF, qui n'est ni
commité ni fourni en exemple sous cette forme (voir plus bas).

## Fichiers

| Fichier | Type détecté | Ce qu'il illustre |
|---|---|---|
| `synec-factures-exemple.csv` | `synec_factures` | Structure réelle de l'export Synec (colonnes `number`, `client_name`, `amount_with_tax`, `payments`...). Couvre les cas rencontrés dans les vrais fichiers : facture payée en une fois, facture payée en plusieurs fois, facture impayée, règlement partiel, financement Oney, avoir (facture d'annulation à montant négatif) |
| `synec-clients-exemple.csv` | `synec_clients` | Structure réelle de l'export clients Synec (colonnes `id`, `main_name`, `mail`, `phone`, `address1/2/3`...). Les noms correspondent volontairement à ceux de `synec-factures-exemple.csv`, pour illustrer l'enrichissement d'un client déjà créé par l'import des factures |
| `stripe-payouts-exemple.csv` | `stripe_payouts` | Structure réelle de l'export payouts Stripe (colonnes `Arrival Date (UTC)`, `Destination Name`...) |
| `stripe-solde-exemple.csv` | `stripe_solde` | Récapitulatif de solde Stripe sur une période (aucune donnée personnelle dans ce type de fichier — structure identique au fichier réel reçu) |
| `stripe-paiements-exemple.csv` | `stripe_paiements` | Export paiements Stripe hypothétique (colonnes usuelles Stripe) — **aucun fichier réel de ce type n'a pu être fourni** (Stripe ne permettait d'exporter que le récapitulatif de solde) |
| `banque-releve-exemple.csv` | `banque_releve` | Relevé bancaire générique au format CSV — **hypothétique**, le relevé réel reçu est un PDF (voir ci-dessous), pas un CSV |

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

## Le relevé bancaire réel est un PDF, pas un CSV

Le fichier fourni comme « relevé de compte » est le PDF Banque Populaire
standard, pas un export CSV. `src/importers/bankStatementPdf.ts` en extrait
le texte (`pdftotext -layout`) et reconstitue chaque opération. Deux pièges
identifiés sur le fichier réel :

1. **Le document contient deux fois les mêmes mouvements** : le détail
   chronologique (« DETAIL DES OPERATIONS DE VOTRE COMPTE COURANT ») puis
   une annexe qui re-détaille les mêmes prélèvements/virements SEPA
   (« DETAIL DE VOS MOUVEMENTS SEPA », « VIREMENTS SEPA RECUS »). Importer
   les deux sections doublonnerait chaque écriture SEPA — seule la première
   section est donc lue.
2. **Libellé et référence bancaire ne sont séparés par aucun caractère
   fiable** (pas de virgule, pas de tabulation) : seule la mise en page en
   colonnes fixes les distingue (un grand espace, pas un espace simple comme
   entre deux mots d'un même libellé).

Ce connecteur a été validé sur le relevé réel complet (76 mouvements sur la
période) : la somme recalculée correspond exactement au total imprimé par
la banque en bas du relevé. Comme il contient des informations bancaires
réelles (IBAN, mouvements, noms de tiers), **il n'est ni commité ni fourni
en exemple** ; `tests/bankStatementPdf.test.ts` teste le même parseur sur un
texte fictif reproduisant la même mise en page (voir ce fichier pour un
exemple de la structure attendue).

## Comment essayer les exemples CSV

```bash
npm run dev
# puis, dans un autre terminal :
curl -F "fichier=@samples/synec-clients-exemple.csv" http://localhost:3000/api/import
curl -F "fichier=@samples/synec-factures-exemple.csv" http://localhost:3000/api/import
curl -F "fichier=@samples/stripe-paiements-exemple.csv" http://localhost:3000/api/import
curl -F "fichier=@samples/stripe-payouts-exemple.csv" http://localhost:3000/api/import
curl -F "fichier=@samples/stripe-solde-exemple.csv" http://localhost:3000/api/import
curl -F "fichier=@samples/banque-releve-exemple.csv" http://localhost:3000/api/import
```

Ou plus simplement : ouvrir `http://localhost:3000` et déposer les fichiers un
par un depuis la page (y compris un vrai relevé PDF, si vous en avez un sous
la main).

## Fichier encore à valider sur données réelles

Le format `stripe_paiements` (paiements/charges Stripe individuels) n'a pas
pu être reçu en version réelle (non exportable depuis votre compte Stripe).
Dès qu'un export réel sera disponible, comparer ses en-têtes à
`src/config/mappings/stripe-payments.json` et ajuster les listes d'alias si
besoin (voir le README principal, section « Ajuster le format des CSV »).
