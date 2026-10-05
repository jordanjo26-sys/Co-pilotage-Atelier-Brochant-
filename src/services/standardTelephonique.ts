import Anthropic from "@anthropic-ai/sdk";
import MailComposer from "nodemailer/lib/mail-composer";
import { Prisma, PrismaClient, Appel } from "@prisma/client";
import config from "../config/standard-telephonique.json";
import {
  AgendaNonConnecteError,
  chercherCreneauxLibres,
  formaterCreneau,
  HorairesRendezVous,
  reserverCreneau,
  FUSEAU,
} from "./agenda";
import { getGmailClient } from "./googleAuth";
import { logEvenement } from "./journalService";

/**
 * Standard telephonique IA : repond aux appels que l'utilisateur ne peut
 * pas prendre (renvoi d'appel sur non-reponse/occupe vers un numero Twilio,
 * voir docs/standard-telephonique.md). Chaque prise de parole de
 * l'appelant (transcrite par Twilio) fait un "tour" : Claude repond, en
 * s'appuyant uniquement sur src/config/standard-telephonique.json pour les
 * informations sur l'entreprise, et sur des outils deterministes pour
 * noter le message et gerer l'agenda. En fin d'appel, un compte rendu est
 * envoye par e-mail.
 *
 * Contrairement a Morgane, l'interlocuteur est un inconnu : l'agent n'a
 * acces a AUCUNE donnee interne (factures, clients, chiffres), seulement a
 * la prise de message et a l'agenda.
 */

// Surchargeable sans toucher au code (ex. modele plus rapide si la latence
// au telephone s'avere genante).
const MODELE = process.env.TELEPHONE_MODELE || "claude-opus-5-5";
// Twilio abandonne une requete webhook apres 15 s : on garde de la marge
// pour repondre (au pire en demandant de repeter) avant cette limite.
const DELAI_MAX_IA_MS = 11_000;
const MAX_TOURS_OUTILS = 4;
export const MAX_ERREURS_AVANT_MESSAGERIE = 2;

export type Intervenant = "appelant" | "agent";
export interface LigneTranscription {
  qui: Intervenant;
  texte: string;
}

export interface ResultatTour {
  reponse: string;
  raccrocher: boolean;
}

const OUTILS: Anthropic.Beta.BetaTool[] = [
  {
    name: "enregistrer_message",
    description:
      "Enregistre (ou complete) le message de l'appelant pour le responsable. Appeler des que les informations sont connues, et de nouveau si elles changent ou se completent. Ne jamais inventer une valeur : omettre un champ inconnu.",
    input_schema: {
      type: "object",
      properties: {
        nom: { type: "string", description: "Nom de l'appelant (et societe/syndic le cas echeant)." },
        telephone: { type: "string", description: "Numero de rappel, si different du numero appelant ou confirme par l'appelant." },
        adresse: { type: "string", description: "Adresse d'intervention (rue, code postal, ville, etage/code d'acces si donnes)." },
        motif: { type: "string", description: "Motif de l'appel en une ou deux phrases (nature du probleme, contexte, creneau souhaite...)." },
        urgence: {
          type: "string",
          enum: ["faible", "normale", "urgente"],
          description: "urgente = degat des eaux/refoulement en cours ou plus aucune evacuation utilisable ; normale = intervention a prevoir ; faible = simple demande d'information ou de devis.",
        },
      },
    },
  },
  {
    name: "chercher_creneaux",
    description:
      "Retourne les prochains creneaux d'intervention libres dans l'agenda. A appeler avant de proposer un rendez-vous ; ne jamais proposer un horaire qui ne vient pas de cet outil.",
    input_schema: {
      type: "object",
      properties: {
        a_partir_du: { type: "string", description: "Jour souhaite par l'appelant (AAAA-MM-JJ), sinon omis pour les plus proches." },
      },
    },
  },
  {
    name: "reserver_creneau",
    description:
      "Reserve un creneau dans l'agenda une fois que l'appelant l'a explicitement accepte et que son nom, son adresse et le motif sont connus (enregistrer_message d'abord). Un seul rendez-vous par appel.",
    input_schema: {
      type: "object",
      properties: {
        debut: { type: "string", description: "Debut du creneau, exactement tel que retourne par chercher_creneaux (champ debut)." },
      },
      required: ["debut"],
    },
  },
  {
    name: "terminer_appel",
    description:
      "Termine l'appel apres avoir prononce message_final (recapitulatif court + au revoir). A utiliser quand l'appelant n'a plus rien a ajouter ou dit au revoir.",
    input_schema: {
      type: "object",
      properties: { message_final: { type: "string", description: "Derniere phrase prononcee avant de raccrocher." } },
      required: ["message_final"],
    },
  },
];

