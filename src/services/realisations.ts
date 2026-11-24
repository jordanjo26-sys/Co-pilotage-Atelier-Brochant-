import { PrismaClient, ActiviteRealisation, PhotoRealisation } from "@prisma/client";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import MailComposer from "nodemailer/lib/mail-composer";
import { getGmailClient } from "./googleAuth";
import { construireEmailHtml } from "./emailFormat";
import { logEvenement } from "./journalService";

/**
 * Module Realisations (demande explicite de l'utilisateur, novembre 2026) :
 * il envoyait a la main par WhatsApp des photos de chantiers a deux
 * prestataires externes (Google Maps/avis, site/referencement), en
 * choisissant a chaque fois dans son album photo qui devait recevoir quoi -
 * fastidieux et repetitif. Remplace par un upload unique depuis l'app
 * (ajouterPhotosRealisation) puis un envoi hebdomadaire automatique (voir
 * scheduler.ts) d'un lien de galerie - jamais les photos elles-memes en
 * piece jointe (demande explicite : un lien plutot que des pieces jointes,
 * plus pratique avec beaucoup de photos).
 *
 * Une ActiviteRealisation par corps de metier (les deux memes marques que
 * dans Synec : "Atelier Brochant" et "France Dégorgement", chacune son
 * propre prestataire/e-mail) : chaque photo est rattachee a une seule
 * activite, jamais envoyee aux deux prestataires a la fois.
 */

export class ActiviteRealisationError extends Error {}

// Valeurs de depart (fournies explicitement par l'utilisateur, novembre
// 2026) - creees une seule fois si la table est vide ; modifiables ensuite
// dans l'application (modifierEmailActiviteRealisation), jamais ecrasees
// par ce seed au redemarrage du serveur (skipDuplicates sur le nom unique).
const ACTIVITES_PAR_DEFAUT = [
  { nom: "Atelier Brochant", email: "hello@jonathanhauet.fr" },
  { nom: "France Dégorgement", email: "stephane.fosseries@sylapps.com" },
];

export async function assurerActivitesRealisations(prisma: PrismaClient): Promise<void> {
  await prisma.activiteRealisation.createMany({
    data: ACTIVITES_PAR_DEFAUT.map((a) => ({ ...a, tokenGalerie: crypto.randomBytes(24).toString("hex") })),
    skipDuplicates: true,
  });
}

export async function listerActivitesRealisations(
  prisma: PrismaClient
): Promise<(ActiviteRealisation & { _count: { photos: number } })[]> {
  await assurerActivitesRealisations(prisma);
  return prisma.activiteRealisation.findMany({ orderBy: { nom: "asc" }, include: { _count: { select: { photos: true } } } });
}

const MOTIF_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function modifierEmailActiviteRealisation(prisma: PrismaClient, id: string, email: string): Promise<void> {
  if (!MOTIF_EMAIL.test(email)) throw new ActiviteRealisationError("Adresse e-mail invalide.");
  const activite = await prisma.activiteRealisation.findUnique({ where: { id } });
  if (!activite) throw new ActiviteRealisationError("Activité introuvable.");
  await prisma.activiteRealisation.update({ where: { id }, data: { email } });
}

// Memes types/limite que le module Reseaux sociaux (reseauxSociauxRoutes.ts) :
// coherent avec le reste de l'application, pas de raison d'etre plus
// permissif ici.
export const TYPES_IMAGE_REALISATIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const DOSSIER_REALISATIONS = path.join(process.cwd(), "public", "media-publics", "realisations");

export async function ajouterPhotosRealisation(
  prisma: PrismaClient,
  activiteId: string,
  // "path" (fichier deja ecrit sur disque par multer, voir
  // buildRealisationsRouter - diskStorage, pas memoryStorage) plutot qu'un
  // buffer en memoire : evite d'accumuler potentiellement plusieurs
  // centaines de Mo en RAM sur un lot de photos de telephone.
  fichiers: { path: string; mimetype: string }[],
  chantierNom?: string
): Promise<PhotoRealisation[]> {
  const activite = await prisma.activiteRealisation.findUnique({ where: { id: activiteId } });
  if (!activite) throw new ActiviteRealisationError("Activité introuvable.");
  if (fichiers.length === 0) throw new ActiviteRealisationError("Aucune photo reçue.");

  await fs.mkdir(DOSSIER_REALISATIONS, { recursive: true });
  const chantier = chantierNom?.trim() || null;
  const crees: PhotoRealisation[] = [];
  for (const fichier of fichiers) {
    const extension = TYPES_IMAGE_REALISATIONS[fichier.mimetype];
    if (!extension) {
      await fs.unlink(fichier.path).catch(() => {});
      continue; // deja filtre par multer en amont (voir buildRealisationsRouter) - defensif ici seulement
    }
    const nomFichier = `${crypto.randomUUID()}.${extension}`;
    const destination = path.join(DOSSIER_REALISATIONS, nomFichier);
    try {
      await fs.rename(fichier.path, destination);
    } catch {
      // Repertoire temporaire sur un autre point de montage que
      // DOSSIER_REALISATIONS (rename impossible entre volumes) : repli sur
      // une copie, puis nettoyage du temporaire.
      await fs.copyFile(fichier.path, destination);
      await fs.unlink(fichier.path).catch(() => {});
    }
    crees.push(await prisma.photoRealisation.create({ data: { activiteId, fichierNom: nomFichier, chantierNom: chantier } }));
  }
  return crees;
}

