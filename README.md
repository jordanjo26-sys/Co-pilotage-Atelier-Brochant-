# Copilote Atelier Brochant

Implémentation progressive du « Copilote IA de gestion » décrit dans le
cahier des charges. Deux briques sont construites à ce stade :

1. **Réception CSV/PDF** — reçoit, reconnaît et normalise les exports Synec
   (factures, clients), Stripe (payouts, solde) et le relevé bancaire
   (PDF), pour poser les fondations des phases suivantes.
2. **Gmail → Dext** (section 7) — surveille une boîte Gmail connectée,
   classe chaque pièce jointe reçue (facture, avoir, bon d'enlèvement,
   relevé fournisseur) et transfère automatiquement les factures standard
   vers Dext, sans double saisie ni doublon.

Voir `docs/architecture.md` pour le détail du découpage en phases et des
choix techniques, et `docs/mise-en-service.md` pour la checklist concrète
(hébergement OVHcloud, connexion Gmail) nécessaire pour que tout tourne en
continu.

> ⚠️ **État des connecteurs** : les vrais exports **Synec** (factures et
> clients), **récapitulatif de solde Stripe** et **relevé de compte Banque
> Populaire (PDF)** ont été reçus et les connecteurs correspondants sont
> calés dessus et validés sur données réelles (voir
> `docs/criteres-acceptation.md`). Le connecteur **paiements Stripe**
> (export CSV des charges individuelles) reste construit sur un format
> hypothétique — vous avez indiqué ne pas pouvoir le produire depuis Stripe
> ; seul le récapitulatif de solde était disponible, et il est déjà géré.
> À valider dès qu'un export réel sera disponible, via le système de
> correspondance de colonnes **ajustable sans toucher au code** (voir plus
> bas).

## Démarrage rapide

Nécessite un serveur **PostgreSQL** accessible (local ou distant) — voir
`docs/mise-en-service.md` pour l'installer sur Ubuntu/OVHcloud, ou en local
pour développer :

```bash
sudo apt install postgresql          # si pas déjà installé
sudo -u postgres psql -c "CREATE DATABASE copilote_brochant;"
sudo -u postgres psql -c "CREATE USER copilote WITH PASSWORD 'changez-moi';"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE copilote_brochant TO copilote;"
sudo -u postgres psql -d copilote_brochant -c "GRANT ALL ON SCHEMA public TO copilote;"
sudo -u postgres psql -c "ALTER USER copilote CREATEDB;"  # necessaire pour "prisma migrate dev"
```

```bash
npm install
cp .env.example .env   # adapter DATABASE_URL a votre installation PostgreSQL
npx prisma migrate dev   # applique les migrations
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
| `synec_factures` | Factures, statut reconstitué (payée / partiellement payée / impayée) | `src/config/mappings/synec-factures.json` |
| `synec_clients` | Identité, coordonnées et adresse des clients | `src/config/mappings/synec-clients.json` |
| `stripe_paiements` | Paiements CB, frais, montant net *(format hypothétique, pas encore reçu réellement)* | `src/config/mappings/stripe-payments.json` |
| `stripe_payouts` | Virements groupés Stripe | `src/config/mappings/stripe-payouts.json` |
| `stripe_solde` | Récapitulatif de solde Stripe sur une période (repère d'audit) | `src/config/mappings/stripe-solde.json` |
| `banque_releve` | Mouvements bancaires, format CSV *(hypothétique, pas encore reçu réellement)* | `src/config/mappings/banque-releve.json` |
| `banque_releve_pdf` | Mouvements bancaires extraits d'un relevé de compte **PDF** Banque Populaire | `src/importers/bankStatementPdf.ts` (pas de mapping CSV : détection par contenu du fichier) |

Le type est détecté automatiquement à partir des intitulés de colonnes du
fichier déposé — inutile de le préciser au moment de l'import. Un fichier
`.pdf` est reconnu comme relevé bancaire Banque Populaire et traité par un
extracteur dédié plutôt que par le système de mapping (voir plus bas).

**Dépendance système pour les relevés PDF** : l'extraction utilise
`pdftotext` (paquet `poppler-utils`), qui doit être installé sur le serveur
(`apt install poppler-utils` sur Ubuntu/OVHcloud). Sans lui, le dépôt d'un
PDF échoue avec un message clair l'indiquant.

## Gmail → Dext

**Rien n'est connecté par défaut** : il faut une boîte Gmail et des
identifiants OAuth Google (voir `docs/mise-en-service.md` pour la
procédure complète, étape par étape). Une fois `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET` et `GOOGLE_REDIRECT_URI` renseignés dans `.env` :

1. Ouvrir `http://localhost:3000/auth/google` (ou l'URL du serveur en
   production) et autoriser l'accès depuis le compte Gmail de l'entreprise.
