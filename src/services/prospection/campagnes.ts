import { Campagne, EmailTemplate, Prisma, PrismaClient, Prospect } from "@prisma/client";
import MailComposer from "nodemailer/lib/mail-composer";
import { getGmailClient } from "../googleAuth";
import { logEvenement } from "../journalService";

/**
 * Module de campagnes (section 2.4 du cahier des charges prospection).
 *
 * L'envoi effectif reutilise la boite Gmail deja connectee pour la gestion
 * (section 7 de l'autre cahier des charges) plutot qu'un fournisseur tiers
 * (Brevo/Mailjet - section 4) : evite un abonnement supplementaire pour
 * demarrer, au prix d'un volume plus limite (quota Gmail) - a reconsiderer
 * avec le developpeur si le volume mensuel vise le justifie (point 7).
 *
 * Dans le meme esprit de prudence que src/services/relances.ts (jamais
 * d'envoi de masse declenche automatiquement) : le premier envoi d'une
 * campagne et chaque relance restent un geste humain volontaire (un clic),
 * le moteur se contentant de determiner QUI est du (listerProspectsDus /
 * listerRelancesDues), jamais d'envoyer de lui-meme.
 */

const VARIABLE_PATTERN = /\{\{\s*(contact|entreprise|marque|service)\s*\}\}/g;

const LIBELLE_MARQUE: Record<string, string> = {
  france_degorgement: "France Dégorgement",
  atelier_brochant: "Atelier Brochant",
};

function appUrl(): string {
  return (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
}

function quotaQuotidien(): number {
  return Number(process.env.PROSPECTION_ENVOI_QUOTIDIEN_MAX) || 50;
}

function rendre(texte: string, prospect: Prospect): string {
  return texte.replace(VARIABLE_PATTERN, (_match, variable: string) => {
    switch (variable) {
      case "contact":
        return prospect.contactNom || prospect.entreprise;
      case "entreprise":
        return prospect.entreprise;
      case "marque":
        return LIBELLE_MARQUE[prospect.marqueProposee || ""] || prospect.marqueProposee || "";
      case "service":
        return prospect.serviceCible || "";
      default:
        return "";
    }
  });
}

/** Reecrit chaque lien du corps pour tracer les clics (section 2.5), avant d'ajouter pixel et desabonnement. */
function tracerLiens(corpsHtml: string, token: string): string {
  return corpsHtml.replace(/href="([^"]+)"/g, (_match, url: string) => {
    const cible = `${appUrl()}/api/prospection/suivi/clic/${token}?u=${encodeURIComponent(url)}`;
    return `href="${cible}"`;
  });
}

/** Compose le HTML final envoye : corps avec liens traces, pixel d'ouverture, lien de desabonnement obligatoire (RGPD, section 3). */
function composerCorps(corpsHtml: string, token: string): string {
  const pixel = `<img src="${appUrl()}/api/prospection/suivi/ouverture/${token}.png" width="1" height="1" alt="" style="display:none" />`;
  const desabonnement =
    `<p style="font-size:12px;color:#666;margin-top:24px">` +
    `Atelier Brochant / France Dégorgement — pour ne plus recevoir ces messages, ` +
    `<a href="${appUrl()}/api/prospection/suivi/desabonnement/${token}">cliquez ici pour vous désinscrire</a>.</p>`;
  return `${tracerLiens(corpsHtml, token)}${desabonnement}${pixel}`;
}

export interface SegmentFiltre {
  type?: string;
  statut?: string;
  codePostal?: string; // prefixe (ex. "77" pour Seine-et-Marne)
  marqueProposee?: string;
}

function segmentWhere(filtre: SegmentFiltre): Prisma.ProspectWhereInput {
  const where: Prisma.ProspectWhereInput = {
    desinscrit: false,
    email: { not: null },
  };
  if (filtre.type) where.type = filtre.type;
  if (filtre.statut) where.statut = filtre.statut;
  if (filtre.marqueProposee) where.marqueProposee = filtre.marqueProposee;
  if (filtre.codePostal) where.codePostal = { startsWith: filtre.codePostal };
  return where;
}

/** Prospects du segment n'ayant encore jamais reçu cette campagne. */
export async function listerProspectsDus(prisma: PrismaClient, campagneId: string): Promise<Prospect[]> {
  const campagne = await prisma.campagne.findUniqueOrThrow({ where: { id: campagneId } });
  const filtre: SegmentFiltre = JSON.parse(campagne.segmentFiltre);

  return prisma.prospect.findMany({
    where: { ...segmentWhere(filtre), envois: { none: { campagneId } } },
    orderBy: { createdAt: "asc" },
  });
}

async function envoyerMail(prisma: PrismaClient, prospectEmail: string, objet: string, corpsHtml: string) {
  const connexionGmail = await getGmailClient(prisma);
  if (!connexionGmail) throw new Error("Aucune boite Gmail connectee (voir /auth/google).");
  const { gmail } = connexionGmail;

  const composer = new MailComposer({ to: prospectEmail, subject: objet, html: corpsHtml });
  const message = await composer.compile().build();
  const raw = message.toString("base64url");
  const envoi = await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
  return { messageId: envoi.data.id ?? null, threadId: envoi.data.threadId ?? null };
}

