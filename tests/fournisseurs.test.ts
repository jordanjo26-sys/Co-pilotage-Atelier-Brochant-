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

test("nom affiche 'Prenom NOM' (contact commercial individuel) -> nom derive du domaine, pas le contact (demande explicite de l'utilisateur)", () => {
  const r = extraireIdentiteExpediteur("Alexandre CECCARELLO <aceccarello@incomm.fr>");
  assert.equal(r.nom, "Incomm");
  assert.equal(r.email, "aceccarello@incomm.fr");
});

test("nom affiche 'Nom, Prenom' (avec virgule) -> nom derive du domaine", () => {
  const r = extraireIdentiteExpediteur('"Khelifa, Redouan" <redouan.khelifa@cedeo.fr>');
  assert.equal(r.nom, "Cedeo");
});

test("'Prenom Nom' (nom de famille PAS tout en majuscules) reste tel quel : trop proche d'une vraie raison sociale pour trancher a coup sur (ex. 'Cedeo Paris')", () => {
  const r = extraireIdentiteExpediteur('"Cedeo Paris" <contact@cedeo.fr>');
  assert.equal(r.nom, "Cedeo Paris");
});

test("'Prenom NOM' chez une messagerie grand public -> nom affiche conserve tel quel (aucune raison sociale fiable a en deriver)", () => {
  const r = extraireIdentiteExpediteur("Jean DUPONT <jean.dupont@gmail.com>");
  assert.equal(r.nom, "Jean DUPONT");
});

test("nom affiche egal a l'adresse e-mail elle-meme -> traite comme une absence de nom, repli sur le domaine (cas reel : Leon Grosse, Kiloutou, CPSE)", () => {
  const r = extraireIdentiteExpediteur('"t.reymond@leongrosse.fr" <t.reymond@leongrosse.fr>');
  assert.equal(r.nom, "Leongrosse");
  assert.equal(r.email, "t.reymond@leongrosse.fr");
});

test("en-tete mal forme avec guillemets internes mal echappes -> nom reel recupere malgre tout (cas reel : WeFix)", () => {
  const r = extraireIdentiteExpediteur(`"\\"L'équipe WeFix\\" " <mailing@wefix.net>`);
  assert.equal(r.nom, "L'équipe WeFix");
  assert.equal(r.email, "mailing@wefix.net");
});

test("nom affiche contenant une adresse e-mail entre parentheses (systeme d'envoi automatise) -> nom derive de CETTE adresse, pas de l'expediteur technique (cas reel : Masternaut via NetSuite)", () => {
  const r = extraireIdentiteExpediteur('"Alain Picard NL (alain.picard@masternaut.com)" <system@sent-via.netsuite.com>');
  assert.equal(r.nom, "Masternaut");
  assert.equal(r.email, "system@sent-via.netsuite.com");
});