2. Le serveur vérifie ensuite la boîte toutes les 5 minutes
   (`GMAIL_POLL_INTERVAL_MS`, réglable) — ou cliquer sur "Synchroniser
   maintenant" dans le cockpit pour déclencher une passe immédiatement.
3. Chaque pièce jointe reçue est classée selon des règles déterministes
   (section 14 : jamais d'interprétation libre) :
   - **Facture** standard (uniquement au format PDF — une image dans le
     même e-mail, ex. logo de signature, reste ambiguë) → transférée
     vers l'adresse Dext appropriée (`facturation-brochant@dext.cc` ou
     `@multiple.dext.cc` s'il y a plusieurs factures dans le même
     e-mail), *sauf* si `DEXT_AUTO_FORWARD=false` (voir ci-dessous).
   - **Avoir**, **bon d'enlèvement**, **relevé de factures fournisseur**,
     **devis / offre de prix** → archivés, jamais envoyés à Dext
     (sections 6.3, 6.4).
   - Tout le reste (pièce jointe illisible, type non reconnu) → mis en
     attente dans le centre de validation (`GET /api/anomalies`), jamais
     deviné.
   - Les e-mails provenant de Dext lui-même (accusés, récapitulatifs) sont
     exclus d'office de l'analyse.
   - Les images intégrées au corps du message (logo de signature, images de
     newsletter/mailing) sont exclues avant même la classification, qu'elles
     portent un en-tête `Content-ID` ou un `Content-Disposition: inline` —
     les deux signaux standards utilisés par les clients mail et les
     plateformes d'e-mailing pour ce type de ressource.
4. Chaque décision est déduplicée par empreinte de fichier (section 7.3),
   **anomalies comprises** : une pièce jointe non reconnue n'est signalée
   qu'une seule fois, jamais à nouveau à chaque passage du planificateur une
   fois traitée (ignorée ou non). Journalisé (`GET /api/journal`) : relancer
   une synchronisation, même plusieurs fois sur les mêmes e-mails, ne
   retransmet et ne re-signale jamais un document déjà connu.
5. Chaque anomalie du centre de validation propose un bouton **Voir** pour
   prévisualiser la pièce jointe (redemandée à Gmail à la volée, jamais
   stockée) en plus d'**Ignorer**.

**Pause du transfert automatique (`DEXT_AUTO_FORWARD=false`)** : les
factures reconnues ne sont alors plus envoyées à Dext — elles sont
étiquetées dans Gmail sous `Copilote/Factures à transférer/<Mois Année>`
(créé automatiquement) et enregistrées avec le statut `a_valider`, pour un
envoi manuel groupé (par ex. en fin de mois, le temps d'observer le
comportement du système). Par défaut (variable absente), le transfert est
actif.

Le jeton Gmail est chiffré au repos (voir `src/services/cipher.ts`,
`ENCRYPTION_KEY` dans `.env`) — jamais stocké en clair, conformément à la
section 17 du cahier des charges.

## Récapitulatif quotidien par e-mail

Chaque jour à `DAILY_RECAP_HOUR` (19h par défaut, heure locale du serveur),
un e-mail est envoyé à la boîte Gmail connectée elle-même avec : le CA de
la veille et les impayés (mêmes chiffres que `GET /api/dashboard/summary`),
les documents reçus dans la journée par type, et les points nécessitant une
validation manuelle. Rien à configurer côté destinataire — c'est déjà
l'adresse consultée par l'utilisateur.

- `GET /api/recap/apercu` : aperçu du contenu (texte), sans envoyer d'e-mail.
- `POST /api/recap/envoyer` : déclenche l'envoi immédiatement (test, ou
  rattrapage si le serveur était indisponible à l'heure prévue).

## Bilan de santé

Note de synthèse sur l'état général de l'activité (chiffre d'affaires 7/30
jours avec évolution, impayés répartis par ancienneté de retard, documents
fournisseurs en attente, points de vigilance) — distincte du récapitulatif
quotidien ci-dessus, qui ne couvre que les événements du jour même.

