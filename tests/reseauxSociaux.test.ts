import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import dotenv from "dotenv";

dotenv.config({ path: path.join(__dirname, "..", ".env") });

// Chiffrement des jetons Meta (ConnexionMeta.pageAccessTokenChiffre) : meme
// principe que tests/cipher.test.ts, une cle valide generee ici plutot que
// de dependre d'une valeur presente ou non dans .env.
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");

const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ||
  (process.env.DATABASE_URL ? process.env.DATABASE_URL.replace(/(\?|$)/, "_test$1") : undefined);

if (!testDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL (ou DATABASE_URL) manquante : voir .env.example.");
}
process.env.DATABASE_URL = testDatabaseUrl;

// Module Reseaux sociaux (Facebook/Instagram), phase "fondations" : meme
// principe de test que googleAds.test.ts/googleAdsActions.test.ts - jamais
// d'appel reel a l'API Graph (aucun jeton valide disponible en test),
// uniquement les rejets explicites en l'absence de configuration/connexion
// et le pipeline propose-puis-valide (creation/acceptation/refus).
test("Module Reseaux sociaux", async (t) => {
  execSync("npx prisma db push --force-reset --skip-generate", {
    cwd: path.join(__dirname, ".."),
    env: process.env,
    stdio: "pipe",
  });

  const { PrismaClient } = await import("@prisma/client");
  const { chiffrer } = await import("../src/services/cipher");
  const { reseauxSociauxEstConfigure, publierSurPlateformes } = await import("../src/services/reseauxSociaux");
  const { buildConsentUrl, obtenirConnexionMeta } = await import("../src/services/metaAuth");
  const {
    creerPropositionPost,
    listerPropositionsPost,
    accepterPropositionPost,
    refuserPropositionPost,
    appliquerPropositionPost,
  } = await import("../src/services/reseauxSociauxActions");
  const prisma = new PrismaClient();

  await t.test("reseauxSociauxEstConfigure : false si une variable Meta manque, true si toutes presentes", () => {
    const sauvegarde = { id: process.env.META_APP_ID, secret: process.env.META_APP_SECRET, redirect: process.env.META_REDIRECT_URI };
    try {
      delete process.env.META_APP_ID;
      delete process.env.META_APP_SECRET;
      delete process.env.META_REDIRECT_URI;
      assert.equal(reseauxSociauxEstConfigure(), false);

      process.env.META_APP_ID = "id-test";
      process.env.META_APP_SECRET = "secret-test";
      process.env.META_REDIRECT_URI = "http://localhost:3000/auth/meta/callback";
      assert.equal(reseauxSociauxEstConfigure(), true);
    } finally {
      for (const [cle, valeur] of Object.entries({
        META_APP_ID: sauvegarde.id,
        META_APP_SECRET: sauvegarde.secret,
        META_REDIRECT_URI: sauvegarde.redirect,
      })) {
        if (valeur === undefined) delete process.env[cle];
        else process.env[cle] = valeur;
      }
    }
  });

  await t.test("buildConsentUrl : erreur explicite si META_APP_ID/META_REDIRECT_URI absentes", () => {
    const sauvegarde = { id: process.env.META_APP_ID, redirect: process.env.META_REDIRECT_URI };
    try {
      delete process.env.META_APP_ID;
      delete process.env.META_REDIRECT_URI;
      assert.throws(() => buildConsentUrl(), /META_APP_ID manquante/);
    } finally {
      if (sauvegarde.id !== undefined) process.env.META_APP_ID = sauvegarde.id;
      if (sauvegarde.redirect !== undefined) process.env.META_REDIRECT_URI = sauvegarde.redirect;
    }
  });

  await t.test("buildConsentUrl : URL de consentement valide une fois configure", () => {
    const sauvegarde = { id: process.env.META_APP_ID, redirect: process.env.META_REDIRECT_URI };
    try {
      process.env.META_APP_ID = "id-test";
      process.env.META_REDIRECT_URI = "http://localhost:3000/auth/meta/callback";
      const url = buildConsentUrl();
      assert.match(url, /^https:\/\/www\.facebook\.com\/v21\.0\/dialog\/oauth\?/);
      assert.match(url, /client_id=id-test/);
      assert.match(url, /instagram_content_publish/);
    } finally {
      for (const [cle, valeur] of Object.entries({ META_APP_ID: sauvegarde.id, META_REDIRECT_URI: sauvegarde.redirect })) {
        if (valeur === undefined) delete process.env[cle];
        else process.env[cle] = valeur;
      }
    }
  });

  await t.test("obtenirConnexionMeta : null si aucune Page connectee", async () => {
    await prisma.connexionMeta.deleteMany({});
    assert.equal(await obtenirConnexionMeta(prisma), null);
  });

  await t.test("obtenirConnexionMeta : dechiffre le jeton de Page une fois connecte", async () => {
    await prisma.connexionMeta.deleteMany({});
    await prisma.connexionMeta.create({
      data: {
        pageId: "page-123",
        pageNom: "Atelier Brochant",
        pageAccessTokenChiffre: chiffrer("jeton-clair-page"),
        instagramBusinessAccountId: "ig-456",
        instagramUsername: "atelierbrochant",
      },
    });
    const connexion = await obtenirConnexionMeta(prisma);
    assert.ok(connexion);
    assert.equal(connexion?.pageAccessToken, "jeton-clair-page");
    assert.equal(connexion?.instagramUsername, "atelierbrochant");
  });

  await t.test("publierSurPlateformes : erreur explicite si aucune Page connectee", async () => {
    await prisma.connexionMeta.deleteMany({});
    await assert.rejects(publierSurPlateformes(prisma, ["FACEBOOK"], "Texte", undefined), /aucune Page connectee/);
  });

  await t.test("creerPropositionPost : rejette l'absence de plateforme valide", async () => {
    await assert.rejects(
      creerPropositionPost(prisma, { plateformes: [], texte: "Texte", justification: "test" }),
      /au moins une plateforme valide/
    );
    await assert.rejects(
      creerPropositionPost(prisma, { plateformes: ["TIKTOK"], texte: "Texte", justification: "test" }),
      /au moins une plateforme valide/
    );
  });

  await t.test("creerPropositionPost : rejette un texte manquant", async () => {
    await assert.rejects(creerPropositionPost(prisma, { plateformes: ["FACEBOOK"], texte: "", justification: "test" }), /texte manquant/);
  });

  await t.test("creerPropositionPost : Instagram exige une photo", async () => {
    await assert.rejects(
      creerPropositionPost(prisma, { plateformes: ["INSTAGRAM"], texte: "Texte", justification: "test" }),
      /cheminMedia manquant/
    );
  });

  await t.test("creerPropositionPost : cree bien une proposition en_attente, listee ensuite", async () => {
    await prisma.propositionPost.deleteMany({});
    const proposition = await creerPropositionPost(prisma, {
      plateformes: ["FACEBOOK"],
      texte: "Nouvelle serrure posee ce matin !",
      justification: "Actualite du jour",
    });
    assert.equal(proposition.statut, "en_attente");

    const liste = await listerPropositionsPost(prisma);
    assert.equal(liste.length, 1);
    assert.equal(liste[0].id, proposition.id);
  });

  await t.test("appliquerPropositionPost : refuse une proposition qui n'est pas acceptee", async () => {
    await prisma.propositionPost.deleteMany({});
    const proposition = await creerPropositionPost(prisma, { plateformes: ["FACEBOOK"], texte: "Texte", justification: "test" });
    await assert.rejects(appliquerPropositionPost(prisma, proposition.id), /pas "acceptee"/);
  });

  await t.test("accepterPropositionPost : passe a echec si aucune Page Meta n'est connectee (jamais de publication fantome)", async () => {
    await prisma.connexionMeta.deleteMany({});
    await prisma.propositionPost.deleteMany({});
    const proposition = await creerPropositionPost(prisma, { plateformes: ["FACEBOOK"], texte: "Texte", justification: "test" });
    const resultat = await accepterPropositionPost(prisma, proposition.id);
    assert.equal(resultat.statut, "echec");
    assert.match(resultat.erreur ?? "", /aucune Page connectee/);
  });

  await t.test("refuserPropositionPost : passe a refusee sans jamais publier", async () => {
    await prisma.propositionPost.deleteMany({});
    const proposition = await creerPropositionPost(prisma, { plateformes: ["FACEBOOK"], texte: "Texte", justification: "test" });
    const resultat = await refuserPropositionPost(prisma, proposition.id);
    assert.equal(resultat.statut, "refusee");
    assert.ok(resultat.decideLe);
  });

  await t.test("accepterPropositionPost : passe a echec si PUBLIC_BASE_URL manquante alors qu'une photo est jointe", async () => {
    await prisma.connexionMeta.deleteMany({});
    await prisma.connexionMeta.create({
      data: { pageId: "page-123", pageNom: "Atelier Brochant", pageAccessTokenChiffre: chiffrer("jeton-clair-page") },
    });
    await prisma.propositionPost.deleteMany({});
    const sauvegarde = process.env.PUBLIC_BASE_URL;
    delete process.env.PUBLIC_BASE_URL;
    try {
      const proposition = await creerPropositionPost(prisma, {
        plateformes: ["FACEBOOK"],
        texte: "Texte",
        cheminMedia: "media-publics/photo-test.jpg",
        justification: "test",
      });
      const resultat = await accepterPropositionPost(prisma, proposition.id);
      assert.equal(resultat.statut, "echec");
      assert.match(resultat.erreur ?? "", /PUBLIC_BASE_URL manquante/);
    } finally {
      if (sauvegarde !== undefined) process.env.PUBLIC_BASE_URL = sauvegarde;
    }
  });

  await prisma.$disconnect();
});