export async function listerPhotosRealisation(
  prisma: PrismaClient,
  activiteId?: string
): Promise<(PhotoRealisation & { activite: { nom: string } })[]> {
  return prisma.photoRealisation.findMany({
    where: activiteId ? { activiteId } : undefined,
    include: { activite: { select: { nom: true } } },
    orderBy: { createdAt: "desc" },
    take: 300,
  });
}

export async function supprimerPhotoRealisation(prisma: PrismaClient, id: string): Promise<void> {
  const photo = await prisma.photoRealisation.findUnique({ where: { id } });
  if (!photo) throw new ActiviteRealisationError("Photo introuvable.");
  await prisma.photoRealisation.delete({ where: { id } });
  await fs.unlink(path.join(DOSSIER_REALISATIONS, photo.fichierNom)).catch(() => {});
}

export async function obtenirActiviteParToken(prisma: PrismaClient, token: string): Promise<ActiviteRealisation | null> {
  return prisma.activiteRealisation.findUnique({ where: { tokenGalerie: token } });
}

function echapperHtmlRealisations(texte: string): string {
  return String(texte).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

/**
 * Page de galerie publique (demande explicite : un lien, pas des pieces
 * jointes) - sans mot de passe (le prestataire externe n'a pas les
 * identifiants du site), protegee uniquement par le jeton imprevisible
 * dans l'URL. Necessite une exception nginx dediee (voir bootstrap.sh,
 * meme principe que /media-publics/ deja exempte pour Facebook/Instagram) :
 * la page elle-meme ET les images qu'elle affiche (deja sous
 * /media-publics/, exemptees) doivent etre joignables sans authentification
 * basique.
 */
export async function construireGaleriePageHtml(prisma: PrismaClient, activite: ActiviteRealisation): Promise<string> {
  const photos = await prisma.photoRealisation.findMany({
    where: { activiteId: activite.id },
    orderBy: { createdAt: "desc" },
    take: 300,
  });

  const groupes = new Map<string, typeof photos>();
  for (const p of photos) {
    const cle = p.createdAt.toLocaleDateString("fr-FR", { day: "2-digit", month: "long", year: "numeric" });
    if (!groupes.has(cle)) groupes.set(cle, []);
    groupes.get(cle)!.push(p);
  }

  const sections = [...groupes.entries()]
    .map(
      ([date, docs]) => `
    <section>
      <h2>${echapperHtmlRealisations(date)}</h2>
      <div class="grille">
        ${docs
          .map((p) => {
            const url = `/media-publics/realisations/${encodeURIComponent(p.fichierNom)}`;
            return `
          <a class="photo" href="${url}" download target="_blank" rel="noopener">
            <img src="${url}" loading="lazy" alt="${echapperHtmlRealisations(p.chantierNom || "Réalisation")}" />
            ${p.chantierNom ? `<span>${echapperHtmlRealisations(p.chantierNom)}</span>` : ""}
          </a>`;
          })
          .join("")}
      </div>
    </section>`
    )
    .join("");

  return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex, nofollow" />
  <title>Réalisations — ${echapperHtmlRealisations(activite.nom)}</title>
  <style>
    :root { color-scheme: light; }
    body { margin:0; font-family:'IBM Plex Sans',Arial,Helvetica,sans-serif; background:#F3F6FB; color:#16213E; }
    header { padding:20px 16px; background:#FFFFFF; border-bottom:1px solid #E2E7F1; }
    header h1 { margin:0; font-size:18px; }
    header p { margin:4px 0 0; font-size:13px; color:#78829C; }
    main { max-width:960px; margin:0 auto; padding:16px; }
    section { margin-bottom:24px; }
    section h2 { font-size:14px; color:#3D4A6B; margin:0 0 10px; }
    .grille { display:grid; grid-template-columns:repeat(auto-fill, minmax(140px, 1fr)); gap:10px; }
    .photo { display:block; border-radius:10px; overflow:hidden; background:#fff; border:1px solid #E2E7F1; text-decoration:none; color:#3D4A6B; }
    .photo img { width:100%; height:140px; object-fit:cover; display:block; }
    .photo span { display:block; padding:6px 8px; font-size:11.5px; }
    .vide { text-align:center; color:#78829C; padding:40px 16px; }
  </style>
</head>
<body>
  <header>
    <h1>Réalisations — ${echapperHtmlRealisations(activite.nom)}</h1>
    <p>Photos de chantiers, les plus récentes en premier. Cliquez une photo pour l'ouvrir/la télécharger.</p>
  </header>
  <main>
    ${sections || `<p class="vide">Aucune photo pour le moment.</p>`}
  </main>
</body>
</html>`;
}

function construireUrlGalerie(token: string): string {
  const base = process.env.PUBLIC_BASE_URL;
  if (!base) {
    throw new Error("PUBLIC_BASE_URL manquante dans .env (ex. https://copilotage-brochant.fr) - necessaire pour construire le lien de galerie.");
  }
  return `${base.replace(/\/$/, "")}/galerie-realisations/${token}`;
}

/**
 * Envoie, pour chaque activite, le lien de galerie au prestataire externe
 * concerne si au moins une nouvelle photo a ete ajoutee depuis le dernier
 * envoi reussi (derniereDigestEnvoyeeLe) - jamais de rappel si rien de
 * nouveau, pour ne jamais noyer le prestataire d'e-mails vides. Chaque
 * activite est traitee independamment (une erreur sur l'une n'empeche
 * jamais l'envoi pour l'autre).
 */
export async function envoyerDigestHebdomadaireRealisations(prisma: PrismaClient, maintenant: Date = new Date()): Promise<void> {
  await assurerActivitesRealisations(prisma);
  const activites = await prisma.activiteRealisation.findMany();

  for (const activite of activites) {
    try {
      const depuis = activite.derniereDigestEnvoyeeLe ?? new Date(0);
      const nouvellesPhotos = await prisma.photoRealisation.findMany({
        where: { activiteId: activite.id, createdAt: { gt: depuis } },
      });

      if (nouvellesPhotos.length === 0) {
        await logEvenement(prisma, {
          evenement: "realisations_digest_non_envoye",
          action: `Digest hebdomadaire réalisations — ${activite.nom}`,
          resultat: "Ignoré : aucune nouvelle photo depuis le dernier envoi.",
        });
        continue;
      }

      const connexionGmail = await getGmailClient(prisma);
      if (!connexionGmail) {
        await logEvenement(prisma, {
          evenement: "realisations_digest_non_envoye",
          action: `Digest hebdomadaire réalisations — ${activite.nom}`,
          resultat: "Ignoré : aucune boîte Gmail active (reconnexion nécessaire via /auth/google).",
        });
        continue;
      }
      const { gmail } = connexionGmail;

      const urlGalerie = construireUrlGalerie(activite.tokenGalerie);
      const chantiers = [...new Set(nouvellesPhotos.map((p) => p.chantierNom).filter((c): c is string => !!c))];
      const sujet = `${nouvellesPhotos.length} nouvelle(s) photo(s) de réalisations — ${activite.nom}`;
      const corpsMarkdown = `${nouvellesPhotos.length} nouvelle(s) photo(s) cette semaine pour ${activite.nom}${
        chantiers.length > 0 ? ` (${chantiers.join(", ")})` : ""
      }.`;

      const composer = new MailComposer({
        to: activite.email,
        subject: sujet,
        text: `${corpsMarkdown}\n\nVoir la galerie : ${urlGalerie}`,
        html: construireEmailHtml({ titre: sujet, corpsMarkdown, lien: { texte: "Voir la galerie", url: urlGalerie } }),
      });
      const message = await composer.compile().build();
      await gmail.users.messages.send({ userId: "me", requestBody: { raw: message.toString("base64url") } });

      await prisma.activiteRealisation.update({ where: { id: activite.id }, data: { derniereDigestEnvoyeeLe: maintenant } });
      await logEvenement(prisma, {
        evenement: "realisations_digest_envoye",
        action: `Digest hebdomadaire réalisations — ${activite.nom} envoyé à ${activite.email}`,
        resultat: `${nouvellesPhotos.length} photo(s).`,
      });
    } catch (err) {
      await logEvenement(prisma, {
        evenement: "realisations_digest_erreur",
        action: `Digest hebdomadaire réalisations — ${activite.nom}`,
        resultat: `Échec : ${(err as Error).message}`,
      }).catch(() => {});
    }
  }
}
