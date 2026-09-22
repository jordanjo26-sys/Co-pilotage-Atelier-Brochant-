# Site de génération de leads — Rénovation énergétique

Site publicitaire (Meta Ads / Google Ads) pour générer des demandes de
prospects qualifiés en rénovation énergétique, conformément au cahier des
charges fourni. **Projet totalement indépendant** du copilote de gestion
Atelier Brochant présent dans le reste de ce dépôt : autre stack (Next.js
au lieu d'Express), autre base de données (SQLite locale au lieu de
Postgres), aucun fichier ni dépendance partagés.

## Démarrage rapide

```bash
cd leads-renovation-energetique
npm install
cp .env.example .env   # facultatif en dev : les identifiants de tracking sont vides par défaut
npm run dev
```

Ouvrir <http://localhost:3000>.

## Ce qui est construit

- **Page d'accueil** (`/`) : accroche, solutions de rénovation, étapes,
  aides (formulations prudentes), réassurance, FAQ, formulaire.
- **3 landing pages dédiées** pour les campagnes ciblées : `/isolation`,
  `/pompe-a-chaleur`, `/renovation-globale` — chacune pré-répond à la
  question "quels travaux ?" du questionnaire en cohérence avec
  l'annonce cliquée.
- **Questionnaire progressif en 7 étapes** (`components/lead-form`) :
  logement → statut → travaux → surface → code postal → délai →
  coordonnées, avec case de consentement explicite.
- **API `/api/leads`** : valide le formulaire (Zod), enregistre le lead
  dans une base SQLite locale (`lib/db.ts`), transmet à un CRM externe si
  `CRM_WEBHOOK_URL` est configuré, et envoie l'événement à l'API
  Conversions de Meta côté serveur si configurée.
- **Suivi publicitaire** : GA4 et conversion Google Ads (gtag), Meta
  Pixel + Conversions API, tous **gatés par consentement** (bandeau
  cookies, `components/cookie-consent.tsx`) — rien n'est chargé avant un
  choix explicite de l'utilisateur.
- **Pages légales** : `/mentions-legales`, `/politique-confidentialite`.
- **Traçabilité des leads** : chaque lead enregistré porte, quand
  disponibles, `source`, `campagne`, `support`, `contenuAnnonce`,
  `motCle`, `gclid`, `fbclid` et la page d'entrée — capturés depuis l'URL
  à l'arrivée sur le site (`lib/utm.ts`) puis associés à la soumission,
  même si elle a lieu plusieurs minutes plus tard.

## Configuration

Voir `.env.example`. Rien n'est requis pour développer en local : sans
identifiants de tracking, les scripts correspondants ne sont simplement
pas chargés ; sans `CRM_WEBHOOK_URL`, les leads restent dans la base
SQLite locale (`data/leads.db`, ignorée par git).

Les informations d'identité de l'entreprise (nom, téléphone, SIRET,
adresse, hébergeur) sont centralisées dans `lib/site-config.ts` — **à
remplacer par vos vraies coordonnées avant mise en ligne**, elles sont
actuellement des valeurs d'exemple.

## Conformité — à lire avant de lancer les campagnes

`docs/conformite.md` détaille les points signalés dans le cahier des
charges : interdiction du démarchage téléphonique pour la rénovation
énergétique (et pourquoi le parcours "opt-in" de ce site respecte
l'exception légale de demande expresse), RGPD, formulations sur les
aides publiques, gestion du consentement cookies. **Cette page ne
remplace pas une relecture par un professionnel du droit.**

## Prochaines étapes suggérées

1. Remplacer les textes/valeurs d'exemple (`lib/site-config.ts`, pages
   légales) par les vraies informations de l'entreprise.
2. Remplacer l'illustration vectorielle du hero
   (`components/sections/house-illustration.tsx`) par une vraie
   photographie qualitative.
3. Faire valider les pages légales et le parcours de consentement
   téléphonique par un professionnel du droit (voir
   `docs/conformite.md`).
4. Brancher `CRM_WEBHOOK_URL` sur votre outil de suivi commercial réel
   (ou remplacer `lib/db.ts` par une intégration directe si vous
   préférez).
5. Renseigner les identifiants GA4 / Google Ads / Meta dans `.env` avant
   de lancer les campagnes, pour pouvoir mesurer coût par lead et,
   avec un CRM à jour du statut des leads (`statut` dans le modèle),
   coût par chantier signé.
6. Éventuellement, ajouter des pages géographiques dédiées si l'activité
   est limitée à certaines zones (`siteConfig.zonesDesservies`).

## Tests manuels effectués

Le parcours complet (accueil → questionnaire 7 étapes → soumission →
page de confirmation → lead visible en base) a été testé en local avec un
navigateur, en résolution mobile et desktop. Aucun test automatisé n'est
encore en place (à ajouter si le projet grandit — par ex. Playwright sur
le parcours de conversion).
