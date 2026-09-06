import Anthropic from "@anthropic-ai/sdk";
import { PrismaClient } from "@prisma/client";
import { getDashboardSummary } from "./dashboardService";
import { construireBilanSante, envoyerBilanSante } from "./bilanSante";
import { construireRecapQuotidien, envoyerRecapQuotidien } from "./dailyRecap";
import { synchroniserGmail } from "./gmailSync";
import { listerFacturesARelancer, envoyerRelance } from "./relances";
import { listerFournisseurs } from "./fournisseurs";
import { logEvenement } from "./journalService";

/**
 * Morgane : assistante IA conversationnelle (Phase 7 du cahier des
 * charges — "assistant IA", jusqu'ici hors perimetre des phases livrees).
 * A la difference des services de classification (gmailClassify.ts) qui
 * doivent rester deterministes (section 14), Morgane est explicitement une
 * couche conversationnelle par-dessus des donnees et des actions DEJA
 * deterministes : elle ne devine jamais un chiffre, elle appelle un outil
 * qui lit la base ou declenche une action existante, puis formule la
 * reponse en langage naturel a partir du resultat.
 */

export interface MessageMorgane {
  role: "user" | "assistant";
  content: string;
}

// Nom de modele tel que fourni par la configuration de l'environnement de
// build (voir la doc interne) : le plus capable disponible, adapte a une
// conversation avec appel d'outils.
const MODELE = "claude-sonnet-5";
const MAX_TOURS_OUTILS = 6;

const OUTILS: Anthropic.Tool[] = [
  {
    name: "obtenir_tableau_de_bord",
    description:
      "Retourne les indicateurs du cockpit du jour : chiffre d'affaires de la veille, impayes (nombre et montant), imports CSV a verifier, anomalies ouvertes.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "obtenir_bilan_sante",
    description:
      "Retourne la note de synthese complete sur l'etat de l'entreprise : chiffre d'affaires 7/30 jours avec evolution, impayes repartis par anciennete de retard, documents fournisseurs en attente, points de vigilance.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "lister_anomalies",
    description: "Liste les anomalies (documents recus par e-mail non reconnus automatiquement) selon leur statut.",
    input_schema: {
      type: "object",
      properties: {
        statut: {
          type: "string",
          enum: ["a_valider", "validee", "ignoree"],
          description: "Statut a filtrer (par defaut a_valider, c'est-a-dire en attente).",
        },
      },
    },
  },
  {
    name: "lister_factures_impayees",
    description: "Liste les factures impayees ou partiellement reglees, triees par date d'echeance (les plus urgentes en premier).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "ignorer_anomalie",
    description:
      "Marque une anomalie precise comme ignoree (conserve une trace, ne supprime rien). N'utiliser que si l'utilisateur a clairement demande d'ignorer CETTE anomalie (par son id, obtenu via lister_anomalies).",
    input_schema: {
      type: "object",
      properties: { id: { type: "string", description: "Identifiant de l'anomalie (voir lister_anomalies)." } },
      required: ["id"],
    },
  },
  {
    name: "declencher_synchronisation_gmail",
    description:
      "Lance immediatement une synchronisation Gmail -> Dext au lieu d'attendre le prochain passage automatique (toutes les 5 minutes). A utiliser si l'utilisateur demande de verifier les nouveaux e-mails maintenant.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "envoyer_recapitulatif_quotidien",
    description: "Envoie immediatement par e-mail le recapitulatif des evenements du jour, a la place d'attendre l'envoi automatique du soir.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "envoyer_bilan_sante",
    description: "Envoie immediatement par e-mail la note de bilan de sante de l'entreprise.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "lister_factures_a_relancer",
    description:
      "Liste les factures impayees ayant atteint un nouveau palier de retard (rappel/relance/mise en demeure) non encore relance, avec le texte de relance propose. N'inclut jamais une facture sous delai accorde.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "lister_fournisseurs",
    description:
      "Liste les fournisseurs connus (fiches derivees automatiquement des documents recus par e-mail) avec leur activite : nombre de documents, nombre de factures, documents en attente, date du dernier document recu.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "envoyer_relance",
    description:
      "Envoie par e-mail la relance proposee pour une facture precise (voir lister_factures_a_relancer pour l'id). N'utiliser que si l'utilisateur a clairement demande de relancer CETTE facture — ne jamais relancer en masse de sa propre initiative.",
    input_schema: {
      type: "object",
      properties: { factureId: { type: "string", description: "Identifiant de la facture (voir lister_factures_a_relancer)." } },
      required: ["factureId"],
    },
  },
];

