import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifierPieceJointe,
  choisirAdresseDext,
  extraireNumeroFacture,
  extraireMontantTTCFacture,
  extraireMontantHTFacture,
  completerMontantHTSansTva,
  completerMontantTTCManquant,
  estAutoliquidation,
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

// Regression reelle en production (novembre 2026, Institec) : un e-mail
// annonçant explicitement "Convention de formation Programme de formation
// RIB de la formation" en pieces jointes (QUALIPAC) creait a tort une
// fiche fournisseur - le contenu integral de la convention mentionnait
// incidemment "facture" (clause de modalites de facturation du stage).
test("une convention de formation n'est jamais classee comme facture, meme si son contenu mentionne 'facture'", () => {
  const e = email({
    sujet: "Formation QUALIPAC - Pompe à chaleur en habitat individuel - QUALIT ENR",
    extraitCorps: "Pour faire suite à votre demande, voici : Convention de formation Programme de formation RIB de la formation",
  });
  const type = classifierPieceJointe(
    e,
    { nomFichier: "BU-CV-05-009 Pompe à chaleur en habitat individuel.pdf", mimeType: "application/pdf" },
    "Modalités de facturation : le stagiaire sera facturé selon les conditions ci-dessous."
  );
  assert.equal(type, "autre");
});

test("un programme de formation n'est jamais classe comme ambigu non plus (autre, comme la convention)", () => {
  const e = email({
    sujet: "Formation QUALIPAC",
    extraitCorps: "Convention de formation Programme de formation RIB de la formation",
  });
  const type = classifierPieceJointe(e, { nomFichier: "BU-PG-02-014 QUALIPAC.pdf", mimeType: "application/pdf" });
  assert.equal(type, "autre");
});

