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
  obtenirSnippetConversion,
  listerPerformanceAnnonces,
  verifierPolitiqueAnnonces,
  verifierPolitiqueAssets,
  rechercherAudiences,
  diagnostiquerAudience,
  listerMotsClesConfigures,
  messageErreurGoogleAds,
  diagnosticConfigurationAds,
  diagnosticScopesJeton,
  diagnosticLienGestionnaire,
} from "./googleAds";
import { dernieresCampagnesImportees } from "./googleAdsImport";
import { auditerSiteWeb, analyserPageDestination } from "./referencementAudit";
import { creerPropositionAds, TypePropositionAds } from "./googleAdsActions";
import { SitelinkAds, StructuredSnippetAds, StrategieEncheres, HoraireAds, AjustementAppareilAds } from "./googleAds";
import { creerPropositionPost, listerPropositionsPost } from "./reseauxSociauxActions";
import { obtenirStatistiquesPost, reseauxSociauxEstConfigure } from "./reseauxSociaux";
import { obtenirConnexionMeta } from "./metaAuth";
import { enregistrerDocumentDepuisPieceJointe, DocumentScanneError } from "./documentsScannes";
import { genererDocumentPdf, DocumentGenereError, SectionDocumentGenere } from "./documentsGeneres";
import { genererDossierComptable } from "./dossierComptable";

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

/**
 * Piece jointe (photo ou fichier) envoyee avec le DERNIER message de
 * l'historique uniquement - jamais stockee dans MessageMorgane.content,
 * qui reste du texte simple (voir repondreMorgane : les octets ne sont
 * utilises que pour ce tour, jamais renvoyes par le client au tour
 * suivant). Demande explicite de l'utilisateur ("Morgane ne peut pas
 * recevoir de photos ou fichiers").
 */
export interface PieceJointeMorgane {
  nomFichier: string;
  mimeType: string;
  donneesBase64: string;
}

