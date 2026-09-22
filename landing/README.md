# Landing page — Rénovation énergétique (Atelier Brochant)

Page vitrine mono-page pensée pour être mise en avant sur les réseaux sociaux et en campagnes Ads (Meta, Google, TikTok...) afin de générer des leads en rénovation énergétique (isolation, pompe à chaleur, fenêtres, audit).

Site statique autonome (HTML/CSS/JS, sans dépendance), indépendant de l'outil de gestion interne (`public/`) déjà présent dans ce dépôt.

## À personnaliser avant la mise en ligne

- **Coordonnées** : remplacer le numéro `01 00 00 00 00`, l'email `contact@atelier-brochant.fr` et le lien WhatsApp dans `index.html`.
- **Mentions légales / SIRET** : compléter le pied de page (`index.html`, section `.pied-de-page`).
- **Certifications** : vérifier les labels affichés (RGE Qualibat, garantie décennale...) et ne garder que ceux réellement détenus.
- **Avis clients** : les témoignages de la section « Ce qu'en pensent nos clients » sont des exemples à remplacer par de vrais avis avant publication.
- **Zone d'intervention** : ajuster le texte du pied de page et de la FAQ.

## Connecter le formulaire

Par défaut (`script.js`, `CONFIG.endpointFormulaire = ""`), le formulaire ouvre le client mail du visiteur avec les informations pré-remplies (aucun backend requis). Pour une capture plus fiable (notamment sur mobile), renseigner `endpointFormulaire` avec l'URL d'un service qui reçoit un POST JSON, par exemple :

- [Formspree](https://formspree.io) ou [Netlify Forms](https://docs.netlify.com/forms/setup/) (aucun code serveur à écrire)
- Un Google Apps Script relié à un Google Sheet
- Une route dédiée de l'API interne de ce projet (`src/api`)

## Tracking publicitaire (Ads)

Emplacements prévus dans le code, à activer avant de lancer les campagnes :

- `index.html` (`<head>`) : coller les snippets Google Ads / GA4 et Meta Pixel.
- `script.js` (commentaire `TODO CONVERSION`) : déclencher les événements de conversion (`fbq('track', 'Lead')`, `gtag('event', 'conversion', ...)`) au moment de l'envoi du formulaire.

## Déploiement

Le dossier est 100% statique, il se déploie tel quel sur :

- **Netlify / Vercel** : déployer le dossier `landing/` comme site statique (racine = `landing`).
- **GitHub Pages** : publier le contenu de `landing/` sur la branche `gh-pages` ou via GitHub Actions.

Aucune étape de build n'est nécessaire.

## Aperçu en local

```bash
cd landing
python3 -m http.server 8080
# puis ouvrir http://localhost:8080
```
