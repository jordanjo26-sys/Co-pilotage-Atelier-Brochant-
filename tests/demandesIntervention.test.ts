import { test, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execSync } from "node:child_process";
import dotenv from "dotenv";

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ||
  (process.env.DATABASE_URL ? process.env.DATABASE_URL.replace(/(\?|$)/, "_test$1") : undefined);

if (!testDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL (ou DATABASE_URL) manquante : voir .env.example.");
}
process.env.DATABASE_URL = testDatabaseUrl;

before(() => {
  execSync("npx prisma db push --force-reset --skip-generate", {
    cwd: path.join(__dirname, ".."),
    env: process.env,
    stdio: "pipe",
  });
});

test("demandes d'intervention : creation, validation, file d'attente et marquage", async (t) => {
  const { PrismaClient } = await import("@prisma/client");
  const {
    creerDemandeIntervention,
    listerDemandesIntervention,
    marquerDemandeInterventionSaisie,
    modifierDemandeIntervention,
    DemandeInterventionValidationError,
  } = await import("../src/services/demandesIntervention");
  const prisma = new PrismaClient();

  await t.test("nom manquant -> erreur de validation", async () => {
    await assert.rejects(creerDemandeIntervention(prisma, {}), DemandeInterventionValidationError);
  });

  await t.test("urgence invalide -> erreur de validation", async () => {
    await assert.rejects(
      creerDemandeIntervention(prisma, { nom: "M. Durand", urgence: "tres_urgente" }),
      DemandeInterventionValidationError
    );
  });

  await t.test("creation valide -> statut 'a_saisir' par defaut", async () => {
    const demande = await creerDemandeIntervention(prisma, {
      nom: "M. Durand",
      telephone: "0601020304",
      email: "m.durand@example.com",
      adresse: "12 rue des Lilas",
      codePostal: "75018",
      ville: "Paris",
      typeLogement: "appartement",
      etage: "3",
      codeAcces: "1234B",
      motif: "WC bouche",
      urgence: "urgente",
      dateSouhaitee: "2026-11-05T14:30",
    });
    assert.equal(demande.statut, "a_saisir");
    assert.equal(demande.nom, "M. Durand");
    assert.equal(demande.email, "m.durand@example.com");
    assert.equal(demande.urgence, "urgente");
    // 5 novembre = hors heure d'ete, Paris = UTC+1 : 14h30 Paris -> 13h30 UTC.
    // Verifie que la date est bien lue comme une heure de Paris (fuseau
    // explicite), pas celle, souvent UTC, du serveur qui execute ce test.
    assert.equal(demande.dateSouhaitee?.toISOString(), "2026-11-05T13:30:00.000Z");
  });

  await t.test("champs vides -> stockes comme absents (undefined), pas chaine vide", async () => {
    const demande = await creerDemandeIntervention(prisma, { nom: "Mme Petit", telephone: "" });
    assert.equal(demande.telephone, null);
  });

  await t.test("liste 'a_saisir' par defaut, exclut les demandes deja saisies", async () => {
    const aSaisir = await listerDemandesIntervention(prisma, "a_saisir");
    assert.equal(aSaisir.length, 2);

    const premiere = aSaisir.find((d) => d.nom === "M. Durand")!;
    await marquerDemandeInterventionSaisie(prisma, premiere.id);

    const apresMarquage = await listerDemandesIntervention(prisma, "a_saisir");
    assert.equal(apresMarquage.length, 1);
    assert.equal(apresMarquage.some((d) => d.id === premiere.id), false);

    const toutes = await listerDemandesIntervention(prisma, "toutes");
    assert.equal(toutes.length, 2);
    const miseAJour = toutes.find((d) => d.id === premiere.id)!;
    assert.equal(miseAJour.statut, "saisie");
    assert.ok(miseAJour.saisieLe);
  });

  await t.test("modification : change les champs fournis, efface ceux envoyes vides", async () => {
    const demande = await creerDemandeIntervention(prisma, { nom: "Mme Petit", telephone: "0600000000", motif: "Fuite" });

    const modifiee = await modifierDemandeIntervention(prisma, demande.id, {
      nom: "Mme Petit-Durand",
      // telephone absent du payload : ne doit pas etre touche.
      motif: "", // envoye vide : doit effacer le motif existant.
    });
    assert.equal(modifiee.nom, "Mme Petit-Durand");
    assert.equal(modifiee.telephone, "0600000000");
    assert.equal(modifiee.motif, null);
  });

  await t.test("modification : nom manquant -> erreur de validation, rien n'est ecrase", async () => {
    const demande = await creerDemandeIntervention(prisma, { nom: "M. Argent" });
    await assert.rejects(modifierDemandeIntervention(prisma, demande.id, { nom: "" }), DemandeInterventionValidationError);
  });

  await prisma.$disconnect();
});
