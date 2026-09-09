import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execSync } from "node:child_process";
import dotenv from "dotenv";
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

test("suppression d'une fiche fournisseur", async (t) => {
  // Base de test dediee a ce seul test (contrairement aux autres tests de ce
  // fichier, purement unitaires) : prepare ici plutot que dans un before()
  // global, pour ne pas rendre les tests unitaires ci-dessus dependants
  // d'une base de donnees dont ils n'ont jamais eu besoin.
  dotenv.config({ path: path.join(__dirname, "..", ".env") });
  const testDatabaseUrl =
    process.env.TEST_DATABASE_URL ||
    (process.env.DATABASE_URL ? process.env.DATABASE_URL.replace(/(\?|$)/, "_test$1") : undefined);
  if (!testDatabaseUrl) {
    throw new Error("TEST_DATABASE_URL (ou DATABASE_URL) manquante : voir .env.example.");
  }
  process.env.DATABASE_URL = testDatabaseUrl;
  execSync("npx prisma db push --force-reset --skip-generate", {
    cwd: path.join(__dirname, ".."),
    env: process.env,
    stdio: "pipe",
  });

  const { PrismaClient } = await import("@prisma/client");
  const { supprimerFournisseur, FournisseurAvecFacturesError } = await import("../src/services/fournisseurs");
  const prisma = new PrismaClient();

  await t.test("fournisseur sans facture -> supprime, documents lies detaches (pas supprimes)", async () => {
    const f = await prisma.fournisseur.create({ data: { nom: "Secretariat" } });
    const doc = await prisma.documentFournisseur.create({ data: { type: "ambigu", fournisseurId: f.id, fichierNom: "x.pdf" } });

    await supprimerFournisseur(prisma, f.id);

    assert.equal(await prisma.fournisseur.findUnique({ where: { id: f.id } }), null);
    const docApres = await prisma.documentFournisseur.findUnique({ where: { id: doc.id } });
    assert.ok(docApres, "le document ne doit pas etre supprime");
    assert.equal(docApres?.fournisseurId, null);
  });

  await t.test("fournisseur avec au moins une facture reelle -> suppression refusee", async () => {
    const f = await prisma.fournisseur.create({ data: { nom: "Point P" } });
    await prisma.factureFournisseur.create({ data: { fournisseurId: f.id, montant: 100 } });

    await assert.rejects(supprimerFournisseur(prisma, f.id), FournisseurAvecFacturesError);
    assert.ok(await prisma.fournisseur.findUnique({ where: { id: f.id } }), "le fournisseur ne doit pas avoir ete supprime");
  });

  await t.test("fournisseur inexistant -> erreur", async () => {
    await assert.rejects(supprimerFournisseur(prisma, "inexistant"));
  });

  await prisma.$disconnect();
});
