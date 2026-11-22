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

const CLES_OVH = ["OVH_ENDPOINT", "OVH_APPLICATION_KEY", "OVH_APPLICATION_SECRET", "OVH_CONSUMER_KEY"] as const;

function nettoyerClesOvh(): Record<string, string | undefined> {
  const sauvegarde: Record<string, string | undefined> = {};
  for (const cle of CLES_OVH) {
    sauvegarde[cle] = process.env[cle];
    delete process.env[cle];
  }
  return sauvegarde;
}

function restaurerClesOvh(sauvegarde: Record<string, string | undefined>): void {
  for (const cle of CLES_OVH) {
    if (sauvegarde[cle] !== undefined) process.env[cle] = sauvegarde[cle];
    else delete process.env[cle];
  }
}

test("ovhEstConfigure / verifierConnexionOvh : aucune cle configuree -> non connecte avec motif explicite", async () => {
  const sauvegarde = nettoyerClesOvh();
  try {
    const { ovhEstConfigure, verifierConnexionOvh } = await import("../src/services/ovhFacturation");
    assert.equal(ovhEstConfigure(), false);
    const resultat = await verifierConnexionOvh();
    assert.equal(resultat.ok, false);
    if (!resultat.ok) assert.match(resultat.motif, /ovh non configure/i);
  } finally {
    restaurerClesOvh(sauvegarde);
  }
});

test("Module OVHcloud — synchronisation des factures", async (t) => {
  execSync("npx prisma db push --force-reset --skip-generate", {
    cwd: path.join(__dirname, ".."),
    env: process.env,
    stdio: "pipe",
  });

  const sauvegardeOvh = nettoyerClesOvh();
  Object.assign(process.env, {
    OVH_ENDPOINT: "ovh-eu",
    OVH_APPLICATION_KEY: "cle-app-test",
    OVH_APPLICATION_SECRET: "secret-app-test",
    OVH_CONSUMER_KEY: "cle-conso-test",
  });

  const { PrismaClient } = await import("@prisma/client");
  const { synchroniserOvh, derniereSynchroOvh } = await import("../src/services/ovhFacturation");
  const prisma = new PrismaClient();

  t.after(async () => {
    await prisma.$disconnect();
    restaurerClesOvh(sauvegardeOvh);
  });

  // Facture "ancienne" (deja connue du compte OVH avant la premiere
  // synchronisation) et facture "nouvelle" (emise apres) - demande
  // explicite de l'utilisateur : seule la seconde doit etre importee.
  const factureAncienne = {
    billId: "FR-ANCIENNE-1",
    date: "2016-01-15T10:00:00+01:00",
    pdfUrl: "https://exemple.invalide/ancienne.pdf",
    priceWithTax: { value: 12, text: "12,00 €", currencyCode: "EUR" },
    priceWithoutTax: { value: 10, text: "10,00 €", currencyCode: "EUR" },
  };
  const factureFutureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const factureNouvelle = {
    billId: "FR-NOUVELLE-1",
    date: factureFutureDate,
    pdfUrl: "https://exemple.invalide/nouvelle.pdf",
    priceWithTax: { value: 120, text: "120,00 €", currencyCode: "EUR" },
    priceWithoutTax: { value: 100, text: "100,00 €", currencyCode: "EUR" },
  };

  const fetchOrigine = globalThis.fetch;
  let appelsPdf = 0;
  globalThis.fetch = (async (url: unknown) => {
    const cible = String(url);
    if (cible.endsWith("/auth/time")) {
      return new Response(String(Math.floor(Date.now() / 1000)), { status: 200 });
    }
    if (cible.endsWith("/me/bill")) {
      return new Response(JSON.stringify([factureAncienne.billId, factureNouvelle.billId]), { status: 200 });
    }
    if (cible.includes(encodeURIComponent(factureAncienne.billId))) {
      return new Response(JSON.stringify(factureAncienne), { status: 200 });
    }
    if (cible.includes(encodeURIComponent(factureNouvelle.billId))) {
      return new Response(JSON.stringify(factureNouvelle), { status: 200 });
    }
    if (cible === factureNouvelle.pdfUrl || cible === factureAncienne.pdfUrl) {
      appelsPdf++;
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }
    throw new Error(`URL inattendue dans le test : ${cible}`);
  }) as typeof fetch;

  try {
    await t.test("premiere synchronisation : la facture anterieure a la connexion n'est jamais importee", async () => {
      const resultat = await synchroniserOvh(prisma);
      assert.equal(resultat.erreurs.length, 0);
      assert.equal(resultat.facturesNouvelles, 1); // seule factureNouvelle

      const archives = await prisma.archiveComptable.findMany({ where: { fournisseurNom: "OVHcloud" } });
      assert.equal(archives.length, 1);
      assert.equal(archives[0].numero, factureNouvelle.billId);
      assert.equal(archives[0].montantHT, 100);
      assert.equal(archives[0].montantTTC, 120);
      assert.equal(archives[0].statut, "complete");
      assert.equal(archives[0].classifiePar, "ovh_api");
      assert.equal(appelsPdf, 1); // jamais telecharge le PDF de la facture ancienne, ignoree avant meme ce telechargement

      const derniere = await derniereSynchroOvh(prisma);
      assert.ok(derniere);
    });

    await t.test("deuxieme synchronisation : aucune nouvelle facture -> pas de doublon", async () => {
      const resultat = await synchroniserOvh(prisma);
      assert.equal(resultat.facturesNouvelles, 0);
      const archives = await prisma.archiveComptable.findMany({ where: { fournisseurNom: "OVHcloud" } });
      assert.equal(archives.length, 1); // toujours une seule, jamais dupliquee
    });
  } finally {
    globalThis.fetch = fetchOrigine;
  }
});