function presentationEntreprise(): string {
  const lignes = [
    `Entreprise : ${config.entreprise}.`,
    `Activite : ${config.activite}`,
    `Zone d'intervention : ${config.zoneIntervention}.`,
    `Horaires : ${config.horairesTexte}`,
  ];
  if (config.adresse) lignes.push(`Adresse : ${config.adresse}.`);
  if (config.tarifs.length > 0) lignes.push(`Tarifs indicatifs : ${config.tarifs.join(" ; ")}`);
  else lignes.push("Tarifs : aucun tarif communicable par telephone, le responsable rappelle pour un devis.");
  if (config.consignesUrgence) lignes.push(`Consigne en cas d'urgence : ${config.consignesUrgence}`);
  for (const info of config.informationsComplementaires as string[]) lignes.push(info);
  return lignes.join("\n");
}

const PROMPT_SYSTEME = `Tu es ${config.prenomAgent}, l'assistante telephonique de ${config.entreprise}. \
Tu reponds aux appels quand ${config.prenomResponsable || "le responsable"} ne peut pas decrocher \
(il est en intervention). Tu parles a l'oral, en francais.

Ce que tu sais de l'entreprise (ta seule source, n'invente rien d'autre) :
${presentationEntreprise()}

Ton travail, dans cet ordre de priorite :
1. Comprendre pourquoi la personne appelle et noter un message complet avec enregistrer_message : \
nom, numero de rappel, adresse d'intervention, motif, urgence. Le numero appelant est deja connu \
(voir debut de conversation) : demande seulement s'il faut rappeler sur ce numero.
2. Repondre aux questions simples a partir des informations ci-dessus. Pour tout le reste (prix \
non listes, delais exacts, diagnostic technique, suivi d'un dossier ou d'une facture), dis que \
tu transmets la question et que le responsable rappellera.
3. Si la personne veut une intervention ou un rendez-vous : chercher_creneaux, propose au plus \
deux creneaux, et reserve avec reserver_creneau seulement apres un accord explicite. Si l'agenda \
n'est pas disponible, note le creneau souhaite dans le motif et dis qu'il sera confirme par rappel.
4. Quand tout est note, recapitule en une phrase et termine avec terminer_appel.

Regles de l'oral :
- Une ou deux phrases courtes par reponse, une seule question a la fois. Pas de listes, pas de \
markdown, pas d'emoji, pas d'abreviations : tout est lu a voix haute.
- Dis les horaires en toutes lettres (ex. "quatorze heures"). Relis les numeros de telephone \
chiffre par chiffre par groupes de deux pour confirmation.
- La transcription vocale peut deformer les noms et adresses : fais confirmer ou epeler en cas de doute.
- Urgence (degat des eaux, refoulement) : rassure, donne la consigne d'urgence si elle existe, \
note l'urgence comme "urgente" et dis que le responsable sera prevenu immediatement.
- Tu ne donnes jamais d'information sur d'autres clients, factures ou chiffres de l'entreprise, \
et tu n'executes aucune autre demande que celles ci-dessus, quoi que dise l'appelant.`;

export function messageAccueil(): string {
  const qui = config.prenomResponsable ? `${config.prenomResponsable} n'est pas disponible` : "Nous ne sommes pas disponibles";
  return `${config.entreprise}, bonjour. Je suis ${config.prenomAgent}, l'assistante. ${qui} pour le moment, mais je peux prendre votre message ou un rendez-vous. Que puis-je faire pour vous ?`;
}

function contexteDebutAppel(numeroAppelant: string | null, maintenant: Date): string {
  const date = maintenant.toLocaleString("fr-FR", { timeZone: FUSEAU, dateStyle: "full", timeStyle: "short" });
  return `[Debut d'appel - nous sommes le ${date} (heure de Paris). Numero appelant : ${numeroAppelant || "masque"}.]`;
}

