# Mise en service — hébergement OVHcloud et connexion Gmail

Ce document liste, dans l'ordre, tout ce qui doit être fait **côté humain**
(compte, paiement, clic de consentement, secrets à transmettre) pour que le
pipeline Gmail → Dext (section 7 du cahier des charges) tourne en continu
sur un serveur réel. Rien de ceci ne peut être fait à la place de
l'utilisateur : ce sont des actions liées à son identité ou à ses comptes
(OVHcloud, Google, GitHub).

## 1. Serveur OVHcloud — fait

Une instance **OVHcloud Public Cloud** (projet "Co-pilote Atelier
Brochant", modèle `d2-4`, région Gravelines) a été créée, avec la clé SSH
dédiée `brochant-deploy` autorisée dessus.

> ⚠️ Contrainte technique découverte en cours de route : l'environnement
> qui exécute Claude Code ne peut sortir qu'en HTTPS (via un proxy), jamais
> en connexion SSH directe. Il est donc **impossible de se connecter
> directement au serveur depuis cette session** pour le configurer. La
> solution retenue : passer par **GitHub Actions**, qui tourne sur
> l'infrastructure de GitHub (sans cette restriction) pour synchroniser le
> code et exécuter le script de déploiement (`scripts/deploy/bootstrap.sh`,
> idempotent) sur le serveur via SSH. Voir section 1 bis ci-dessous.

## 1 bis. Déploiement automatisé (GitHub Actions) — à configurer

Trois secrets doivent être ajoutés sur le dépôt GitHub :
**Settings → Secrets and variables → Actions → New repository secret**.

| Nom du secret | Valeur |
|---|---|
| `OVH_HOST` | L'adresse IP publique du serveur (ex. `137.74.133.193`) |
| `OVH_USER` | `ubuntu` — les images Ubuntu cloud OVH désactivent la connexion SSH directe en `root` ; il faut se connecter en `ubuntu` puis passer par `sudo` (déjà géré par le workflow) |
| `OVH_SSH_PRIVATE_KEY` | La clé **privée** correspondant à la clé publique `brochant-deploy` déjà autorisée sur le serveur |

La clé privée a été générée dans cette session (jamais envoyée par un autre
canal) : demander à Claude de vous la communiquer pour l'ajouter dans
GitHub, ou de créer une nouvelle paire si la session a changé entre-temps.

Une fois ces trois secrets renseignés, le déploiement se déclenche :
- **automatiquement** à chaque fusion sur la branche `main` ;
- **manuellement** à tout moment depuis l'onglet **Actions** du dépôt
  GitHub → workflow "Déploiement OVHcloud" → **Run workflow** (ou en le
  demandant à Claude, qui peut le déclencher directement).

Le workflow (`.github/workflows/deploy.yml`) synchronise le code sur le
serveur puis exécute `scripts/deploy/bootstrap.sh`, qui installe/actualise
tout ce qu'il faut (Node.js, PostgreSQL, nginx, service systemd) — sans
jamais écraser le fichier `.env` du serveur une fois créé, pour préserver
les identifiants déjà configurés (base de données, clé de chiffrement,
Gmail).

## 2. Nom de domaine — fait

Domaine acheté : **`copilotage-brochant.fr`** (et `www.copilotage-brochant.fr`),
enregistrements DNS de type **A** pointant vers l'IP du serveur.

Le certificat HTTPS (Let's Encrypt) est obtenu et renouvelé automatiquement
par `scripts/deploy/bootstrap.sh` à chaque déploiement : rien à faire à la
main. Le nom de domaine et l'adresse email utilisée pour l'enregistrement
Let's Encrypt sont en dur dans ce script (`DOMAIN`, `ADMIN_EMAIL`) — à
changer là si jamais le domaine ou l'adresse de contact évoluent.

## 3. Connexion Gmail (OAuth) — à faire une fois le déploiement en place

1. Aller sur [Google Cloud Console](https://console.cloud.google.com/) avec
   le compte Google qui gère l'adresse Gmail professionnelle d'Atelier
   Brochant (ou un compte administrateur si vous êtes en Google Workspace).
2. Créer un nouveau projet (nom libre, ex. "Copilote Atelier Brochant").
3. **Activer l'API Gmail** : API et services → Bibliothèque → rechercher
   "Gmail API" → Activer.
4. **Configurer l'écran de consentement OAuth** : API et services → Écran
   de consentement OAuth.
   - Type d'utilisateur : "Externe" (sauf si vous êtes en Google Workspace
     et préférez "Interne", ce qui simplifie la validation).
   - Renseigner le nom de l'application, une adresse de contact.
   - Ajouter les scopes : `gmail.readonly`, `gmail.send`, `gmail.labels`.
   - Tant que l'application n'est pas validée par Google (ce qui n'est pas
     nécessaire pour un usage interne), ajouter votre propre adresse Gmail
     comme "utilisateur test" dans cet écran — sinon la connexion échouera.
5. **Créer un identifiant OAuth** : API et services → Identifiants → Créer
   des identifiants → ID client OAuth → type "Application Web".
   - URI de redirection autorisée : `https://copilotage-brochant.fr/auth/google/callback`
6. **Ajouter l'"ID client" et le "Secret du client"** générés à cette étape
   (ce sont des identifiants d'application, pas un mot de passe Google —
   conformes à la règle "jamais de mot de passe" de la section 17 du cahier
   des charges) comme deux nouveaux secrets GitHub, comme pour les accès
   OVH (**Settings → Secrets and variables → Actions → New repository
   secret**) :

   | Nom du secret | Valeur |
   |---|---|
   | `GOOGLE_CLIENT_ID` | L'"ID client" affiché par Google |
   | `GOOGLE_CLIENT_SECRET` | Le "Secret du client" affiché par Google |

   Le prochain déploiement (automatique ou déclenché manuellement) les
   inscrit alors dans le `.env` du serveur — rien à taper à la main dessus.
7. Une fois ces identifiants en place, ouvrir
   `https://copilotage-brochant.fr/auth/google` dans un navigateur
   **connecté à la boîte Gmail de l'entreprise** et cliquer sur "Autoriser"
   — c'est la seule étape que l'utilisateur doit faire lui-même dans
   l'interface de l'app.

## 4. Dext — rien à faire

Les adresses de réception (`facturation-brochant@dext.cc` et
`facturation-brochant@multiple.dext.cc`, déjà indiquées dans le cahier des
charges) sont directement utilisées par le connecteur Gmail → Dext.
Vérifier simplement qu'elles sont toujours actives dans le compte Dext.

## 5. Stripe (pour plus tard)

Quand vous serez prêt : Tableau de bord Stripe → Développeurs → Clés API →
créer une **clé restreinte** avec un accès en lecture seule sur les
paiements, remboursements et virements (payouts). Ne jamais utiliser la clé
secrète complète du compte.

## Ce qui se passe une fois tout branché

- Le serveur vérifie la boîte Gmail toutes les 5 minutes (réglable via
  `GMAIL_POLL_INTERVAL_MS`), classe chaque pièce jointe reçue, transfère
  automatiquement les factures fournisseurs standard vers Dext, archive
  bons d'enlèvement et relevés, et met les cas ambigus en attente dans le
  centre de validation (`GET /api/anomalies`) — voir
  `docs/architecture.md` pour le détail du pipeline.
- Rien de ceci ne fonctionne tant que le déploiement (section 1 bis) et la
  connexion OAuth (section 3) n'ont pas été faits : sans serveur permanent
  et connecté, personne ne vérifie Gmail entre deux sessions de travail.
