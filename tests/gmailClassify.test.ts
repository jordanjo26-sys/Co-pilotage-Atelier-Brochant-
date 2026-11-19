import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifierPieceJointe,
  choisirAdresseDext,
  extraireNumeroFacture,
  extraireMontantTTCFacture,
  extraireMontantHTFacture,
  completerMontantHTSansTva,
  estPieceJointeZip,
  EmailAClassifier,
} from "../src/services/gmailClassify";

function email(partiel: Partial<EmailAClassifier>): EmailAClassifier {
  return { sujet: "", expediteur: "fournisseur@example.com", extraitCorps: "", piecesJointes: [], ...partiel };
}

test("classifie une facture standard (mot-cle dans le sujet)", () => {
  const e = email({ sujet: "Votre facture n°2026-014" });
  const type = classifierPieceJointe(e, { nomFichier: "document.pdf", mimeType: "application/pdf" });
  assert.equal(type, "facture");
});

// Regression reelle en production (novembre 2026) : "Valority" est un
// donneur d'ordre de l'utilisateur, jamais un fournisseur - une mission
// confiee par Valority genere une facture de VENTE (emise par
// l'utilisateur), pas une facture fournisseur. Creait a tort une fiche
// fournisseur au nom du client final et envoyait la facture de vente a
// Dext (fiches "Kenza GHILAS"/"YOBOUET Samaecken").
test("une facture mentionnant Valority (donneur d'ordre) n'est jamais classee comme facture fournisseur", () => {
  const e = email({ sujet: "Votre facture" });
  const type = classifierPieceJointe(e, { nomFichier: "Facture VALORITY PO FROMENTIN Lucien.pdf", mimeType: "application/pdf" });
  assert.equal(type, "autre");
});

// Regression reelle en production (facture Trenois Decamps, novembre
// 2026) : le systeme de facturation de l'expediteur declarait la piece
// jointe en mimeType application/octet-stream (generique) au lieu
// d'application/pdf - avant correctif, estPieceDocument/estPdf se fiaient
// uniquement au mimeType declare et classaient ce document "ambigu" des
// la premiere verification, sans meme regarder le sujet ("Facture
// N°4478982"). Le nom de fichier (.pdf) est desormais aussi verifie pour
// ce type MIME generique.
test("classifie une facture dont la piece jointe est declaree application/octet-stream (vrai .pdf mal etiquete)", () => {
  const e = email({ sujet: "Facture N°4478982", extraitCorps: "Votre facture Trenois Decamps" });
  const type = classifierPieceJointe(e, { nomFichier: "fac01_01_004478982.pdf", mimeType: "application/octet-stream" });
  assert.equal(type, "facture");
});

test("un document sans aucun mot-cle reconnu est ambigu, jamais presume facture (correctif incident Dext)", () => {
  const e = email({ sujet: "Votre commande chez Central Plomberie", extraitCorps: "Merci pour votre achat." });
  const type = classifierPieceJointe(e, { nomFichier: "scan0042.pdf", mimeType: "application/pdf" });
  assert.equal(type, "ambigu");
});

test("classifie un bon d'enlevement, jamais une facture", () => {
  const e = email({ sujet: "Bon d'enlèvement - chantier Fontainebleau" });
  const type = classifierPieceJointe(e, { nomFichier: "bon.pdf", mimeType: "application/pdf" });
  assert.equal(type, "bon_enlevement");
});

test("classifie un releve de factures fournisseur", () => {
  const e = email({ sujet: "Relevé de factures - CEDEO" });
  const type = classifierPieceJointe(e, { nomFichier: "releve_cedeo.pdf", mimeType: "application/pdf" });
  assert.equal(type, "releve");
});

// Regression a partir d'un exemple reel fourni par l'utilisateur (relevé
// mensuel Cedeo, novembre 2026) : le sujet/corps de l'e-mail ne contient
// pas forcement le mot "relevé" (sujet generique ici), et le PDF lui-meme
// mentionne "facture" dans son en-tete de tableau ("N° de facture et
// références") - sans le repli sur le titre auto-genere du document
// ("Relevé <ref> du <date>"), ce cas tombait a tort en "facture" (comptant
// deux fois la meme depense : une fois par facture individuelle, une fois
// via ce relevé qui les recapitule).
test("un releve Cedeo reel (sujet generique, PDF mentionnant 'facture' dans son en-tete) n'est jamais classe facture", () => {
  const e = email({ sujet: "Vos documents" });
  const type = classifierPieceJointe(
    e,
    { nomFichier: "releve.pdf", mimeType: "application/pdf" },
    "Relevé 889C6004972251 du 31/10/2026 N° Client G9B4C / 1000750064\n" +
      "Agence N° de facture et références Montant Devise\n" +
      "3235 N° 889C6004955165 - du 31/10/2026 767,69 EUR\n" +
      "1076 N° 889C6004956987 - du 31/10/2026 80,36 EUR\n" +
      "TOTAL TTC EUR 848,05"
  );
  assert.equal(type, "releve");
});