async function executerOutil(prisma: PrismaClient, nom: string, entree: unknown): Promise<unknown> {
  const params = (entree && typeof entree === "object" ? entree : {}) as Record<string, unknown>;

  switch (nom) {
    case "obtenir_tableau_de_bord":
      return getDashboardSummary(prisma);

    case "obtenir_bilan_sante":
      return { note: await construireBilanSante(prisma) };

    case "lister_anomalies": {
      const statut = typeof params.statut === "string" ? params.statut : "a_valider";
      const anomalies = await prisma.anomalie.findMany({ where: { statut }, orderBy: { createdAt: "desc" }, take: 50 });
      return anomalies.map((a) => ({ id: a.id, type: a.type, gravite: a.gravite, creeLe: a.createdAt, preuves: a.preuves }));
    }

    case "lister_factures_impayees": {
      const factures = await prisma.facture.findMany({
        where: { statut: { in: ["impayee", "partiellement_payee"] } },
        orderBy: { dateEcheance: "asc" },
        take: 50,
      });
      return factures.map((f) => ({
        reference: f.reference,
        client: f.clientNom,
        echeance: f.dateEcheance,
        resteAPercevoir: f.montantTTC - f.montantRegle,
      }));
    }

    case "ignorer_anomalie": {
      const id = params.id;
      if (typeof id !== "string") return { erreur: "id manquant" };
      try {
        await prisma.anomalie.update({ where: { id }, data: { statut: "ignoree" } });
        await logEvenement(prisma, { evenement: "morgane_action", action: `Anomalie ${id} ignoree via Morgane`, resultat: "OK" });
        return { ok: true };
      } catch {
        return { erreur: "Anomalie introuvable." };
      }
    }

    case "declencher_synchronisation_gmail": {
      try {
        const resultat = await synchroniserGmail(prisma);
        await logEvenement(prisma, {
          evenement: "morgane_action",
          action: "Synchronisation Gmail declenchee via Morgane",
          resultat: JSON.stringify(resultat),
        });
        return resultat;
      } catch (err) {
        return { erreur: (err as Error).message };
      }
    }

    case "envoyer_recapitulatif_quotidien": {
      try {
        await envoyerRecapQuotidien(prisma);
        return { ok: true, apercu: await construireRecapQuotidien(prisma) };
      } catch (err) {
        return { erreur: (err as Error).message };
      }
    }

    case "envoyer_bilan_sante": {
      try {
        await envoyerBilanSante(prisma);
        return { ok: true };
      } catch (err) {
        return { erreur: (err as Error).message };
      }
    }

    case "lister_fournisseurs":
      return listerFournisseurs(prisma);

    case "lister_factures_a_relancer":
      return listerFacturesARelancer(prisma);

    case "envoyer_relance": {
      const factureId = params.factureId;
      if (typeof factureId !== "string") return { erreur: "factureId manquant" };
      try {
        return { ok: true, relance: await envoyerRelance(prisma, factureId) };
      } catch (err) {
        return { erreur: (err as Error).message };
      }
    }

    default:
      return { erreur: `Outil inconnu : ${nom}` };
  }
}

const PROMPT_SYSTEME = `Tu es Morgane, l'assistante IA du Copilote de gestion de l'Atelier Brochant \
(entreprise de degorgement/debouchage a Paris). Tu reponds en francais, de facon concise et directe.

Regles importantes :
- Tu n'inventes jamais un chiffre. Toute donnee chiffree (CA, impayes, nombre \
d'anomalies...) doit venir d'un appel a un outil ; si tu n'as pas encore \
l'information, appelle l'outil correspondant avant de repondre.
- Tu peux executer des actions concretes (ignorer une anomalie, lancer une \
synchronisation Gmail, envoyer le recapitulatif ou le bilan de sante par \
e-mail, envoyer une relance a un client precis) uniquement quand \
l'utilisateur te le demande explicitement pour cette action precise. Ne \
prends jamais d'initiative sur une action qui modifie des donnees ou qui \
contacte un tiers (client, fournisseur) sans demande claire — une relance \
en particulier ne se declenche jamais en masse de ta propre initiative, \
seulement facture par facture sur demande.
- Si une question sort de ton perimetre (donnees Stripe detaillees, actions \
non couvertes par tes outils), dis-le simplement plutot que d'inventer une \
reponse.
- Reste bref : des phrases courtes, des listes plutot que des paragraphes \
quand c'est plus lisible sur un telephone.`;

/**
 * Fait dialoguer l'historique fourni avec Claude, en executant les outils
 * demandes jusqu'a obtenir une reponse textuelle finale (ou une limite de
 * tours de securite, pour eviter une boucle infinie en cas de comportement
 * inattendu du modele).
 */
export async function repondreMorgane(prisma: PrismaClient, historique: MessageMorgane[]): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("Morgane n'est pas encore configuree (cle ANTHROPIC_API_KEY manquante cote serveur).");
  }
  const client = new Anthropic({ apiKey });

  const messages: Anthropic.MessageParam[] = historique
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content }));

  for (let tour = 0; tour < MAX_TOURS_OUTILS; tour++) {
    const reponse = await client.messages.create({
      model: MODELE,
      max_tokens: 1024,
      system: PROMPT_SYSTEME,
      tools: OUTILS,
      messages,
    });

    if (reponse.stop_reason !== "tool_use") {
      const texte = reponse.content
        .filter((bloc): bloc is Anthropic.TextBlock => bloc.type === "text")
        .map((bloc) => bloc.text)
        .join("\n\n");
      return texte || "(Morgane n'a pas produit de reponse.)";
    }

    messages.push({ role: "assistant", content: reponse.content });

    const resultatsOutils: Anthropic.ToolResultBlockParam[] = [];
    for (const bloc of reponse.content) {
      if (bloc.type === "tool_use") {
        const resultat = await executerOutil(prisma, bloc.name, bloc.input);
        resultatsOutils.push({ type: "tool_result", tool_use_id: bloc.id, content: JSON.stringify(resultat) });
      }
    }
    messages.push({ role: "user", content: resultatsOutils });
  }

  return "Desolee, je n'arrive pas a conclure sur ce point (trop d'etapes necessaires). Peux-tu reformuler ta question ?";
}
