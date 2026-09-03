# Architecture — outil de réception CSV

Ce document explique comment ce dépôt se situe dans le cahier des charges
« Copilote IA de gestion — Atelier Brochant » (V2), et les choix techniques
faits pour cette première brique.

## Ce que couvre ce dépôt aujourd'hui

Le cahier des charges décrit un système large (Gmail → Dext, IA
conversationnelle, cockpit, agents multiples…). Le plan de développement du
cahier des charges (section 18) découpe volontairement le projet en phases :

```
Phase 0 — Infrastructure
Phase 1 — Documents (Gmail -> Dext)
Phase 2 — Synec : import CSV factures, normalisation                <- ce dépôt
Phase 3 — Stripe / banque : imports, paiements, frais, payouts,
          rapprochement bancaire (chaîne de preuves)                <- ce dépôt
Phase 4 — Fournisseurs
Phase 5 — Règles / validation
Phase 6 — Cockpit
Phase 7 — Assistant IA
Phase 8 — Mémoire / autonomie
Phase 9 — API Synec (remplace les imports CSV)
```

Ce dépôt construit **la fondation de réception et de normalisation des CSV**
(Phases 2 et une bonne partie de la 3), demandée explicitement dans la
consigne initiale : « comment réceptionner ça, comment organiser ça ». Elle
correspond aussi au critère d'acceptation V1 : *« Le CSV Synec met à jour les
factures et permet de calculer le CA de la veille et les impayés »* et à la
mécanique de ventilation Stripe → banque de la section 5.

Ce que ce dépôt **ne fait pas (encore)** : connexion Gmail, envoi vers Dext,
règles de relance/délais, centre de validation complet, assistant IA
conversationnel, cockpit visuel riche. Le modèle de données (Prisma) prévoit
déjà les tables nécessaires à ces phases suivantes (`Decision`, `Anomalie`,
`Fournisseur`, `DocumentFournisseur`, `FactureFournisseur`) pour éviter une
refonte quand elles seront développées.

## Pipeline de réception d'un CSV

Reprend, adapté aux fichiers CSV, le principe du pipeline documentaire Gmail
de la section 7.2 : détecter, classifier, contrôler les doublons, traiter, ou
mettre en attente si ambigu, journaliser.

```
Fichier CSV depose (UI ou API)
        |
        v
1. Empreinte SHA-256 du fichier -> deja importe ? -> oui : "doublon_fichier", on s'arrete
        |
        v non
2. Lecture CSV (BOM, ; ou , auto-detecte) -> en-tetes normalisees
        |
        v
3. Detection du type (src/config/mappings/*.json) :
   compare les en-tetes a chaque mapping connu (Synec, Stripe paiements,
   Stripe payouts, releve bancaire). Aucun mapping ne correspond a 100% des
   colonnes requises -> statut "type_inconnu", le fichier est trace pour
   verification manuelle plutot que devine (jamais d'invention, cf. section
   14 "regles transversales").
        |
        v type reconnu
4. Normalisation ligne a ligne (src/importers/<type>.ts) :
   - montants et dates convertis (formats francais et Stripe geres)
   - upsert par cle metier (reference facture, id paiement Stripe, id
     payout, empreinte de ligne bancaire) -> une ligne deja connue est
     mise a jour, jamais dupliquee
        |
        v
5. Enregistrement d'un ImportBatch (nb lignes, nouveaux, doublons, erreurs)
   et d'une entree de Journal (section 12 : "journal lisible : evenement,
   interpretation, action proposee, validation, resultat")
```

## Détection de type — pourquoi un système de mapping, pas du code en dur

Aucun exemple de fichier CSV n'a été fourni avec le cahier des charges au
moment de la construction de cet outil (seul le document Word a été
transmis). Plutôt que de deviner des formats de colonnes figés dans le code,
chaque type de CSV connu est décrit par un fichier JSON dans
`src/config/mappings/` : une liste d'alias de noms de colonnes par champ
métier (`reference`, `montantTTC`, `clientNom`…).

Avantage : quand les vrais exports Synec / Stripe / Banque Populaire seront
fournis et que leurs intitulés de colonnes diffèrent des valeurs par défaut,
**il suffit d'ajouter les alias correspondants dans le JSON** — aucune
modification de code TypeScript n'est nécessaire. Voir le README principal,
section « Ajuster le format des CSV ».

## Rapprochement Stripe → banque (chaîne de preuves, section 5)

`Paiement.payoutRef` et `Payout.mouvementBancaireId` sont des champs texte
simples, **pas des clés étrangères strictes** en base. Ce choix est
délibéré : les fichiers Stripe (paiements, payouts) et le relevé bancaire
peuvent être déposés dans n'importe quel ordre, et un paiement peut
référencer un payout pas encore importé. Le rapprochement se fait par
requête applicative (`GET /api/payouts/:payoutRef/ventilation`), jamais en
imposant un ordre d'import.

## Ce que l'export Synec réel a changé

Le premier jet de ce dépôt supposait, faute d'exemple, un export Synec avec
des colonnes « Statut », « Date d'échéance » et « Mode de règlement ».
L'export réel reçu ensuite n'a **aucune de ces trois colonnes** : à la place,
une colonne `payments` empile un ou plusieurs règlements au format
`date|montant|mode|note` (séparés par ` // ` pour un règlement en plusieurs
fois). `src/importers/synecFactures.ts` reconstitue à partir de cette seule
colonne : le statut (payée / partiellement payée / impayée, en comparant la
somme réglée au montant TTC), le mode de paiement, et le financement Oney
(détecté via la mention « Oneybank » dans le mode ou la note d'un
règlement). Ce connecteur a été validé sur l'export réel complet (347
factures, 0 erreur) avant publication.

## Distinguer les exports Stripe entre eux

Stripe réutilise les mêmes noms de colonnes (`id`, `Amount`,
`Created (UTC)`) dans son export de paiements et son export de payouts : un
mapping basé uniquement sur ces colonnes matcherait les deux indifféremment.
La désambiguïsation repose sur une colonne exclusive à chaque type :
`Customer Email` pour un paiement (`stripe_paiements`, un payout n'a jamais
de client), `Destination Name` pour un payout (`stripe_payouts`, la banque
destinataire du virement — absente d'un export de paiements). Ces deux
colonnes sont donc marquées obligatoires (`requiredFields`) dans leurs
mappings respectifs, précisément pour cette raison.

## Pourquoi SQLite par défaut

Le cahier des charges recommande PostgreSQL pour la cible de production
(section 16). Pour cette première brique, SQLite est utilisé par défaut afin
que l'outil tourne immédiatement sans installer de serveur de base de
données. Le changement vers PostgreSQL se fait uniquement dans
`prisma/schema.prisma` (`provider = "postgresql"`) et `.env`
(`DATABASE_URL`) — le reste du code ne dépend pas du moteur choisi.