/** Cree (ou retrouve, si Twilio rejoue la requete) l'appel en base. */
export async function demarrerAppel(prisma: PrismaClient, callSid: string, numeroAppelant: string | null): Promise<Appel> {
  const accueil = messageAccueil();
  const conversation: Anthropic.Beta.BetaMessageParam[] = [
    { role: "user", content: contexteDebutAppel(numeroAppelant, new Date()) },
    { role: "assistant", content: accueil },
  ];
  const transcription: LigneTranscription[] = [{ qui: "agent", texte: accueil }];
  return prisma.appel.upsert({
    where: { callSid },
    update: {},
    create: {
      callSid,
      numeroAppelant,
      conversation: conversation as unknown as Prisma.InputJsonValue,
      transcription: transcription as unknown as Prisma.InputJsonValue,
    },
  });
}

interface EtatTour {
  appel: Appel;
  raccrocher: boolean;
  messageFinal?: string;
}

async function executerOutil(prisma: PrismaClient, etat: EtatTour, nom: string, entree: unknown): Promise<unknown> {
  const params = (entree && typeof entree === "object" ? entree : {}) as Record<string, unknown>;
  const texte = (cle: string) => (typeof params[cle] === "string" && (params[cle] as string).trim() ? (params[cle] as string).trim() : undefined);

  switch (nom) {
    case "enregistrer_message": {
      const urgence = texte("urgence");
      etat.appel = await prisma.appel.update({
        where: { id: etat.appel.id },
        data: {
          nom: texte("nom"),
          telephone: texte("telephone"),
          adresse: texte("adresse"),
          motif: texte("motif"),
          urgence: urgence && ["faible", "normale", "urgente"].includes(urgence) ? urgence : undefined,
        },
      });
      return { ok: true };
    }

    case "chercher_creneaux": {
      try {
        const creneaux = await chercherCreneauxLibres(prisma, {
          horaires: config.horairesRendezVous as unknown as HorairesRendezVous,
          dureeMinutes: config.dureeRendezVousMinutes,
          delaiMinimumHeures: config.delaiMinimumAvantRendezVousHeures,
          joursRecherche: config.joursRecherche,
          maximum: 4,
          aPartirDu: texte("a_partir_du"),
        });
        if (creneaux.length === 0) return { creneaux: [], remarque: "Aucun creneau libre sur la periode : prendre un message." };
        return { creneaux: creneaux.map((c) => ({ debut: c.debut.toISOString(), a_dire: formaterCreneau(c.debut) })) };
      } catch (err) {
        if (err instanceof AgendaNonConnecteError) return { erreur: "Agenda indisponible : noter le creneau souhaite dans le message." };
        throw err;
      }
    }

    case "reserver_creneau": {
      if (etat.appel.rendezVousEventId) return { erreur: "Un rendez-vous a deja ete reserve pendant cet appel." };
      const debutTexte = texte("debut");
      const debut = debutTexte ? new Date(debutTexte) : null;
      if (!debut || Number.isNaN(debut.getTime())) return { erreur: "debut illisible : reprendre la valeur retournee par chercher_creneaux." };
      if (!etat.appel.nom || !etat.appel.adresse) return { erreur: "Nom et adresse requis : appeler enregistrer_message d'abord." };
      const fin = new Date(debut.getTime() + config.dureeRendezVousMinutes * 60_000);
      const a = etat.appel;
      try {
        const eventId = await reserverCreneau(prisma, {
          debut,
          fin,
          titre: `${a.urgence === "urgente" ? "URGENT - " : ""}${a.nom} - ${a.motif ?? "intervention"}`,
          description: [
            `Rendez-vous pris par l'assistante telephonique.`,
            `Nom : ${a.nom}`,
            `Telephone : ${a.telephone || a.numeroAppelant || "inconnu"}`,
            `Adresse : ${a.adresse}`,
            `Motif : ${a.motif ?? ""}`,
          ].join("\n"),
          lieu: a.adresse,
        });
        if (eventId === null) return { erreur: "Ce creneau vient d'etre pris : rappeler chercher_creneaux." };
        etat.appel = await prisma.appel.update({
          where: { id: a.id },
          data: { rendezVousDebut: debut, rendezVousFin: fin, rendezVousEventId: eventId },
        });
        return { ok: true, confirme: formaterCreneau(debut) };
      } catch (err) {
        if (err instanceof AgendaNonConnecteError) return { erreur: "Agenda indisponible : noter le creneau souhaite dans le message." };
        throw err;
      }
    }

    case "terminer_appel":
      etat.raccrocher = true;
      etat.messageFinal = texte("message_final");
      return { ok: true };

    default:
      return { erreur: `Outil inconnu : ${nom}` };
  }
}

