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
Phase 7 — Assistant IA                                              <- premiere version (Morgane)
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

## Lire un relevé bancaire PDF sans dupliquer les mouvements

Le relevé Banque Populaire reçu est un PDF, pas un CSV. `bankStatementPdf.ts`
extrait le texte via `pdftotext -layout` (poppler-utils, dépendance système
à installer sur le serveur) puis reconstitue chaque ligne d'opération avec
une regex ancrée sur la forme `date | libellé (+ référence) | date | date |
montant`. Deux difficultés propres à ce document ont été résolues :

1. **Annexes redondantes.** Le PDF détaille deux fois les mouvements SEPA :
   une fois dans le relevé chronologique, une fois dans une annexe de fin de
   document (« DETAIL DE VOS MOUVEMENTS SEPA », « VIREMENTS SEPA RECUS »).
   Le texte est donc borné entre le début du relevé chronologique et le
   début de la première annexe avant toute extraction — jamais lu au-delà.
2. **Libellé vs référence bancaire.** Rien ne les sépare de façon fiable
   sinon la mise en page : un grand espace fixe (mise en colonnes) contre un
   espace simple entre deux mots d'un même libellé. Le texte est donc coupé
   sur les runs de 2 espaces ou plus (`/\s{2,}/`), jamais sur un critère de
   contenu (looks-like-a-reference), qui aurait produit de faux positifs sur
   des noms de tiers tout en majuscules.

Une fois les opérations extraites, elles sont transmises telles quelles
(mêmes chaînes `"1 200,00 €"`, `"18/02/2026"`) au normalisateur
`importBankStatement` déjà utilisé pour un relevé CSV : aucune logique de
rapprochement/dédoublonnage n'est dupliquée entre les deux formats.

Validé sur le relevé réel complet : le total recalculé après import
correspond exactement au total imprimé par la banque en bas du document.

## Lier factures et clients sans double saisie

L'export clients Synec (`synec_clients`) a un identifiant stable (`id`)
que l'export factures n'a pas : une facture ne référence son client que
par son nom (`client_name`). `synecClients.ts` retrouve donc un `Client`
déjà créé sans `synecId` (par un import de factures antérieur) en cherchant
par nom, et le complète au lieu d'en recréer un doublon. Dans l'autre sens,
`synecFactures.ts` continue de chercher un client par nom si aucun import
clients n'a encore eu lieu. L'ordre d'import des deux fichiers n'a donc pas
d'importance.

## Pipeline Gmail → Dext (section 7)

Reprend le meme principe general que la reception CSV (detecter,
classifier, deduplic, traiter ou mettre en attente, journaliser), applique
aux pieces jointes d'une boite Gmail connectee.

**OAuth, jamais de mot de passe** (section 17). `googleAuth.ts` gere
l'echange du code d'autorisation, puis chiffre le refresh token
(AES-256-GCM, cle dans `ENCRYPTION_KEY`) avant de le stocker — `cipher.ts`
est deliberement un module a part, sans dependance au reste de
l'application, pour que toute donnee qui y transite soit demontrablement
jamais loggee en clair.

**Polling plutot que push (Pub/Sub).** Gmail propose un mecanisme de
notification push (Cloud Pub/Sub) pour eviter d'interroger l'API en
continu, mais il demande une configuration GCP supplementaire
(topic, souscription, verification de domaine) hors de proportion pour le
volume d'un artisan/TPE. `scheduler.ts` interroge Gmail toutes les 5
minutes (configurable) : suffisant pour "traitement evenementiel" au sens
du cahier des charges sans complexite d'infrastructure additionnelle.
Migrer vers Pub/Sub plus tard n'impose pas de reecrire `gmailSync.ts` :
seul le declencheur change.

