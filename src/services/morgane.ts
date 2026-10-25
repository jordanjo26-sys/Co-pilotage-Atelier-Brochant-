import Anthropic from "@anthropic-ai/sdk";
import { PrismaClient } from "@prisma/client";
import { getDashboardSummary } from "./dashboardService";
import { construireBilanSante, envoyerBilanSante } from "./bilanSante";
import { construireRecapQuotidien, envoyerRecapQuotidien } from "./dailyRecap";
import { synchroniserGmail } from "./gmailSync";
import { listerFacturesARelancer, envoyerRelance } from "./relances";
import { listerFournisseurs } from "./fournisseurs";
import { executerRapprochementBancaire } from "./rapprochementBancaire";
import { synchroniserStripe, stripeEstConnecte } from "./stripeSync";
import { enregistrerDecision, listerDecisions, TypeDecision } from "./decisions";
import { logEvenement } from "./journalService";
import { verifierMailsImportants } from "./mailsImportants";
import {
  listerCampagnesAds,
  listerMotsCles,
  listerTermesRecherche,
  listerActionsConversion,
  listerExtensionsAppel,
  messageErreurGoogleAds,
  diagnosticConfigurationAds,
  diagnosticScopesJeton,
  diagnosticLienGestionnaire,
} from "./googleAds";
import { dernieresCampagnesImportees } from "./googleAdsImport";
import { creerPropositionAds, TypePropositionAds } from "./googleAdsActions";

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
const MODELE = "claude-sonnet-5-5";
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
    name: "declencher_synchronisation_stripe",
    description:
      "Lance immediatement une synchronisation Stripe (recupere les payouts et paiements recents par API) au lieu d'attendre le prochain passage automatique. Ne fait rien si aucune cle API Stripe n'est configuree.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "verifier_rapprochement_bancaire",
    description:
      "Relance le rapprochement automatique des payouts Stripe avec les mouvements bancaires (section 5) et indique combien ont ete rapproches, restent ambigus (plusieurs mouvements candidats) ou sans mouvement correspondant. Ecriture purement interne, sans impact externe.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "memoriser_decision",
    description:
      "Enregistre durablement une decision metier (memoire a long terme, section 8) : delai accorde, exception, financement Oney, ou correction. A utiliser uniquement quand l'utilisateur demande explicitement de retenir/memoriser quelque chose de facon durable (ex. 'retiens que...', 'a partir de maintenant...'). Reste consultable dans toutes les conversations futures.",
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["delai_accorde", "exception", "financement_oney", "correction"] },
        motif: { type: "string", description: "Explication en langage naturel de la decision et de son contexte." },
        objetType: { type: "string", description: "A quoi la decision s'applique, ex. 'Facture', 'Client', 'Fournisseur', ou 'Global' si generale." },
        objetId: { type: "string", description: "Identifiant de l'objet concerne (id de facture/client/fournisseur), absent si objetType est 'Global'." },
        dateFin: { type: "string", description: "Date de fin de validite (AAAA-MM-JJ), si la decision est temporaire. Omis = indefinie jusqu'a revocation." },
      },
      required: ["type", "motif"],
    },
  },
  {
    name: "lister_decisions",
    description:
      "Consulte les decisions memorisees precedemment (memoire a long terme). A appeler avant de repondre a une question ou d'agir des qu'une decision passee pourrait etre pertinente (ex. avant de relancer une facture, verifier si un delai/exception a ete accorde).",
    input_schema: {
      type: "object",
      properties: {
        objetType: { type: "string", description: "Filtrer par type d'objet, ex. 'Facture'." },
        objetId: { type: "string", description: "Filtrer par identifiant d'objet precis." },
        activesSeulement: { type: "boolean", description: "Exclure les decisions pas encore commencees ou deja terminees (recommande, defaut true)." },
      },
    },
  },
  {
    name: "lister_fournisseurs",
    description:
      "Liste les fournisseurs connus (fiches derivees automatiquement des documents recus par e-mail) avec leur activite : nombre de documents, nombre de factures, documents en attente, date du dernier document recu.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "verifier_mails_importants",
    description:
      "Relance immediatement la detection des mails importants (demandes d'intervention, urgences client) au lieu d'attendre le prochain passage automatique (toutes les heures). Envoie un e-mail recapitulatif uniquement si au moins un mail important est trouve.",
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
  {
    name: "obtenir_campagnes_ads",
    description:
      "Retourne la liste des campagnes Google Ads avec leurs indicateurs de performance sur la periode demandee : impressions, clics, cout, conversions, CTR, CPC moyen, budget quotidien. Lecture seule.",
    input_schema: {
      type: "object",
      properties: {
        jours: { type: "number", description: "Nombre de jours a analyser en arriere (30 par defaut)." },
      },
    },
  },
  {
    name: "obtenir_mots_cles_ads",
    description:
      "Retourne la performance PAR MOT-CLE (impressions, clics, cout, conversions, CTR, CPC moyen, score de qualite) sur la periode demandee. A utiliser pour identifier les mots-cles rentables a developper, ceux a optimiser, et ceux sans interet commercial. Precise campagneId pour te concentrer sur une seule campagne (recommande des que tu analyses une campagne precise). Lecture seule.",
    input_schema: {
      type: "object",
      properties: {
        jours: { type: "number", description: "Nombre de jours a analyser en arriere (30 par defaut)." },
        campagneId: { type: "string", description: "Limiter a une campagne precise (campaign.id, voir obtenir_campagnes_ads). Omis = toutes les campagnes." },
      },
    },
  },
  {
    name: "obtenir_termes_recherche_ads",
    description:
      "Retourne les TERMES DE RECHERCHE REELS (ce que les internautes ont effectivement tape, par opposition aux mots-cles cibles) ayant declenche une annonce, avec leurs indicateurs. A utiliser pour detecter le trafic non pertinent et identifier des mots-cles exclus a proposer (proposer_action_ads, type ajouter_mots_cles_exclus). Le champ statut indique si le terme est deja ajoute/exclu comme mot-cle (EXCLUDED/ADDED_EXCLUDED = deja traite, inutile de le reproposer). Precise campagneId pour te concentrer sur une seule campagne. Lecture seule.",
    input_schema: {
      type: "object",
      properties: {
        jours: { type: "number", description: "Nombre de jours a analyser en arriere (30 par defaut)." },
        campagneId: { type: "string", description: "Limiter a une campagne precise (campaign.id, voir obtenir_campagnes_ads). Omis = toutes les campagnes." },
      },
    },
  },
  {
    name: "obtenir_actions_conversion_ads",
    description:
      "Retourne les actions de conversion CONFIGUREES au niveau du compte Google Ads (nom, type, categorie, statut, si elle compte dans les conversions, duree minimale pour un appel telephonique). A utiliser des que le nombre de conversions semble incoherent avec l'activite reelle (ex. tres peu de conversions pour une activite ou l'appel telephonique est la vraie conversion) - permet de voir precisement CE QUI est compte, et si une action censee exister (appel, formulaire) est absente, mal configuree ou desactivee (include_in_conversions_metric=false ou statut different de ENABLED). Lecture seule.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "obtenir_extensions_appel_ads",
    description:
      "Retourne les extensions d'appel (numero de telephone affiche dans l'annonce) liees a chaque campagne, avec le statut du suivi de conversion d'appel. Une campagne ABSENTE du resultat n'a PAS d'extension d'appel configuree. A utiliser pour verifier qu'une campagne dispose bien d'un moyen de suivre les appels telephoniques independamment du site. Precise campagneId pour te concentrer sur une seule campagne. Lecture seule.",
    input_schema: {
      type: "object",
      properties: {
        campagneId: { type: "string", description: "Limiter a une campagne precise (campaign.id, voir obtenir_campagnes_ads). Omis = toutes les campagnes." },
      },
    },
  },
  {
    name: "proposer_action_ads",
    description:
      "Enregistre une proposition d'action Google Ads (pause/reactivation d'une campagne OU d'un mot-cle precis, ajout de mots-cles exclus, exclusion d'une action de conversion du comptage, OU creation complete d'une nouvelle campagne Search), APRES que l'utilisateur ait clairement donne son accord dans la conversation sur cette action precise. N'execute RIEN directement : la proposition est deposee sur l'ecran de validation dedie de l'application (onglet Google Ads), ou l'utilisateur doit explicitement l'accepter avant qu'elle ne soit appliquee. Ne jamais appeler cet outil sans accord explicite et recent de l'utilisateur. Pour creer_campagne : une campagne complete est toujours creee EN PAUSE (securite demandee par l'utilisateur) - elle ne depensera rien tant qu'il ne l'active pas lui-meme dans Google Ads apres verification ; dis-le lui.",
    input_schema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["pause_campagne", "reactiver_campagne", "creer_campagne", "ajouter_mots_cles_exclus", "pause_mot_cle", "reactiver_mot_cle", "exclure_action_conversion"],
          description: "Action proposee.",
        },
        campagneId: {
          type: "string",
          description:
            "Identifiant Google Ads de la campagne existante (campaign.id, voir obtenir_campagnes_ads). Requis pour pause_campagne/reactiver_campagne/ajouter_mots_cles_exclus. Omis/vide pour creer_campagne (elle n'existe pas encore), pour pause_mot_cle/reactiver_mot_cle (groupeId/criterionId suffisent) et pour exclure_action_conversion (action au niveau du compte, pas d'une campagne).",
        },
        conversionActionId: {
          type: "string",
          description: "Identifiant de l'action de conversion (id, voir obtenir_actions_conversion_ads). REQUIS pour exclure_action_conversion.",
        },
        groupeId: {
          type: "string",
          description: "Identifiant du groupe d'annonces (ad_group.id, voir obtenir_mots_cles_ads). REQUIS pour pause_mot_cle/reactiver_mot_cle.",
        },
        criterionId: {
          type: "string",
          description: "Identifiant du critere mot-cle (criterionId, voir obtenir_mots_cles_ads). REQUIS pour pause_mot_cle/reactiver_mot_cle - identifie le mot-cle precis avec groupeId.",
        },
        motCleTexte: {
          type: "string",
          description: "Texte du mot-cle concerne, pour affichage sur l'ecran de validation. REQUIS pour pause_mot_cle/reactiver_mot_cle.",
        },
        campagneNom: {
          type: "string",
          description: "Nom de la campagne (existante, ou nom propose pour une nouvelle campagne). Pour exclure_action_conversion : nom de l'action de conversion concernee (affichage).",
        },
        justification: {
          type: "string",
          description: "Resume en langage clair de pourquoi cette action est proposee, affiche a l'utilisateur sur l'ecran de validation.",
        },
        budgetQuotidien: { type: "number", description: "Budget quotidien en euros, decide avec l'utilisateur dans la conversation. Uniquement pour creer_campagne." },
        urlFinale: { type: "string", description: "Page de destination des annonces (URL complete). Uniquement pour creer_campagne." },
        titres: {
          type: "array",
          items: { type: "string" },
          description: "Entre 3 et 15 titres d'annonce (30 caracteres max chacun, contrainte Google Ads). Uniquement pour creer_campagne.",
        },
        descriptions: {
          type: "array",
          items: { type: "string" },
          description: "Entre 2 et 4 descriptions d'annonce (90 caracteres max chacune, contrainte Google Ads). Uniquement pour creer_campagne.",
        },
        motsCles: { type: "array", items: { type: "string" }, description: "Mots-cles pertinents a cibler (au moins un). Uniquement pour creer_campagne." },
        motsClesExclus: {
          type: "array",
          items: { type: "string" },
          description:
            "Mots-cles exclus (negatifs) a ajouter. Optionnel pour creer_campagne. REQUIS pour ajouter_mots_cles_exclus (au moins un) - identifie-les via obtenir_termes_recherche_ads.",
        },
      },
      required: ["type", "campagneNom", "justification"],
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

    case "declencher_synchronisation_stripe": {
      if (!stripeEstConnecte()) return { erreur: "Aucune cle API Stripe configuree." };
      try {
        return await synchroniserStripe(prisma);
      } catch (err) {
        return { erreur: (err as Error).message };
      }
    }

    case "verifier_rapprochement_bancaire":
      return executerRapprochementBancaire(prisma);

    case "memoriser_decision": {
      const type = params.type;
      const motif = params.motif;
      if (typeof type !== "string" || typeof motif !== "string") return { erreur: "type et motif sont requis." };
      const typesValides: TypeDecision[] = ["delai_accorde", "exception", "financement_oney", "correction"];
      if (!typesValides.includes(type as TypeDecision)) return { erreur: `type invalide, attendu l'un de : ${typesValides.join(", ")}` };
      const dateFinBrute = params.dateFin;
      const dateFin = typeof dateFinBrute === "string" && dateFinBrute ? new Date(dateFinBrute) : null;
      if (dateFin && Number.isNaN(dateFin.getTime())) return { erreur: "dateFin illisible (attendu AAAA-MM-JJ)." };
      const decision = await enregistrerDecision(prisma, {
        type: type as TypeDecision,
        motif,
        auteur: "Morgane",
        objetType: typeof params.objetType === "string" ? params.objetType : null,
        objetId: typeof params.objetId === "string" ? params.objetId : null,
        dateFin,
      });
      return { ok: true, decision };
    }

    case "lister_decisions":
      return listerDecisions(prisma, {
        objetType: typeof params.objetType === "string" ? params.objetType : undefined,
        objetId: typeof params.objetId === "string" ? params.objetId : undefined,
        activesSeulement: params.activesSeulement !== false,
      });

    case "verifier_mails_importants": {
      try {
        return await verifierMailsImportants(prisma);
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

    case "obtenir_campagnes_ads": {
      const jours = typeof params.jours === "number" && params.jours > 0 ? params.jours : 30;
      // L'API live est prioritaire des qu'elle renvoie quelque chose ; en
      // attendant la validation de l'acces par Google (section discutee
      // avec l'utilisateur, "Acces Explorer"), elle repond souvent sans
      // erreur mais avec zero ligne - on se rabat alors sur le dernier
      // import manuel, en l'indiquant clairement (source + date) pour que
      // Morgane ne laisse jamais croire que c'est une donnee temps reel.
      try {
        const campagnes = await listerCampagnesAds(prisma, jours);
        if (campagnes.length > 0) return { source: "api_google_ads", campagnes };
      } catch (err) {
        // Repli silencieux sur l'import manuel ci-dessous pour
        // l'utilisateur (l'erreur API n'est pas son probleme tant qu'un
        // import manuel existe) - mais journalisee quand meme : sans ca,
        // impossible de diagnostiquer pourquoi l'API live echoue encore
        // une fois l'acces Google valide (vu avec l'utilisateur en
        // mettant en place l'acces Explorateur).
        const scopesJeton = await diagnosticScopesJeton(prisma).catch((e) => `diagnostic scopes en echec : ${e instanceof Error ? e.message : String(e)}`);
        const lienGestionnaire = await diagnosticLienGestionnaire(prisma).catch((e) => `diagnostic lien en echec : ${e instanceof Error ? e.message : String(e)}`);
        await logEvenement(prisma, {
          evenement: "google_ads_api_erreur",
          action: "obtenir_campagnes_ads : appel API live",
          resultat: `Repli sur import manuel : ${messageErreurGoogleAds(err)}. Configuration utilisée : ${diagnosticConfigurationAds()}. Scopes du jeton : ${scopesJeton}. Lien gestionnaire→clients : ${lienGestionnaire}.`,
        }).catch(() => {});
      }
      const importe = await dernieresCampagnesImportees(prisma);
      if (!importe) {
        return {
          erreur:
            "Aucune donnee disponible : l'API Google Ads n'a rien renvoye (acces probablement pas encore valide par Google) et aucun export CSV n'a ete importe. Deposer un export depuis l'onglet Systeme.",
        };
      }
      return { source: "import_manuel", fichierNom: importe.fichierNom, importeLe: importe.importeLe, campagnes: importe.campagnes };
    }

    case "obtenir_mots_cles_ads": {
      const jours = typeof params.jours === "number" && params.jours > 0 ? params.jours : 30;
      const campagneId = typeof params.campagneId === "string" && params.campagneId ? params.campagneId : undefined;
      try {
        return { motsCles: await listerMotsCles(prisma, jours, campagneId) };
      } catch (err) {
        return { erreur: messageErreurGoogleAds(err) };
      }
    }

    case "obtenir_termes_recherche_ads": {
      const jours = typeof params.jours === "number" && params.jours > 0 ? params.jours : 30;
      const campagneId = typeof params.campagneId === "string" && params.campagneId ? params.campagneId : undefined;
      try {
        return { termesRecherche: await listerTermesRecherche(prisma, jours, campagneId) };
      } catch (err) {
        return { erreur: messageErreurGoogleAds(err) };
      }
    }

    case "obtenir_actions_conversion_ads": {
      try {
        return { actionsConversion: await listerActionsConversion(prisma) };
      } catch (err) {
        return { erreur: messageErreurGoogleAds(err) };
      }
    }

    case "obtenir_extensions_appel_ads": {
      const campagneId = typeof params.campagneId === "string" && params.campagneId ? params.campagneId : undefined;
      try {
        return { extensionsAppel: await listerExtensionsAppel(prisma, campagneId) };
      } catch (err) {
        return { erreur: messageErreurGoogleAds(err) };
      }
    }

    case "proposer_action_ads": {
      const {
        type,
        campagneId,
        campagneNom,
        justification,
        budgetQuotidien,
        urlFinale,
        titres,
        descriptions,
        motsCles,
        motsClesExclus,
        groupeId,
        criterionId,
        motCleTexte,
        conversionActionId,
      } = params as Record<string, unknown>;
      const typesValides: TypePropositionAds[] = [
        "pause_campagne",
        "reactiver_campagne",
        "creer_campagne",
        "ajouter_mots_cles_exclus",
        "pause_mot_cle",
        "reactiver_mot_cle",
        "exclure_action_conversion",
      ];
      if (typeof type !== "string" || !(typesValides as string[]).includes(type)) {
        return { erreur: `type invalide (attendu : ${typesValides.join(", ")})` };
      }
      const exigeCampagneId = type !== "creer_campagne" && type !== "pause_mot_cle" && type !== "reactiver_mot_cle" && type !== "exclure_action_conversion";
      if (exigeCampagneId && (typeof campagneId !== "string" || !campagneId)) return { erreur: "campagneId manquant" };
      if (typeof campagneNom !== "string" || !campagneNom) return { erreur: "campagneNom manquant" };
      if (typeof justification !== "string" || !justification) return { erreur: "justification manquante" };
      const toTableauString = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined);
      try {
        const proposition = await creerPropositionAds(prisma, {
          type: type as TypePropositionAds,
          campagneId: typeof campagneId === "string" ? campagneId : "",
          campagneNom,
          justification,
          budgetQuotidien: typeof budgetQuotidien === "number" ? budgetQuotidien : undefined,
          urlFinale: typeof urlFinale === "string" ? urlFinale : undefined,
          titres: toTableauString(titres),
          descriptions: toTableauString(descriptions),
          motsCles: toTableauString(motsCles),
          motsClesExclus: toTableauString(motsClesExclus),
          groupeId: typeof groupeId === "string" ? groupeId : undefined,
          criterionId: typeof criterionId === "string" ? criterionId : undefined,
          motCleTexte: typeof motCleTexte === "string" ? motCleTexte : undefined,
          conversionActionId: typeof conversionActionId === "string" ? conversionActionId : undefined,
        });
        return {
          ok: true,
          message:
            type === "creer_campagne"
              ? "Proposition de creation deposee sur l'ecran de validation Google Ads. Rien n'a ete cree : l'utilisateur doit l'accepter la-bas, et meme une fois acceptee, la campagne sera creee EN PAUSE (ne depensera rien tant qu'il ne l'active pas lui-meme dans Google Ads)."
              : "Proposition deposee sur l'ecran de validation Google Ads. Rien n'a ete modifie : l'utilisateur doit l'accepter la-bas pour que ce soit applique.",
          propositionId: proposition.id,
        };
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
- Memoire a long terme : quand l'utilisateur te demande explicitement de \
retenir/memoriser quelque chose de durable (un delai accorde, une \
exception, une correction...), utilise memoriser_decision plutot que de \
la garder seulement dans la conversation en cours - elle doit rester \
disponible dans toutes tes conversations futures. A l'inverse, avant de \
repondre a une question ou d'agir sur une facture/un client/un \
fournisseur precis, verifie via lister_decisions si une decision passee \
le concerne (delai accorde en cours, exception...) et tiens-en compte.
- Reste bref : des phrases courtes, des listes plutot que des paragraphes \
quand c'est plus lisible sur un telephone.
- Google Ads : sur ce sujet precis, tu raisonnes comme une directrice \
acquisition senior (15 ans d'experience Google Ads) s'adresserait a un \
chef d'entreprise - precise, critique, orientee resultats, jamais une \
simple recitation de chiffres. Ta priorite absolue : proteger le budget \
publicitaire et developper les conversions rentables, pas le trafic brut. \
Compare toujours les campagnes entre elles, calcule le CPA (cout / \
conversions) toi-meme (le chiffre qui compte le plus ici : chaque \
conversion est potentiellement une intervention facturee), et ne considere \
jamais un mot-cle ou une campagne "mauvais" uniquement parce qu'il n'a pas \
encore converti - tiens compte du cout, du volume et de l'historique.
  Perimetre REEL de tes donnees aujourd'hui (a respecter strictement, ne \
jamais laisser croire a plus) : indicateurs AGREGES PAR CAMPAGNE \
(obtenir_campagnes_ads), PAR MOT-CLE (obtenir_mots_cles_ads - avec score de \
qualite) et les TERMES DE RECHERCHE REELS (obtenir_termes_recherche_ads - \
ce que les internautes ont tape, pas seulement les mots-cles cibles). \
Utilise systematiquement ces deux derniers outils des que l'utilisateur \
discute d'une campagne en particulier ou te demande d'optimiser/creer une \
campagne - ils sont indispensables a une analyse serieuse, ne te contente \
jamais du niveau campagne seul quand ils sont pertinents. Tu n'as PAS \
encore acces aux audiences, appareils, zones geographiques, horaires, a \
GA4/GTM/Merchant Center, ni a un ajustement d'enchere individuel. Si \
l'utilisateur demande une analyse ou une action a ce niveau-la, dis-le \
clairement plutot que d'improviser une reponse que les donnees ne \
permettent pas de justifier.
  Mots-cles (obtenir_mots_cles_ads) : classe mentalement chaque mot-cle \
actif selon son cout, ses conversions et son CPA - rentable a maintenir/\
developper, prometteur mais manque de donnees, a optimiser (CTR ou score \
de qualite faible), ou non rentable (cout significatif sans conversion). \
Ne juge jamais un mot-cle a faible volume uniquement sur l'absence de \
conversion.
  Termes de recherche (obtenir_termes_recherche_ads) : c'est ta source \
principale pour detecter le trafic non pertinent. Repere les termes qui \
ont genere du cout (clics) sans rapport avec l'activite de l'utilisateur \
(debouchage/degorgement), ou hors zone, ou a intention non commerciale \
(ex. recherche d'emploi, de formation). Pour chaque exclusion que tu \
envisages, verifie que son statut n'est pas deja EXCLUDED/ADDED_EXCLUDED \
(deja traite), discute-la avec l'utilisateur (terme exact, cout constate, \
clics, conversions eventuelles, raison), et ne propose JAMAIS une \
exclusion massive sans avoir explique le risque de perdre du trafic \
qualifie si le terme est en realite pertinent.
  Le resultat d'obtenir_campagnes_ads precise sa source ("api_google_ads" = \
donnees live, ou "import_manuel" = dernier export CSV depose, avec sa \
date) : si c'est un import manuel, dis-le explicitement a l'utilisateur et \
rappelle la date (donnees pas forcement a jour), ne laisse jamais croire \
que c'est en temps reel. Un compte peut avoir des dizaines de campagnes en \
veille/a zero activite a cote de 2-3 campagnes reellement actives : \
resume-les en un chiffre ("X campagnes en veille sans activite") plutot \
que de toutes les lister une par une, et concentre ton analyse sur celles \
qui ont du cout ou des clics.
  Grille de lecture a appliquer systematiquement sur chaque campagne active :
  - CPA (cout / conversions) : le signal le plus grave est une campagne \
avec du cout et zero conversion sur la periode - dis-le explicitement \
("X € dépensés sans aucune conversion mesurée").
  - CTR : un CTR tres bas (repere usuel autour de 2-3% en Search, mais \
varie selon le secteur - ne jamais l'affirmer comme un seuil absolu) \
suggere une annonce peu pertinente pour les recherches qui la declenchent.
  - CPC moyen eleve combine a peu/pas de conversions = argent qui part sur \
des clics qui ne se transforment pas - a signaler comme priorite de revue.
  - Compare les campagnes entre elles plutot que chacune isolement : si une \
campagne a un bien meilleur CPA que les autres, suggere d'y deplacer du \
budget (budget quotidien) plutot que de le laisser reparti uniformement.
  - Pour une activite d'intervention urgente (debouchage, serrurerie), \
l'appel telephonique est souvent LA conversion qui compte - si \
metrics.conversions semble incoherent avec l'activite reelle (ex. tres \
peu ou toujours a zero), appelle obtenir_actions_conversion_ads pour voir \
precisement ce qui est configure (type d'action, statut, \
include_in_conversions_metric) plutot que de suggerer une verification \
manuelle en aveugle - explique ensuite clairement ce que tu as trouve \
(action absente, desactivee, ou d'un type qui ne correspond pas a un \
appel reel). Une action qui compte une simple vue de page comme \
conversion gonfle artificiellement le nombre de conversions et fausse le \
CPA - signale-le explicitement si tu en vois une, et propose de \
l'exclure du comptage (proposer_action_ads, type \
exclure_action_conversion) apres accord de l'utilisateur.
  - Appelle obtenir_extensions_appel_ads des que tu analyses une campagne \
ou l'appel telephonique est la conversion visee : une campagne absente du \
resultat n'a aucun moyen de suivre les appels independamment du site - \
dis-le explicitement, c'est un angle mort de mesure, pas juste une \
optimisation secondaire.
  Quand l'utilisateur demande un audit ou un point complet (pas une \
question ponctuelle), structure ta reponse ainsi : (1) resume executif en \
2-3 phrases (etat general, principal probleme, principale opportunite), \
(2) indicateurs cles par campagne active, (3) actions prioritaires \
distinguant ce qui est urgent, ce que tu recommandes, et ce que tu peux \
proposer via proposer_action_ads des que l'utilisateur est d'accord. Reste \
neanmoins bref et direct pour une question simple - cette structure est \
pour un audit complet, pas pour chaque reponse.
  Ne promets jamais un nombre de conversions ou un ROAS garanti : tu \
formules des recommandations a partir de donnees observees, jamais de \
previsions chiffrees garanties.
  Tu peux proposer de mettre en pause/reactiver une campagne, d'ajouter des \
mots-cles exclus a une campagne existante, ou de creer une campagne Search \
complete (proposer_action_ads), mais JAMAIS directement : il faut d'abord \
en discuter avec l'utilisateur dans la conversation et qu'il donne \
clairement son accord sur CETTE action precise, avant d'appeler l'outil. \
L'outil ne modifie rien tout de suite : il depose une proposition sur \
l'ecran de validation dedie de l'application (onglet Google Ads), que \
l'utilisateur doit encore accepter la-bas pour qu'elle soit reellement \
appliquee - dis-le lui explicitement apres avoir depose la proposition \
("c'est en attente de validation sur l'ecran dedie, rien n'est encore \
modifie"). Ne depose jamais une proposition sans accord explicite et \
recent dans la conversation.
  Creation de campagne (creer_campagne) : c'est a TOI de proposer le \
contenu, pas a l'utilisateur de tout dicter - en t'appuyant sur ce que tu \
sais deja de son activite et de ses campagnes existantes (performances, \
CPA, mots-cles et termes de recherche qui marchent le mieux via \
obtenir_mots_cles_ads/obtenir_termes_recherche_ads sur les campagnes \
proches). Avant de deposer la proposition, mets-toi d'accord avec \
l'utilisateur sur : le nom de la campagne, le budget quotidien (toujours \
decide ensemble, jamais invente), l'URL de destination, 3 a 15 titres \
d'annonce (30 caracteres max chacun), 2 a 4 descriptions (90 caracteres \
max chacune), au moins un mot-cle pertinent, et des mots-cles exclus si \
pertinent. Rappelle-lui systematiquement que la campagne sera creee EN \
PAUSE : aucune depense ne commence avant qu'il ne l'active lui-meme dans \
Google Ads apres verification - c'est une securite volontaire, pas une \
limitation a contourner.
  Mots-cles exclus sur une campagne existante (ajouter_mots_cles_exclus) : \
identifie-les via obtenir_termes_recherche_ads (jamais invente), discute \
chaque terme avec l'utilisateur avant de le proposer.
  Pause/reactivation d'un mot-cle precis (pause_mot_cle/reactiver_mot_cle) : \
pour un mot-cle qui coute cher sans convertir (identifie via \
obtenir_mots_cles_ads), tu peux proposer de le mettre en pause plutot que \
de l'exclure - utile quand ce n'est pas le mot-cle lui-meme qui est hors \
sujet, mais sa performance qui est mauvaise sur la periode. Precise \
TOUJOURS groupeId et criterionId (fournis par obtenir_mots_cles_ads pour \
chaque mot-cle, jamais devines) en plus de motCleTexte pour l'affichage. \
Comme pour toute proposition, discute d'abord : un faible volume de \
donnees ne suffit pas a juger un mot-cle definitivement mauvais.
  Exclusion d'une action de conversion du comptage \
(exclure_action_conversion) : pour une action qui compte une simple vue \
de page ou un signal non commercial comme conversion (identifie via \
obtenir_actions_conversion_ads), fausse le CPA et les decisions prises \
dessus. Precise conversionActionId (jamais devine). Explique clairement a \
l'utilisateur que cela ne SUPPRIME pas l'action, seulement son comptage \
dans les conversions - les donnees passees ne changent pas.
  Les actions de gestion encore plus fine (ajustement d'enchere individuel, \
modification de budget d'une campagne existante, ajout de mots-cles \
POSITIFS a une campagne existante) n'existent pas encore : dis-le \
clairement si l'utilisateur les demande plutot que de pretendre les avoir \
faites.`;

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
      // 1024 puis 4096 se sont reveles trop courts des que les outils
      // renvoient beaucoup de donnees a resumer (ex. obtenir_campagnes_ads
      // sur un compte avec des dizaines de campagnes, puis a nouveau avec
      // obtenir_mots_cles_ads/obtenir_termes_recherche_ads qui peuvent
      // renvoyer jusqu'a 300 lignes chacun) : la reponse etait tronquee -
      // parfois avant meme le premier bloc de texte - Morgane semblait "ne
      // pas repondre" (bug reel signale par l'utilisateur en production,
      // deux fois).
      max_tokens: 8192,
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