test("une vraie facture Cedeo (auto-titree 'Facture <ref> du <date>') n'est jamais confondue avec un releve", () => {
  const e = email({ sujet: "Vos documents" });
  const type = classifierPieceJointe(
    e,
    { nomFichier: "facture.pdf", mimeType: "application/pdf" },
    "Facture 889C6004956987 du 31/10/2026 N° Client G9B4C / 1000750064\nTOTAL HT 66,97\nTOTAL TTC EUR 80,36"
  );
  assert.equal(type, "facture");
});

// Regression reelle en production (novembre 2026) : un avis de virement
// (Groupe Gendry informant Atelier Brochant d'un paiement RECU, pas une
// facture fournisseur) etait classe "facture" a tort des que son contenu
// mentionnait incidemment "la facture n°X" qu'il reglait, puis envoye a
// Dext avec un numero de facture invente ("facture" lui-meme, voir les
// tests extraireNumeroFacture ci-dessous).
test("un avis de virement n'est jamais classe comme facture, meme s'il mentionne 'facture' dans son contenu", () => {
  const e = email({ sujet: "AVIS DE VIREMENT REGLEMENT ATELIER BROCHANT" });
  const type = classifierPieceJointe(
    e,
    { nomFichier: "2026-11-19_NTR_VIRSEPA-CICE_ATELIER-BROCHANT.pdf", mimeType: "application/pdf" },
    "En reglement de votre facture n°2026-014, nous avons emis un virement de 1234,56 EUR."
  );
  assert.equal(type, "autre");
});

test("classifie un avoir (mot en tete de sujet)", () => {
  const e = email({ sujet: "Avoir suite a votre reclamation" });
  const type = classifierPieceJointe(e, { nomFichier: "avoir.pdf", mimeType: "application/pdf" });
  assert.equal(type, "avoir");
});

test("classifie un avoir precede d'un determinant", () => {
  const e = email({ sujet: "Merci, votre avoir a ete emis" });
  const type = classifierPieceJointe(e, { nomFichier: "document.pdf", mimeType: "application/pdf" });
  assert.equal(type, "avoir");
});

test("classifie un avoir suivi d'une reference, meme sans etre en tete de sujet", () => {
  const e = email({ sujet: "Suite a votre retour, avoir n°2026-014" });
  const type = classifierPieceJointe(e, { nomFichier: "document.pdf", mimeType: "application/pdf" });
  assert.equal(type, "avoir");
});

test("une vraie facture au sujet contenant 'avoir' au sens du verbe n'est pas detournee (regression reelle en production, signalee deux fois)", () => {
  const e = email({ sujet: "Merci d'avoir choisi Style A - Facture n°2026-201" });
  const type = classifierPieceJointe(e, { nomFichier: "facture.pdf", mimeType: "application/pdf" });
  assert.equal(type, "facture");
});

test("une vraie facture dont le corps commence par 'après avoir' n'est pas detournee", () => {
  const e = email({ sujet: "Votre commande", extraitCorps: "Bonjour, apres avoir valide votre commande, voici votre facture." });
  const type = classifierPieceJointe(e, { nomFichier: "facture.pdf", mimeType: "application/pdf" });
  assert.equal(type, "facture");
});

test("classifie un devis, jamais une facture ni un cas ambigu", () => {
  const e = email({ sujet: "Votre devis pour la salle de bain" });
  const type = classifierPieceJointe(e, { nomFichier: "devis_042.pdf", mimeType: "application/pdf" });
  assert.equal(type, "devis");
});

test("classifie une offre de prix comme un devis", () => {
  const e = email({ sujet: "Offre de prix - materiel plomberie" });
  const type = classifierPieceJointe(e, { nomFichier: "offre.pdf", mimeType: "application/pdf" });
  assert.equal(type, "devis");
});

