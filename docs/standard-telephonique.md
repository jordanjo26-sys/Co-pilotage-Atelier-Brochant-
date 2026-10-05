# Standard téléphonique IA — mise en service

L'assistante téléphonique **Morgane** décroche **à votre place
quand vous ne pouvez pas répondre**. Elle :

- prend un **message complet** : nom, numéro de rappel, adresse
  d'intervention, motif, niveau d'urgence ;
- **répond aux questions simples** (horaires, zone, services) à partir de
  `src/config/standard-telephonique.json`, et rien d'autre : ce qu'elle ne
  sait pas, elle le transmet ;
- **prend un rendez-vous** dans votre agenda Google en ne proposant que des
  créneaux réellement libres ;
- vous envoie un **compte rendu par e-mail** à la fin de chaque appel
  (sujet préfixé `URGENT` en cas de dégât des eaux / refoulement), avec la
  transcription complète.

Elle n'a accès à **aucune donnée interne** (factures, clients, chiffres) :
un appelant ne peut rien obtenir d'autre que la prise de message et
l'agenda.

## Comment ça marche

```
Client appelle VOTRE numéro habituel
        │
        ├── vous décrochez → appel normal, rien ne change
        │
        └── pas de réponse / occupé / injoignable
                │  (renvoi d'appel conditionnel chez votre opérateur)
                v
        Numéro Twilio (loué, invisible pour le client)
                │  webhooks HTTPS
                v
        copilotage-brochant.fr/telephonie/*
          - reconnaissance vocale Twilio (français)
          - réponses de l'assistante (Claude)
          - agenda Google, e-mail de compte rendu
```

Vos clients **gardent le même numéro** : c'est votre opérateur qui renvoie
l'appel vers le numéro Twilio seulement quand vous ne décrochez pas.

Si l'IA ne répond pas (panne, clé absente), l'appel bascule sur une
**messagerie vocale de secours** et le lien de l'enregistrement arrive dans
l'e-mail de compte rendu : aucun appel n'est perdu.

## Coûts indicatifs

| Poste | Ordre de grandeur |
|---|---|
| Numéro Twilio français | ~1 à 3 € / mois |
| Minutes reçues + synthèse et reconnaissance vocale | ~0,05 à 0,10 € / minute |
| IA (Claude) | quelques centimes par appel |

Un appel de 2 minutes revient donc à environ 0,20 à 0,30 €.

## Étapes à faire (côté humain)

### 1. Compte Twilio et numéro

1. Créer un compte sur [twilio.com](https://www.twilio.com/try-twilio) et
   l'approvisionner (carte bancaire, 20 € suffisent pour démarrer).
2. **Phone Numbers → Buy a number**, pays **France**, capacité **Voice**.
   Un numéro français exige un dossier réglementaire (« Regulatory
   Bundle ») : justificatif d'adresse en France et Kbis/pièce d'identité.
   La validation prend en général 1 à 3 jours ouvrés.
3. Une fois le numéro actif, dans sa configuration (**Voice
   Configuration**) :
   - **A call comes in** : Webhook, `https://copilotage-brochant.fr/telephonie/entrant`, `HTTP POST`
   - **Call status changes** : `https://copilotage-brochant.fr/telephonie/statut`, `HTTP POST`
4. Récupérer l'**Auth Token** (console Twilio → Account → *API keys &
   tokens*) et l'ajouter en secret GitHub :

   | Nom du secret | Valeur |
   |---|---|
   | `TWILIO_AUTH_TOKEN` | L'Auth Token du compte Twilio |

   Le prochain déploiement le transmet au serveur. Il sert uniquement à
   vérifier que chaque requête vient bien de Twilio (les adresses
   `/telephonie/*` sont exclues du mot de passe du site, que Twilio ne peut
   pas saisir).

`ANTHROPIC_API_KEY` (déjà utilisée par Morgane) doit aussi être configurée.

### 2. Autoriser l'accès à l'agenda Google

L'assistante réserve dans l'agenda principal du compte Google déjà
connecté pour Gmail. Cette autorisation est nouvelle : il faut **reconnecter
le compte une fois** en ouvrant `https://copilotage-brochant.fr/auth/google`
et en acceptant l'accès à l'agenda.

