# Points de conformité à traiter avant le lancement des campagnes

Ce document résume les points juridiques mentionnés dans le cahier des
charges. **Il ne remplace pas un avis juridique** : faites valider ce
parcours par un professionnel du droit avant de dépenser un euro en
publicité, en particulier sur le point 1 ci-dessous.

## 1. Démarchage téléphonique et rénovation énergétique

Depuis la loi du 24 juillet 2020 (renforcée par la loi n° 2020-901), **le
démarchage téléphonique visant à proposer des travaux de rénovation
énergétique est interdit en France**, y compris pour les entreprises non
inscrites sur Bloctel.

**Exception légale : la demande expresse et préalable du consommateur.**
C'est précisément le cas d'usage de ce site : le prospect remplit
lui-même un formulaire pour *demander* à être rappelé au sujet de son
projet. Ce parcours "opt-in" (le prospect sollicite l'appel, l'entreprise
ne démarche pas à froid) est ce qui permet légalement l'appel qui suit.

Conséquences concrètes pour ce site :

- Le formulaire doit rester **volontaire et informé** : la case
  consentement (étape finale) doit être visible, non cochée par défaut, et
  formulée clairement ("j'accepte d'être contacté(e)...").
- Ne jamais acheter ou réutiliser une liste de contacts n'ayant pas
  explicitement demandé un rappel via ce parcours pour ce projet précis.
- Conserver une preuve de ce consentement (date, formulaire soumis) — la
  base locale (`lib/db.ts`) horodate chaque lead à cette fin.
- Si un délai important s'écoule entre la demande et l'appel, ou si le
  lead est revendu à un partenaire, vérifier avec un juriste que le
  consentement initial couvre toujours l'appel (préciser au besoin,
  dans le texte de consentement, que des partenaires peuvent être amenés
  à contacter le prospect — c'est déjà le cas dans le texte actuel du
  formulaire).

## 2. RGPD

Voir `/politique-confidentialite` : base légale (consentement), durée de
conservation, droits des personnes, destinataires (équipes internes +
professionnels partenaires après accord du prospect). À adapter si un
sous-traitant supplémentaire (CRM externe, outil d'emailing) est ajouté —
il doit alors apparaître dans la politique et faire l'objet d'un contrat
de sous-traitance RGPD.

## 3. Promesses sur les aides publiques

Le cahier des charges est explicite sur ce point : ne jamais promettre
« travaux gratuits », « financé à 100 % » ou un montant d'aide garanti
avant étude du dossier. Ce principe est déjà appliqué dans les textes du
site (`components/sections/aides-section.tsx`, FAQ, mentions légales) —
à vérifier systématiquement dans toute nouvelle accroche publicitaire
créée pour les campagnes Meta/Google Ads, y compris les visuels et
titres d'annonce (qui ne sont pas dans ce dépôt).

## 4. Cookies et consentement publicitaire

Le bandeau (`components/cookie-consent.tsx`) bloque GA4, Google Ads et
Meta Pixel tant qu'aucun choix n'est fait, et rend le refus aussi simple
que l'acceptation (recommandation CNIL). Si vous ajoutez d'autres
scripts tiers (chat, heatmap...), veillez à les gater de la même façon.