// jpeg/png : formats geres a la fois par pdfkit (classement en document
// fournisseur, voir documentsScannes.ts) et par la vision Claude - pas de
// webp/heic, que pdfkit ne sait pas mettre en page. application/pdf est
// deja un document, transmis tel quel a Claude (bloc "document").
export const MIME_PIECES_JOINTES_AUTORISEES = ["image/jpeg", "image/png", "application/pdf"];

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
      "Retourne les actions de conversion CONFIGUREES au niveau du compte Google Ads (nom, type, categorie, statut, si elle compte pour l'objectif principal (comptePourObjectifPrincipal, ex-include_in_conversions_metric), duree minimale pour un appel telephonique). A utiliser des que le nombre de conversions semble incoherent avec l'activite reelle (ex. tres peu de conversions pour une activite ou l'appel telephonique est la vraie conversion) - permet de voir precisement CE QUI est compte, et si une action censee exister (appel, formulaire) est absente, mal configuree ou desactivee (comptePourObjectifPrincipal=false ou statut different de ENABLED). Lecture seule.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "obtenir_extensions_appel_ads",
    description:
      "Retourne les extensions d'appel (numero de telephone affiche dans l'annonce) liees a chaque campagne. suiviConversionAppel indique si le suivi est actif : \"DISABLED\" = pas de suivi, \"USE_ACCOUNT_LEVEL_CALL_CONVERSION_ACTION\" = suit via l'action de conversion du compte (bon signe, ca marche), \"USE_RESOURCE_LEVEL_CALL_CONVERSION_ACTION\" = action dediee a cette extension. Une campagne ABSENTE du resultat n'a PAS d'extension d'appel configuree. Precise campagneId pour te concentrer sur une seule campagne. Lecture seule.",
    input_schema: {
      type: "object",
      properties: {
        campagneId: { type: "string", description: "Limiter a une campagne precise (campaign.id, voir obtenir_campagnes_ads). Omis = toutes les campagnes." },
      },
    },
  },
  {
    name: "obtenir_snippet_conversion_ads",
    description:
      "Retourne le code pret a coller (balise globale + extrait d'evenement JavaScript) fourni directement par Google Ads pour une action de conversion WEB donnee (CLICK_TO_CALL ou WEBPAGE, creee via proposer_action_ads type creer_action_conversion_site). A utiliser UNIQUEMENT une fois cette action de conversion creee et acceptee sur l'ecran de validation - sinon aucun code n'existe encore. Donne ce code textuellement et integralement a l'utilisateur pour qu'il le fasse ajouter sur son site (lui-meme ou via la plateforme qui l'a construit) : ne jamais le reformuler ou le resumer, c'est du code exact a copier-coller. Lecture seule.",
    input_schema: {
      type: "object",
      properties: {
        conversionActionId: { type: "string", description: "Identifiant de l'action de conversion (id, voir obtenir_actions_conversion_ads ou le resultat de la creation)." },
      },
      required: ["conversionActionId"],
    },
  },
  {
    name: "obtenir_performance_annonces_ads",
    description:
      "Retourne la performance de CHAQUE ANNONCE individuelle d'un groupe d'annonces (titres, descriptions, statut, impressions, clics, cout, conversions, CTR). Indispensable pour comparer des variantes de test A/B (voir proposer_action_ads, type ajouter_annonce_test) - sans ca, impossible de dire laquelle fonctionne mieux. Lecture seule.",
    input_schema: {
      type: "object",
      properties: {
        groupeId: { type: "string", description: "Identifiant du groupe d'annonces (ad_group.id, voir obtenir_mots_cles_ads)." },
        jours: { type: "number", description: "Nombre de jours a analyser en arriere (30 par defaut)." },
      },
      required: ["groupeId"],
    },
  },
  {
    name: "auditer_referencement_site",
    description:
      "Analyse une page web en lecture seule : balises SEO (titre, meta description, canonical, viewport), presence de donnees structurees (schema.org/JSON-LD), presence REELLE de robots.txt/sitemap.xml/llms.txt (distingue un vrai fichier du HTML de secours d'une application monopage), robots IA explicitement bloques dans robots.txt (GPTBot, ClaudeBot, PerplexityBot...), et surtout renduCoteClientUniquement : indique si le contenu de la page n'existe QUE via JavaScript execute par le navigateur - critique car la plupart des robots IA (contrairement a Googlebot) n'executent PAS le JavaScript, donc un site 'renduCoteClientUniquement=true' peut etre invisible pour ChatGPT/Perplexity/Claude meme s'il est correct pour Google. N'ACCEDE PAS au code du site (herberge ailleurs, souvent sur une plateforme tierce comme Emergent) : analyse uniquement ce qui est publiquement expose, comme un robot le verrait. Lecture seule - ne modifie jamais rien.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL complete de la page a analyser (ex. https://fichet-depannage.fr/)." },
      },
      required: ["url"],
    },
  },
  {
    name: "analyser_page_destination_ads",
    description:
      "Analyse une page de destination d'annonce (lecture seule, sans navigateur) sous l'angle de la conversion : temps de reponse, adaptation mobile, numero(s) de telephone cliquables (liens tel:), presence d'un formulaire, mots d'appel a l'action trouves dans le texte visible (appelez, devis, contactez...), et si le contenu n'existe qu'en JavaScript (invisible sans executer le site). CE N'EST PAS une mesure de taux de conversion reel (ca demanderait les donnees Google Ads/Analytics, pas le HTML) - uniquement des signaux structurels qui, s'ils manquent (pas de telephone cliquable, aucun appel a l'action), expliquent souvent un mauvais taux de conversion malgre un bon trafic publicitaire. N'accede pas au code du site. Lecture seule.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL complete de la page de destination a analyser." },
      },
      required: ["url"],
    },
  },
  {
    name: "verifier_politique_annonces_ads",
    description:
      "Retourne le statut d'approbation reel (APPROVED/APPROVED_LIMITED/DISAPPROVED...) et les sujets de politique (ex. TRADEMARKS_IN_AD_TEXT, LOCAL_SERVICES_AD) des annonces EXISTANTES, regroupes par campagne (nombre d'annonces concernees, pas le detail annonce par annonce). Utile pour comparer une campagne qui diffuse deja a une campagne bloquee a la creation (ex. erreur POLICY_ERROR sur un mot-cle) - permet de voir si le compte porte une restriction visible sur ses annonces deja actives, ou si le probleme est specifique a la nouvelle tentative. IMPORTANT : si le compte a plus de quelques campagnes, precise TOUJOURS campagneId pour cibler la campagne pertinente (ex. celle qui diffuse deja) plutot que d'interroger tout le compte, qui peut etre tres volumineux. Lecture seule.",
    input_schema: {
      type: "object",
      properties: {
        campagneId: { type: "string", description: "Limiter a une campagne precise (campaign.id, voir obtenir_campagnes_ads). Omis = toutes les campagnes." },
      },
    },
  },
  {
    name: "verifier_politique_assets_ads",
    description:
      "Retourne le statut d'approbation reel et les sujets de politique des ASSETS (sitelinks, accroches/callouts, extensions d'appel...), avec leur texte ET leur description exacts (y compris les descriptions de sitelinks, souvent oubliees) - par opposition a verifier_politique_annonces_ads, qui ne couvre QUE les annonces. Chaque asset porte aussi contientNumeroTelephone (detection automatique d'une sequence de chiffres dans le texte ou la description) - verifie ce champ en PRIORITE si l'utilisateur signale un refus Google Ads pour politique 'Numero de telephone dans un texte d'annonce' : ca identifie directement le bon asset sans relire chaque ligne a la main. Indispensable aussi pour 'Services locaux' : ce refus porte souvent sur un sitelink/accroche, pas sur l'annonce elle-meme, et verifier_politique_annonces_ads ne le detecte pas. Compte entier, pas de filtre par campagne (un asset peut etre partage). Lecture seule.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "rechercher_audiences_ads",
    description:
      "Cherche, pour chaque terme donne, une categorie d'audience Google Ads existante (user_interest) dont le nom contient ce terme, et retourne son nom EXACT tel que Google le connait. Indispensable AVANT de proposer ajouter_audiences_campagne avec un nom invente ou traduit litteralement (ex. 'Securite domestique') : Google ne resout que son propre libelle exact, et un nom sans correspondance fait echouer tout l'ajout d'audiences (pas seulement celui-la). Essaie plusieurs termes courts et varies (francais et anglais, singulier/pluriel, synonymes) si le premier essai ne trouve rien - c'est une recherche par 'contient', pas une resolution intelligente. Lecture seule, aucune modification.",
    input_schema: {
      type: "object",
      properties: {
        termes: { type: "array", items: { type: "string" }, description: "Termes a chercher, ex. ['demenagement', 'moving', 'securite', 'alarm', 'bricolage', 'home improvement']." },
      },
      required: ["termes"],
    },
  },
  {
    name: "diagnostiquer_audience_ads",
    description:
      "Diagnostic BRUT (lecture seule) de tous les centres d'interet Google correspondant a UN terme : type de taxonomie (AFFINITY/IN_MARKET/...), si lance pour tous les canaux, disponibilites detaillees par canal, et si notre filtre actuel le juge eligible au reseau Search. A utiliser quand rechercher_audiences_ads ou ajouter_audiences_campagne renvoie INVALID_USER_INTEREST malgre un nom trouve : permet de voir les vraies donnees Google pour comprendre pourquoi, au lieu de deviner une nouvelle hypothese. Ne cherche qu'UN terme a la fois (contrairement a rechercher_audiences_ads). Aucune modification.",
    input_schema: {
      type: "object",
      properties: {
        terme: { type: "string", description: "Un seul terme a diagnostiquer, ex. 'Locks & Locksmiths'." },
      },
      required: ["terme"],
    },
  },
  {
    name: "lister_mots_cles_configures_ads",
    description:
      "Liste les mots-cles REELLEMENT CONFIGURES sur une campagne (texte, type de correspondance, statut, statut d'approbation), SANS filtre d'activite. A utiliser pour verifier qu'une campagne a bien ete creee avec ses mots-cles - obtenir_mots_cles_ads (base sur les statistiques) renvoie TOUJOURS une liste vide pour une campagne en pause ou tout juste creee, meme si ses mots-cles existent, car il exige des impressions > 0. Lecture seule.",
    input_schema: {
      type: "object",
      properties: {
        campagneId: { type: "string", description: "Campagne a verifier (campaign.id, voir obtenir_campagnes_ads)." },
      },
      required: ["campagneId"],
    },
  },
  {
    name: "proposer_action_ads",
    description:
      "Enregistre une proposition d'action Google Ads (pause/reactivation d'une campagne OU d'un mot-cle precis, ajout de mots-cles exclus OU positifs, modification du budget d'une campagne existante, exclusion d'une action de conversion du comptage, creation d'une action de conversion WEB (clic a appeler ou formulaire), ajustement des encheres par appareil, suppression definitive d'une campagne, OU creation complete d'une nouvelle campagne Search), APRES que l'utilisateur ait clairement donne son accord dans la conversation sur cette action precise. N'execute RIEN directement : la proposition est deposee sur l'ecran de validation dedie de l'application (onglet Google Ads), ou l'utilisateur doit explicitement l'accepter avant qu'elle ne soit appliquee. Ne jamais appeler cet outil sans accord explicite et recent de l'utilisateur. Pour creer_campagne : une campagne complete est toujours creee EN PAUSE (securite demandee par l'utilisateur) - elle ne depensera rien tant qu'il ne l'active pas lui-meme dans Google Ads apres verification ; dis-le lui. Pour supprimer_campagne : operation IRREVERSIBLE (contrairement a pause_campagne) - la campagne ne peut plus etre reactivee ni modifiee ensuite. Assure-toi que l'utilisateur comprend bien ce caractere definitif avant de deposer cette proposition, et prefere pause_campagne si un doute existe sur son intention reelle.",
    input_schema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: [
            "pause_campagne",
            "reactiver_campagne",
            "creer_campagne",
            "ajouter_mots_cles_exclus",
            "pause_mot_cle",
            "reactiver_mot_cle",
            "exclure_action_conversion",
            "creer_action_conversion_site",
            "modifier_budget_campagne",
            "ajouter_mots_cles_positifs",
            "ajouter_extensions_campagne",
            "modifier_strategie_encheres",
            "definir_horaires_campagne",
            "ajouter_audiences_campagne",
            "ajouter_annonce_test",
            "supprimer_campagne",
            "ajuster_encheres_appareil",
          ],
          description: "Action proposee.",
        },
        typeConversionSite: {
          type: "string",
          enum: ["CLICK_TO_CALL", "WEBPAGE"],
          description:
            "REQUIS pour creer_action_conversion_site. CLICK_TO_CALL = clic sur le numero de telephone affiche sur le site (approxime une intention d'appel, pas une duree d'appel confirmee). WEBPAGE = envoi d'un formulaire/page de confirmation.",
        },
        campagneId: {
          type: "string",
          description:
            "Identifiant Google Ads de la campagne existante (campaign.id, voir obtenir_campagnes_ads). Requis pour pause_campagne/reactiver_campagne/ajouter_mots_cles_exclus/modifier_budget_campagne/ajouter_mots_cles_positifs/ajouter_extensions_campagne/modifier_strategie_encheres/definir_horaires_campagne/ajouter_audiences_campagne. Omis/vide pour creer_campagne (elle n'existe pas encore), pour pause_mot_cle/reactiver_mot_cle/ajouter_annonce_test (groupeId suffit), pour exclure_action_conversion et creer_action_conversion_site (actions au niveau du compte, pas d'une campagne).",
        },
        conversionActionId: {
          type: "string",
          description: "Identifiant de l'action de conversion (id, voir obtenir_actions_conversion_ads). REQUIS pour exclure_action_conversion.",
        },
        groupeId: {
          type: "string",
          description: "Identifiant du groupe d'annonces (ad_group.id, voir obtenir_mots_cles_ads). REQUIS pour pause_mot_cle/reactiver_mot_cle/ajouter_mots_cles_positifs/ajouter_annonce_test.",
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
          description:
            "Nom de la campagne (existante, ou nom propose pour une nouvelle campagne). Pour exclure_action_conversion : nom de l'action de conversion concernee (affichage). Pour creer_action_conversion_site : nom a donner a la nouvelle action de conversion.",
        },
        justification: {
          type: "string",
          description: "Resume en langage clair de pourquoi cette action est proposee, affiche a l'utilisateur sur l'ecran de validation.",
        },
        budgetQuotidien: {
          type: "number",
          description:
            "Budget quotidien en euros, decide avec l'utilisateur dans la conversation. REQUIS pour creer_campagne (budget initial) et modifier_budget_campagne (nouveau budget).",
        },
        urlFinale: { type: "string", description: "Page de destination des annonces (URL complete). Pour creer_campagne et ajouter_annonce_test (REQUIS dans ce dernier cas)." },
        titres: {
          type: "array",
          items: { type: "string" },
          description: "Entre 3 et 15 titres d'annonce (30 caracteres max chacun, contrainte Google Ads). Pour creer_campagne et ajouter_annonce_test.",
        },
        descriptions: {
          type: "array",
          items: { type: "string" },
          description: "Entre 2 et 4 descriptions d'annonce (90 caracteres max chacune, contrainte Google Ads). Pour creer_campagne et ajouter_annonce_test.",
        },
        motsCles: {
          type: "array",
          items: { type: "string" },
          description: "Mots-cles pertinents a cibler (au moins un). REQUIS pour creer_campagne et ajouter_mots_cles_positifs.",
        },
        motsClesExclus: {
          type: "array",
          items: { type: "string" },
          description:
            "Mots-cles exclus (negatifs) a ajouter. Optionnel pour creer_campagne. REQUIS pour ajouter_mots_cles_exclus (au moins un) - identifie-les via obtenir_termes_recherche_ads.",
        },
        ciblesGeographiques: {
          type: "array",
          items: { type: "string" },
          description:
            "Noms de lieux a cibler (ex. \"Île-de-France\", \"Seine-et-Marne\", \"Lyon\"), resolus automatiquement en identifiants Google au moment de la creation - jamais d'identifiant numerique a deviner toi-meme. Optionnel pour creer_campagne : omis, la campagne n'a aucune restriction geographique (cible par defaut selon les parametres du compte).",
        },
        numeroTelephone: {
          type: "string",
          description:
            "Numero de telephone (ex. \"0972574450\") pour lequel creer une extension d'appel liee des la creation de la campagne, avec suivi de conversion d'appel au niveau du compte active par defaut. Optionnel pour creer_campagne - sans lui, la campagne n'a aucun moyen de suivre les appels independamment du site tant que l'utilisateur ne l'ajoute pas lui-meme.",
        },
        typeCorrespondance: {
          type: "string",
          enum: ["EXACT", "PHRASE", "BROAD"],
          description:
            "Type de correspondance applique a TOUS les mots-cles de motsCles (pas de reglage par mot-cle individuel aujourd'hui). Optionnel pour creer_campagne et ajouter_mots_cles_positifs - PHRASE par defaut si omis (plus sur pour le budget que BROAD, moins restrictif que EXACT).",
        },
        sitelinks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              texte: { type: "string", description: "Libelle affiche du lien (1 a 25 caracteres)." },
              description1: { type: "string", description: "1ere ligne de description (1 a 35 caracteres) - optionnelle, mais doit etre accompagnee de description2." },
              description2: { type: "string", description: "2e ligne de description (1 a 35 caracteres) - optionnelle, mais doit etre accompagnee de description1." },
              url: { type: "string", description: "Page de destination du lien - si omise, reutilise l'URL finale de la campagne." },
            },
            required: ["texte"],
          },
          description: "Liens d'accroche (sitelinks) a creer et lier. Optionnel pour creer_campagne et ajouter_extensions_campagne.",
        },
        callouts: {
          type: "array",
          items: { type: "string" },
          description: "Accroches courtes (callouts, 1 a 25 caracteres chacune, ex. 'Intervention rapide'). Optionnel pour creer_campagne et ajouter_extensions_campagne.",
        },
        structuredSnippets: {
          type: "array",
          items: {
            type: "object",
            properties: {
              header: { type: "string", description: "Categorie Google predefinie (ex. 'Services', 'Types', 'Marques') - ne pas inventer une categorie hors de la liste officielle de Google." },
              valeurs: { type: "array", items: { type: "string" }, description: "3 a 10 valeurs, 1 a 25 caracteres chacune." },
            },
            required: ["header", "valeurs"],
          },
          description: "Extraits structures (structured snippets) a creer et lier. Optionnel pour creer_campagne et ajouter_extensions_campagne.",
        },
        strategieEncheres: {
          type: "string",
          enum: ["MAXIMIZE_CONVERSIONS", "TARGET_CPA", "MANUAL_CPC"],
          description:
            "Strategie d'encheres. MAXIMIZE_CONVERSIONS (defaut) : Google optimise automatiquement pour le nombre de conversions. TARGET_CPA : vise un cout par acquisition precis (necessite cpaCibleEuros). MANUAL_CPC : CPC optimise (enhanced), moins automatise. Optionnel pour creer_campagne, REQUIS pour modifier_strategie_encheres.",
        },
        cpaCibleEuros: {
          type: "number",
          description: "Cout par acquisition cible en euros. REQUIS si strategieEncheres = TARGET_CPA, ignore sinon.",
        },
        horaires: {
          type: "array",
          items: {
            type: "object",
            properties: {
              jour: { type: "string", enum: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"] },
              heureDebut: { type: "number", description: "0 a 23." },
              minuteDebut: { type: "number", enum: [0, 15, 30, 45], description: "Optionnel, defaut 0. Google n'accepte que 0/15/30/45." },
              heureFin: { type: "number", description: "1 a 24 (24 = minuit)." },
              minuteFin: { type: "number", enum: [0, 15, 30, 45], description: "Optionnel, defaut 0." },
            },
            required: ["jour", "heureDebut", "heureFin"],
          },
          description:
            "Plages horaires de diffusion (dayparting). Sans ceci, la campagne diffuse sans restriction horaire (24h/24, 7j/7). Optionnel pour creer_campagne, REQUIS (au moins une plage) pour definir_horaires_campagne.",
        },
        audiences: {
          type: "array",
          items: { type: "string" },
          description:
            "Noms de centres d'interet (en francais OU en anglais - rechercher_audiences_ads traduit automatiquement les themes courants du metier : securite, demenagement, bricolage, serrurier, proprietaire, etc.) a resoudre puis attacher en SIGNAL D'OBSERVATION (n'exclut ni ne restreint qui voit l'annonce sur une campagne Search - sert a ajuster les encheres et analyser la performance par segment). Ce n'est PAS du remarketing (reciblage des visiteurs du site) : ca necessiterait une balise sur le site, absente aujourd'hui - ne jamais presenter ceci comme du remarketing a l'utilisateur. Utilise TOUJOURS rechercher_audiences_ads d'abord pour verifier les noms exacts trouves par Google avant de les inclure ici. Optionnel pour creer_campagne, REQUIS (au moins un) pour ajouter_audiences_campagne.",
        },
        ajustementsAppareil: {
          type: "array",
          items: {
            type: "object",
            properties: {
              appareil: { type: "string", enum: ["MOBILE", "TABLET", "DESKTOP"] },
              pourcentage: { type: "number", description: "Entre -90 et +900. Ex. -20 pour reduire les encheres de 20% sur cet appareil, 50 pour les augmenter de 50%." },
            },
            required: ["appareil", "pourcentage"],
          },
          description: "Ajustements d'enchere par appareil. REQUIS (au moins un) pour ajuster_encheres_appareil.",
        },
      },
      required: ["type", "campagneNom", "justification"],
    },
  },
  {
    name: "obtenir_connexion_reseaux_sociaux",
    description: "Indique si une Page Facebook (et un compte Instagram professionnel lie) est connectee au module Reseaux sociaux, et laquelle. Lecture seule.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "proposer_publication_reseaux_sociaux",
    description:
      "Enregistre une proposition de publication Facebook et/ou Instagram, APRES que l'utilisateur ait clairement donne son accord dans la conversation sur ce contenu precis. N'execute RIEN directement : la proposition est deposee sur l'ecran de validation dedie de l'application (onglet Reseaux sociaux), ou l'utilisateur doit explicitement l'accepter avant qu'elle ne soit publiee. Ne jamais appeler cet outil sans accord explicite et recent de l'utilisateur sur le TEXTE EXACT et la/les plateforme(s). Instagram exige une photo (cheminMedia) - texte seul impossible sur ce reseau ; Facebook accepte les deux. Le media doit deja avoir ete uploade par l'utilisateur via l'onglet dedie (tu n'as pas la capacite d'uploader un fichier toi-meme) - demande-lui le chemin qu'il a obtenu si besoin.",
    input_schema: {
      type: "object",
      properties: {
        plateformes: { type: "array", items: { type: "string", enum: ["FACEBOOK", "INSTAGRAM"] }, description: "Au moins une plateforme." },
        texte: { type: "string", description: "Texte/legende exact du post, valide avec l'utilisateur." },
        cheminMedia: { type: "string", description: "Chemin du media deja uploade (ex. 'media-publics/xxxx.jpg'), fourni par l'utilisateur. REQUIS si 'INSTAGRAM' fait partie des plateformes." },
        justification: { type: "string", description: "Resume en langage clair de pourquoi ce post est propose, affiche a l'utilisateur sur l'ecran de validation." },
      },
      required: ["plateformes", "texte", "justification"],
    },
  },
  {
    name: "obtenir_statistiques_publication_reseaux_sociaux",
    description: "Retourne les likes/commentaires (et partages sur Facebook uniquement) d'une publication DEJA PUBLIEE, a partir de son identifiant (visible sur une proposition au statut 'appliquee'). Lecture seule.",
    input_schema: {
      type: "object",
      properties: {
        idPublication: { type: "string", description: "Identifiant de la publication, tel que renvoye lors de sa publication." },
        plateforme: { type: "string", enum: ["FACEBOOK", "INSTAGRAM"] },
      },
      required: ["idPublication", "plateforme"],
    },
  },
  {
    name: "classer_document_recu",
    description:
      "Enregistre la photo ou le fichier PDF joint AU MESSAGE EN COURS comme document fournisseur (facture, avoir, bon d'enlevement, releve ou devis) : meme circuit que le scanner de l'onglet Factures (type facture -> envoi automatique vers Dext si possible, sinon en attente ; autres types -> simplement archives). Echoue explicitement si aucune piece jointe n'a ete envoyee avec ce message - ne jamais appeler sans piece jointe reelle, et toujours confirmer le fournisseur et le type avec l'utilisateur avant d'appeler (ne les devine jamais a partir du seul nom de fichier).",
    input_schema: {
      type: "object",
      properties: {
        fournisseurNom: { type: "string", description: "Nom du fournisseur (cree s'il n'existe pas encore)." },
        type: { type: "string", enum: ["facture", "avoir", "bon_enlevement", "releve", "devis"] },
        numero: { type: "string", description: "Numero de piece visible sur le document, si lisible/connu. Optionnel." },
      },
      required: ["fournisseurNom", "type"],
    },
  },
  {
    name: "generer_document_pdf",
    description:
      "Genere un document PDF telechargeable a partir d'un contenu que TU redige (recapitulatif, rapport, lettre...) - demande explicite de l'utilisateur ('fais-moi un fichier'). Retourne une URL de telechargement (/api/documents-generes/...) a donner telle quelle a l'utilisateur dans ta reponse, jamais reformulee. Structure le contenu en sections (titre de section optionnel + paragraphes et/ou puces) plutot que de tout mettre dans un seul bloc de texte - une lettre typique est une seule section avec des paragraphes, un rapport a plusieurs sections. Ne fabrique jamais un chiffre dans le document : toute donnee chiffree doit venir d'un outil de lecture deja appele dans la conversation.",
    input_schema: {
      type: "object",
      properties: {
        titre: { type: "string", description: "Titre du document (sert aussi de nom de fichier)." },
        sections: {
          type: "array",
          description: "Au moins une section.",
          items: {
            type: "object",
            properties: {
              titre: { type: "string", description: "Titre de la section, omis si non pertinent (ex. lettre simple)." },
              paragraphes: { type: "array", items: { type: "string" }, description: "Paragraphes de texte, dans l'ordre." },
              puces: { type: "array", items: { type: "string" }, description: "Liste a puces, dans l'ordre." },
            },
          },
        },
      },
      required: ["titre", "sections"],
    },
  },
  {
    name: "generer_dossier_comptable",
    description:
      "Relance le rapprochement bancaire (payouts Stripe + factures fournisseurs, voir verifier_rapprochement_bancaire) puis genere un PDF pret a transmettre au comptable : resume chiffre, encaissements/factures encore en attente de rapprochement, et mouvements bancaires non expliques. Retourne une URL de telechargement a donner telle quelle a l'utilisateur. N'appelle cet outil que si l'utilisateur demande explicitement un dossier/document pour son comptable - une simple verification de rapprochement reste verifier_rapprochement_bancaire, sans fichier.",
    input_schema: { type: "object", properties: {} },
  },
];