// Regression reelle en production (novembre 2026) : un CLIENT demandant
// un devis en joignant des photos de son probleme ("pouvez-vous me faire
// un devis, voici des photos") etait classe "devis" (type fournisseur) a
// cause du seul mot "devis" dans le sujet/corps, creant a tort une fiche
// fournisseur au nom du client. Une image dans ce contexte doit rester
// ambigue, comme pour une facture (voir plus bas).
test("une image dans un e-mail mentionnant 'devis' n'est jamais presumee etre le devis (demande de devis d'un client)", () => {
  const e = email({
    sujet: "Demande de devis",
    extraitCorps: "Bonjour, pouvez-vous me faire un devis pour cette reparation ? Voici des photos.",
    expediteur: "client.particulier@gmail.com",
  });
  const type = classifierPieceJointe(e, { nomFichier: "photo1.jpg", mimeType: "image/jpeg" });
  assert.equal(type, "ambigu");
});

test("une image dans un e-mail de facture n'est jamais transmise comme facture (ex. logo de signature)", () => {
  const e = email({ sujet: "Votre facture n°2026-014" });
  const type = classifierPieceJointe(e, { nomFichier: "signature.png", mimeType: "image/png" });
  assert.equal(type, "ambigu");
});

test("une piece jointe qui n'est pas un document (mimetype non gere) est ambigue", () => {
  const e = email({ sujet: "Facture" });
  const type = classifierPieceJointe(e, { nomFichier: "logo.svg", mimeType: "image/svg+xml" });
  assert.equal(type, "ambigu");
});

test("choisirAdresseDext : une seule facture -> adresse standard", () => {
  assert.equal(choisirAdresseDext(1), "facturation-brochant@dext.cc");
  assert.equal(choisirAdresseDext(0), "facturation-brochant@dext.cc");
});

test("choisirAdresseDext : plusieurs factures dans le meme e-mail -> adresse multiple", () => {
  assert.equal(choisirAdresseDext(2), "facturation-brochant@multiple.dext.cc");
});

test("extraireNumeroFacture trouve un numero apres le mot facture", () => {
  assert.equal(extraireNumeroFacture("Votre facture N°2026-014 est disponible"), "2026-014");
});

test("extraireNumeroFacture retourne null si rien de reconnaissable", () => {
  assert.equal(extraireNumeroFacture("Merci pour votre commande"), null);
});

// Bug reel constate en production (novembre 2026, avis de virement Groupe
// Gendry) : "no" (abreviation de "numero") matchait sans limite de mot
// n'importe quel mot contenant ces deux lettres, capturant la suite du mot
// comme "numero".
test("extraireNumeroFacture n'est jamais trompe par 'no' a l'interieur d'un autre mot ('Nouveau', 'renouvelable'...)", () => {
  assert.equal(extraireNumeroFacture("Ceci est un nouveau document, non lie a une facture"), null);
  assert.equal(extraireNumeroFacture("Contrat renouvelable chaque annee"), null);
});

// Extrait reel (pdftotext -layout) d'une vraie facture Leroy Merlin -
// format de facturation electronique officiel (e-reporting/Chorus Pro) :
// libelle "MONTANT TOTAL Net HT" (pas juste "Total HT"), montant separe
// du libelle par ~130 caracteres d'espacement de mise en page, et "N°
// Document : <ref>" plutot que "N° <ref>" - trois libelles reels qui ne
// matchaient aucun des motifs avant correctif (signale par l'utilisateur,
// novembre 2026 : "il y a des factures ... on voit clairement marque les
// montants ... et [l'app] ne le lit pas").
const EXTRAIT_FACTURE_LEROY_MERLIN_REEL =
  "  N° Document : CFR00102926012045\n" +
  "  MONTANT TOTAL Net HT                                                                                                                              48,07 €\n" +
  "  MONTANT TOTAL TVA                                                                                                                                  9,62 €\n" +
  "  MONTANT TOTAL TTC                                                                                                                                 57,69 €";

test("extraireMontantHTFacture : 'MONTANT TOTAL Net HT' (vraie facture Leroy Merlin, facturation electronique)", () => {
  assert.equal(extraireMontantHTFacture(EXTRAIT_FACTURE_LEROY_MERLIN_REEL), 48.07);
});