**Classification deterministe, jamais devinee** (section 14 : "les regles
metier deterministes priment sur une interpretation libre de l'IA").
`gmailClassify.ts` est un module pur (aucun appel reseau, aucune donnee
Prisma) : entierement teste unitairement, il classe une piece jointe en
facture / avoir / bon d'enlevement / relevé / ambigu par des motifs
explicites sur le sujet, le corps et le nom de fichier. Le cas "aucun
motif ne correspond" part au centre de validation (ambigu), jamais vers
Dext automatiquement.

> ⚠️ Historique : une premiere version traitait ce cas comme "facture
> standard" par defaut (l'hypothese etant que beaucoup de fournisseurs
> n'ecrivent jamais le mot "facture"). En conditions reelles, la
> recherche Gmail (`has:attachment newer_than:7d`) balaie toute la
> boite mail et pas seulement les fournisseurs : ce comportement a
> provoque l'envoi automatique de documents non-factures vers Dext
> (rejetes en nombre). Corrige pour se conformer au principe de la
> section 14 : ce qui n'est pas reconnu de maniere certaine ne part
> jamais automatiquement, il attend une validation humaine.

**Deduplication par empreinte de fichier, pas par Message-ID.** Un meme
message Gmail peut contenir plusieurs pieces jointes (donc plusieurs
documents) : le Message-ID sert a la tracabilite
(`DocumentFournisseur.gmailMessageId`, non unique), mais la veritable cle
de deduplication est le hash SHA-256 de chaque piece jointe
(`hashFichier`, unique), identique au mecanisme deja utilise pour les CSV.
Cela rend `synchroniserGmail` idempotent par construction : la relancer
plusieurs fois sur les memes e-mails (volontairement une fenetre de
recherche large de 7 jours a chaque passage, pour ne jamais rater un
message en cas d'arret prolonge du service) ne retransmet jamais un
document deja envoye a Dext.

> ⚠️ Historique : la deduplication par empreinte de fichier ne s'appliquait
> initialement qu'aux documents reconnus (facture, avoir...), pas aux
> documents "ambigus" — une piece jointe non reconnue (image de newsletter,
> logo sans Content-ID) etait donc re-signalee comme une toute nouvelle
> anomalie a chaque passage du planificateur (toutes les 5 minutes), y
> compris apres avoir ete ignoree. Corrige en enregistrant aussi un
> `DocumentFournisseur` (type "ambigu") pour les cas ambigus, soumis a la
> meme verification de hash que les autres types avant toute creation
> d'anomalie.

**Interrupteur `DEXT_AUTO_FORWARD`.** A la suite de l'incident ci-dessus,
l'utilisateur a demande une periode d'observation avant de refaire
confiance a l'envoi automatique. Mis a `false` (dans `scripts/deploy/bootstrap.sh`,
controle par le code — pas un secret), les factures reconnues ne sont plus
transmises a Dext : elles sont etiquetees dans Gmail sous
`Copilote/Factures a transferer/<Mois Annee>` (libelle cree automatiquement
au premier document du mois) et enregistrees avec `statutDext: "a_valider"`,
pour un envoi manuel groupe en fin de mois. Pour reactiver le transfert
automatique une fois la confiance retablie : repasser `DEXT_AUTO_FORWARD`
a `"true"` dans `bootstrap.sh` puis redeployer.

**Transfert par recomposition, pas par "Forward" natif.** Plutot que de
reconstruire une chaine de reponse/transfert Gmail (fragile pour les pieces
jointes), `gmailSync.ts` compose un nouvel e-mail (via `nodemailer`
`MailComposer`, pour un encodage MIME fiable) depuis la boite connectee
vers l'adresse Dext, avec la piece jointe originale — le resultat pour Dext
est identique (elle recoit la facture a l'adresse dediee), la mecanique
est juste plus robuste a implementer et a tester.

## Déploiement via GitHub Actions, pas en direct

L'environnement d'exécution de Claude Code ne peut sortir qu'en HTTPS (via
un proxy applicatif) : aucune connexion SSH brute n'est possible depuis
cette session vers un serveur externe. Le déploiement passe donc par
**GitHub Actions** (`.github/workflows/deploy.yml`), qui tourne sur
l'infrastructure de GitHub sans cette restriction :

1. Synchronise le code vers `/opt/copilote-brochant` sur le serveur (rsync
   par SSH, en excluant `.git`, `node_modules`, `dist`, `.env`).
2. Execute `scripts/deploy/bootstrap.sh` sur le serveur, qui installe/met a
   jour Node.js, PostgreSQL, nginx, cree la base et le fichier `.env` s'ils
   n'existent pas encore (sans jamais les ecraser sinon), compile, applique
   les migrations, et (re)demarre le service systemd.

Le script est **idempotent** par construction : chaque etape verifie
l'etat existant avant d'agir, si bien qu'il peut etre rejoue a chaque
deploiement (premier comme centieme) sans effet de bord. C'est aussi ce qui
permet de le declencher manuellement (`workflow_dispatch`) a la demande
pendant la mise au point, avant de le brancher sur chaque fusion sur
`main` une fois stabilise.

## PostgreSQL partout, y compris en local

Les toutes premières versions de ce dépôt utilisaient SQLite par défaut
pour demarrer sans installation. Depuis le premier déploiement réel
(OVHcloud), le projet est passé entièrement à **PostgreSQL** (section 16
du cahier des charges), y compris pour le développement local et les
tests : ne jamais valider le code sur un moteur différent de celui de
production évite une classe entière de bugs "ça marchait en local".
`docs/mise-en-service.md` explique l'installation sur le serveur ; le
README, l'installation locale pour développer.