/**
 * Envoie la campagne aux prospects du segment pas encore contactes,
 * jusqu'au quota quotidien (PROSPECTION_ENVOI_QUOTIDIEN_MAX - section 3 :
 * "limitation du volume d'envoi quotidien pour preserver la delivrabilite").
 * Geste humain volontaire (voir en-tete du fichier) : jamais planifie tout
 * seul.
 */
export async function envoyerCampagne(prisma: PrismaClient, campagneId: string): Promise<{ nbEnvoyes: number; nbEchecs: number }> {
  const campagne = await prisma.campagne.findUniqueOrThrow({ where: { id: campagneId }, include: { template: true } });

  if (!(await getGmailClient(prisma))) {
    throw new Error("Aucune boite Gmail connectee (voir /auth/google) : impossible d'envoyer la campagne.");
  }

  const dus = await listerProspectsDus(prisma, campagneId);
  const dejaEnvoyesAujourdhui = await prisma.envoiCampagne.count({
    where: { dateEnvoi: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } },
  });
  const restant = Math.max(quotaQuotidien() - dejaEnvoyesAujourdhui, 0);
  const aEnvoyer = dus.slice(0, restant);

  let nbEnvoyes = 0;
  let nbEchecs = 0;

  for (const prospect of aEnvoyer) {
    try {
      await envoyerUnMessage(prisma, campagne, campagne.template, prospect, false);
      nbEnvoyes++;
    } catch (err) {
      nbEchecs++;
      await logEvenement(prisma, {
        evenement: "campagne_envoi_echec",
        action: `Envoi de la campagne "${campagne.nom}" a ${prospect.entreprise}`,
        resultat: (err as Error).message,
      });
    }
  }

  if (campagne.statut === "brouillon" && nbEnvoyes > 0) {
    await prisma.campagne.update({ where: { id: campagneId }, data: { statut: "en_cours" } });
  }

  await logEvenement(prisma, {
    evenement: "campagne_envoi",
    action: `Envoi de la campagne "${campagne.nom}"`,
    resultat: `${nbEnvoyes} envoye(s), ${nbEchecs} echec(s), ${dus.length - aEnvoyer.length} reporte(s) au quota du jour.`,
  });

  return { nbEnvoyes, nbEchecs };
}

async function envoyerUnMessage(
  prisma: PrismaClient,
  campagne: Campagne,
  template: EmailTemplate,
  prospect: Prospect,
  estRelance: boolean
) {
  const envoi = await prisma.envoiCampagne.create({
    data: { campagneId: campagne.id, prospectId: prospect.id, estRelance },
  });

  const objet = rendre(template.objet, prospect);
  const corps = composerCorps(rendre(template.corpsHtml, prospect), envoi.tokenSuivi);

  const { messageId, threadId } = await envoyerMail(prisma, prospect.email!, objet, corps);

  await prisma.envoiCampagne.update({
    where: { id: envoi.id },
    data: { gmailMessageId: messageId, gmailThreadId: threadId },
  });

  const ancienStatut = prospect.statut;
  const nouveauStatut = estRelance ? "relance" : ancienStatut === "a_contacter" ? "contacte" : ancienStatut;
  await prisma.prospect.update({
    where: { id: prospect.id },
    data: {
      statut: nouveauStatut,
      datePremierContact: prospect.datePremierContact ?? new Date(),
      dateDerniereRelance: estRelance ? new Date() : prospect.dateDerniereRelance,
    },
  });
  if (nouveauStatut !== ancienStatut) {
    await prisma.prospectStatutChangement.create({
      data: { prospectId: prospect.id, ancienStatut, nouveauStatut, auteur: "campagne" },
    });
  }
}

export interface RelanceDue {
  campagneId: string;
  campagneNom: string;
  prospectId: string;
  entreprise: string;
  joursDepuisEnvoi: number;
}

/**
 * Calcule les relances dues (section 2.4 : "relance a J+7 si pas de
 * reponse, arret automatique si reponse recue"). Ne fait qu'identifier -
 * l'envoi reste manuel (envoyerRelance), meme logique que les relances de
 * factures impayees.
 */
export async function listerRelancesDues(prisma: PrismaClient, maintenant: Date = new Date()): Promise<RelanceDue[]> {
  const campagnes = await prisma.campagne.findMany({
    where: { statut: "en_cours", relanceApresJours: { not: null } },
    include: { envois: { include: { prospect: true }, orderBy: { dateEnvoi: "desc" } } },
  });

  const resultat: RelanceDue[] = [];
  for (const campagne of campagnes) {
    const parProspect = new Map<string, (typeof campagne.envois)[number][]>();
    for (const envoi of campagne.envois) {
      const liste = parProspect.get(envoi.prospectId) || [];
      liste.push(envoi);
      parProspect.set(envoi.prospectId, liste);
    }

    for (const [prospectId, envois] of parProspect) {
      const dernier = envois[0]; // le plus recent (tri desc)
      if (dernier.prospect.desinscrit) continue;
      if (campagne.arretSiReponse && envois.some((e) => e.statut === "repondu")) continue;

      const joursDepuisEnvoi = Math.floor((maintenant.getTime() - dernier.dateEnvoi.getTime()) / (1000 * 60 * 60 * 24));
      if (joursDepuisEnvoi < campagne.relanceApresJours!) continue;
      // Une seule relance par cycle : si le dernier envoi est deja une
      // relance, il faudra une nouvelle campagne pour relancer encore.
      if (dernier.estRelance) continue;

      resultat.push({ campagneId: campagne.id, campagneNom: campagne.nom, prospectId, entreprise: dernier.prospect.entreprise, joursDepuisEnvoi });
    }
  }

  return resultat;
}