async function executerOutil(
  prisma: PrismaClient,
  nom: string,
  entree: unknown,
  pieceJointe: PieceJointeMorgane | undefined
): Promise<unknown> {
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

    case "obtenir_performance_annonces_ads": {
      const groupeId = typeof params.groupeId === "string" ? params.groupeId : "";
      if (!groupeId) return { erreur: "groupeId manquant" };
      const jours = typeof params.jours === "number" ? params.jours : 30;
      try {
        return { annonces: await listerPerformanceAnnonces(prisma, groupeId, jours) };
      } catch (err) {
        return { erreur: messageErreurGoogleAds(err) };
      }
    }

    case "auditer_referencement_site": {
      const url = typeof params.url === "string" ? params.url : "";
      if (!url) return { erreur: "url manquante" };
      try {
        return { audit: await auditerSiteWeb(url) };
      } catch (err) {
        return { erreur: `Echec de l'analyse de ${url} : ${(err as Error).message}` };
      }
    }

    case "analyser_page_destination_ads": {
      const url = typeof params.url === "string" ? params.url : "";
      if (!url) return { erreur: "url manquante" };
      try {
        return { analyse: await analyserPageDestination(url) };
      } catch (err) {
        return { erreur: `Echec de l'analyse de ${url} : ${(err as Error).message}` };
      }
    }

    case "verifier_politique_annonces_ads": {
      const campagneId = typeof params.campagneId === "string" && params.campagneId ? params.campagneId : undefined;
      try {
        return { annonces: await verifierPolitiqueAnnonces(prisma, campagneId) };
      } catch (err) {
        return { erreur: messageErreurGoogleAds(err) };
      }
    }

    case "verifier_politique_assets_ads": {
      try {
        return { assets: await verifierPolitiqueAssets(prisma) };
      } catch (err) {
        return { erreur: messageErreurGoogleAds(err) };
      }
    }

    case "rechercher_audiences_ads": {
      const termes = Array.isArray(params.termes) ? params.termes.filter((t): t is string => typeof t === "string" && t.length > 0) : [];
      if (termes.length === 0) return { erreur: "termes manquant ou vide" };
      try {
        const trouvees = await rechercherAudiences(prisma, termes);
        const manquantes = termes.filter((t) => !trouvees.some((a) => a.nomRecherche === t));
        return { trouvees, manquantes };
      } catch (err) {
        return { erreur: messageErreurGoogleAds(err) };
      }
    }

    case "diagnostiquer_audience_ads": {
      const terme = typeof params.terme === "string" ? params.terme : "";
      if (!terme) return { erreur: "terme manquant" };
      try {
        return { resultats: await diagnostiquerAudience(prisma, terme) };
      } catch (err) {
        return { erreur: messageErreurGoogleAds(err) };
      }
    }

    case "lister_mots_cles_configures_ads": {
      const campagneId = typeof params.campagneId === "string" ? params.campagneId : "";
      if (!campagneId) return { erreur: "campagneId manquant" };
      try {
        return { motsCles: await listerMotsClesConfigures(prisma, campagneId) };
      } catch (err) {
        return { erreur: messageErreurGoogleAds(err) };
      }
    }

    case "obtenir_snippet_conversion_ads": {
      const conversionActionId = typeof params.conversionActionId === "string" ? params.conversionActionId : "";
      if (!conversionActionId) return { erreur: "conversionActionId manquant" };
      try {
        return { snippets: await obtenirSnippetConversion(prisma, conversionActionId) };
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
        typeConversionSite,
        ciblesGeographiques,
        numeroTelephone,
        typeCorrespondance,
        sitelinks,
        callouts,
        structuredSnippets,
        strategieEncheres,
        cpaCibleEuros,
        horaires,
        audiences,
        ajustementsAppareil,
      } = params as Record<string, unknown>;
      const typesValides: TypePropositionAds[] = [
        "pause_campagne",
        "reactiver_campagne",
        "creer_campagne",
        "ajouter_mots_cles_exclus",
        "pause_mot_cle",
        "reactiver_mot_cle",
        "exclure_action_conversion",
        "creer_action_conversion_site",
        "modifier_budget_campagne",
        "ajouter_mots_cles_positifs",
        "ajouter_extensions_campagne",
        "modifier_strategie_encheres",
        "definir_horaires_campagne",
        "ajouter_audiences_campagne",
        "ajouter_annonce_test",
        "supprimer_campagne",
        "ajuster_encheres_appareil",
      ];
      if (typeof type !== "string" || !(typesValides as string[]).includes(type)) {
        return { erreur: `type invalide (attendu : ${typesValides.join(", ")})` };
      }
      const exigeCampagneId =
        type !== "creer_campagne" &&
        type !== "pause_mot_cle" &&
        type !== "reactiver_mot_cle" &&
        type !== "exclure_action_conversion" &&
        type !== "creer_action_conversion_site" &&
        type !== "ajouter_annonce_test";
      if (exigeCampagneId && (typeof campagneId !== "string" || !campagneId)) return { erreur: "campagneId manquant" };
      if (typeof campagneNom !== "string" || !campagneNom) return { erreur: "campagneNom manquant" };
      if (typeof justification !== "string" || !justification) return { erreur: "justification manquante" };
      const toTableauString = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined);
      const toSitelinks = (v: unknown): SitelinkAds[] | undefined => {
        if (!Array.isArray(v)) return undefined;
        return v
          .filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && typeof (x as Record<string, unknown>).texte === "string")
          .map((x) => ({
            texte: x.texte as string,
            description1: typeof x.description1 === "string" ? x.description1 : undefined,
            description2: typeof x.description2 === "string" ? x.description2 : undefined,
            url: typeof x.url === "string" ? x.url : undefined,
          }));
      };
      const toStructuredSnippets = (v: unknown): StructuredSnippetAds[] | undefined => {
        if (!Array.isArray(v)) return undefined;
        return v
          .filter(
            (x): x is Record<string, unknown> =>
              !!x && typeof x === "object" && typeof (x as Record<string, unknown>).header === "string" && Array.isArray((x as Record<string, unknown>).valeurs)
          )
          .map((x) => ({ header: x.header as string, valeurs: (x.valeurs as unknown[]).filter((v2): v2 is string => typeof v2 === "string") }));
      };
      const toHoraires = (v: unknown): HoraireAds[] | undefined => {
        if (!Array.isArray(v)) return undefined;
        const joursValides = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"];
        return v
          .filter((x): x is Record<string, unknown> => {
            const o = x as Record<string, unknown>;
            return !!o && typeof o === "object" && joursValides.includes(o.jour as string) && typeof o.heureDebut === "number" && typeof o.heureFin === "number";
          })
          .map((x) => ({
            jour: x.jour as HoraireAds["jour"],
            heureDebut: x.heureDebut as number,
            minuteDebut: [0, 15, 30, 45].includes(x.minuteDebut as number) ? (x.minuteDebut as 0 | 15 | 30 | 45) : undefined,
            heureFin: x.heureFin as number,
            minuteFin: [0, 15, 30, 45].includes(x.minuteFin as number) ? (x.minuteFin as 0 | 15 | 30 | 45) : undefined,
          }));
      };
      const toAjustementsAppareil = (v: unknown): AjustementAppareilAds[] | undefined => {
        if (!Array.isArray(v)) return undefined;
        const appareilsValides = ["MOBILE", "TABLET", "DESKTOP"];
        return v
          .filter((x): x is Record<string, unknown> => {
            const o = x as Record<string, unknown>;
            return !!o && typeof o === "object" && appareilsValides.includes(o.appareil as string) && typeof o.pourcentage === "number";
          })
          .map((x) => ({ appareil: x.appareil as AjustementAppareilAds["appareil"], pourcentage: x.pourcentage as number }));
      };
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
          typeConversionSite: typeConversionSite === "CLICK_TO_CALL" || typeConversionSite === "WEBPAGE" ? typeConversionSite : undefined,
          ciblesGeographiques: toTableauString(ciblesGeographiques),
          numeroTelephone: typeof numeroTelephone === "string" ? numeroTelephone : undefined,
          typeCorrespondance:
            typeCorrespondance === "EXACT" || typeCorrespondance === "PHRASE" || typeCorrespondance === "BROAD" ? typeCorrespondance : undefined,
          sitelinks: toSitelinks(sitelinks),
          callouts: toTableauString(callouts),
          structuredSnippets: toStructuredSnippets(structuredSnippets),
          strategieEncheres:
            strategieEncheres === "MAXIMIZE_CONVERSIONS" || strategieEncheres === "TARGET_CPA" || strategieEncheres === "MANUAL_CPC"
              ? (strategieEncheres as StrategieEncheres)
              : undefined,
          cpaCibleEuros: typeof cpaCibleEuros === "number" ? cpaCibleEuros : undefined,
          horaires: toHoraires(horaires),
          audiences: toTableauString(audiences),
          ajustementsAppareil: toAjustementsAppareil(ajustementsAppareil),
        });
        return {
          ok: true,
          message:
            type === "creer_campagne"
              ? "Proposition de creation deposee sur l'ecran de validation Google Ads. Rien n'a ete cree : l'utilisateur doit l'accepter la-bas, et meme une fois acceptee, la campagne sera creee EN PAUSE (ne depensera rien tant qu'il ne l'active pas lui-meme dans Google Ads)."
              : type === "creer_action_conversion_site"
                ? "Proposition deposee sur l'ecran de validation Google Ads. Rien n'a ete cree : une fois acceptee la-bas, utilise obtenir_actions_conversion_ads pour recuperer son id, puis obtenir_snippet_conversion_ads pour obtenir le code a donner a l'utilisateur."
                : "Proposition deposee sur l'ecran de validation Google Ads. Rien n'a ete modifie : l'utilisateur doit l'accepter la-bas pour que ce soit applique.",
          avertissement:
            type === "supprimer_campagne"
              ? "IRREVERSIBLE : une fois acceptee, cette campagne ne pourra plus etre reactivee ni modifiee. Assure-toi que l'utilisateur a bien confirme vouloir une suppression definitive, pas juste une pause."
              : ciblesGeographiques && Array.isArray(ciblesGeographiques) && ciblesGeographiques.length > 0
                ? "Les noms de lieux donnes seront resolus par Google au moment de l'acceptation. Si l'un d'eux ne correspond a aucun lieu connu, toute la creation echouera avec un message clair (statut 'echec') - rien ne sera cree a moitie."
                : audiences && Array.isArray(audiences) && audiences.length > 0
                  ? "Les noms de centres d'interet seront resolus par Google au moment de l'acceptation (meme principe que le ciblage geographique : tout echoue proprement si l'un d'eux ne correspond a rien). Rappel : c'est un signal d'observation, pas du remarketing - rien n'exclut qui voit l'annonce."
                  : undefined,
          propositionId: proposition.id,
        };
      } catch (err) {
        return { erreur: (err as Error).message };
      }
    }

    case "obtenir_connexion_reseaux_sociaux": {
      if (!reseauxSociauxEstConfigure()) return { connecte: false, erreur: "Module Reseaux sociaux non configure cote serveur (META_APP_ID/META_APP_SECRET/META_REDIRECT_URI manquants)." };
      const connexion = await obtenirConnexionMeta(prisma);
      return connexion
        ? { connecte: true, pageNom: connexion.pageNom, instagramUsername: connexion.instagramUsername }
        : { connecte: false };
    }

    case "proposer_publication_reseaux_sociaux": {
      const plateformes = Array.isArray(params.plateformes) ? params.plateformes.filter((p): p is string => typeof p === "string") : [];
      const texte = typeof params.texte === "string" ? params.texte : "";
      const cheminMedia = typeof params.cheminMedia === "string" ? params.cheminMedia : undefined;
      const justification = typeof params.justification === "string" ? params.justification : "";
      try {
        const proposition = await creerPropositionPost(prisma, { plateformes, texte, cheminMedia, justification });
        return {
          ok: true,
          message: "Proposition de publication deposee sur l'ecran de validation (onglet Reseaux sociaux). Rien n'est publie : l'utilisateur doit l'accepter la-bas.",
          propositionId: proposition.id,
        };
      } catch (err) {
        return { erreur: (err as Error).message };
      }
    }

    case "obtenir_statistiques_publication_reseaux_sociaux": {
      const idPublication = typeof params.idPublication === "string" ? params.idPublication : "";
      const plateforme = params.plateforme === "FACEBOOK" || params.plateforme === "INSTAGRAM" ? params.plateforme : undefined;
      if (!idPublication || !plateforme) return { erreur: "idPublication et plateforme sont requis." };
      try {
        return { statistiques: await obtenirStatistiquesPost(prisma, idPublication, plateforme) };
      } catch (err) {
        return { erreur: (err as Error).message };
      }
    }

    case "classer_document_recu": {
      if (!pieceJointe) {
        return { erreur: "Aucune piece jointe n'a ete recue avec ce message : redemande a l'utilisateur d'envoyer la photo ou le fichier avant d'appeler cet outil." };
      }
      const fournisseurNom = typeof params.fournisseurNom === "string" ? params.fournisseurNom : "";
      const type = typeof params.type === "string" ? params.type : "";
      const numero = typeof params.numero === "string" ? params.numero : undefined;
      try {
        const document = await enregistrerDocumentDepuisPieceJointe(prisma, {
          buffer: Buffer.from(pieceJointe.donneesBase64, "base64"),
          mimeType: pieceJointe.mimeType,
          type,
          fournisseurNom,
          numero,
        });
        return { ok: true, documentId: document.id, statutDext: document.statutDext };
      } catch (err) {
        if (err instanceof DocumentScanneError) return { erreur: err.message };
        throw err;
      }
    }

    case "generer_document_pdf": {
      const titre = typeof params.titre === "string" ? params.titre : "";
      const sections = Array.isArray(params.sections) ? (params.sections as SectionDocumentGenere[]) : [];
      try {
        return await genererDocumentPdf(prisma, { titre, sections });
      } catch (err) {
        if (err instanceof DocumentGenereError) return { erreur: err.message };
        throw err;
      }
    }

    case "generer_dossier_comptable":
      return genererDossierComptable(prisma);

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
comptePourObjectifPrincipal) plutot que de suggerer une verification \
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
  Options supplementaires de creer_campagne, a proposer quand elles sont \
