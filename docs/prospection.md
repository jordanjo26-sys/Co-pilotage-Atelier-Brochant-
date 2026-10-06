# Architecture — module Prospection commerciale

Ce document explique le module de prospection (sourcing, mini-CRM,
enrichissement email, campagnes) construit à partir du cahier des charges
« Outil de prospection commerciale » (v1.0, septembre 2026), fourni en
référence dans `docs/cahier-des-charges-prospection.docx`. Il s'agit d'un
second module dans ce même dépôt, distinct de la gestion (factures, Gmail →
Dext, Stripe…) documentée dans `docs/architecture.md` : cible commerciale
différente (syndics/gestionnaires et assurances, priorité Seine-et-Marne 77),
mais même application, même base de données, même connexion Gmail.

Accès : lien « Prospection commerciale » depuis le cockpit principal
(`/prospection.html`), API sous `/api/prospection/*`.

## Ce qui est construit et pleinement fonctionnel

- **Sourcing (section 2.1)** : import CSV avec dédoublonnage (entreprise +
  email), ajout manuel. Recherche automatisée par mot-clé/zone (Google
  Places) codée et prête, mais désactivée tant que `GOOGLE_PLACES_API_KEY`
  n'est pas fournie (voir « Points ouverts » ci-dessous) — voir
  `src/services/prospection/sourcing.ts`.
- **Mini-CRM (section 2.2)** : fiches prospect avec tous les champs demandés,
  statuts avec historique horodaté, notes, dates de premier contact/relance,
  filtre par type/statut/marque/code postal/recherche libre —
  `src/services/prospection/crm.ts`.
- **Enrichissement email (section 2.3)** : génère une adresse plausible
  (`contact@`, `prenom.nom@`...) à partir du site web, vérifiée par requête
  DNS **MX réelle** (aucune clé API requise) avant d'être retenue. Fournisseur
  tiers (Hunter.io) câblé mais désactivé sans `HUNTER_API_KEY` —
  `src/services/prospection/enrichissement.ts`.
- **Campagnes (section 2.4)** : modèles de mail avec variables
  (`{{contact}}`, `{{entreprise}}`, `{{marque}}`, `{{service}}`), pièce
  jointe optionnelle par modèle (plaquette commerciale PDF/PNG/JPEG, 15 Mo
  max — stockée hors dépôt dans `uploads/prospection/`, voir
  `src/services/prospection/pieceJointe.ts`), segments réévalués à chaque
  envoi, envoi réel via la boîte Gmail déjà connectée (aucun abonnement
  supplémentaire nécessaire pour démarrer), lien de désinscription et pixel
  de suivi insérés automatiquement, quota d'envoi quotidien
  (`PROSPECTION_ENVOI_QUOTIDIEN_MAX`) — `src/services/prospection/campagnes.ts`.
  Chaque campagne peut être **manuelle** (un clic envoie aux prospects dus)
  ou **automatique** (bascule explicite depuis l'interface, avec
  confirmation) : un planificateur envoie alors seul les premiers envois et
  les relances dues, toutes les heures par défaut
  (`PROSPECTION_ENVOI_AUTO_INTERVAL_MS`), toujours dans la limite du même
  quota quotidien partagé avec les envois manuels.
- **Suivi et reporting (section 2.5)** : ouverture (pixel), clic (lien
  réécrit), réponse (détection automatique par lecture du fil Gmail,
  planifiée toutes les 15 minutes), désinscription — tout est tracé sur
  `EnvoiCampagne` et agrégé dans le tableau de bord —
  `src/services/prospection/dashboard.ts`.
- **RGPD (section 3)** : lien de désinscription systématique et obligatoire
  dans chaque e-mail, un prospect désinscrit est exclu de tout futur segment
  quel que soit le filtre, aucune donnée sensible collectée.

## Choix délibérés

- **Envoi via Gmail plutôt que Brevo/Mailjet (section 4)** : évite un
  abonnement supplémentaire pour démarrer. Volume limité par le quota Gmail
  (~500/j sur un compte Workspace) — largement suffisant pour le volume de
  démarrage visé sur la Seine-et-Marne. Migrer vers Brevo/Mailjet plus tard
  ne change que `envoyerMail()` dans `campagnes.ts`, pas le reste du module.
- **Envoi manuel par défaut, automatique sur demande explicite par
  campagne** — même principe de prudence que les relances de factures
  impayées (`src/services/relances.ts`) au départ (un envoi de masse a un
  impact externe qui justifie un geste humain), mais l'exploitant a
  explicitement demandé de pouvoir automatiser l'envoi des e-mails de
  prospection : chaque campagne reste manuelle à la création
  (`Campagne.automatique = false` par défaut), et n'est envoyée sans clic
  qu'une fois ce réglage activé volontairement depuis l'interface (avec
  confirmation explicite du risque). Le quota quotidien reste le garde-fou
  commun aux deux modes. Les relances de factures, elles, restent
  inchangées : toujours manuelles, la sensibilité relationnelle d'un impayé
  étant d'une autre nature qu'une prospection commerciale à froid.
  La détection de réponse, elle, est automatique dans tous les cas (lecture
  seule, aucun envoi).
- **Import Excel non implémenté** : le seul paquet npm disponible pour lire
  les `.xlsx` (`xlsx`/SheetJS) a des vulnérabilités connues non corrigées sur
  le registre npm (pollution de prototype, ReDoS — voir `npm audit`), pour un
  module qui traite des fichiers déposés par un utilisateur. Import CSV
  uniquement pour l'instant ; Excel s'exporte en CSV en une étape depuis
  n'importe quel tableur.

## Points ouverts (section 7 du cahier des charges)

À arbitrer avec le développeur avant d'aller plus loin que le MVP ci-dessus :

- **Sourcing automatisé** : activer `GOOGLE_PLACES_API_KEY` (ou retenir un
  autre annuaire) pour la recherche par mot-clé + zone. Sans clé, l'import
  CSV/manuel reste pleinement utilisable pour démarrer.
- **Enrichissement email** : activer `HUNTER_API_KEY` si le taux de
  succès de la simple vérification MX s'avère insuffisant en pratique.
- **Volume d'envoi mensuel visé** : si le quota Gmail devient limitant,
  reconsidérer Brevo/Mailjet (section 4).
- **Nombre d'utilisateurs** : l'application n'a actuellement aucune
  authentification (comme le reste du dépôt) — à ajouter si plusieurs
  personnes doivent y accéder avec des droits différents (section 2.2).

## Stockage des pièces jointes

`uploads/prospection/` (hors dépôt, voir `.gitignore`) doit **persister sur
le serveur entre deux déploiements** : le workflow de déploiement
(`.github/workflows/deploy.yml`) exclut ce dossier du `rsync --delete` au
même titre que `.env`, pour ne pas effacer les plaquettes commerciales
déjà envoyées à chaque mise à jour du code.

## Modèle de données

Cinq tables ajoutées au schéma existant (`prisma/schema.prisma`) :
`Prospect`, `ProspectStatutChangement` (historique), `ProspectionImport`
(traçabilité des imports CSV, même principe que `ImportBatch`),
`EmailTemplate`, `Campagne`, `EnvoiCampagne` (un envoi = un token de suivi
unique, jamais l'id interne, pour ne pas exposer les identifiants de la base
dans les URLs d'un e-mail).
