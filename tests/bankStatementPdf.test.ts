import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractReleveTransactions,
  texteSignificatif,
  estReleveCarteAmex,
  extractReleveCarteAmexTransactions,
} from "../src/importers/bankStatementPdf";

// Texte fictif reproduisant la mise en page reelle d'un relevé Banque
// Populaire telle qu'extraite par `pdftotext -layout` : colonnes alignees
// par de grands blancs, libelle et reference separes par un grand blanc,
// annexe "DETAIL DE VOS MOUVEMENTS SEPA" a exclure en fin de document.
const FIXTURE = `
                                                                         Votre relevé de compte n°3 au 05/01/2026

                                                                         DETAIL DES OPERATIONS DE VOTRE COMPTE COURANT N° 00000000000

                                                                           DATE                                                                                          DATE                   DATE
                                                                                           LIBELLE / REFERENCE                                                                                                 MONTANT
                                                                          COMPTA                                                                                       OPERATION               VALEUR

                                                                                           SOLDE CREDITEUR AU 27/12/2025                                                                                       10 000,00 €
                                                                            28/12             VIR INST Client Test                                                     AB12345              28/12                28/12                          1 500,00 €
                                                                                                Facture FICTIVE-0001
                                                                            02/01             PRLV SEPA Fournisseur Test                                               CD98765              02/01                02/01                            - 120,50 €
                                                                            03/01             LCR DOMICILIEE                                                                                03/01                03/01                          - 300,00 €
                                                                            04/01             VIR INST LUGASSY JORDAN                                                  WGHDUWZ              04/01                04/01                        - 1 000,00 €

                  TOTAL DES MOUVEMENTS DEBITEURS                                                                                                                   - 1 420,50 €
                  TOTAL DES MOUVEMENTS CREDITEURS                                                                                                                    1 500,00 €

                  SOLDE CREDITEUR AU 05/01/2026*                                                                                                                     10 079,50 €

DETAIL DE VOS MOUVEMENTS SEPA

                                                                              DATE         DETAIL DE VOS PRELEVEMENTS SEPA RECUS                                                                                                                    DEBIT
                                                                              02/01        Fournisseur Test                       FR00ZZZ000000                                                                                                    120,50 €
                                                                            05/01             DUPLICATE LEAK TEST                                                    ZZ00000              05/01                05/01                          9 999,99 €
`;

test("extractReleveTransactions lit les operations du releve", () => {
  const txs = extractReleveTransactions(FIXTURE);
  assert.equal(txs.length, 4);
});

test("extractReleveTransactions separe libelle et reference sur le grand blanc de mise en page", () => {
  const txs = extractReleveTransactions(FIXTURE);
  const t = txs.find((t) => t.montant.replace(/\s/g, "") === "1500,00");
  assert.equal(t?.libelle, "VIR INST Client Test");
});

test("extractReleveTransactions garde le libelle complet quand il n'y a pas de reference (ex. LCR)", () => {
  const txs = extractReleveTransactions(FIXTURE);
  const t = txs.find((t) => t.libelle.includes("LCR"));
  assert.equal(t?.libelle, "LCR DOMICILIEE");
});

test("extractReleveTransactions ne separe pas une reference sans chiffres au milieu d'un nom en majuscules", () => {
  // "LUGASSY JORDAN" est ecrit en majuscules mais n'est separe de "WGHDUWZ"
  // (la vraie reference, elle-meme sans chiffre) que par un espace simple :
  // seul le grand blanc de mise en page doit determiner la coupure.
  const txs = extractReleveTransactions(FIXTURE);
  const t = txs.find((t) => t.libelle.includes("LUGASSY"));
  assert.equal(t?.libelle, "VIR INST LUGASSY JORDAN");
});

test("extractReleveTransactions exclut l'annexe 'DETAIL DE VOS MOUVEMENTS SEPA' (deja comptee dans le ledger)", () => {
  const txs = extractReleveTransactions(FIXTURE);
  const fuite = txs.find((t) => t.libelle.includes("DUPLICATE LEAK"));
  assert.equal(fuite, undefined);
});

test("extractReleveTransactions deduit l'annee a partir de l'entete du relevé, avec bascule sur le passage d'annee", () => {
  const txs = extractReleveTransactions(FIXTURE);
  // Le relevé est "au 05/01/2026" : une operation datee 28/12 est donc de
  // decembre 2025 (annee precedente), pas 2026.
  const dec = txs.find((t) => t.date.startsWith("28/12"));
  assert.equal(dec?.date, "28/12/2025");

  const jan = txs.find((t) => t.date.startsWith("02/01"));
  assert.equal(jan?.date, "02/01/2026");
});

test("extractReleveTransactions capture la reference bancaire de la ligne (utile pour distinguer deux operations sinon identiques en date+libelle+montant)", () => {
  const txs = extractReleveTransactions(FIXTURE);
  const t = txs.find((t) => t.libelle.includes("Fournisseur Test"));
  assert.equal(t?.reference, "CD98765");
});