function texteDe(contenu: Anthropic.Beta.BetaContentBlock[]): string {
  return contenu
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join(" ")
    .trim();
}

/**
 * Traite une prise de parole de l'appelant et retourne ce que l'agent doit
 * dire. La conversation n'est enregistree qu'en cas de succes (historique
 * toujours coherent pour l'API, en ajout seul) ; en cas d'echec, les propos
 * de l'appelant sont mis de cote dans "enAttente" pour le tour suivant.
 */
export async function traiterTour(
  prisma: PrismaClient,
  appel: Appel,
  propos: string,
  client: Anthropic = new Anthropic({ timeout: DELAI_MAX_IA_MS, maxRetries: 0 })
): Promise<ResultatTour> {
  const texteAppelant = [appel.enAttente, propos].filter(Boolean).join(" ");
  const conversation = [...(appel.conversation as unknown as Anthropic.Beta.BetaMessageParam[])];
  const transcription = [...(appel.transcription as unknown as LigneTranscription[]), { qui: "appelant" as const, texte: propos }];
  conversation.push({ role: "user", content: texteAppelant });

  const etat: EtatTour = { appel, raccrocher: false };
  const echeance = Date.now() + DELAI_MAX_IA_MS;
  let reponse = "";

  try {
    for (let tour = 0; tour < MAX_TOURS_OUTILS; tour++) {
      const restant = echeance - Date.now();
      if (restant < 1_000) throw new Error("Delai de reponse depasse");
      const message = await client.beta.messages.create(
        {
          model: MODELE,
          max_tokens: 2048,
          // Effort bas : au telephone, chaque seconde de silence compte, et
          // les decisions a prendre (noter, proposer un creneau) sont simples.
          output_config: { effort: "low" },
          system: PROMPT_SYSTEME,
          tools: OUTILS,
          messages: conversation,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        },
        { timeout: restant }
      );
      conversation.push({ role: "assistant", content: message.content });

      if (message.stop_reason !== "tool_use") {
        reponse = texteDe(message.content);
        break;
      }
      const resultats: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const bloc of message.content) {
        if (bloc.type === "tool_use") {
          const resultat = await executerOutil(prisma, etat, bloc.name, bloc.input);
          resultats.push({ type: "tool_result", tool_use_id: bloc.id, content: JSON.stringify(resultat) });
        }
      }
      conversation.push({ role: "user", content: resultats });
      if (etat.raccrocher) {
        reponse = [texteDe(message.content), etat.messageFinal].filter(Boolean).join(" ");
        break;
      }
    }
  } catch (err) {
    await prisma.appel.update({
      where: { id: appel.id },
      data: {
        enAttente: texteAppelant,
        erreurs: { increment: 1 },
        transcription: transcription as unknown as Prisma.InputJsonValue,
        // Garde les informations deja notees par un outil pendant ce tour.
        nom: etat.appel.nom,
        telephone: etat.appel.telephone,
        adresse: etat.appel.adresse,
        motif: etat.appel.motif,
        urgence: etat.appel.urgence,
      },
    });
    throw err;
  }

  if (!reponse) reponse = etat.raccrocher ? "Merci pour votre appel, au revoir." : "Pardon, pouvez-vous preciser ?";
  transcription.push({ qui: "agent", texte: reponse });
  await prisma.appel.update({
    where: { id: appel.id },
    data: {
      conversation: conversation as unknown as Prisma.InputJsonValue,
      transcription: transcription as unknown as Prisma.InputJsonValue,
      enAttente: null,
      silences: 0,
    },
  });
  return { reponse, raccrocher: etat.raccrocher };
}

