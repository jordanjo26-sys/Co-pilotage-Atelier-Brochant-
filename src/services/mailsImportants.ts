import Anthropic from "@anthropic-ai/sdk";
import { gmail_v1 } from "googleapis";
import { PrismaClient } from "@prisma/client";
import MailComposer from "nodemailer/lib/mail-composer";
import { getGmailClient } from "./googleAuth";
import { extraireEntete } from "./gmailSync";
import { logEvenement } from "./journalService";

/**
 * Détection horaire des mails importants (demande explicite de
 * l'utilisateur : repérer "les demandes d'intervention, tout ce qui est
 * urgent, tout ce qu'il ne voit pas au quotidien dans la journée", sans
 * attendre le récapitulatif du soir).
 *
 * À la différence de la synchronisation Gmail existante (gmailSync.ts), qui
 * ne regarde que les e-mails AVEC pièce jointe pour router des documents
 * fournisseurs, cette détection regarde le sujet/extrait de TOUS les mails
 * reçus (demandes client par e-mail, souvent sans pièce jointe) et utilise
 * l'IA pour juger s'ils méritent d'être signalés tout de suite.
 *
 * N'envoie un e-mail que si au moins un mail important a été trouvé (choix
 * explicite de l'utilisateur) : pas de bruit horaire si rien de neuf.
 */

const MODELE = "claude-sonnet-5-5";

export interface MailImportant {
  gmailMessageId: string;
  sujet: string;
  expediteur: string;
  resume: string;
  dateReception: Date | null;
}

const OUTIL_CLASSIFICATION: Anthropic.Tool = {
  name: "classer_mail",
  description: "Indique si ce mail recu merite d'etre signale tout de suite au gerant, plutot que d'attendre le recapitulatif du soir.",
  input_schema: {
    type: "object",
    properties: {
      important: {
        type: "boolean",
        description:
          "true pour une demande d'intervention client, une urgence (degat des eaux, fuite, bouchon, refoulement...), une reclamation, ou toute autre chose necessitant une action rapide. " +
          "false pour tout le reste : newsletter, publicite, facture ou document fournisseur (deja traite par un autre circuit), accuse de reception, notification automatique, spam.",
      },
      resume: {
        type: "string",
        description: "Si important=true : un resume en une phrase courte (ce que demande l'expediteur, et si c'est urgent). Chaine vide sinon.",
      },
    },
    required: ["important", "resume"],
  },
};

const PROMPT_SYSTEME = `Tu tries les mails recus par une entreprise de debouchage/degorgement pour reperer ceux qui meritent \
une attention immediate du gerant, parmi le flux quotidien de newsletters, publicites et mails fournisseurs. \
Sois conservateur : en cas de doute reel, repond false plutot que de sur-signaler. Une demande client (intervention, \
urgence, reclamation, question sur un rendez-vous ou une facture) est TOUJOURS importante, meme sans mot-cle d'urgence.`;

/**
 * Classifie un mail par IA. Toute erreur (cle API manquante, panne reseau,
 * reponse inattendue) remonte a l'appelant plutot que d'etre avalee
 * silencieusement : contrairement a gmailClassifyIA (simple filet de
 * securite sur une classification deja faite par des regles), ici l'IA est
 * la SEULE source de decision - une panne doit faire retenter le mail au
 * prochain passage plutot que le faire disparaitre silencieusement en
 * "non important".
 */
export async function classerMailImportant(mail: { sujet: string; expediteur: string; extrait: string }): Promise<{ important: boolean; resume: string }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY manquante : impossible de classer les mails importants.");

  const client = new Anthropic({ apiKey });
  const reponse = await client.messages.create({
    model: MODELE,
    max_tokens: 300,
    system: PROMPT_SYSTEME,
    tools: [OUTIL_CLASSIFICATION],
    tool_choice: { type: "tool", name: "classer_mail" },
    messages: [
      {
        role: "user",
        content: `Expediteur : ${mail.expediteur}\nSujet : ${mail.sujet}\nExtrait : ${mail.extrait || "(vide)"}`,
      },
    ],
  });

  const bloc = reponse.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  if (!bloc) throw new Error("Reponse de classification inattendue (aucun outil appele).");
  const entree = bloc.input as { important?: unknown; resume?: unknown };
  return {
    important: entree.important === true,
    resume: typeof entree.resume === "string" ? entree.resume : "",
  };
}