// Regression reelle en production (novembre 2026, Te Traiteur) : un
// CLIENT (pas un fournisseur) relance le reglement de sa propre facture et
// la joint/l'evoque ("RELANCE FACTURES") - le fichier porte la
// numerotation Synec de l'utilisateur (FACTURE-<numero>), jamais celle
// d'un fournisseur. Creait a tort une fiche fournisseur au nom du client.
test("un fichier nomme comme une facture de vente propre (FACTURE-<numero>) n'est jamais classe comme facture fournisseur", () => {
  const e = email({ sujet: "RE: RELANCE FACTURES", extraitCorps: "La facture FACTURE-2051 doit être adressée à l'Usine Té" });
  const type = classifierPieceJointe(e, { nomFichier: "FACTURE-2051.pdf", mimeType: "application/pdf" });
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

// Regression reelle en production (novembre 2026, une vingtaine de vraies
// factures OVHcloud restees "HT non renseigne") : le libelle "Total de la
// facture HT"/"Total de la facture TTC" (les mots "de la facture"
// s'intercalant) ne correspondait a aucun motif connu - seul le TTC etait
// retrouve, par coincidence, via une ligne "Total TTC" isolee plus loin
// dans le document (pied de page), jamais le HT.
test("extraireMontantHTFacture/extraireMontantTTCFacture : 'Total de la facture HT/TTC' (vraie facture OVHcloud)", () => {
  const texte =
    " Facture FR75540643 du 01 Février 2026                                        Information de paiement :\n" +
    "                                                                              Le montant de 25,54 € sera prélevé\n" +
    " Total de la facture HT                                          21,28 €      le 01 Février 2026 sur votre moyen\n" +
    "                                                                              de paiement par défaut.\n" +
    " TVA (20%)                                                         4,26 €\n" +
    "                                                                              Facture payable dès réception.\n" +
    "\n" +
    " Total de la facture TTC                                        25,54 €";
  assert.equal(extraireMontantHTFacture(texte), 21.28);
  assert.equal(extraireMontantTTCFacture(texte), 25.54);
});

// Regression reelle en production (novembre 2026, vraie facture Darty
// "JUSTIFICATIF DE VENTE") : l'en-tete de tableau "Total HT"/"Total TTC"
// s'etale sur DEUX lignes ("Référence Qté Libellé ... Total HT ... Total
// TTC" puis "... délivrance Taux TVA" juste en-dessous, suite du meme
// en-tete) avant la vraie ligne de donnees - le repli "valeur sur une des
// trois lignes suivantes, en colonne" s'arretait a tort des la premiere
// ligne non vide rencontree (celle de continuation d'en-tete, sans le
// moindre chiffre), sans jamais regarder la ligne suivante ou se trouvait
// pourtant la vraie valeur.
test("extraireMontantHTFacture/extraireMontantTTCFacture : en-tete de tableau sur deux lignes avant la ligne de donnees (vraie facture Darty)", () => {
  const texte =
    "                                                                       Date                                      Montant /\n" +
    "Référence Qté Libellé                                                                           Total HT                        Total TTC\n" +
    "                                                                    délivrance                                   Taux TVA\n" +
    " 7765711      1    ROWEN ASPIRATEUR TRAINEAU                        18/11/2025                   166,66 €              33,33      199,99 €\n" +
    "                   RO7943                                                                                             20,00 %\n" +
    "                   Disponibilité des pièces détachées : 15 ans";
  assert.equal(extraireMontantHTFacture(texte), 166.66);
  assert.equal(extraireMontantTTCFacture(texte), 199.99);
});

// Regression reelle en production (novembre 2026) : credit Anthropic epuise,
// le filet IA ne pouvait plus completer ce que la regex ratait - plusieurs
// vraies factures de fournisseurs etrangers (jamais de libelle francais)
// restaient "non renseigne" alors que HT/TTC y sont parfaitement lisibles.
test("extraireMontantHTFacture/extraireMontantTTCFacture : 'Total (HT)' entre parentheses (vraie facture TooManyTools)", () => {
  const texte =
    "                                    Détail des        Taux de taxe      Prix de base            Taxe totale                                       Total produits                       166,58 €\n" +
    "                                                                                                                                                       Total (HT)                      172,00 €\n" +
    "                                                                                                                                                     Taxe totale                            34,40 €\n" +
    "                                        Moyen de paiement                        PayPal                206,40 €                                              Total                   206,40 €\n" +
    "                                                                           SARL MANYTOOL au capital de 5000 Euros N°Siret 534867999 TVA: FR36534867999";
  assert.equal(extraireMontantHTFacture(texte), 172);
  // Pas de libelle TTC exploitable ici (juste "Total" seul, trop ambigu pour
  // etre un motif fiable) - complete via le taux standard 20% (confirme
  // exact sur cette facture : Taxe totale 34,40 = 172 x 0.2 ; la mention
  // "TVA" au pied de page empeche le repli "absence totale de TVA").
  assert.equal(completerMontantTTCManquant(texte, 172, extraireMontantTTCFacture(texte)), 206.4);
});

test("extraireMontantHTFacture/extraireMontantTTCFacture : 'Total excl./incl. tax' (vraie facture Trofim Victor, anglais, TVA a 10%)", () => {
  const texte =
    "To pay bank transfer.                                               Total excl. tax                                      570,00 €\n" +
    "Due by 19/04/2026.\n" +
    "                                                                    Tax at 10 %                                           57,00 €\n" +
    "                                                                    Total incl. tax                                    627,00 €";
  assert.equal(extraireMontantHTFacture(texte), 570);
  assert.equal(extraireMontantTTCFacture(texte), 627);
});

test("extraireMontantHTFacture/extraireMontantTTCFacture : 'Subtotal'/'Amount due' (vraie facture WeTransfer BV, anglais)", () => {
  const texte =
    "                                                                        Subtotal     EUR 70.00\n" +
    "                                                                        Tax          EUR 14.00\n" +
    "                                                                        Total        EUR 84.00\n" +
    "                                                                        Amount due   EUR 84.00";
  assert.equal(extraireMontantHTFacture(texte), 70);
  assert.equal(extraireMontantTTCFacture(texte), 84);
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

// Demande explicite de l'utilisateur (novembre 2026) : plutot que de
// laisser indefiniment "non renseigne" quand le libelle HT n'est pas
// reconnu mais que la TVA est bien mentionnee (ni autoliquidation, ni
// absence totale de TVA), le HT se deduit du TTC au taux standard francais
// (20%) - ses achats sont toujours a ce taux.
test("completerMontantHTSansTva : TTC trouve, HT absent, TVA mentionnee (ni autoliquidation ni absence de TVA) -> HT deduit du taux standard 20%", () => {
  const texte = "TVA 20,00% incluse\nTotal TTC 120,00 €";
  assert.equal(completerMontantHTSansTva(texte, null, 120), 100);
});

test("completerMontantHTSansTva : pas de TTC trouve non plus -> reste null", () => {
  assert.equal(completerMontantHTSansTva("Merci de votre commande.", null, null), null);
});

// Demande explicite de l'utilisateur (novembre 2026) : les factures de
// sous-traitance BTP en autoliquidation de la TVA (article 283-2 nonies du
// CGI) mentionnent "TVA" (donc le repli general ci-dessus ne s'applique
// pas) mais HT = TTC quand meme, par definition du dispositif - verifie
// sur deux vraies factures reelles (La Centrale Du Debouchage, APF
// Assainissement Pompage Fosse).
test("completerMontantHTSansTva : autoliquidation explicite (sous-traitance BTP) -> HT = TTC meme si la TVA est mentionnee", () => {
  const texte = "Intervention de sous traitance TVA auto liquidation 1 0,00 €\nSous-total 300,00 €\nTotal TTC 300,00 €";
  assert.equal(completerMontantHTSansTva(texte, null, 300), 300);
});

test("completerMontantHTSansTva : autoliquidation avec orthographe sans espace (AUTOLIQUIDATION) -> HT = TTC", () => {
  const texte = 'Sous-total 500,00 €\nTVA 0 % (500,00 €) 0,00 €\nTotal TTC 500,00 €\nDécret de finance du 01 janvier 2014 "AUTOLIQUIDATION DE LA TVA EN APPLICATION DE L\'ARTICLE 283.2 NONIES DU CGI"';
  assert.equal(completerMontantHTSansTva(texte, null, 500), 500);
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

test("estAutoliquidation reconnait les trois orthographes reelles (collee, espacee, avec tiret)", () => {
  assert.equal(estAutoliquidation("TVA auto liquidation"), true);
  assert.equal(estAutoliquidation("AUTOLIQUIDATION DE LA TVA"), true);
  assert.equal(estAutoliquidation("auto-liquidation de la TVA"), true);
  assert.equal(estAutoliquidation("TVA 20,00% incluse"), false);
});

// completerMontantTTCManquant : symetrique de completerMontantHTSansTva,
// demande explicite de l'utilisateur (meme principe dans l'autre sens).
test("completerMontantTTCManquant : TTC deja trouve -> inchange", () => {
  assert.equal(completerMontantTTCManquant("peu importe", 100, 120), 120);
});

test("completerMontantTTCManquant : HT trouve, TTC absent, aucune mention de TVA/VAT -> TTC = HT", () => {
  assert.equal(completerMontantTTCManquant("Sous-total 20,00 $US\nMontant dû 20,00 $US", 20, null), 20);
});

test("completerMontantTTCManquant : HT trouve, TTC absent, autoliquidation -> TTC = HT", () => {
  const texte = "Intervention de sous traitance TVA auto liquidation\nSous-total 300,00 €";
  assert.equal(completerMontantTTCManquant(texte, 300, null), 300);
});

test("completerMontantTTCManquant : HT trouve, TTC absent, TVA mentionnee (ni autoliquidation ni absence de TVA) -> TTC deduit du taux standard 20%", () => {
  const texte = "TVA 20,00% incluse\nTotal HT 100,00 €";
  assert.equal(completerMontantTTCManquant(texte, 100, null), 120);
});

test("completerMontantTTCManquant : pas de HT trouve non plus -> reste null", () => {
  assert.equal(completerMontantTTCManquant("Merci de votre commande.", null, null), null);
});