test("extraireMontantTTCFacture : montant separe du libelle par plus de 100 caracteres d'espacement (vraie facture Leroy Merlin)", () => {
  assert.equal(extraireMontantTTCFacture(EXTRAIT_FACTURE_LEROY_MERLIN_REEL), 57.69);
});

test("extraireNumeroFacture : 'N° Document : <ref>' (vraie facture Leroy Merlin)", () => {
  assert.equal(extraireNumeroFacture(EXTRAIT_FACTURE_LEROY_MERLIN_REEL), "CFR00102926012045");
});

// Bug reel constate en production : "...en reglement de votre facture..."
// (texte d'un avis de virement, pas d'une vraie facture) capturait
// litteralement le mot "facture" lui-meme comme numero, faute d'exiger un
// chiffre dans la valeur capturee.
test("extraireNumeroFacture n'extrait jamais le mot declencheur lui-meme comme numero", () => {
  assert.equal(extraireNumeroFacture("En reglement de votre facture facture reçue le mois dernier"), null);
});

test("extraireNumeroFacture fonctionne toujours avec 'N°' colle a un numero contenant des lettres", () => {
  assert.equal(extraireNumeroFacture("Référence facture n°CFR00102926012045"), "CFR00102926012045");
});

test("extraireMontantTTCFacture trouve le net a payer en priorite", () => {
  assert.equal(extraireMontantTTCFacture("Total HT : 100,00 € Net à payer : 1 234,56 €"), 1234.56);
});

test("extraireMontantTTCFacture se rabat sur le total TTC si pas de net a payer", () => {
  assert.equal(extraireMontantTTCFacture("Total HT: 100,00 € TVA: 20,00 € Total TTC : 120,00 €"), 120);
});

test("extraireMontantTTCFacture retourne null si aucun libelle connu n'est trouve", () => {
  assert.equal(extraireMontantTTCFacture("Merci pour votre commande, livraison sous 48h."), null);
});

test("extraireMontantHTFacture trouve le total HT", () => {
  assert.equal(extraireMontantHTFacture("Total HT : 100,00 € TVA: 20,00 € Total TTC : 120,00 €"), 100);
});

test("extraireMontantHTFacture retourne null si aucun libelle connu n'est trouve", () => {
  assert.equal(extraireMontantHTFacture("Merci pour votre commande, livraison sous 48h."), null);
});

// Regression a partir de deux vraies factures Cedeo (exemples fournis par
// l'utilisateur, novembre 2026) : "TOTAL HT" et "TOTAL TTC" apparaissent
// dans un tableau recapitulatif de taxes, separes du montant par d'autres
// colonnes (BASE/TAXE a 0,00) sur la meme ligne de texte extrait.
test("extraireMontantHTFacture/extraireMontantTTCFacture sur une vraie facture Cedeo", () => {
  const texte =
    "Traite directe   TAUX K=20.0%\n" +
    "Votre IBAN FR76 1020 7000 5622 2102 3737 516   BASE 66,97 0,00 0,00\n" +
    "CCBPFRPPMTG   TAXE 13,39 0,00 0,00  TOTAL HT 66,97\n" +
    "TOTAL TTC EUR 80,36";
  assert.equal(extraireMontantHTFacture(texte), 66.97);
  assert.equal(extraireMontantTTCFacture(texte), 80.36);
});

test("extraireMontantHTFacture/extraireMontantTTCFacture sur une seconde vraie facture Cedeo (avec frais de gestion)", () => {
  const texte =
    "Traite directe   TAUX K=20.0% Frais Gestion   3,5    K\n" +
    "Votre IBAN FR76 1020 7000 5622 2102 3737 516   BASE 639,74 0,00 0,00\n" +
    "CCBPFRPPMTG   TAXE 127,95 0,00 0,00  TOTAL HT 639,74\n" +
    "TOTAL TTC EUR 767,69";
  assert.equal(extraireMontantHTFacture(texte), 639.74);
  assert.equal(extraireMontantTTCFacture(texte), 767.69);
});

