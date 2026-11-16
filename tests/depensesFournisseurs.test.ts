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

let compteur = 0;
function ref(prefixe: string): string {
  compteur += 1;
  return `${prefixe}-${compteur}`;
}

test("depenses par fournisseur : regroupement, somme des montants HT/TTC, et comptage des montants manquants", async () => {
  const { PrismaClient } = await import("@prisma/client");
  const { obtenirDepensesFournisseurs } = await import("../src/services/depensesFournisseurs");
  const prisma = new PrismaClient();

  const cedeo = await prisma.fournisseur.create({ data: { nom: ref("Cedeo") } });

  async function facture(fournisseurId: string, dateReceptionMail: Date, montantHT: number | null, montantTTC: number | null) {
    return prisma.documentFournisseur.create({
      data: { type: "facture", fournisseurId, montantHT, montantTTC, hashFichier: ref("hash"), dateReceptionMail },
    });
  }

  await facture(cedeo.id, new Date("2026-03-05"), 80, 100);
  await facture(cedeo.id, new Date("2026-03-20"), 40, 50);
  // Montant TTC manquant mais HT connu (ou l'inverse) : chaque montant compte independamment dans son propre nombreSansMontant*.
  await facture(cedeo.id, new Date("2026-03-25"), 60, null);
  // Mois different : groupe separe.
  await facture(cedeo.id, new Date("2026-04-10"), 160, 200);

  const parMois = await obtenirDepensesFournisseurs(prisma, { granularite: "mois" });
  const mars = parMois.find((d) => d.periode === "2026-03" && d.fournisseurId === cedeo.id);
  const avril = parMois.find((d) => d.periode === "2026-04" && d.fournisseurId === cedeo.id);

  assert.ok(mars, "le groupe de mars doit exister");
  assert.equal(mars!.totalHT, 180);
  assert.equal(mars!.totalTTC, 150);
  assert.equal(mars!.nombreFactures, 3);
  assert.equal(mars!.nombreSansMontantHT, 0);
  assert.equal(mars!.nombreSansMontantTTC, 1);
  assert.equal(mars!.fournisseurNom, cedeo.nom);

  assert.ok(avril, "le groupe d'avril doit exister");
  assert.equal(avril!.totalHT, 160);
  assert.equal(avril!.totalTTC, 200);
  assert.equal(avril!.nombreSansMontantHT, 0);
  assert.equal(avril!.nombreSansMontantTTC, 0);

  const parAnnee = await obtenirDepensesFournisseurs(prisma, { granularite: "annee" });
  const annee2026 = parAnnee.find((d) => d.periode === "2026" && d.fournisseurId === cedeo.id);
  assert.ok(annee2026, "le groupe de l'annee doit exister");
  assert.equal(annee2026!.totalHT, 340);
  assert.equal(annee2026!.totalTTC, 350);

  const filtre = await obtenirDepensesFournisseurs(prisma, {
    granularite: "mois",
    debut: new Date("2026-04-01"),
  });
  assert.equal(filtre.some((d) => d.periode === "2026-03"), false, "mars doit etre exclu par le filtre 'debut'");
  assert.equal(filtre.some((d) => d.periode === "2026-04"), true);
});

test("depenses par fournisseur : type different de 'facture' (devis, avoir...) ignore", async () => {
  const { PrismaClient } = await import("@prisma/client");
  const { obtenirDepensesFournisseurs } = await import("../src/services/depensesFournisseurs");
  const prisma = new PrismaClient();

  const f = await prisma.fournisseur.create({ data: { nom: ref("AutreFournisseur") } });
  await prisma.documentFournisseur.create({
    data: {
      type: "devis",
      fournisseurId: f.id,
      montantHT: 999,
      montantTTC: 999,
      hashFichier: ref("hash"),
      dateReceptionMail: new Date("2026-05-01"),
    },
  });

  const resultat = await obtenirDepensesFournisseurs(prisma, { granularite: "mois" });
  assert.equal(
    resultat.some((d) => d.fournisseurId === f.id),
    false,
    "un devis ne doit jamais compter dans les depenses"
  );
});