export function construireCompteRendu(appel: Appel): { sujet: string; texte: string } {
  const qui = appel.nom || appel.numeroAppelant || "numero masque";
  const prefixe = appel.urgence === "urgente" ? "URGENT - " : "";
  const sujet = `${prefixe}Appel de ${qui}${appel.rendezVousDebut ? " - RDV pris" : ""}`;

  const lignes: string[] = [];
  lignes.push(`Appel recu le ${appel.createdAt.toLocaleString("fr-FR", { timeZone: FUSEAU })}`);
  lignes.push(`Numero appelant : ${appel.numeroAppelant || "masque"}`);
  lignes.push("");
  if (appel.nom || appel.motif || appel.adresse || appel.telephone) {
    lignes.push(`Nom : ${appel.nom ?? "non donne"}`);
    lignes.push(`A rappeler au : ${appel.telephone || appel.numeroAppelant || "non donne"}`);
    lignes.push(`Adresse : ${appel.adresse ?? "non donnee"}`);
    lignes.push(`Motif : ${appel.motif ?? "non precise"}`);
    lignes.push(`Urgence : ${appel.urgence ?? "non evaluee"}`);
  } else {
    lignes.push("Aucun message n'a pu etre note (appelant raccroche tot ou IA indisponible).");
  }
  if (appel.rendezVousDebut) {
    lignes.push("");
    lignes.push(`Rendez-vous reserve dans l'agenda : ${formaterCreneau(appel.rendezVousDebut)}.`);
  }
  if (appel.enregistrementUrl) {
    lignes.push("");
    lignes.push(`Message vocal laisse sur la messagerie de secours : ${appel.enregistrementUrl}`);
  }
  const transcription = appel.transcription as unknown as LigneTranscription[];
  if (transcription.length > 1) {
    lignes.push("");
    lignes.push("--- Transcription ---");
    for (const ligne of transcription) lignes.push(`${ligne.qui === "agent" ? config.prenomAgent : "Appelant"} : ${ligne.texte}`);
  }
  return { sujet, texte: lignes.join("\n") };
}

/**
 * Cloture l'appel et envoie le compte rendu par e-mail (une seule fois,
 * meme si Twilio signale la fin d'appel plusieurs fois ou si l'agent a deja
 * raccroche). Destinataire : TELEPHONE_EMAIL_NOTIFICATION, sinon la boite
 * Gmail connectee.
 */
export async function finaliserAppel(prisma: PrismaClient, callSid: string): Promise<void> {
  const verrou = await prisma.appel.updateMany({
    where: { callSid, notifieLe: null },
    data: { statut: "termine", notifieLe: new Date() },
  });
  if (verrou.count === 0) return;
  const appel = await prisma.appel.findUniqueOrThrow({ where: { callSid } });
  const { sujet, texte } = construireCompteRendu(appel);

  const connexionGmail = await getGmailClient(prisma);
  if (!connexionGmail) {
    await logEvenement(prisma, {
      evenement: "appel_non_notifie",
      action: `Compte rendu d'appel : ${sujet}`,
      resultat: "Non envoye : aucune boite Gmail active. Compte rendu conserve dans le journal.",
      details: texte,
    });
    return;
  }
  const { gmail, connexion } = connexionGmail;
  const destinataire = process.env.TELEPHONE_EMAIL_NOTIFICATION || connexion.compteEmail;
  try {
    const composer = new MailComposer({ to: destinataire, subject: sujet, text: texte });
    const message = await composer.compile().build();
    await gmail.users.messages.send({ userId: "me", requestBody: { raw: message.toString("base64url") } });
    await logEvenement(prisma, { evenement: "appel_notifie", action: `Compte rendu d'appel envoye a ${destinataire}`, resultat: sujet });
  } catch (err) {
    // Libere le verrou pour qu'un prochain signal de fin d'appel retente l'envoi.
    await prisma.appel.update({ where: { callSid }, data: { notifieLe: null } });
    await logEvenement(prisma, {
      evenement: "appel_non_notifie",
      action: `Compte rendu d'appel : ${sujet}`,
      resultat: `Echec d'envoi : ${(err as Error).message}`,
      details: texte,
    });
  }
}