/** Construit le contenu (texte brut) du recapitulatif des mails importants trouves. */
export function construireRecapMailsImportants(mails: MailImportant[]): { sujet: string; texte: string } {
  const sujet = `${mails.length} mail${mails.length > 1 ? "s" : ""} important${mails.length > 1 ? "s" : ""} a traiter - Copilote Atelier Brochant`;
  const lignes: string[] = [];
  lignes.push(`${mails.length} mail(s) recu(s) qui semble(nt) demander une action rapide :`);
  lignes.push("");
  for (const mail of mails) {
    lignes.push(`- De : ${mail.expediteur}`);
    lignes.push(`  Sujet : ${mail.sujet}`);
    if (mail.resume) lignes.push(`  Resume : ${mail.resume}`);
    lignes.push(`  Ouvrir : https://mail.google.com/mail/u/0/#inbox/${mail.gmailMessageId}`);
    lignes.push("");
  }
  return { sujet, texte: lignes.join("\n").trimEnd() };
}

async function envoyerRecapMailsImportants(gmail: gmail_v1.Gmail, destinataire: string, mails: MailImportant[]): Promise<void> {
  const { sujet, texte } = construireRecapMailsImportants(mails);
  const composer = new MailComposer({ to: destinataire, subject: sujet, text: texte });
  const message = await composer.compile().build();
  await gmail.users.messages.send({ userId: "me", requestBody: { raw: message.toString("base64url") } });
}

/**
 * Repasse sur les mails recus recemment, ignore ceux deja examines
 * (MailExamine), classe les nouveaux par IA, et envoie un recapitulatif
 * UNIQUEMENT si au moins un est important. Fenetre de recherche large (2
 * jours) combinee a la deduplication par MailExamine : meme principe que
 * synchroniserGmail (section "idempotent par construction"), pour ne
 * manquer aucun mail en cas d'arret prolonge entre deux passages.
 */
export async function verifierMailsImportants(prisma: PrismaClient): Promise<{ examines: number; importants: number }> {
  const connexionGmail = await getGmailClient(prisma);
  if (!connexionGmail) {
    // Pas de ligne de Journal ici (contrairement au recap quotidien) : ce
    // planificateur tourne toutes les heures, une trace quotidienne suffit
    // deja (recap_quotidien_non_envoye) a signaler une boite deconnectee
    // sans noyer le Journal d'une ligne identique 24 fois par jour.
    return { examines: 0, importants: 0 };
  }
  const { gmail, connexion } = connexionGmail;

  const messages: gmail_v1.Schema$Message[] = [];
  let pageToken: string | undefined;
  do {
    const liste = await gmail.users.messages.list({
      userId: "me",
      q: `in:inbox newer_than:2d -from:${connexion.compteEmail} -from:dext.cc -category:promotions -category:social`,
      maxResults: 50,
      pageToken,
    });
    messages.push(...(liste.data.messages || []));
    pageToken = liste.data.nextPageToken || undefined;
  } while (pageToken && messages.length < 300);

  const idsRecus = messages.map((m) => m.id).filter((id): id is string => Boolean(id));
  const dejaExamines = await prisma.mailExamine.findMany({
    where: { gmailMessageId: { in: idsRecus } },
    select: { gmailMessageId: true },
  });
  const dejaExaminesSet = new Set(dejaExamines.map((m) => m.gmailMessageId));
  const aExaminer = idsRecus.filter((id) => !dejaExaminesSet.has(id));

  const importants: MailImportant[] = [];
  let nombreExamine = 0;

  for (const id of aExaminer) {
    try {
      const msg = await gmail.users.messages.get({
        userId: "me",
        id,
        format: "metadata",
        metadataHeaders: ["Subject", "From"],
      });
      const sujet = extraireEntete(msg.data.payload?.headers, "Subject");
      const expediteur = extraireEntete(msg.data.payload?.headers, "From");
      const dateReception = msg.data.internalDate ? new Date(Number(msg.data.internalDate)) : null;
      const extrait = msg.data.snippet || "";

      const resultat = await classerMailImportant({ sujet, expediteur, extrait });
      await prisma.mailExamine.upsert({
        where: { gmailMessageId: id },
        update: {},
        create: { gmailMessageId: id, important: resultat.important },
      });
      nombreExamine++;

      if (resultat.important) {
        importants.push({ gmailMessageId: id, sujet, expediteur, resume: resultat.resume, dateReception });
      }
    } catch (err) {
      // N'enregistre pas ce mail comme examine : sera retente au prochain
      // passage (dans l'heure qui suit) plutot que silencieusement perdu.
      console.error(`Classification du mail ${id} en echec :`, (err as Error).message);
    }
  }

  if (importants.length > 0) {
    await envoyerRecapMailsImportants(gmail, connexion.compteEmail, importants);
    await logEvenement(prisma, {
      evenement: "mails_importants_signales",
      action: `Verification horaire des mails importants (${nombreExamine} nouveau(x) examine(s))`,
      resultat: `${importants.length} mail(s) important(s) signale(s) par e-mail.`,
    });
  }

  return { examines: nombreExamine, importants: importants.length };
}
