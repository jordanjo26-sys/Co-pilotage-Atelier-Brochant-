import { test } from "node:test";
import assert from "node:assert/strict";
import { extractReleveTransactions } from "../src/importers/bankStatementPdf";

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

test("extractReleveTransactions retourne un tableau vide si la mise en page n'est pas reconnue", () => {
  const txs = extractReleveTransactions("Un texte quelconque sans rapport avec un releve bancaire.");
  assert.deepEqual(txs, []);
});