// Regressions a partir d'exemples reels fournis par l'utilisateur
// (novembre 2026) : apres deploiement, la quasi-totalite des factures deja
// en base restaient a "0,00 €" malgre une extraction "a posteriori"
// reussie (backfillMontantsFacturesSansMontant) - le PDF etait bien relu,
// mais ces mises en page reelles (montants en point anglo-saxon, symbole
// monetaire glisse dans le libelle, libelle en-tete de colonne avec sa
// valeur sur la ligne suivante, libelle repete plusieurs fois sur le
// meme document...) depassaient ce que l'extraction savait reconnaitre.
test("extraireMontantTTCFacture : montant en point anglo-saxon (vraie facture Leroy Merlin), jamais confondu avec un total intermediaire", () => {
  const texte =
    "                                  Total HT                 Montant TVA\n" +
    " TVA 20.00%                                   48.07 €                           9.62 €                                   Total TTC sans remise                                                 59.47 €\n" +
    " Total TVA                                    48.07 €                           9.62 €                                   Total TTC remise hors fidélité                                         0.00 €\n" +
    "                                                                                                                         Total TTC remise fidélité                                              1.78 €\n" +
    "                                                                                                                         Total TTC remise                                                       1.78 €\n" +
    "        Date                     Réglement                                 Montant\n" +
    "     16/11/2026           CARTE AMEX (EUR)                                  57.69 €\n" +
    "                                                                                                                         Total TTC                                                           57.69 €";
  assert.equal(extraireMontantHTFacture(texte), 48.07);
  assert.equal(extraireMontantTTCFacture(texte), 57.69);
});

test("extraireMontantFacture : libelle avec le symbole monetaire glisse dedans (vraie facture Kiloutou, \"Total € HT\"/\"Total € TTC\")", () => {
  const texte =
    "                                                                                            Total € HT                                                                                             138,71\n" +
    "                                                                                            1 : TVA à l'encaissement                                                      20,00 %                   27,74\n" +
    "                                                                                            Total € TTC                                                                                            166,45\n" +
    "                                                                                            Règlement : Carte Bleue                                                                                166,45";
  assert.equal(extraireMontantHTFacture(texte), 138.71);
  assert.equal(extraireMontantTTCFacture(texte), 166.45);
});

test("extraireMontantTTCFacture : \"NET à PAYER\" a 0,00 (traite/prelevement automatique, vraie facture Prolians) n'ecrase jamais le vrai TOTAL TTC", () => {
  const texte =
    "                                                                                                                TOTAL HT                                                                23,08 EUR\n" +
    "                                                                                                                TOTAL TVA                                                                4,17 EUR\n" +
    "                                                                                                                 TOTAL TTC                                                              27,25 EUR\n" +
    "                                                                                                                 NET à PAYER                                                             0,00 EUR";
  assert.equal(extraireMontantHTFacture(texte), 23.08);
  assert.equal(extraireMontantTTCFacture(texte), 27.25);
});

test("extraireMontantFacture : libelle en-tete de colonne, valeur sur la ligne suivante (vraie facture PUM Plastique)", () => {
  const texte =
    "    TOTAL HT EUR                                       NET HT EUR          TAUX/MONTANT TVA                 TOTAL TTC                                            NET A PAYER EUR\n" +
    "\n" +
    "                 37,43                                           37,43     20,00% S              7,49                     44,92                                                     44,92";
  assert.equal(extraireMontantHTFacture(texte), 37.43);
  assert.equal(extraireMontantTTCFacture(texte), 44.92);
});

test("extraireMontantFacture : libelle repete (en-tete de colonne par ligne d'article ET total general, vraie facture JD Assainissement) -> retient le total general", () => {
  const texte =
    "          Désignation                                                                      Quantité           Prix unit. HT     TVA (%)                Total HT\n" +
    "          DEPLACEMENT                                                                        1 forfait            150,00 €           20%               150,00 €\n" +
    "          CAMERA                                                                             1 forfait           450,00 €            20%               450,00 €\n" +
    "          Taux                                Montant TVA                        Base HT                 Total HT                                     600,00 €\n" +
    "          20%                                          120,00 €                   600,00 €               Total TVA                                    120,00 €\n" +
    "                                                                                                         Total TTC                                   720,00 €";
  assert.equal(extraireMontantHTFacture(texte), 600);
  assert.equal(extraireMontantTTCFacture(texte), 720);
});

test("extraireMontantFacture : montant TTC sans decimale initiale a 0 (vraie facture SylApps)", () => {
  const texte =
    "                                                                                                                      Total HT                                       261,00\n" +
    "                                                                                                                      Total TVA                                      52,20\n" +
    "Total TVA                52,20 52,20                                                                                  Total TTC                                   313,20 €";
  assert.equal(extraireMontantHTFacture(texte), 261);
  assert.equal(extraireMontantTTCFacture(texte), 313.2);
});

