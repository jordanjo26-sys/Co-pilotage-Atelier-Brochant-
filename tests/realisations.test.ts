import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
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
process.env.PUBLIC_BASE_URL = "https://copilotage-brochant.fr";

const DOSSIER_REALISATIONS = path.join(__dirname, "..", "public", "media-publics", "realisations");

test("Module Réalisations", async (t) => {
  execSync("npx prisma db push --force-reset --skip-generate", {
    cwd: path.join(__dirname, ".."),
    env: process.env,
    stdio: "pipe",
  });

  const { PrismaClient } = await import("@prisma/client");
  const {
    assurerActivitesRealisations,
    listerActivitesRealisations,
    modifierEmailActiviteRealisation,
    ActiviteRealisationError,
    ajouterPhotosRealisation,
    listerPhotosRealisation,
    supprimerPhotoRealisation,
    construireGaleriePageHtml,
    envoyerDigestHebdomadaireRealisations,
  } = await import("../src/services/realisations");
  const prisma = new PrismaClient();
  const fichiersEcrits: string[] = [];

  await t.test("assurerActivitesRealisations : crée les deux activités une seule fois, avec les bonnes adresses", async () => {
    await assurerActivitesRealisations(prisma);
    const activites = await listerActivitesRealisations(prisma);
    assert.equal(activites.length, 2);
    const brochant = activites.find((a) => a.nom === "Atelier Brochant");
    const degorgement = activites.find((a) => a.nom === "France Dégorgement");
    assert.equal(brochant?.email, "hello@jonathanhauet.fr");
    assert.equal(degorgement?.email, "stephane.fosseries@sylapps.com");
    assert.ok(brochant?.tokenGalerie && brochant.tokenGalerie.length >= 32, "jeton de galerie généré et suffisamment long");
    assert.notEqual(brochant?.tokenGalerie, degorgement?.tokenGalerie, "chaque activité a son propre jeton");

    // Rejoue l'appel : ne doit ni dupliquer, ni ecraser un email deja modifie.
    await modifierEmailActiviteRealisation(prisma, brochant!.id, "autre@exemple.fr");
    await assurerActivitesRealisations(prisma);
    const apresRejeu = await listerActivitesRealisations(prisma);
    assert.equal(apresRejeu.length, 2);
    assert.equal(apresRejeu.find((a) => a.nom === "Atelier Brochant")?.email, "autre@exemple.fr");
  });

  await t.test("modifierEmailActiviteRealisation : email invalide ou activité inexistante -> erreur", async () => {
    const [brochant] = await listerActivitesRealisations(prisma);
    await assert.rejects(modifierEmailActiviteRealisation(prisma, brochant.id, "pas-un-email"), ActiviteRealisationError);
    await assert.rejects(modifierEmailActiviteRealisation(prisma, "inexistant", "valide@exemple.fr"), ActiviteRealisationError);
  });

  await t.test("ajouterPhotosRealisation : écrit les fichiers, crée les documents, liste et supprime correctement", async () => {
    const [activite] = await listerActivitesRealisations(prisma);
    const photos = await ajouterPhotosRealisation(
      prisma,
      activite.id,
      [
        { buffer: Buffer.from("fausse-image-1"), mimetype: "image/jpeg" },
        { buffer: Buffer.from("fausse-image-2"), mimetype: "image/png" },
      ],
      "  Chantier Rue de la Paix  "
    );
    assert.equal(photos.length, 2);
    for (const p of photos) fichiersEcrits.push(path.join(DOSSIER_REALISATIONS, p.fichierNom));

    // chantierNom nettoyé (espaces en trop retirés).
    assert.equal(photos[0].chantierNom, "Chantier Rue de la Paix");

    for (const p of photos) {
      const contenu = await fs.readFile(path.join(DOSSIER_REALISATIONS, p.fichierNom));
      assert.ok(contenu.length > 0, "le fichier a bien été écrit sur disque");
    }

    const listees = await listerPhotosRealisation(prisma, activite.id);
    assert.equal(listees.length, 2);
    assert.equal(listees[0].activite.nom, activite.nom);

    await supprimerPhotoRealisation(prisma, photos[0].id);
    const apresSuppression = await listerPhotosRealisation(prisma, activite.id);
    assert.equal(apresSuppression.length, 1);
    await assert.rejects(fs.access(path.join(DOSSIER_REALISATIONS, photos[0].fichierNom)), "le fichier supprimé ne doit plus exister sur disque");

    await assert.rejects(supprimerPhotoRealisation(prisma, photos[0].id), ActiviteRealisationError);
  });

  await t.test("ajouterPhotosRealisation : activité inexistante ou aucun fichier -> erreur", async () => {
    await assert.rejects(ajouterPhotosRealisation(prisma, "inexistant", [{ buffer: Buffer.from("x"), mimetype: "image/jpeg" }]), ActiviteRealisationError);
    const [activite] = await listerActivitesRealisations(prisma);
    await assert.rejects(ajouterPhotosRealisation(prisma, activite.id, []), ActiviteRealisationError);
  });

  await t.test("construireGaleriePageHtml : affiche le chantier, et un message vide quand aucune photo", async () => {
    const activites = await listerActivitesRealisations(prisma);
    const degorgement = activites.find((a) => a.nom === "France Dégorgement")!;
    const pageVide = await construireGaleriePageHtml(prisma, degorgement);
    assert.match(pageVide, /Aucune photo pour le moment/);

    const brochant = activites.find((a) => a.nom === "Atelier Brochant")!;
    const page = await construireGaleriePageHtml(prisma, brochant);
    assert.match(page, /Chantier Rue de la Paix/);
    assert.match(page, /media-publics\/realisations\//);
  });

  await t.test("envoyerDigestHebdomadaireRealisations : rien de nouveau -> ignoré sans jamais contacter Gmail", async () => {
    const activites = await listerActivitesRealisations(prisma);
    const degorgement = activites.find((a) => a.nom === "France Dégorgement")!;
    // Aucune photo pour cette activite : doit etre ignore avant meme de
    // chercher une connexion Gmail (jamais testee ici, voir le commentaire
    // du fichier de test Reseaux sociaux - aucun jeton Gmail valide en test).
    await envoyerDigestHebdomadaireRealisations(prisma, new Date());
    const apres = await prisma.activiteRealisation.findUnique({ where: { id: degorgement.id } });
    assert.equal(apres?.derniereDigestEnvoyeeLe, null, "aucun envoi sans nouvelle photo");

    const evenement = await prisma.journalEvenement.findFirst({
      where: { evenement: "realisations_digest_non_envoye", action: { contains: "France Dégorgement" } },
      orderBy: { horodatage: "desc" },
    });
    assert.ok(evenement, "un evenement 'ignoré' doit être journalisé");
  });

  await t.test("envoyerDigestHebdomadaireRealisations : nouvelle photo sans Gmail connecté -> ignoré, jamais une erreur qui interrompt les autres activités", async () => {
    const activites = await listerActivitesRealisations(prisma);
    const degorgement = activites.find((a) => a.nom === "France Dégorgement")!;
    const photo = await ajouterPhotosRealisation(prisma, degorgement.id, [{ buffer: Buffer.from("fausse-image-3"), mimetype: "image/webp" }]);
    fichiersEcrits.push(path.join(DOSSIER_REALISATIONS, photo[0].fichierNom));

    await envoyerDigestHebdomadaireRealisations(prisma, new Date());

    const evenement = await prisma.journalEvenement.findFirst({
      where: { evenement: "realisations_digest_non_envoye", action: { contains: "France Dégorgement" } },
      orderBy: { horodatage: "desc" },
    });
    assert.match(evenement?.resultat || "", /aucune boîte Gmail active/i);
  });

  await prisma.$disconnect();
  await Promise.all(fichiersEcrits.map((f) => fs.unlink(f).catch(() => {})));
});
