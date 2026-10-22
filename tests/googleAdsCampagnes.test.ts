import { test } from "node:test";
import assert from "node:assert/strict";
import { parserCampagnesAds, EnteteGoogleAdsIntrouvable } from "../src/importers/googleAdsCampagnes";

// Reproduit la forme typique d'un export "Campagnes" de Google Ads : titre
// de rapport sur les premieres lignes, puis l'en-tete, puis les donnees, et
// une ligne de total finale - jamais l'en-tete en premiere ligne comme les
// exports Synec/Stripe.
const EXPORT_TYPE = [
  "Rapport des campagnes",
  "Atelier Brochant",
  "14 oct. 2026-21 oct. 2026",
  "",
  "Campagne,Budget,État,Type de campagne,Clics,Impr.,CTR,CPC moy.,Coût,Conversions",
  '"Serrurier Pas Cher","18,00 €",En veille,Réseau de Recherche,142,6471,"2,19 %","1,23 €","174,60 €",3',
  '"Dépannage urgence","25,00 €",Actif,Réseau de Recherche,89,3200,"2,78 %","0,95 €","84,55 €",5,5',
  'Total : --,--,--,--,231,9671,"2,39 %","1,12 €","259,15 €",8,5',
].join("\n");

test("parserCampagnesAds : trouve l'en-tete malgre le titre de rapport au-dessus", () => {
  const lignes = parserCampagnesAds(Buffer.from(EXPORT_TYPE, "utf8"));
  assert.equal(lignes.length, 2);
});

test("parserCampagnesAds : exclut la ligne de total finale", () => {
  const lignes = parserCampagnesAds(Buffer.from(EXPORT_TYPE, "utf8"));
  assert.ok(lignes.every((l) => !/^total/i.test(l.nom)));
});

test("parserCampagnesAds : montants, pourcentages et entiers francais correctement convertis", () => {
  const lignes = parserCampagnesAds(Buffer.from(EXPORT_TYPE, "utf8"));
  const serrurier = lignes.find((l) => l.nom === "Serrurier Pas Cher")!;
  assert.equal(serrurier.budgetQuotidien, 18);
  assert.equal(serrurier.statut, "En veille");
  assert.equal(serrurier.type, "Réseau de Recherche");
  assert.equal(serrurier.clics, 142);
  assert.equal(serrurier.impressions, 6471);
  assert.equal(serrurier.ctr, 2.19);
  assert.equal(serrurier.cpcMoyen, 1.23);
  assert.equal(serrurier.cout, 174.6);
  assert.equal(serrurier.conversions, 3);
});

test("parserCampagnesAds : exclut les campagnes supprimees (meme filtre que l'API live)", () => {
  const exportAvecSupprimee = [
    "Campagne,Budget,État,Type de campagne,Clics,Impr.,CTR,CPC moy.,Coût,Conversions",
    '"Campagne active","18,00 €",Activée,Réseau de Recherche,142,6471,"2,19 %","1,23 €","174,60 €",3',
    '"Vieille campagne","50,00 €",Supprimée,Réseau de Recherche,0,0,"0,00 %","0,00 €","0,00 €",0',
  ].join("\n");
  const lignes = parserCampagnesAds(Buffer.from(exportAvecSupprimee, "utf8"));
  assert.equal(lignes.length, 1);
  assert.equal(lignes[0].nom, "Campagne active");
});

test("parserCampagnesAds : delimiteur point-virgule egalement reconnu", () => {
  const exportPointVirgule = [
    "Rapport des campagnes",
    "",
    "Campagne;Budget;État;Type de campagne;Clics;Impr.;CTR;CPC moy.;Coût;Conversions",
    "Devis en ligne;10,00 €;Actif;Réseau Display;20;500;4,00 %;0,50 €;10,00 €;1",
  ].join("\n");
  const lignes = parserCampagnesAds(Buffer.from(exportPointVirgule, "utf8"));
  assert.equal(lignes.length, 1);
  assert.equal(lignes[0].nom, "Devis en ligne");
  assert.equal(lignes[0].clics, 20);
});

test("parserCampagnesAds : leve une erreur explicite si aucune en-tete plausible", () => {
  const fichierInattendu = "Ceci,nest,pas,un,export,Google,Ads\nabc,def,ghi,jkl,mno,pqr,stu";
  assert.throws(() => parserCampagnesAds(Buffer.from(fichierInattendu, "utf8")), EnteteGoogleAdsIntrouvable);
});

// Fichier "Campagnes(...).csv" reel fourni par l'utilisateur (extrait du
// zip "Fiches de la page Vue d'ensemble") : en-tete directement en
// premiere ligne (pas de titre de rapport), intitules longs ("Nom de la
// campagne", "État de la campagne"), colonne "Nom du groupe de campagnes"
// vide a ignorer, et un format different de l'export direct de la page
// "Campagnes" simule ci-dessus (pas de Budget/Type/Impr./CPC/Conversions
// dans ce fichier-la).
const EXPORT_VUE_ENSEMBLE = [
  "Nom de la campagne,Nom du groupe de campagnes,État de la campagne,Coût,Clics,CTR",
  'Depannage,,Activé,"6 061,31 €",3 711,"1,18 %"',
  'Sos Express,,Activé,"2 228,24 €",783,"6,37 %"',
  'Le Bon Depanneur,,Mis en veille,"166,96 €",77,"3,37 %"',
].join("\n");

test("parserCampagnesAds : export groupe 'Vue d'ensemble' (intitules longs, en-tete en 1ere ligne)", () => {
  const lignes = parserCampagnesAds(Buffer.from(EXPORT_VUE_ENSEMBLE, "utf8"));
  assert.equal(lignes.length, 3);

  const depannage = lignes.find((l) => l.nom === "Depannage")!;
  assert.equal(depannage.statut, "Activé");
  assert.equal(depannage.cout, 6061.31);
  assert.equal(depannage.clics, 3711);
  assert.equal(depannage.ctr, 1.18);
  // Colonnes absentes de ce fichier : jamais une valeur devinee.
  assert.equal(depannage.budgetQuotidien, null);
  assert.equal(depannage.type, null);
  assert.equal(depannage.impressions, null);
  assert.equal(depannage.conversions, null);
  assert.equal(depannage.cpcMoyen, null);
});