test("extraireMontantFacture : ticket de caisse sans detail HT (vrai ticket Autobacs) -> HT absent, TTC trouve", () => {
  const texte = "------------------------------------------\nTotal TTC :                       129.90€\n------------------------------------------";
  assert.equal(extraireMontantHTFacture(texte), null);
  assert.equal(extraireMontantTTCFacture(texte), 129.9);
});

// Regressions a partir d'exemples reels fournis par l'utilisateur (video,
// novembre 2026) : d'autres mises en page reelles restaient elles aussi a
// "non renseigne" malgre un contenu PDF/texte bien extrait - "TOT TTC"
// (abrege) et "Net" (vrai ticket carte bancaire station E.Leclerc), et
// "Montant du" en dollars sans notion de TVA francaise (vraie facture
// Emergent Labs Inc, abonnement emergent.sh).
test("extraireMontantFacture : ticket de carte bancaire abrege 'TOT TTC' / 'Net' (vrai ticket station E.Leclerc)", () => {
  const texte =
    "TOT TTC                                                                € 100,00\n" +
    "TVA                                          20,00 %                   € 16,67\n" +
    "Net                                                                     € 83,33";
  assert.equal(extraireMontantTTCFacture(texte), 100);
  assert.equal(extraireMontantHTFacture(texte), 83.33);
});

test("extraireMontantHTFacture : le filet 'Net' n'est jamais pris pour le HT a l'interieur de 'Net à payer' (deux sens differents du meme mot)", () => {
  const texte = "Total TTC : 90,00 €\nNet à payer : 90,00 €";
  assert.equal(extraireMontantHTFacture(texte), null);
});

test("extraireMontantHTFacture : le filet 'Net' ne matche jamais a l'interieur d'un autre mot (ex. 'Internet')", () => {
  const texte = "Abonnement Internet : 29,99 €\nTotal TTC : 29,99 €";
  assert.equal(extraireMontantHTFacture(texte), null);
});

test("extraireMontantTTCFacture : 'Montant dû' en dernier recours (vraie facture Emergent Labs Inc, en dollars, sans notion de TVA francaise)", () => {
  const texte = "Sous-total                              20,00 $US\nTotal                                     20,00 $US\nMontant dû                                20,00 $US";
  assert.equal(extraireMontantTTCFacture(texte), 20);
  assert.equal(extraireMontantHTFacture(texte), null);
});

test("extraireMontantTTCFacture : 'Montant dû' ne prime jamais sur un vrai Total TTC (meme protection que 'Net à payer')", () => {
  const texte = "Total TTC : 120,00 €\nMontant dû : 0,00 €";
  assert.equal(extraireMontantTTCFacture(texte), 120);
});

test("extraireMontantHTFacture : 'Montant Hors TVA' (vraie facture EDF)", () => {
  const texte =
    "Montant Hors TVA                                        27,82 €\n" +
    "Montant TVA (payée sur les débits)                       5,56 €\n" +
    "Facture TTC                                             33,38 €\n" +
    "Montant total à payer (TTC)                             33,38 €";
  assert.equal(extraireMontantHTFacture(texte), 27.82);
  assert.equal(extraireMontantTTCFacture(texte), 33.38);
});

// completerMontantHTSansTva : repli explicite demande par l'utilisateur
// (video, novembre 2026) - HT = TTC (TVA = 0) uniquement quand le document
// ne mentionne JAMAIS la TVA/VAT nulle part, jamais pour un vrai HT non
// trouve sur un document qui, lui, mentionne la TVA quelque part.
test("completerMontantHTSansTva : HT deja trouve -> inchange", () => {
  assert.equal(completerMontantHTSansTva("peu importe", 100, 120), 100);
});

test("completerMontantHTSansTva : TTC trouve, HT absent, aucune mention de TVA/VAT -> HT = TTC (vraie facture Emergent Labs Inc)", () => {
  const texte = "Sous-total 20,00 $US\nTotal 20,00 $US\nMontant dû 20,00 $US";
  assert.equal(completerMontantHTSansTva(texte, null, 20), 20);
});

test("completerMontantHTSansTva : TTC trouve, HT absent, mais le document mentionne la TVA ailleurs -> HT reste non renseigne (mise en page non reconnue, pas une absence reelle de TVA)", () => {
  const texte = "TVA 20,00% incluse\nTotal TTC 120,00 €";
  assert.equal(completerMontantHTSansTva(texte, null, 120), null);
});

