import { test } from "node:test";
import assert from "node:assert/strict";
import { extraireIdentiteExpediteur } from "../src/services/fournisseurs";

test("nom affiche present -> utilise tel quel (casse normale)", () => {
  const r = extraireIdentiteExpediteur('"Cedeo Paris" <contact@cedeo.fr>');
  assert.equal(r.nom, "Cedeo Paris");
  assert.equal(r.email, "contact@cedeo.fr");
});

test("nom affiche tout en majuscules -> remis en casse titre", () => {
  const r = extraireIdentiteExpediteur('"POINT P LOGISTIQUE" <contact@point-p.fr>');
  assert.equal(r.nom, "Point P Logistique");
});

test("pas de nom affiche, domaine professionnel -> nom derive du domaine", () => {
  const r = extraireIdentiteExpediteur("contact@point-p.fr");
  assert.equal(r.nom, "Point P");
  assert.equal(r.email, "contact@point-p.fr");
});

test("sous-domaine (www) ignore dans la derivation du nom", () => {
  const r = extraireIdentiteExpediteur("facture@www.cedeo.fr");
  assert.equal(r.nom, "Cedeo");
});

test("messagerie grand public sans nom affiche -> l'adresse elle-meme sert de nom (pas d'invention)", () => {
  const r = extraireIdentiteExpediteur("jean.dupont@gmail.com");
  assert.equal(r.nom, "jean.dupont@gmail.com");
});

test("adresse illisible -> repli sur la chaine brute", () => {
  const r = extraireIdentiteExpediteur("expediteur invalide sans arobase");
  assert.equal(r.nom, "expediteur invalide sans arobase");
  assert.equal(r.email, null);
});
