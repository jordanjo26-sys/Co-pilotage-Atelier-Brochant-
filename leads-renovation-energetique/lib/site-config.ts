// Configuration centrale du site : à adapter avant mise en production
// (nom de marque, téléphone, zones desservies, identifiants publicitaires).

export const siteConfig = {
  brand: "RénovConseil",
  baseline: "Rénovation énergétique",
  phoneDisplay: "01 23 45 67 89",
  phoneHref: "+33123456789",
  // Zones desservies affichées dans le footer / réassurance. Laisser vide
  // (tableau vide) pour ne rien afficher si vous intervenez partout en France.
  zonesDesservies: [] as string[],
  siret: "000 000 000 00000",
  siegeSocial: "12 rue de l'Exemple, 75000 Paris",
  directeurPublication: "Nom du responsable de publication",
  hebergeur: {
    nom: "Nom de l'hébergeur",
    adresse: "Adresse de l'hébergeur",
  },
};

// Identifiants de tracking : lus depuis l'environnement, absents en dev.
// Chaque script n'est chargé que si son identifiant est renseigné ET que le
// consentement correspondant a été donné (voir components/analytics).
export const trackingConfig = {
  ga4MeasurementId: process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID ?? "",
  googleAdsConversionId: process.env.NEXT_PUBLIC_GOOGLE_ADS_ID ?? "",
  googleAdsConversionLabel: process.env.NEXT_PUBLIC_GOOGLE_ADS_CONVERSION_LABEL ?? "",
  metaPixelId: process.env.NEXT_PUBLIC_META_PIXEL_ID ?? "",
};