test("completerMontantHTSansTva : pas de TTC trouve non plus -> reste null", () => {
  assert.equal(completerMontantHTSansTva("Merci de votre commande.", null, null), null);
});

test("sujet/corps generiques, mais le mot facture est dans le contenu du PDF -> reconnue (pas ambigue)", () => {
  const e = email({ sujet: "Voici vos documents", extraitCorps: "Bonjour, veuillez trouver ci-joint." });
  const type = classifierPieceJointe(
    e,
    { nomFichier: "document.pdf", mimeType: "application/pdf" },
    "FACTURE N°2026-099\nCedeo Paris\nMontant TTC : 245,00 EUR"
  );
  assert.equal(type, "facture");
});

test("contenu du PDF vide/absent -> comportement inchange (repli sur sujet/corps/nom de fichier)", () => {
  const e = email({ sujet: "Commande chez Central Plomberie" });
  const type = classifierPieceJointe(e, { nomFichier: "scan0042.pdf", mimeType: "application/pdf" }, undefined);
  assert.equal(type, "ambigu");
});

test("une vraie facture au sujet generique n'est pas detournee en avoir/devis/releve par un mot present ailleurs dans le PDF (regression reelle en production)", () => {
  const e = email({ sujet: "Vos documents", extraitCorps: "Bonjour, veuillez trouver ci-joint." });
  // "avoir" est un mot francais tres courant hors de son sens comptable :
  // une mention legale de bas de page ("pour avoir plus d'informations,
  // contactez-nous") ne doit jamais faire basculer une vraie facture en
  // type "avoir" (jamais transmis a Dext, jamais signale en anomalie -
  // donc totalement invisible si mal classe).
  const type = classifierPieceJointe(
    e,
    { nomFichier: "document.pdf", mimeType: "application/pdf" },
    "FACTURE N°2026-142\nOr Torah\nMontant TTC : 89,00 EUR\nPour avoir plus d'informations, contactez notre service client."
  );
  assert.equal(type, "facture");
});

test("un CV envoye par l'agence d'interim connue est 'autre', jamais ambigu ni facture (demande explicite de l'utilisateur, encombrait le centre de validation)", () => {
  const e = email({
    expediteur: "Federico RICHICHI <frichichi@le-cercle-interimaire.fr>",
    sujet: "CV Guy - électricien chef équipe en recherche active",
  });
  const type = classifierPieceJointe(e, { nomFichier: "CV Guy.pdf", mimeType: "application/pdf" });
  assert.equal(type, "autre");
});

test("la regle de l'agence d'interim s'applique aussi a une image (pas seulement un PDF)", () => {
  const e = email({ expediteur: "contact@le-cercle-interimaire.fr", sujet: "CV Photo" });
  const type = classifierPieceJointe(e, { nomFichier: "photo.jpg", mimeType: "image/jpeg" });
  assert.equal(type, "autre");
});

test("le mot 'facture' dans le sujet d'un e-mail de l'agence d'interim ne devient pas une facture (le filtre expediteur passe avant tout)", () => {
  const e = email({ expediteur: "contact@le-cercle-interimaire.fr", sujet: "Votre facture d'honoraires" });
  const type = classifierPieceJointe(e, { nomFichier: "doc.pdf", mimeType: "application/pdf" });
  assert.equal(type, "autre");
});

test("estPieceJointeZip reconnait les mimeTypes zip usuels", () => {
  assert.equal(estPieceJointeZip("application/zip", "facture.zip"), true);
  assert.equal(estPieceJointeZip("application/x-zip-compressed", "facture.zip"), true);
  assert.equal(estPieceJointeZip("application/x-zip", "facture.zip"), true);
});

test("estPieceJointeZip reconnait un ZIP declare en octet-stream generique, via l'extension du nom de fichier (ex. Total Fuel Card)", () => {
  assert.equal(estPieceJointeZip("application/octet-stream", "Total_Fuel_Card_20261115_FACPJ175002786_.zip"), true);
});

test("estPieceJointeZip ne confond pas un PDF en octet-stream generique avec un ZIP", () => {
  assert.equal(estPieceJointeZip("application/octet-stream", "facture.pdf"), false);
});

test("estPieceJointeZip rejette un mimeType et une extension sans rapport", () => {
  assert.equal(estPieceJointeZip("application/pdf", "facture.pdf"), false);
});
