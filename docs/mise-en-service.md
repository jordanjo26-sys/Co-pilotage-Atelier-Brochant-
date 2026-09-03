# Mise en service — hébergement OVHcloud et connexion Gmail

Ce document liste, dans l'ordre, tout ce qui doit être fait **côté humain**
(compte, paiement, clic de consentement) pour que le pipeline Gmail → Dext
(section 7 du cahier des charges) tourne en continu sur un serveur réel.
Rien de ceci ne peut être fait à votre place : ce sont des actions liées à
votre identité ou à vos comptes (OVHcloud, Google).

## 1. Serveur OVHcloud

1. Créer un compte OVHcloud si vous n'en avez pas, puis commander un
   **VPS** (pas besoin d'un serveur dédié pour démarrer) :
   - Gamme "VPS Value" ou "VPS Essential" suffit largement pour un artisan/TPE.
   - Image système : **Ubuntu 22.04 LTS** (ou plus récent), conforme à la
     section 16 du cahier des charges.
   - Région : Europe (Gravelines ou Strasbourg, au choix).
2. Une fois le VPS actif, récupérer :
   - son adresse IP publique,
   - l'accès root (mot de passe initial reçu par e-mail, ou clé SSH si vous
     en avez configuré une à la commande).
3. **Me transmettre l'IP et l'accès SSH** (idéalement une clé SSH plutôt
   qu'un mot de passe — je peux vous indiquer comment en générer une) pour
   que je configure le serveur : Node.js, PostgreSQL, la base du dépôt, un
   reverse proxy (nginx) avec certificat HTTPS (Let's Encrypt), et le
   service applicatif en tâche de fond (systemd), qui redémarre tout seul
   en cas de coupure.
4. Un nom de domaine ou sous-domaine (ex. `copilote.atelier-brochant.fr`)
   pointant vers cette IP est recommandé mais pas obligatoire pour démarrer
   (on peut commencer sur l'IP brute avec un certificat auto-signé, puis
   ajouter le domaine ensuite).

## 2. Connexion Gmail (OAuth)

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
   - URI de redirection autorisée : `https://votre-domaine/auth/google/callback`
     (ou `http://localhost:3000/auth/google/callback` pour tester en local
     avant le déploiement définitif).
6. **Me transmettre le "ID client" et le "Secret du client"** générés à
   cette étape (ce sont des identifiants d'application, pas votre mot de
   passe Google — conformes à la règle "jamais de mot de passe" de la
   section 17 du cahier des charges).
7. Une fois ces identifiants renseignés dans le `.env` du serveur
   (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`),
   ouvrir `https://votre-domaine/auth/google` dans un navigateur **connecté
   à la boîte Gmail de l'entreprise** et cliquer sur "Autoriser" — c'est la
   seule étape que vous devez faire vous-même dans l'interface de l'app.

## 3. Dext

Rien à configurer côté Dext pour la V1 : les adresses de réception
(`facturation-brochant@dext.cc` et `facturation-brochant@multiple.dext.cc`,
déjà indiquées dans le cahier des charges) sont directement utilisées par
le connecteur Gmail → Dext. Vérifier simplement qu'elles sont toujours
actives dans votre compte Dext.

## 4. Stripe (pour plus tard)

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
- Rien de ceci ne fonctionne tant que les étapes 1 et 2 ci-dessus n'ont pas
  été faites : sans serveur permanent, personne ne vérifie Gmail entre deux
  sessions de travail ; sans connexion OAuth, il n'y a rien à vérifier.