test("extractReleveTransactions : reference absente (ex. LCR, sans reference imprimee) quand la ligne n'en a pas", () => {
  const txs = extractReleveTransactions(FIXTURE);
  const t = txs.find((t) => t.libelle.includes("LCR"));
  assert.equal(t?.reference, undefined);
});

// Fixture reproduisant la mise en page reelle d'une remise carte bleue
// (voir extractReleveTransactions) : le montant credite (net) est suivi
// d'une ligne de detail "BRUT ... - COM ...".
const FIXTURE_REMISE_CB = `
                                                                         Votre relevé de compte n°3 au 05/01/2026

                                                                         DETAIL DES OPERATIONS DE VOTRE COMPTE COURANT N° 00000000000

                                                                           DATE                                                                                          DATE                   DATE
                                                                                           LIBELLE / REFERENCE                                                                                                 MONTANT
                                                                          COMPTA                                                                                       OPERATION               VALEUR

                                                                                           SOLDE CREDITEUR AU 27/12/2025                                                                                       10 000,00 €
                                                                            02/01             REMISE CB 1317821012                                                     0033976              02/01                02/01                          2 348,16 €
                                                                                                BRUT       2 377,88E - COM 29,72E
                                                                                                           - NB0002/120976

                  TOTAL DES MOUVEMENTS DEBITEURS                                                                                                                        0,00 €
                  TOTAL DES MOUVEMENTS CREDITEURS                                                                                                                   2 348,16 €

                  SOLDE CREDITEUR AU 05/01/2026*                                                                                                                    12 348,16 €

DETAIL DE VOS MOUVEMENTS SEPA
`;

test("extractReleveTransactions capture le montant BRUT (avant commission) d'une remise carte bleue", () => {
  const txs = extractReleveTransactions(FIXTURE_REMISE_CB);
  const t = txs.find((t) => t.libelle.startsWith("REMISE CB"));
  assert.equal(t?.montant, "2 348,16");
  assert.equal(t?.montantBrut, "2 377,88");
});

test("extractReleveTransactions : montantBrut absent pour une operation qui n'est pas une remise CB", () => {
  const txs = extractReleveTransactions(FIXTURE);
  const t = txs.find((t) => t.libelle.includes("LCR"));
  assert.equal(t?.montantBrut, undefined);
});

test("extractReleveTransactions retourne un tableau vide si la mise en page n'est pas reconnue", () => {
  const txs = extractReleveTransactions("Un texte quelconque sans rapport avec un releve bancaire.");
  assert.deepEqual(txs, []);
});

// Bug reel trouve en inspectant un vrai releve Banque Populaire (novembre
// 2026) : une ligne de paiement carte n'imprime que "DDMMYY CB****NNNN"
// (reference de carte), jamais le nom du commercant - celui-ci est sur la
// ligne suivante, seul. Sans recuperer cette ligne, 36 % des operations
// d'un releve reel (celles payees par carte) restaient avec un libelle
// inexploitable pour le rapprochement fournisseur.
const FIXTURE_CARTE = `
                                                                         Votre relevé de compte n°3 au 05/01/2026

                                                                         DETAIL DES OPERATIONS DE VOTRE COMPTE COURANT N° 00000000000

                                                                           DATE                                                                                          DATE                   DATE
                                                                                           LIBELLE / REFERENCE                                                                                                 MONTANT
                                                                          COMPTA                                                                                       OPERATION               VALEUR

                                                                                           SOLDE CREDITEUR AU 27/12/2025                                                                                       10 000,00 €
                                                                            02/01             010126 CB****9020                                                        0HP4OPD              02/01                02/01                        - 136,56 €
                                                                                                LEROY MERLIN SCFR COLLEGIEN
                                                                                                136,56EUR 1 EURO = 1,000000
                                                                            03/01             020126 CB****9020                                                        0HP4OPC              03/01                03/01                           - 20,00 €
0008 0003



                                                                                                Google ADS78531IE DUBLIN 4
20260130*223828*EXTCL02*P183346*00010784*00000002/00000005*00026845*0*



                                                                                                20,00EUR 1 EURO = 1,000000

                  TOTAL DES MOUVEMENTS DEBITEURS                                                                                                                   - 156,56 €
                  TOTAL DES MOUVEMENTS CREDITEURS                                                                                                                      0,00 €

                  SOLDE CREDITEUR AU 05/01/2026*                                                                                                                      9 843,44 €

DETAIL DE VOS MOUVEMENTS SEPA
`;

test("extractReleveTransactions recupere le nom du commercant sur la ligne suivante pour un paiement carte", () => {
  const txs = extractReleveTransactions(FIXTURE_CARTE);
  const t = txs.find((t) => t.montant.replace(/\s/g, "") === "-136,56");
  assert.equal(t?.libelle, "LEROY MERLIN SCFR COLLEGIEN (010126 CB****9020)");
});