- `GET /api/bilan-sante/apercu` : contenu (texte), sans envoyer d'e-mail.
- `POST /api/bilan-sante/envoyer` : envoie immédiatement à la boîte Gmail connectée.
- Accessible aussi depuis la section « Bilan de santé » de l'interface.

## Morgane, l'assistante IA

Section « Morgane » de l'interface : un chat qui répond aux questions sur
l'activité et peut exécuter des actions déléguées, en s'appuyant sur l'API
Claude d'Anthropic (`ANTHROPIC_API_KEY` dans `.env`, voir
`docs/mise-en-service.md`). Toujours fondée sur des données réelles — jamais
un chiffre inventé : chaque réponse chiffrée provient d'un appel outil vers
les mêmes données que le reste de l'application (tableau de bord, bilan de
santé, anomalies, factures impayées), jamais d'une estimation du modèle.

Actions qu'elle peut déléguer, uniquement sur demande explicite : ignorer
une anomalie précise, déclencher une synchronisation Gmail immédiate,
envoyer le récapitulatif quotidien ou le bilan de santé par e-mail.

- `POST /api/morgane/message` : `{ historique: [{role, content}, ...] }` → `{ reponse }`.
- Sans `ANTHROPIC_API_KEY`, la section affiche une erreur explicite ; le
  reste de l'application continue de fonctionner normalement.

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

## Stripe — synchronisation directe par API

Remplace le dépôt manuel d'export CSV Stripe par une **récupération
automatique** des payouts et des paiements qui les composent, directement
via l'API Stripe (`src/services/stripeSync.ts`) :

- Nécessite `STRIPE_API_KEY` dans `.env` — une clé **restreinte, lecture
  seule** (jamais la clé secrète complète du compte). Sans elle, la section
  Stripe de l'interface reste simplement désactivée, tout le reste continue
  de fonctionner.
- Synchronise automatiquement toutes les heures (`STRIPE_POLL_INTERVAL_MS`,
  réglable) une fois connecté, ou à la demande (bouton « Synchroniser
  maintenant », ou Morgane).
- Utilise **exactement les mêmes clés de déduplication** que l'import CSV
  (`Payout.payoutRef`, `Paiement.paymentRef`) : les deux voies alimentent la
  même base sans jamais se dupliquer, le dépôt manuel d'un fichier reste
  possible en complément si besoin.
- Déclenche automatiquement le rapprochement bancaire (voir ci-dessous)
  après chaque synchronisation.

- `GET /api/stripe/status` : connecté ou non, date de dernière synchronisation.
- `POST /api/stripe/sync` : déclenche une synchronisation immédiate.

## Rapprochement bancaire (payouts Stripe)

Fait automatiquement correspondre un payout Stripe groupé (virement) au
mouvement bancaire correspondant (section 5) — jusqu'ici visible mais
jamais relié : `Payout.mouvementBancaireId` et
`MouvementBancaire.rapprochementStatut` existaient déjà dans le modèle de
données sans être renseignés.

- **Correspondance exigée** : même montant (à 1 centime près) et date à 5
  jours d'écart maximum. Une seule correspondance possible → rapprochement
  automatique (écriture purement interne, même niveau de confiance que le
  rattachement client par nom — pas de validation humaine requise,
  contrairement aux relances qui contactent un tiers).
- **Ambiguïté jamais devinée** (section 14) : si plusieurs mouvements
  correspondent au même montant à des dates proches, rien n'est rapproché
  automatiquement — à vérifier manuellement.