- Dans Google Cloud Console, **activer l'API Google Calendar** sur le même
  projet que l'API Gmail, et ajouter le scope
  `https://www.googleapis.com/auth/calendar.events` à l'écran de
  consentement.
- Sans cette étape, tout fonctionne quand même : l'assistante note
  simplement le créneau souhaité dans le message, à confirmer en rappelant.

### 3. Activer le renvoi d'appel chez votre opérateur

**Sur un mobile** (Orange, SFR, Bouygues, Free…), composer depuis le
téléphone, en remplaçant `0XXXXXXXXX` par le numéro Twilio :

| Renvoi quand… | Activer | Désactiver |
|---|---|---|
| vous ne répondez pas | `**61*0XXXXXXXXX#` | `##61#` |
| vous êtes déjà en ligne | `**67*0XXXXXXXXX#` | `##67#` |
| téléphone éteint / sans réseau | `**62*0XXXXXXXXX#` | `##62#` |
| **les trois d'un coup (recommandé)** | `**004*0XXXXXXXXX#` | `##004#` |

Le délai avant renvoi sur non-réponse se règle avec
`**61*0XXXXXXXXX**20#` (20 secondes ; valeurs possibles 5 à 30).

⚠️ Ne pas utiliser le renvoi **inconditionnel** (`**21*`) : tous les appels
partiraient vers l'assistante, même quand vous êtes disponible.

**Sur une ligne fixe / box**, le renvoi conditionnel se règle dans
l'espace client de l'opérateur (rubrique « Renvoi d'appel » / « Transfert
d'appel ») ou auprès de son service client.

Chez certains opérateurs, un renvoi vers un numéro fixe peut être facturé
comme un appel sortant : à vérifier dans votre forfait (la plupart des
forfaits incluent les appels illimités vers les fixes).

### 4. Personnaliser ce que dit l'assistante

Relire et compléter `src/config/standard-telephonique.json` :

- `prenomResponsable` : votre prénom (« Jordan n'est pas disponible… ») ;
- `prenomAgent` : le prénom de l'assistante ;
- `horairesTexte`, `horairesRendezVous` : horaires annoncés et plages où
  elle peut placer des rendez-vous ;
- `dureeRendezVousMinutes`, `delaiMinimumAvantRendezVousHeures` ;
- `tarifs` : laisser vide pour qu'elle ne donne **jamais** de prix, ou
  lister des tarifs indicatifs (ex. `"Debouchage evier : a partir de 90 euros TTC"`) ;
- `consignesUrgence`, `informationsComplementaires`.

Les valeurs actuelles sont des **exemples à vérifier**.

### 5. Tester

Appeler votre numéro depuis un autre téléphone sans décrocher : après le
délai de renvoi, l'assistante répond. Le compte rendu arrive par e-mail à
la boîte Gmail connectée (ou à `TELEPHONE_EMAIL_NOTIFICATION` si définie).
Chaque appel est aussi enregistré en base (table `Appel`) et les erreurs
dans le Journal (`appel_erreur_ia`, `appel_non_notifie`).

## Réglages optionnels (`.env` du serveur)

| Variable | Rôle | Défaut |
|---|---|---|
| `TELEPHONE_EMAIL_NOTIFICATION` | Destinataire des comptes rendus | boîte Gmail connectée |
| `GOOGLE_CALENDAR_ID` | Agenda où réserver | `primary` |
| `TELEPHONE_VOIX` | Voix de synthèse Twilio | `Polly.Lea-Neural` |
| `TELEPHONE_MODELE` | Modèle Claude | `claude-opus-5-5` |
| `TELEPHONE_URL_PUBLIQUE` | URL publique (vérification de signature) | `https://copilotage-brochant.fr` (posée au déploiement) |

## Limites connues

- Conversation au tour par tour : l'appelant parle, puis l'assistante
  répond après une à trois secondes. On ne peut pas lui couper la parole.
- La reconnaissance vocale peut écorcher noms et adresses : l'assistante
  fait confirmer, et la transcription complète figure dans l'e-mail.
- Un seul rendez-vous par appel.