export async function envoyerRelance(prisma: PrismaClient, campagneId: string, prospectId: string) {
  const campagne = await prisma.campagne.findUniqueOrThrow({ where: { id: campagneId }, include: { template: true } });
  const prospect = await prisma.prospect.findUniqueOrThrow({ where: { id: prospectId } });
  if (!prospect.email) throw new Error(`Aucun email connu pour "${prospect.entreprise}".`);

  await envoyerUnMessage(prisma, campagne, campagne.template, prospect, true);
  await logEvenement(prisma, {
    evenement: "campagne_relance",
    action: `Relance de "${prospect.entreprise}" pour la campagne "${campagne.nom}"`,
  });
}

// --- Suivi (section 2.5 : ouverture, clic, reponse, desinscription) --------

export async function enregistrerOuverture(prisma: PrismaClient, token: string): Promise<void> {
  const envoi = await prisma.envoiCampagne.findUnique({ where: { tokenSuivi: token } });
  if (!envoi || envoi.dateOuverture) return;
  await prisma.envoiCampagne.update({
    where: { id: envoi.id },
    data: { statut: envoi.statut === "envoye" ? "ouvert" : envoi.statut, dateOuverture: new Date() },
  });
}

/** Enregistre le clic puis renvoie l'URL d'origine vers laquelle rediriger. */
export async function enregistrerClic(prisma: PrismaClient, token: string, urlOrigine: string): Promise<string> {
  const envoi = await prisma.envoiCampagne.findUnique({ where: { tokenSuivi: token } });
  if (envoi) {
    await prisma.envoiCampagne.update({
      where: { id: envoi.id },
      data: {
        statut: envoi.statut === "envoye" || envoi.statut === "ouvert" ? "clique" : envoi.statut,
        dateOuverture: envoi.dateOuverture ?? new Date(),
        dateClic: new Date(),
      },
    });
  }
  return urlOrigine;
}

/** Desinscription (RGPD, section 3) : exclut definitivement le prospect de tout futur envoi. */
export async function desabonner(prisma: PrismaClient, token: string): Promise<Prospect | null> {
  const envoi = await prisma.envoiCampagne.findUnique({ where: { tokenSuivi: token }, include: { prospect: true } });
  if (!envoi) return null;

  await prisma.envoiCampagne.update({ where: { id: envoi.id }, data: { statut: "desabonne" } });
  await prisma.prospect.update({
    where: { id: envoi.prospectId },
    data: { desinscrit: true, dateDesinscription: new Date() },
  });
  await logEvenement(prisma, {
    evenement: "prospect_desinscription",
    action: `Desinscription de "${envoi.prospect.entreprise}" via la campagne ${envoi.campagneId}`,
  });
  return envoi.prospect;
}

/**
 * Detection de reponse (section 2.5). S'appuie sur le fil Gmail (threadId)
 * enregistre a l'envoi : un fil qui contient desormais un message que nous
 * n'avons pas envoye signale une reponse. Appelee periodiquement par le
 * planificateur (voir src/services/scheduler.ts), jamais a chaque requete
 * (couteux en appels API Gmail).
 */
export async function detecterReponses(prisma: PrismaClient): Promise<number> {
  const enAttente = await prisma.envoiCampagne.findMany({
    where: { statut: { in: ["envoye", "ouvert", "clique"] }, gmailThreadId: { not: null } },
  });
  if (enAttente.length === 0) return 0;

  const connexionGmail = await getGmailClient(prisma);
  if (!connexionGmail) return 0;
  const { gmail } = connexionGmail;

  let nbReponses = 0;
  for (const envoi of enAttente) {
    try {
      const thread = await gmail.users.threads.get({ userId: "me", id: envoi.gmailThreadId!, format: "metadata" });
      const messages = thread.data.messages || [];
      const aRepondu = messages.some((m) => m.id !== envoi.gmailMessageId);
      if (!aRepondu) continue;

      await prisma.envoiCampagne.update({ where: { id: envoi.id }, data: { statut: "repondu", dateReponse: new Date() } });
      nbReponses++;
    } catch {
      // Fil supprime/inaccessible : on ignore, sans bloquer le reste du lot.
      continue;
    }
  }

  if (nbReponses > 0) {
    await logEvenement(prisma, { evenement: "campagne_reponses_detectees", resultat: `${nbReponses} reponse(s) detectee(s).` });
  }
  return nbReponses;
}