test("adresse entre parentheses sur une messagerie grand public -> pas de deduction fiable, nom affiche conserve tel quel", () => {
  const r = extraireIdentiteExpediteur('"Jean (jean.dupont@gmail.com)" <system@sent-via.netsuite.com>');
  assert.equal(r.nom, "Jean (jean.dupont@gmail.com)");
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

test("renommage d'une fiche fournisseur", async (t) => {
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
  const { renommerFournisseur } = await import("../src/services/fournisseurs");
  const prisma = new PrismaClient();

  await t.test("nom cible libre -> simple renommage", async () => {
    const f = await prisma.fournisseur.create({ data: { nom: "Alexandre CECCARELLO" } });
    const resultat = await renommerFournisseur(prisma, f.id, "Incomm");
    assert.equal(resultat.fusionneAvec, null);
    const apres = await prisma.fournisseur.findUnique({ where: { id: f.id } });
    assert.equal(apres?.nom, "Incomm");
  });

  await t.test("nom cible deja pris -> fusion, documents et factures reattaches, fiche source supprimee", async () => {
    const source = await prisma.fournisseur.create({ data: { nom: "Khelifa, Redouan" } });
    const cible = await prisma.fournisseur.create({ data: { nom: "Cedeo" } });
    const doc = await prisma.documentFournisseur.create({ data: { type: "facture", fournisseurId: source.id, fichierNom: "f.pdf" } });
    const facture = await prisma.factureFournisseur.create({ data: { fournisseurId: source.id, montant: 50 } });

    const resultat = await renommerFournisseur(prisma, source.id, "Cedeo");

    assert.equal(resultat.fusionneAvec, "Cedeo");
    assert.equal(await prisma.fournisseur.findUnique({ where: { id: source.id } }), null, "la fiche source doit etre supprimee");
    assert.ok(await prisma.fournisseur.findUnique({ where: { id: cible.id } }), "la fiche cible doit subsister");
    assert.equal((await prisma.documentFournisseur.findUnique({ where: { id: doc.id } }))?.fournisseurId, cible.id);
    assert.equal((await prisma.factureFournisseur.findUnique({ where: { id: facture.id } }))?.fournisseurId, cible.id);
  });

  await t.test("meme nom -> aucun changement", async () => {
    const f = await prisma.fournisseur.create({ data: { nom: "Ionos" } });
    const resultat = await renommerFournisseur(prisma, f.id, "Ionos");
    assert.equal(resultat.fusionneAvec, null);
  });

  await t.test("fournisseur inexistant -> erreur", async () => {
    await assert.rejects(renommerFournisseur(prisma, "inexistant", "Nouveau nom"));
  });

  await prisma.$disconnect();
});

test("resoudreFournisseur : priorite au nom lu sur le document (IA) sur le nom derive de l'expediteur", async (t) => {
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
  const { resoudreFournisseur } = await import("../src/services/fournisseurs");
  const prisma = new PrismaClient();

  await t.test("nomDocumentIA fourni (facture transmise par un intermediaire) -> prime sur l'expediteur", async () => {
    const fournisseurId = await resoudreFournisseur(prisma, '"e-Facture PA" <no-reply@e-facture-pa.fr>', undefined, "Leroy Merlin");
    const fournisseur = await prisma.fournisseur.findUnique({ where: { id: fournisseurId } });
    assert.equal(fournisseur?.nom, "Leroy Merlin", "le fournisseur reel lu sur le document, pas l'intermediaire qui l'a transmise");
  });

  await t.test("nomDocumentIA absent -> comportement inchange (nom derive de l'expediteur)", async () => {
    const fournisseurId = await resoudreFournisseur(prisma, "contact@cedeo.fr");
    const fournisseur = await prisma.fournisseur.findUnique({ where: { id: fournisseurId } });
    assert.equal(fournisseur?.nom, "Cedeo");
  });

  await t.test("nomDocumentIA vide/blanc -> ignore, repli sur l'expediteur (jamais de fiche vide)", async () => {
    const fournisseurId = await resoudreFournisseur(prisma, "contact@point-p.fr", undefined, "   ");
    const fournisseur = await prisma.fournisseur.findUnique({ where: { id: fournisseurId } });
    assert.equal(fournisseur?.nom, "Point P");
  });

  await t.test("nomDocumentIA tout en majuscules -> remis en casse titre comme le nom d'expediteur", async () => {
    const fournisseurId = await resoudreFournisseur(prisma, "contact@portail-facturation.fr", undefined, "LEROY MERLIN");
    const fournisseur = await prisma.fournisseur.findUnique({ where: { id: fournisseurId } });
    assert.equal(fournisseur?.nom, "Leroy Merlin");
  });

  await t.test("deuxieme facture du meme fournisseur reel via le meme intermediaire -> rattachee a la MEME fiche (pas de doublon)", async () => {
    const premiere = await resoudreFournisseur(prisma, '"e-Facture PA" <no-reply@e-facture-pa.fr>', undefined, "Leroy Merlin");
    const seconde = await resoudreFournisseur(prisma, '"e-Facture PA" <no-reply@e-facture-pa.fr>', undefined, "Leroy Merlin");
    assert.equal(premiere, seconde);
    const toutes = await prisma.fournisseur.findMany({ where: { nom: "Leroy Merlin" } });
    assert.equal(toutes.length, 1);
  });

  await t.test("cache partage : la cle de cache suit le nom final resolu, pas le nom d'expediteur", async () => {
    const cache = new Map<string, string>();
    const id1 = await resoudreFournisseur(prisma, '"Portail X" <x@portail-x.fr>', cache, "Castorama");
    assert.equal(cache.get("Castorama"), id1);
    const id2 = await resoudreFournisseur(prisma, '"Portail X" <x@portail-x.fr>', cache, "Castorama");
    assert.equal(id1, id2);
  });

  await prisma.$disconnect();
});

test("corrigerNomsFournisseursDepuisExpediteur : corrige retroactivement les fiches au nom illisible", async (t) => {
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
  const { corrigerNomsFournisseursDepuisExpediteur } = await import("../src/services/fournisseurs");
  const prisma = new PrismaClient();

  await t.test("nom = l'adresse e-mail elle-meme, consensus unanime -> renomme (cas reel Leon Grosse)", async () => {
    const f = await prisma.fournisseur.create({ data: { nom: "t.reymond@leongrosse.fr" } });
    await prisma.documentFournisseur.create({
      data: { type: "facture", fournisseurId: f.id, fichierNom: "a.pdf", gmailExpediteur: '"t.reymond@leongrosse.fr" <t.reymond@leongrosse.fr>' },
    });
    await prisma.documentFournisseur.create({
      data: { type: "facture", fournisseurId: f.id, fichierNom: "b.pdf", gmailExpediteur: '"t.reymond@leongrosse.fr" <t.reymond@leongrosse.fr>' },
    });

    const resultat = await corrigerNomsFournisseursDepuisExpediteur(prisma);
    const entree = resultat.corriges.find((c) => c.fournisseurId === f.id);
    assert.ok(entree, "la fiche doit avoir ete corrigee");
    assert.equal(entree?.ancienNom, "t.reymond@leongrosse.fr");
    assert.equal(entree?.nouveauNom, "Leongrosse");

    const apres = await prisma.fournisseur.findUnique({ where: { id: f.id } });
    assert.equal(apres?.nom, "Leongrosse");
  });

  await t.test("documents rattaches a des expediteurs differents -> pas de consensus, fiche jamais touchee", async () => {
    const f = await prisma.fournisseur.create({ data: { nom: "contact@ambigu.fr" } });
    await prisma.documentFournisseur.create({
      data: { type: "facture", fournisseurId: f.id, fichierNom: "a.pdf", gmailExpediteur: "contact@ambigu.fr" },
    });
    await prisma.documentFournisseur.create({
      // Document reattache manuellement a une autre fiche existante au prealable
      // (simule ici par un expediteur totalement different) : aucune certitude
      // sur le nom a appliquer, donc aucun changement.
      data: { type: "facture", fournisseurId: f.id, fichierNom: "b.pdf", gmailExpediteur: "contact@autre-domaine.fr" },
    });

    const resultat = await corrigerNomsFournisseursDepuisExpediteur(prisma);
    assert.equal(resultat.corriges.some((c) => c.fournisseurId === f.id), false);
    const apres = await prisma.fournisseur.findUnique({ where: { id: f.id } });
    assert.equal(apres?.nom, "contact@ambigu.fr");
  });

  await t.test("nom deja correct -> aucun changement (idempotent)", async () => {
    const f = await prisma.fournisseur.create({ data: { nom: "Cedeo" } });
    await prisma.documentFournisseur.create({
      data: { type: "facture", fournisseurId: f.id, fichierNom: "a.pdf", gmailExpediteur: "contact@cedeo.fr" },
    });

    const resultat = await corrigerNomsFournisseursDepuisExpediteur(prisma);
    assert.equal(resultat.corriges.some((c) => c.fournisseurId === f.id), false);
  });

  await t.test("documents envoyes depuis le compte Gmail connecte lui-meme -> jamais utilises pour recalculer le nom (regression reelle corrigee : Leclerc/Revival Derichebourg ecrases par 'atelier.brochant@gmail.com')", async () => {
    await prisma.gmailConnexion.create({ data: { compteEmail: "atelier.brochant@gmail.com", refreshTokenChiffre: "x" } });
    const f = await prisma.fournisseur.create({ data: { nom: "Leclerc" } });
    await prisma.documentFournisseur.create({
      data: { type: "facture", fournisseurId: f.id, fichierNom: "ticket.pdf", gmailExpediteur: "atelier.brochant@gmail.com" },
    });

    const resultat = await corrigerNomsFournisseursDepuisExpediteur(prisma);
    assert.equal(resultat.corriges.some((c) => c.fournisseurId === f.id), false, "un document auto-envoye ne doit jamais ecraser un nom saisi a la main");
    const apres = await prisma.fournisseur.findUnique({ where: { id: f.id } });
    assert.equal(apres?.nom, "Leclerc");
  });

  await t.test("nom cible deja pris par une autre fiche -> fusion (meme comportement que renommerFournisseur)", async () => {
    const cible = await prisma.fournisseur.create({ data: { nom: "Kiloutou" } });
    const source = await prisma.fournisseur.create({ data: { nom: "agence0240@kiloutou.fr" } });
    const doc = await prisma.documentFournisseur.create({
      data: {
        type: "facture",
        fournisseurId: source.id,
        fichierNom: "a.pdf",
        gmailExpediteur: '"agence0240@kiloutou.fr" <agence0240@kiloutou.fr>',
      },
    });

    const resultat = await corrigerNomsFournisseursDepuisExpediteur(prisma);
    const entree = resultat.corriges.find((c) => c.fournisseurId === source.id);
    assert.ok(entree?.fusionne);
    assert.equal(await prisma.fournisseur.findUnique({ where: { id: source.id } }), null);
    assert.equal((await prisma.documentFournisseur.findUnique({ where: { id: doc.id } }))?.fournisseurId, cible.id);
  });

  await prisma.$disconnect();
});

test("suppression d'un document isole rattache a tort a un fournisseur", async (t) => {
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
  const { supprimerDocumentFournisseur } = await import("../src/services/fournisseurs");
  const prisma = new PrismaClient();

  await t.test("document non envoye a Dext -> suppression effective", async () => {
    const f = await prisma.fournisseur.create({ data: { nom: "Le Cercle Interimaire" } });
    const doc = await prisma.documentFournisseur.create({
      data: { type: "autre", statutDext: "archive", fournisseurId: f.id, fichierNom: "cv.pdf" },
    });
    await supprimerDocumentFournisseur(prisma, doc.id);
    assert.equal(await prisma.documentFournisseur.findUnique({ where: { id: doc.id } }), null);
  });

  // Supprimable aussi apres envoi a Dext (ex. facture envoyee par erreur,
  // demande explicite de l'utilisateur) : retire uniquement le suivi local,
  // l'application n'ayant aucun acces a l'API de Dext pour agir la-bas.
  await t.test("document deja envoye a Dext -> suppression autorisee (retire seulement le suivi local)", async () => {
    const f = await prisma.fournisseur.create({ data: { nom: "Cedeo" } });
    const doc = await prisma.documentFournisseur.create({
      data: { type: "facture", statutDext: "envoye", fournisseurId: f.id, fichierNom: "f.pdf" },
    });
    await supprimerDocumentFournisseur(prisma, doc.id);
    assert.equal(await prisma.documentFournisseur.findUnique({ where: { id: doc.id } }), null);
  });

  await t.test("document inexistant -> erreur", async () => {
    await assert.rejects(supprimerDocumentFournisseur(prisma, "inexistant"));
  });

  await prisma.$disconnect();
});

test("saisie manuelle du montant d'une facture fournisseur", async (t) => {
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
  const { saisirMontantDocumentFournisseur, MontantDocumentFournisseurError } = await import("../src/services/fournisseurs");
  const prisma = new PrismaClient();

  await t.test("montant HT et TTC -> enregistres sur le document", async () => {
    const f = await prisma.fournisseur.create({ data: { nom: "Cedeo" } });
    const doc = await prisma.documentFournisseur.create({
      data: { type: "facture", fournisseurId: f.id, fichierNom: "f.pdf" },
    });
    await saisirMontantDocumentFournisseur(prisma, doc.id, { montantHT: 100, montantTTC: 123.45 });
    const miseAJour = await prisma.documentFournisseur.findUnique({ where: { id: doc.id } });
    assert.equal(miseAJour?.montantHT, 100);
    assert.equal(miseAJour?.montantTTC, 123.45);
  });

  await t.test("un seul des deux montants fourni -> l'autre reste inchange", async () => {
    const f = await prisma.fournisseur.create({ data: { nom: "Rexel" } });
    const doc = await prisma.documentFournisseur.create({
      data: { type: "facture", fournisseurId: f.id, fichierNom: "f.pdf", montantHT: 50 },
    });
    await saisirMontantDocumentFournisseur(prisma, doc.id, { montantTTC: 60 });
    const miseAJour = await prisma.documentFournisseur.findUnique({ where: { id: doc.id } });
    assert.equal(miseAJour?.montantHT, 50);
    assert.equal(miseAJour?.montantTTC, 60);
  });

  await t.test("montant negatif, nul, ou aucun montant fourni -> erreur", async () => {
    const f = await prisma.fournisseur.create({ data: { nom: "Point P" } });
    const doc = await prisma.documentFournisseur.create({
      data: { type: "facture", fournisseurId: f.id, fichierNom: "f.pdf" },
    });
    await assert.rejects(saisirMontantDocumentFournisseur(prisma, doc.id, { montantTTC: 0 }), MontantDocumentFournisseurError);
    await assert.rejects(saisirMontantDocumentFournisseur(prisma, doc.id, { montantHT: -10 }), MontantDocumentFournisseurError);
    await assert.rejects(saisirMontantDocumentFournisseur(prisma, doc.id, {}), MontantDocumentFournisseurError);
  });

  await t.test("document inexistant -> erreur", async () => {
    await assert.rejects(saisirMontantDocumentFournisseur(prisma, "inexistant", { montantTTC: 50 }), MontantDocumentFournisseurError);
  });

  const { assignerFournisseurDocument, FournisseurDocumentError } = await import("../src/services/fournisseurs");

  await t.test("assignerFournisseurDocument : cree le fournisseur s'il n'existe pas encore", async () => {
    const doc = await prisma.documentFournisseur.create({
      data: { type: "facture", fichierNom: "ticket-leclerc.pdf", gmailExpediteur: "atelier.brochant@gmail.com" },
    });
    await assignerFournisseurDocument(prisma, doc.id, "Leclerc");
    const miseAJour = await prisma.documentFournisseur.findUnique({ where: { id: doc.id }, include: { fournisseur: true } });
    assert.equal(miseAJour?.fournisseur?.nom, "Leclerc");
  });

  await t.test("assignerFournisseurDocument : reutilise un fournisseur existant du meme nom (pas de doublon)", async () => {
    const existant = await prisma.fournisseur.create({ data: { nom: "Kiloutou" } });
    const doc = await prisma.documentFournisseur.create({ data: { type: "facture", fichierNom: "f.pdf" } });
    await assignerFournisseurDocument(prisma, doc.id, "Kiloutou");
    const miseAJour = await prisma.documentFournisseur.findUnique({ where: { id: doc.id } });
    assert.equal(miseAJour?.fournisseurId, existant.id);
    assert.equal(await prisma.fournisseur.count({ where: { nom: "Kiloutou" } }), 1);
  });

  await t.test("assignerFournisseurDocument : nom vide ou document inexistant -> erreur", async () => {
    const doc = await prisma.documentFournisseur.create({ data: { type: "facture", fichierNom: "f.pdf" } });
    await assert.rejects(assignerFournisseurDocument(prisma, doc.id, "   "), FournisseurDocumentError);
    await assert.rejects(assignerFournisseurDocument(prisma, "inexistant", "Leclerc"), FournisseurDocumentError);
  });

  const { enregistrerFournisseur } = await import("../src/services/fournisseurs");

  await t.test("enregistrerFournisseur : cree un fournisseur par son seul nom, sans document associe", async () => {
    const resultat = await enregistrerFournisseur(prisma, "OVH");
    assert.equal(resultat.nom, "OVH");
    assert.equal(resultat.cree, true);
    assert.equal(await prisma.fournisseur.count({ where: { nom: "OVH" } }), 1);
  });

  await t.test("enregistrerFournisseur : un nom deja existant ne cree pas de doublon", async () => {
    const resultat = await enregistrerFournisseur(prisma, "OVH");
    assert.equal(resultat.cree, false);
    assert.equal(await prisma.fournisseur.count({ where: { nom: "OVH" } }), 1);
  });

  await t.test("enregistrerFournisseur : nom vide -> erreur", async () => {
    await assert.rejects(enregistrerFournisseur(prisma, "   "), FournisseurDocumentError);
  });

  await prisma.$disconnect();
});