- Se déclenche automatiquement après chaque import d'un relevé bancaire ou
  d'un export de payouts Stripe. Rejouable à la demande :
  `POST /api/rapprochement-bancaire/executer` (utile après correction
  d'une donnée, sans redéposer de fichier).
- Le mouvement bancaire rapproché apparaît dans
  `GET /api/payouts/:payoutRef/ventilation`. Morgane peut aussi vérifier
  l'état du rapprochement sur demande.

## Fiche Fournisseurs

Aucun import dédié n'existe pour les fournisseurs (contrairement aux
clients, qui arrivent par l'export Synec) : les fiches sont **dérivées
automatiquement** de l'expéditeur des documents reçus par e-mail
(`src/services/fournisseurs.ts`) — un fournisseur par expéditeur, créé au
premier document reçu :

- Nom affiché dans l'e-mail (`"Cedeo Paris" <contact@cedeo.fr>`) utilisé en
  priorité, sinon dérivé du domaine (`point-p.fr` → « Point P »).
- Pour une messagerie grand public (gmail.com, outlook.com...) sans nom
  affiché, l'adresse elle-même sert de nom plutôt que d'inventer une raison
  sociale à partir du domaine.
- Chaque document reçu ensuite du même expéditeur rejoint automatiquement
  la même fiche (nombre de documents, de factures, de documents en attente,
  date du dernier document reçu).

- `GET /api/fournisseurs` : liste avec résumé d'activité.
- `GET /api/fournisseurs/:id` : détail d'un fournisseur et historique complet de ses documents.

## Relances de factures impayées

Moteur de règles (section 4.3 du cahier des charges, Phase 5) qui détermine
automatiquement **qui** relancer et **à quel palier**, selon le retard par
rapport à l'échéance :

| Palier | Retard |
|---|---|
| Rappel amical | 7 jours |
| Relance formelle | 15 jours |
| Mise en demeure | 30 jours |

- Une facture sous **délai accordé** (`delaiAccordeJusqua` dans le futur)
  n'est jamais relancée tant que ce délai court (section 4.3).
- Un palier déjà envoyé n'est jamais renvoyé (table `Relance`) ; une facture
  ne réapparaît que lorsqu'elle atteint un **nouveau** palier.
- **L'envoi reste toujours un geste humain volontaire, facture par
  facture** — jamais déclenché automatiquement par le planificateur.
  Contacter un client sur un impayé a un impact sur la relation
  commerciale plus sensible qu'un routage interne de document : le moteur
  propose, il n'envoie jamais de lui-même (même philosophie que
  `DEXT_AUTO_FORWARD` après l'incident Dext, en encore plus prudent).

Le texte de relance est généré automatiquement (ton croissant selon le
palier) et modifiable avant envoi le cas échéant en le retapant dans son
propre client mail — dans l'application, le bouton "Envoyer" utilise le
texte proposé tel quel, via la boîte Gmail connectée.

- `GET /api/relances` : liste des factures à relancer avec le texte proposé.
- `POST /api/relances/:factureId/envoyer` : envoie la relance pour cette facture précise.

## API

| Route | Description |
|---|---|
| `POST /api/import` | Dépose un fichier CSV (champ `fichier`), retourne le résumé de l'import |
| `GET /api/imports` | Historique des imports (type détecté, statut, compteurs) |
| `GET /api/clients` | Clients normalisés (identité, coordonnées, adresse) |
| `GET /api/factures?statut=impayee` | Liste des factures normalisées |
| `GET /api/paiements` | Paiements Stripe normalisés |
| `GET /api/payouts` | Virements Stripe |
| `GET /api/payouts/:payoutRef/ventilation` | Détail des paiements composant un virement, avec le mouvement bancaire rapproché (chaîne de preuves, section 5) |
| `POST /api/rapprochement-bancaire/executer` | Relance le rapprochement automatique payouts ↔ mouvements bancaires |
| `GET /api/stripe/status` | État de la connexion Stripe et date de dernière synchronisation |
| `POST /api/stripe/sync` | Déclenche une synchronisation Stripe immédiate (payouts + paiements) |
| `GET /api/recapitulatifs-solde` | Récapitulatif de solde Stripe par période (repère d'audit) |
| `GET /api/mouvements-bancaires` | Mouvements bancaires importés |
| `GET /api/journal` | Journal des événements (section 12) |
| `GET /api/dashboard/summary` | CA de la veille, impayés, alertes (cockpit, section 9) |
| `GET /auth/google` | Redirige vers l'écran de consentement Google (connexion Gmail) |
| `GET /auth/google/callback` | Callback OAuth, enregistre la connexion Gmail |
| `GET /api/gmail/status` | Compte Gmail connecté et date de dernière synchronisation |
| `POST /api/gmail/sync` | Déclenche une synchronisation Gmail → Dext immédiate |
| `GET /api/documents-fournisseurs` | Documents reçus par e-mail (factures transférées, avoirs/bons/relevés archivés) |
| `GET /api/anomalies?statut=a_valider` | Documents ambigus en attente de classification manuelle |
| `PATCH /api/anomalies/:id` | Change le statut d'une anomalie (`a_valider`\|`validee`\|`ignoree`) |
| `POST /api/anomalies/ignorer-en-masse` | Ignore plusieurs anomalies (`ids` et/ou `type`) |
| `GET /api/anomalies/:id/document` | Prévisualise la pièce jointe d'une anomalie (redemandée à Gmail à la volée) |
| `GET /api/recap/apercu` | Aperçu (texte) du récapitulatif quotidien, sans envoyer d'e-mail |
| `POST /api/recap/envoyer` | Envoie immédiatement le récapitulatif quotidien à la boîte Gmail connectée |
| `GET /api/bilan-sante/apercu` | Aperçu (texte) du bilan de santé, sans envoyer d'e-mail |
| `POST /api/bilan-sante/envoyer` | Envoie immédiatement le bilan de santé à la boîte Gmail connectée |
| `POST /api/morgane/message` | Envoie un message à Morgane (assistante IA), retourne sa réponse |
| `GET /api/fournisseurs` | Fournisseurs (fiches dérivées automatiquement) avec résumé d'activité |
| `GET /api/fournisseurs/:id` | Détail d'un fournisseur et historique de ses documents |
| `GET /api/relances` | Factures ayant atteint un nouveau palier de retard, avec texte de relance proposé |
| `POST /api/relances/:factureId/envoyer` | Envoie la relance proposée pour cette facture |

## Modèle de données

`prisma/schema.prisma` reprend la section 15 du cahier des charges
(« Données principales à stocker ») : `Client`, `Facture`, `Paiement`,
`Payout`, `MouvementBancaire`, `Fournisseur`, `DocumentFournisseur`,
`FactureFournisseur`, `Decision`, `Anomalie`, `JournalEvenement`,
`GmailConnexion` (jeton OAuth chiffré), en plus de `ImportBatch` qui trace
chaque fichier reçu.

PostgreSQL partout (section 16), y compris en développement local, pour ne
jamais tester sur un moteur différent de la production — voir « Démarrage
rapide » ci-dessus pour l'installer.

## Tests

```bash
npm test
```

Couvre : lecture CSV (BOM, séparateurs, montants FR/US, dates), détection de
type, reconstitution du statut Synec à partir de la colonne `payments`
(paiement unique, en plusieurs fois, partiel, financement Oney, avoir),
extraction des opérations d'un relevé PDF (séparation libellé/référence par
la mise en page, exclusion de l'annexe SEPA qui doublonnerait les
mouvements, déduction de l'année sur un passage d'année), et un test de
bout en bout qui rejoue le scénario de la section 5 (deux paiements Stripe
regroupés dans un virement, lui-même rapproché d'un mouvement bancaire) sur
une base PostgreSQL de test dédiée (`TEST_DATABASE_URL`, recréée à chaque
lancement — voir `.env.example`).

Couvre aussi la classification Gmail → Dext (facture standard même sans le
mot « facture », bon d'enlèvement, avoir, relevé, choix de l'adresse Dext
selon le nombre de factures dans l'e-mail) et le chiffrement du jeton Gmail
(aller-retour fidèle, intégrité garantie par le tag d'authentification
GCM). La synchronisation Gmail elle-même (appels réels à l'API Gmail)
n'est pas testée automatiquement — elle nécessite une vraie connexion
OAuth, à valider manuellement une fois `docs/mise-en-service.md` suivi.

Les connecteurs Synec (factures et clients) et relevé PDF ont par ailleurs
été validés manuellement sur les fichiers réels complets avant publication
(347 factures, 480 clients, 76 mouvements bancaires — total recalculé
identique au total imprimé par la banque) — voir
`docs/criteres-acceptation.md`. `npm test` ne rejoue pas ce PDF réel (il
n'est pas commité, cf. section suivante) ; il teste le parseur sur un texte
fictif reproduisant la même mise en page.

## Données personnelles

Les fichiers réels (Synec en particulier) contiennent des noms, e-mails et
téléphones de clients d'Atelier Brochant. Aucun fichier réel n'est commité
dans ce dépôt : `samples/` ne contient que des fixtures fictives reproduisant
la structure exacte des vrais exports (voir `samples/README.md`). Gardez la
même discipline pour vos propres tests.

## Prochaines étapes suggérées

1. Suivre `docs/mise-en-service.md` : hébergement OVHcloud + connexion Gmail.
2. Phase 3 — API Stripe (remplace les exports CSV par une synchronisation continue).
3. Phase 4 — Fournisseurs (échéances, prélèvements, sous-traitants).
4. Phase 5 — Moteur de règles, agents et centre de validation complet (section 8, 13).
5. Phase 6 — Cockpit visuel complet (section 9) et e-mail quotidien (section 10).