test("extractReleveTransactions retrouve le commercant meme quand une rupture de page (bruit de pagination/code-barres) separe la ligne carte de son commercant", () => {
  const txs = extractReleveTransactions(FIXTURE_CARTE);
  const t = txs.find((t) => t.montant.replace(/\s/g, "") === "-20,00");
  assert.equal(t?.libelle, "Google ADS78531IE DUBLIN 4 (020126 CB****9020)");
});

// Bug reel trouve en production (novembre 2026, tickets Leclerc/REVIVAL,
// deux scans sans aucune couche de texte) : pdftotext emet toujours au
// moins un saut de page ("\f"), jamais une chaine litteralement vide,
// meme pour une page entierement sans texte. Un appelant qui testait
// juste `if (texte)` considerait alors a tort qu'il y avait du texte
// (une chaine non vide est "truthy" en JS), et ne declenchait jamais le
// repli vers la vision IA sur l'image rendue de la page.
test("texteSignificatif : un saut de page seul (\"\\f\", ce que pdftotext emet pour une page sans texte) est traite comme une absence de texte", () => {
  assert.equal(texteSignificatif("\f"), undefined);
  assert.equal(texteSignificatif("\f\f"), undefined);
  assert.equal(texteSignificatif("   \n\t  "), undefined);
  assert.equal(texteSignificatif(""), undefined);
  assert.equal(texteSignificatif(undefined), undefined);
});

test("texteSignificatif : du vrai texte est conserve (debarrasse des blancs en tete/fin)", () => {
  assert.equal(texteSignificatif("  Total TTC 120,00 €\f"), "Total TTC 120,00 €");
});

// Fixture reproduisant la mise en page reelle d'un releve de carte
// American Express Carte Business Platinum (voir extractReleveCarteAmexTransactions).
const FIXTURE_AMEX = `
                   La Carte Business Platinum American Express                                                                              americanexpress.fr
                   Relevé de compte

Nom                                                                                                    Numéro de Compte              Date de relevé        Prochain relevé
JORDAN LUGASSY                                                                              xxxx-xxxxxx-41001                       25/10/26              25/11/26
ATELIER BROCHANT

Date de la    Enregistrée                                                                                                                                    Montant en
transaction   le:           Details de la transaction                                              Dépenses en monnaie étrangère                                   EUR


29 sept 29 sept PRELEVEMENT AUTOMATIQUE ENREGISTRE-MERCI                                                                                                 2 942,24
                                                                                                                                                               CR
Opérations pour JORDAN LUGASSY
Carte xxxx-xxxxxx-41001

6 oct         7 oct         TWILIO.COM                      DUBLIN                                                        20.00                                18,36
                                                                                                                 Dollar américain
                            Taux de conversion: 1.1198 + commission 0,50

9 oct         9 oct         LM IVRY LEROYM49                      IVRY                                                                                        90,79
Total des dépenses pour JORDAN LUGASSY                                                                                                                       109,15
`;

test("estReleveCarteAmex detecte un releve de carte American Express", () => {
  assert.equal(estReleveCarteAmex(FIXTURE_AMEX), true);
});

test("estReleveCarteAmex ne detecte pas un releve de compte courant", () => {
  assert.equal(estReleveCarteAmex("DETAIL DES OPERATIONS DE VOTRE COMPTE COURANT N° 123"), false);
});

test("extractReleveCarteAmexTransactions lit les operations du releve, dates completees avec l'annee de l'entete", () => {
  const txs = extractReleveCarteAmexTransactions(FIXTURE_AMEX);
  assert.equal(txs.length, 2);
  assert.deepEqual(
    txs.map((t) => t.date),
    ["06/10/2026", "09/10/2026"]
  );
});

test("extractReleveCarteAmexTransactions convertit chaque depense carte en montant negatif (sortie d'argent)", () => {
  const txs = extractReleveCarteAmexTransactions(FIXTURE_AMEX);
  const t = txs.find((t) => t.libelle.includes("LM IVRY"));
  assert.equal(t?.montant, "- 90,79");
});

test("extractReleveCarteAmexTransactions ignore le montant en devise etrangere (point) et ne retient que le montant EUR final (virgule)", () => {
  const txs = extractReleveCarteAmexTransactions(FIXTURE_AMEX);
  const t = txs.find((t) => t.libelle.includes("TWILIO"));
  assert.equal(t?.montant, "- 18,36");
});

test("extractReleveCarteAmexTransactions exclut le prelevement automatique du solde precedent (ligne 'CR') - deja compte sur le releve du compte bancaire", () => {
  const txs = extractReleveCarteAmexTransactions(FIXTURE_AMEX);
  const fuite = txs.find((t) => t.libelle.includes("PRELEVEMENT AUTOMATIQUE"));
  assert.equal(fuite, undefined);
});