pertinentes (jamais obligatoires) :
  - ciblesGeographiques : noms de lieux (ex. "Île-de-France", \
"Seine-et-Marne") - tu donnes des noms, Google les resout lui-meme en \
identifiants au moment de la creation, tu n'as jamais a deviner un \
identifiant numerique. Si un nom ne correspond a rien chez Google, TOUTE \
la creation echoue proprement (rien de cree a moitie) avec un message \
clair - previens l'utilisateur de ce risque si un nom de lieu est \
inhabituel ou ambigu. Sans ciblesGeographiques, la campagne n'a aucune \
restriction geographique.
  - numeroTelephone : cree une extension d'appel liee des la creation, \
avec suivi de conversion d'appel actif par defaut (niveau compte). \
Fortement recommande des que l'activite repose sur l'appel telephonique - \
sans lui, la nouvelle campagne n'aura AUCUN moyen de suivre les appels \
independamment du site tant que l'utilisateur ne l'ajoute pas lui-meme.
  - typeCorrespondance : EXACT/PHRASE/BROAD, applique a tous les \
mots-cles de la campagne (pas de reglage individuel aujourd'hui). PHRASE \
par defaut si tu ne precises rien - plus sur pour le budget que BROAD.
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
  Creation d'une action de conversion WEB (creer_action_conversion_site, \
type CLICK_TO_CALL ou WEBPAGE) : pour qu'un site compte un clic sur le \
numero de telephone ou l'envoi d'un formulaire comme conversion. Sois \
HONNETE sur ce que ça mesure vraiment : CLICK_TO_CALL compte un clic sur \
le lien telephonique (l'internaute ouvre son clavier d'appel), PAS une \
conversation confirmee ni sa duree - contrairement au suivi d'appel par \
extension d'annonce (deja actif independamment du site, voir \
obtenir_extensions_appel_ads), qui lui mesure un appel reellement passe \
avec une duree minimale. Ne laisse jamais croire que CLICK_TO_CALL \
equivaut a un appel confirme. Une fois la proposition acceptee par \
l'utilisateur sur l'ecran dedie, recupere l'id de la nouvelle action \
(obtenir_actions_conversion_ads) puis son code pret a coller \
(obtenir_snippet_conversion_ads) et donne ce code A L'UTILISATEUR \
TEXTUELLEMENT ET INTEGRALEMENT (jamais reformule, resume ou traduit) - \
c'est du code exact qu'il doit faire ajouter sur son site.
  Modification du budget d'une campagne existante \
(modifier_budget_campagne) : precise budgetQuotidien avec le NOUVEAU \
montant quotidien souhaite (pas la difference). Discute toujours avec \
l'utilisateur du budget cible et de pourquoi, comme pour une creation.
  Ajout de mots-cles POSITIFS a une campagne existante \
(ajouter_mots_cles_positifs) : precise campagneId, groupeId (voir \
obtenir_mots_cles_ads pour le retrouver) et motsCles. typeCorrespondance \
optionnel (PHRASE par defaut).
  Extensions d'annonce - liens d'accroche, accroches, extraits structures \
(ajouter_extensions_campagne pour une campagne existante ; sitelinks/ \
callouts/structuredSnippets optionnels directement dans creer_campagne) :
  - sitelinks : texte (1-25 caracteres) obligatoire par lien, \
description1+description2 (1-35 caracteres chacune) optionnelles mais \
TOUJOURS ensemble (jamais l'une sans l'autre), url optionnelle (sinon \
reutilise l'URL de la campagne). Mets-toi d'accord avec l'utilisateur sur \
le contenu avant de proposer - ne les invente pas au hasard, ancre-les \
dans l'activite reelle (ex. un service precis, une zone, le contact).
  - callouts : textes courts (1-25 caracteres), 4 a 6 est un bon volume \
habituel meme si rien ne l'impose techniquement ici.
  - structuredSnippets : header OBLIGATOIREMENT une categorie officielle \
Google (ex. "Services", "Types", "Marques" - jamais une categorie \
inventee, Google rejettera le reste sinon), valeurs : 3 a 10 par header, \
1-25 caracteres chacune.
  Strategie d'encheres (strategieEncheres, optionnel a la creation, \
REQUIS pour modifier_strategie_encheres) : MAXIMIZE_CONVERSIONS par \
defaut (Google optimise automatiquement). TARGET_CPA : vise un cout par \
acquisition precis, demande cpaCibleEuros (discute-le avec l'utilisateur, \
jamais invente - appuie-toi sur le CPA historique observe via \
obtenir_mots_cles_ads/obtenir_campagnes_ads). MANUAL_CPC : CPC optimise \
(enhanced), moins automatise, utile si l'utilisateur veut garder la main. \
Avec TARGET_CPA/MANUAL_CPC, pas de gestion d'enchere individuelle par \
mot-cle ici (meme limite qu'avant) - seulement le choix de la strategie \
globale de la campagne.
  Programmation horaire (horaires, optionnel a la creation, REQUIS pour \
definir_horaires_campagne) : jour (lundi-dimanche), heureDebut/heureFin \
(0-23, 24=minuit), minuteDebut/minuteFin optionnels (uniquement 0/15/30/45, \
Google n'accepte pas d'autres valeurs). Sans ca, diffusion 24h/24 7j/7. \
Utile pour une activite avec des horaires d'intervention reels - \
mets-toi d'accord sur les horaires exacts avec l'utilisateur, ne les \
devine pas.
  Audiences (audiences, optionnel a la creation, REQUIS pour \
ajouter_audiences_campagne) : noms de centres d'interet Google resolus \
puis attaches en SIGNAL D'OBSERVATION sur une campagne Search - n'exclut \
ni ne restreint qui voit l'annonce, sert a ajuster les encheres et \
analyser la performance par segment. Ce n'est JAMAIS du remarketing \
(reciblage des visiteurs du site) : le remarketing exigerait une balise \
de suivi sur le site, absente aujourd'hui - ne dis jamais a l'utilisateur \
que tu peux faire du remarketing, precise la difference s'il en parle. \
Tu peux chercher en francais (securite, demenagement, bricolage, \
serrurier, proprietaire...) : rechercher_audiences_ads traduit \
automatiquement les themes courants du metier vers l'anglais, seule \
langue dans laquelle Google expose ces categories - inutile de demander \
a l'utilisateur de donner les noms en anglais lui-meme. UTILISE TOUJOURS \
rechercher_audiences_ads en premier (jamais diagnostiquer_audience_ads \
directement sauf investigation technique) pour verifier les noms exacts \
trouves par Google avant de les proposer - un nom invente ou mal resolu \
fait echouer tout l'ajout, pas seulement celui-la.
  Annonce de test A/B (ajouter_annonce_test) : ajoute une annonce \
supplementaire a un groupe d'annonces EXISTANT (groupeId, titres, \
descriptions, urlFinale - memes contraintes que creer_campagne), creee \
EN PAUSE comme toute creation. Une fois les deux annonces actives, \
compare leur performance avec obtenir_performance_annonces_ads (jamais \
avant d'avoir assez de donnees - quelques clics ne suffisent pas a \
conclure).
  Ajustement d'enchere par appareil (ajustementsAppareil, REQUIS pour \
ajuster_encheres_appareil) : appareil (MOBILE/TABLET/DESKTOP) + \
pourcentage (-90 a +900, ex. -20 pour reduire les encheres de 20% sur cet \
appareil). Utile si un appareil convertit nettement moins bien ou mieux \
qu'un autre (verifie via les donnees disponibles avant de proposer un \
chiffre, ne l'invente pas). C'est un ajustement par campagne, pas par \
mot-cle individuel.
  Suppression de campagne (supprimer_campagne) : operation IRREVERSIBLE \
(contrairement a pause_campagne, qui peut toujours etre annulee) - une \
fois supprimee, une campagne ne peut plus etre reactivee ni modifiee. \
Ne propose JAMAIS cette action a la place d'une simple mise en pause sans \
que l'utilisateur ait explicitement demande une suppression definitive. \
En cas de doute sur son intention reelle, demande confirmation ou \
propose pause_campagne a la place.
  Ce qui n'existe PAS encore : l'ajustement d'enchere individuel par \
mot-cle, et le reglage du type de correspondance mot-cle par mot-cle \
(aujourd'hui un seul type pour toute la campagne/le lot ajoute). Le \
remarketing proprement dit (balise de suivi des visiteurs du site, \
listes de reciblage) n'existe pas non plus - voir audiences ci-dessus, \
qui n'est qu'un signal d'observation sur l'intention de recherche, pas \
un reciblage de visiteurs. Dis-le clairement si l'utilisateur les \
demande plutot que de pretendre les avoir faites.

Referencement (SEO classique et visibilite aupres des assistants IA - \
sujet distinct de Google Ads, outil auditer_referencement_site) :
  Tu n'as PAS acces au code du site (herberge sur une plateforme tierce, \
souvent Emergent) : tu analyses en lecture seule ce qu'un robot verrait \
publiquement, jamais tu ne modifies rien toi-meme. Pour toute correction, \
donne a l'utilisateur le texte/code exact a transmettre a la plateforme \
qui gere le site - meme principe que pour le code de suivi de conversion. \
Ne dis jamais que tu as "corrige" ou "mis a jour" le site.
  Distingue toujours deux sujets separes pour l'utilisateur : le SEO \
classique (etre bien classe sur Google) et le referencement IA/GEO (etre \
cite par ChatGPT, Perplexity, les apercus IA de Google...) - un site peut \
tres bien reussir l'un et rater l'autre.
  Le signal le plus important du rapport est renduCoteClientUniquement : \
s'il est vrai, le contenu de la page n'existe QUE via du JavaScript \
execute par un navigateur. Googlebot l'execute generalement (avec des \
limites et un delai), mais la plupart des robots IA (GPTBot, ClaudeBot, \
PerplexityBot...) NE L'EXECUTENT PAS : ils ne voient alors rien du \
contenu reel (services, zone d'intervention, coordonnees...), meme si le \
site a l'air normal dans un navigateur. C'est souvent LE probleme \
prioritaire a signaler, pas un detail parmi d'autres - sois directe \
la-dessus plutot que de le noyer dans une liste.
  robots.txt/sitemap.xml/llms.txt : le champ "existe" distingue un vrai \
fichier d'un simple HTML de secours renvoye par une application monopage \
(frequent, et ca trompe facilement) - explique cette nuance si tu \
signales leur absence, l'utilisateur pourrait croire qu'ils existent \
parce que l'URL "repond". llms.txt est une convention recente (resume du \
site pour les IA) : utile a proposer sans etre indispensable. robotsIaBloques \
liste les robots IA explicitement bloques si robots.txt existe reellement.
  Autres points a verifier manuellement en complement du rapport (pas \
mesures automatiquement) : donnees structurees schema.org adaptees a \
l'activite (ex. LocalBusiness avec nom/adresse/telephone/horaires pour un \
commerce local - fortement recommande si nombreBlocsJsonLd = 0), coherence \
des informations factuelles sur le site (nom, adresse, telephone, \
horaires) avec ce qui est annonce ailleurs (ex. Google Ads, fiche Google \
Business) - une incoherence nuit autant au SEO qu'a la confiance qu'un \
assistant IA accorde au contenu.
  Ne promets jamais un classement ou un volume de trafic garanti : \
recommandations fondees sur l'audit reel, jamais de prevision chiffree.

Recommandations d'optimisation (a la demande dans la conversation, ET \
analyse automatique quotidienne envoyee par e-mail - meme logique \
d'analyse dans les deux cas) : quand l'utilisateur demande ce qu'il faut \
ameliorer/ajouter/retirer sur une campagne, croise obtenir_campagnes_ads \
(etat general), obtenir_mots_cles_ads (mots-cles a cout notable et zero \
conversion -> candidats a l'exclusion ; score de qualite faible) et \
obtenir_termes_recherche_ads (termes qui convertissent deja bien mais ne \
sont pas encore des mots-cles positifs -> candidats a l'ajout). Chaque \
recommandation doit citer le chiffre qui la justifie (cout, conversions, \
CTR...) - jamais une suggestion sans donnee a l'appui. Priorise 3 a 5 \
points plutot que de tout lister. Une recommandation reste une \
RECOMMANDATION : ne depose jamais une proposition toi-meme a partir de \
l'analyse automatique quotidienne (celle-ci n'appelle jamais \
proposer_action_ads) - seulement si l'utilisateur la redemande \
explicitement dans la conversation ensuite, comme pour toute autre action.

Analyse de page de destination (analyser_page_destination_ads, sujet \
distinct du referencement ci-dessus - ici on regarde la page du point de \
vue de quelqu'un qui vient de cliquer sur une annonce, pas d'un moteur \
de recherche) : temps de reponse, adaptation mobile, telephone(s) \
cliquables (liens tel:), presence d'un formulaire, mots d'appel a \
l'action trouves dans le texte. CE N'EST PAS une mesure de taux de \
conversion reel (il faudrait les donnees Google Ads/Analytics, pas le \
HTML) - uniquement des signaux structurels. Sois honnete sur cette \
limite si l'utilisateur demande "combien ca convertit" : dis-lui que \
seul obtenir_campagnes_ads (conversions reelles comptees par Google) \
repond a ca, pas cet outil. L'usage typique : une campagne a beaucoup de \
clics mais peu de conversions -> verifier si la page de destination a un \
telephone cliquable et un appel a l'action clair avant de chercher \
ailleurs. Meme principe d'acces que le referencement : lecture seule, \
pas d'acces au code du site.

Module Reseaux sociaux (Facebook/Instagram, sujet SEPARE de Google Ads - \
outils obtenir_connexion_reseaux_sociaux, proposer_publication_reseaux_sociaux, \
obtenir_statistiques_publication_reseaux_sociaux). Phase "fondations" \
seulement : creer/publier des posts avec une photo (texte seul possible \
sur Facebook uniquement, jamais sur Instagram), pas encore de generation \
d'image/video par IA, pas encore de recuperation automatique de photos \
depuis une source externe - dis-le clairement si l'utilisateur en demande \
plus, sans laisser croire que c'est deja fait.
  Avant de proposer quoi que ce soit, verifie obtenir_connexion_reseaux_sociaux : \
si rien n'est connecte, dis-le a l'utilisateur et redirige-le vers /auth/meta \
depuis l'application (necessite une Page Facebook + un compte Instagram \
professionnel lie + une application Meta for Developers deja creee par \
l'utilisateur - tu ne peux rien faire sans ca).
  Tu n'as pas la capacite d'uploader un fichier toi-meme : le media doit \
deja avoir ete uploade par l'utilisateur via l'onglet Reseaux sociaux de \
l'application (qui te donne un cheminMedia, ex. "media-publics/xxxx.jpg") \
AVANT que tu ne puisses le referencer dans une proposition - ne l'invente \
jamais.
  Comme pour Google Ads : propose uniquement APRES accord explicite et \
recent de l'utilisateur sur le texte exact et les plateformes, et dis-lui \
toujours que la publication reelle ne se fait qu'apres son acceptation \
sur l'ecran de validation dedie, jamais depuis la conversation.
  Instagram EXIGE une photo (cheminMedia) - rappelle-le si l'utilisateur \
demande un post Instagram texte seul, ce qui n'existe pas sur ce reseau.

Pieces jointes dans la conversation (photo ou PDF, outil classer_document_recu) : \
l'utilisateur peut joindre une photo ou un fichier a son message - tu la \
vois directement (vision), tu peux donc decrire ce qu'elle montre, lire \
du texte visible, repondre a une question dessus, SANS appeler aucun \
outil pour ca. N'appelle classer_document_recu que si l'utilisateur \
demande explicitement de l'enregistrer/classer comme document \
fournisseur (facture, avoir, bon d'enlevement, releve, devis) - jamais de \
ta propre initiative juste parce qu'une photo ressemble a une facture. \
Confirme toujours le fournisseur et le type exact avec l'utilisateur \
avant d'appeler l'outil (ne les devine jamais depuis l'image seule, une \
mauvaise lecture enverrait le document au mauvais fournisseur). La piece \
jointe n'existe que pour CE message : si l'utilisateur en reparle plus \
tard dans la conversation sans la renvoyer, tu ne la vois plus - dis-le \
plutot que de pretendre t'en souvenir.

Generation de fichiers (outil generer_document_pdf, demande explicite \
"fais-moi un fichier/un document/une lettre...") : c'est a toi de \
rediger le contenu (texte, structure en sections), pas a l'utilisateur de \
te dicter phrase par phrase - pose-lui seulement les quelques questions \
necessaires (destinataire d'une lettre, periode d'un recap...) puis \
redige. Une fois genere, donne-lui l'URL de telechargement renvoyee par \
l'outil TELLE QUELLE dans ta reponse (jamais reformulee ni raccourcie), \
en disant clairement que c'est un fichier a telecharger. Comme ailleurs, \
aucun chiffre invente : si le document doit contenir des donnees de \
l'application (factures, impayes, campagnes...), appelle d'abord l'outil \
de lecture correspondant.

Dossier comptable (outil generer_dossier_comptable, distinct de \
verifier_rapprochement_bancaire qui ne fait que relancer le rapprochement \
sans produire de fichier) : relance le rapprochement bancaire (payouts \
Stripe ET factures fournisseurs) puis genere un PDF listant ce qui est \
deja rapproche (resume chiffre) et surtout ce qui ne l'est PAS encore \
(encaissements et factures fournisseurs en attente, mouvements bancaires \
non expliques) - c'est ce qu'un comptable a besoin de voir pour faire son \
travail. N'appelle cet outil que si l'utilisateur demande explicitement \
un document/dossier pour son comptable, donne l'URL renvoyee telle \
quelle.`;

/**
 * Fait dialoguer l'historique fourni avec Claude, en executant les outils
 * demandes jusqu'a obtenir une reponse textuelle finale (ou une limite de
 * tours de securite, pour eviter une boucle infinie en cas de comportement
 * inattendu du modele).
 */
export async function repondreMorgane(
  prisma: PrismaClient,
  historique: MessageMorgane[],
  pieceJointe?: PieceJointeMorgane
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("Morgane n'est pas encore configuree (cle ANTHROPIC_API_KEY manquante cote serveur).");
  }
  // Delai borne sur chaque appel : sans cela, un appel Anthropic lent ou
  // bloque (ex. compte proche de sa limite d'usage) peut rester en attente
  // plusieurs minutes cote serveur pendant que le navigateur mobile, lui,
  // abandonne la requete HTTP bien avant (observe en production : "Erreur :
  // Load failed" cote utilisateur, sans aucun message clair, le serveur
  // n'ayant jamais eu l'occasion de repondre avec l'erreur reelle). 25s
  // s'est revele trop court des qu'une reponse combine plusieurs appels
  // d'outils et une synthese longue (ex. proposition de campagne complete) -
  // 55s laisse la marge necessaire tout en echouant bien avant le delai par
  // defaut de la librairie (plusieurs minutes).
  const client = new Anthropic({ apiKey, timeout: 55_000, maxRetries: 1 });

  const messages: Anthropic.MessageParam[] = historique
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content }));

  // Piece jointe (photo/PDF) : ajoutee comme bloc supplementaire sur le
  // DERNIER message seulement (forcement le plus recent message "user",
  // voir la validation faite cote route) - jamais repassee aux tours
  // suivants de cette meme reponse ni aux appels futurs, qui ne reverront
  // que le texte conserve dans historique (voir PieceJointeMorgane).
  if (pieceJointe) {
    const dernier = messages[messages.length - 1];
    if (dernier?.role === "user" && typeof dernier.content === "string") {
      const blocPieceJointe: Anthropic.ImageBlockParam | Anthropic.DocumentBlockParam =
        pieceJointe.mimeType === "application/pdf"
          ? {
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: pieceJointe.donneesBase64 },
            }
          : {
              type: "image",
              source: { type: "base64", media_type: pieceJointe.mimeType as "image/jpeg" | "image/png", data: pieceJointe.donneesBase64 },
            };
      dernier.content = [{ type: "text", text: dernier.content || "(voir piece jointe)" }, blocPieceJointe];
    }
  }

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
        const resultat = await executerOutil(prisma, bloc.name, bloc.input, pieceJointe);
        resultatsOutils.push({ type: "tool_result", tool_use_id: bloc.id, content: JSON.stringify(resultat) });
      }
    }
    messages.push({ role: "user", content: resultatsOutils });
  }

  return "Desolee, je n'arrive pas a conclure sur ce point (trop d'etapes necessaires). Peux-tu reformuler ta question ?";
}
