import { test } from "node:test";
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

// Module PagesJaunes/Solocal Manager, mode "assiste" (pas d'API, SSO bloque
// les navigateurs automatises - voir pagesJaunesActions.ts) : aucune
// publication reelle n'est jamais declenchee par ce module, seulement le
// pipeline propose/accepte/refuse/marque-publiee, pour les trois types
// (actualite, info_fiche, reponse_avis) du modele unifie.
test("Module PagesJaunes", async (t) => {
  execSync("npx prisma db push --force-reset --skip-generate", {
    cwd: path.join(__dirname, ".."),
    env: process.env,
    stdio: "pipe",
  });

  const { PrismaClient } = await import("@prisma/client");
  const {
    ETABLISSEMENT_PAGESJAUNES,
    creerPropositionActualite,
    creerPropositionInfoFiche,
    creerPropositionReponseAvis,
    listerPropositionsPagesJaunes,
    accepterPropositionPagesJaunes,
    refuserPropositionPagesJaunes,
    marquerPublieePropositionPagesJaunes,
    obtenirEtatActualitesPagesJaunes,
  } = await import("../src/services/pagesJaunesActions");
  const prisma = new PrismaClient();

  await t.test("creerPropositionActualite : rejette un texte manquant", async () => {
    await assert.rejects(creerPropositionActualite(prisma, { texte: "", justification: "test" }), /texte manquant/);
  });

  await t.test("creerPropositionActualite : cree une proposition en_attente avec l'etablissement fixe", async () => {
    await prisma.propositionPagesJaunes.deleteMany({});
    const proposition = await creerPropositionActualite(prisma, { texte: "Nouvelle intervention reussie !", justification: "Actualite du jour" });
    assert.equal(proposition.statut, "en_attente");
    assert.equal(proposition.type, "actualite");
    assert.equal(proposition.etablissement, ETABLISSEMENT_PAGESJAUNES);

    const liste = await listerPropositionsPagesJaunes(prisma);
    assert.equal(liste.length, 1);
    assert.equal(liste[0].id, proposition.id);
  });

  await t.test("creerPropositionInfoFiche : rejette un champFiche invalide", async () => {
    await assert.rejects(creerPropositionInfoFiche(prisma, { champFiche: "autre_chose", texte: "Texte", justification: "test" }), /champFiche invalide/);
  });

  await t.test("creerPropositionInfoFiche : cree une proposition en_attente", async () => {
    await prisma.propositionPagesJaunes.deleteMany({});
    const proposition = await creerPropositionInfoFiche(prisma, { champFiche: "horaires", texte: "Lun-Ven 8h-18h", justification: "Horaires a jour" });
    assert.equal(proposition.statut, "en_attente");
    assert.equal(proposition.type, "info_fiche");
    assert.equal(proposition.champFiche, "horaires");
  });

  await t.test("creerPropositionReponseAvis : rejette une note hors de 1 a 5", async () => {
    await assert.rejects(
      creerPropositionReponseAvis(prisma, { avisTexte: "Avis", texte: "Reponse", avisNote: 6, justification: "test" }),
      /avisNote doit etre comprise/
    );
  });

  await t.test("creerPropositionReponseAvis : cree une proposition en_attente", async () => {
    await prisma.propositionPagesJaunes.deleteMany({});
    const proposition = await creerPropositionReponseAvis(prisma, {
      avisTexte: "Tres bon service, rapide et efficace.",
      texte: "Merci beaucoup pour votre retour !",
      avisClientNom: "M. Dupont",
      avisNote: 5,
      justification: "Avis positif recent",
    });
    assert.equal(proposition.statut, "en_attente");
    assert.equal(proposition.type, "reponse_avis");
    assert.equal(proposition.avisClientNom, "M. Dupont");
  });

  await t.test("marquerPublieePropositionPagesJaunes : refuse une proposition qui n'est pas acceptee", async () => {
    await prisma.propositionPagesJaunes.deleteMany({});
    const proposition = await creerPropositionActualite(prisma, { texte: "Texte", justification: "test" });
    await assert.rejects(marquerPublieePropositionPagesJaunes(prisma, proposition.id), /pas "acceptee"/);
  });

  await t.test("accepterPropositionPagesJaunes puis marquerPublieePropositionPagesJaunes : flux complet sans aucune publication automatique", async () => {
    await prisma.propositionPagesJaunes.deleteMany({});
    const proposition = await creerPropositionActualite(prisma, { texte: "Texte", justification: "test" });

    const acceptee = await accepterPropositionPagesJaunes(prisma, proposition.id);
    assert.equal(acceptee.statut, "acceptee");
    assert.ok(acceptee.decideLe);

    const publiee = await marquerPublieePropositionPagesJaunes(prisma, proposition.id);
    assert.equal(publiee.statut, "publiee");
    assert.ok(publiee.publieeLe);
  });

  await t.test("refuserPropositionPagesJaunes : passe a refusee", async () => {
    await prisma.propositionPagesJaunes.deleteMany({});
    const proposition = await creerPropositionActualite(prisma, { texte: "Texte", justification: "test" });
    const resultat = await refuserPropositionPagesJaunes(prisma, proposition.id);
    assert.equal(resultat.statut, "refusee");
    assert.ok(resultat.decideLe);
  });

  await t.test("listerPropositionsPagesJaunes : filtre par type", async () => {
    await prisma.propositionPagesJaunes.deleteMany({});
    await creerPropositionActualite(prisma, { texte: "Texte actu", justification: "test" });
    await creerPropositionInfoFiche(prisma, { champFiche: "services", texte: "Debouchage, plomberie", justification: "test" });

    const actualites = await listerPropositionsPagesJaunes(prisma, "actualite");
    assert.equal(actualites.length, 1);
    assert.equal(actualites[0].type, "actualite");

    const toutes = await listerPropositionsPagesJaunes(prisma);
    assert.equal(toutes.length, 2);
  });

  await t.test("obtenirEtatActualitesPagesJaunes : ne compte que les actualites publiees CE mois-ci, objectif fixe a 4", async () => {
    await prisma.propositionPagesJaunes.deleteMany({});
    const maintenant = new Date("2026-11-15T12:00:00");
    const moisDernier = new Date("2026-10-20T12:00:00");

    const p1 = await creerPropositionActualite(prisma, { texte: "Actu ce mois", justification: "test" });
    await accepterPropositionPagesJaunes(prisma, p1.id);
    await marquerPublieePropositionPagesJaunes(prisma, p1.id);

    const p2 = await creerPropositionActualite(prisma, { texte: "Actu mois dernier", justification: "test" });
    await prisma.propositionPagesJaunes.update({ where: { id: p2.id }, data: { statut: "publiee", publieeLe: moisDernier } });

    const etat = await obtenirEtatActualitesPagesJaunes(prisma, maintenant);
    assert.equal(etat.nbPublieesCeMois, 1);
    assert.equal(etat.objectifMensuel, 4);
    assert.ok(etat.dernieresActualites.length >= 1);
  });

  await prisma.$disconnect();
});
