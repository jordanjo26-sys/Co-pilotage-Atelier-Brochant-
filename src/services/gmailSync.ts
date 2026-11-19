import { PrismaClient } from "@prisma/client";
import { gmail_v1 } from "googleapis";
import MailComposer from "nodemailer/lib/mail-composer";
import { getGmailClient } from "./googleAuth";
import {
  classifierPieceJointe,
  choisirAdresseDext,
  extraireNumeroFacture,
  extraireMontantTTCFacture,
  extraireMontantHTFacture,
  completerMontantHTSansTva,
  estPieceDocument,
  estPieceJointeZip,
  EmailAClassifier,
  PieceJointe,
  TypeDocument,
} from "./gmailClassify";
import { classifierParIA, classifierImageParIA } from "./gmailClassifyIA";
import { extraireChampsFacturePdf, extraireChampsFactureImage } from "./archiveComptableIA";
import { archiverFactureEnvoyeeDext } from "./archiveComptable";
import { sha256Hex } from "./hash";
import { logEvenement } from "./journalService";
import { resoudreFournisseur, extraireIdentiteExpediteur } from "./fournisseurs";
import { controlerReleveFournisseur } from "./controleReleves";
import { extractPdfText, texteSignificatif } from "../importers/bankStatementPdf";
import { extraireTexteDepuisZip } from "../importers/zipAttachment";
import { rendrePremierePageEnImage } from "../importers/pdfRenderImage";
import fs from "node:fs/promises";

// Format d'image gere par la vision IA (extraireChampsFactureImage) - PAS
// "application/pdf", qui lui n'est jamais envoye tel quel a la vision :
// un PDF sans texte extractible est d'abord rendu en PNG (voir
// rendrePremierePageEnImage) avant d'y recourir.
const MIME_IMAGES_FACTURE = new Set(["image/jpeg", "image/png"]);

/**
 * Resout les montants HT/TTC d'une facture fournisseur en empilant,
 * dans l'ordre, les trois niveaux de lecture disponibles - demande
 * explicite de l'utilisateur ("je veux que tu codes correctement pour
 * qu'il puisse lire tous les montants, car c'est pas possible
 * actuellement") :
 *  1. Extraction deterministe par libelle connu (extraireMontantHTFacture/
 *     TTCFacture) - gratuite, instantanee, prioritaire quand elle suffit.
 *  2. Vision/texte IA (extraireChampsFacturePdf sur le texte du PDF,
 *     extraireChampsFactureImage sur une image ou un PDF sans texte
 *     rendu en PNG) - seulement si (1) n'a pas tout trouve, pour ne pas
 *     multiplier les appels IA sur les factures qui s'extraient deja
 *     parfaitement par regle.
 *  3. completerMontantHTSansTva (TVA = 0 explicite quand le document ne
 *     mentionne jamais la TVA/VAT) en tout dernier recours.
 * Chaque niveau ne retente que ce que le precedent n'a pas trouve -
 * jamais n'ecrase un montant deja obtenu, jamais n'invente de chiffre
 * (section 14, "jamais deviner") : un montant toujours introuvable apres
 * les trois niveaux reste explicitement "non renseigne".
 */
async function resoudreMontantsFacture(
  prisma: PrismaClient,
  mimeType: string,
  donnees: Buffer,
  contenuExtrait: string | undefined
): Promise<{ montantHT: number | null; montantTTC: number | null }> {
  let montantTTC = contenuExtrait ? extraireMontantTTCFacture(contenuExtrait) : null;
  let montantHT = contenuExtrait ? extraireMontantHTFacture(contenuExtrait) : null;

  if (montantHT == null || montantTTC == null) {
    let champsIA = null;
    if (contenuExtrait) {
      champsIA = await extraireChampsFacturePdf(contenuExtrait, prisma);
    } else {
      const mime = mimeType.toLowerCase();
      const imageBuffer = MIME_IMAGES_FACTURE.has(mime) ? donnees : mime === "application/pdf" ? rendrePremierePageEnImage(donnees) : undefined;
      const imageMime = MIME_IMAGES_FACTURE.has(mime) ? mime : "image/png";
      if (imageBuffer) champsIA = await extraireChampsFactureImage(imageBuffer, imageMime, prisma);
    }
    if (champsIA) {
      if (montantHT == null && champsIA.montantHT != null) montantHT = champsIA.montantHT;
      if (montantTTC == null && champsIA.montantTTC != null) montantTTC = champsIA.montantTTC;
    }
  }

  if (contenuExtrait) montantHT = completerMontantHTSansTva(contenuExtrait, montantHT, montantTTC);
  return { montantHT, montantTTC };
}

export interface ResultatSyncGmail {
  messagesExamines: number;
  documentsTraites: number;
  documentsDoublons: number;
  documentsAmbigus: number;
  erreurs: string[];
}

/**
 * Regroupe les erreurs identiques (chacune de la forme "identifiant :
 * message") en une ligne par message distinct, avec un compte plutot
 * qu'une repetition individuelle au-dela de quelques occurrences. Sans
 * cela, une panne affectant beaucoup de messages a la fois (ex. quota
 * Gmail depasse) produisait un mur de texte quasi identique, ligne par
 * ligne, dans le Journal - illisible et peu professionnel pour un
 * utilisateur non technique (signale en production).
 */
export function resumerErreurs(erreurs: string[]): string {
  if (erreurs.length === 0) return "";

  const groupes = new Map<string, string[]>();
  for (const entree of erreurs) {
    const separateur = entree.indexOf(" : ");
    const identifiant = separateur === -1 ? entree : entree.slice(0, separateur);
    const message = separateur === -1 ? entree : entree.slice(separateur + 3);
    if (!groupes.has(message)) groupes.set(message, []);
    groupes.get(message)!.push(identifiant);
  }

  return [...groupes.entries()]
    .map(([message, identifiants]) => {
      const messageCourt = message.length > 160 ? `${message.slice(0, 160)}…` : message;
      // Seuil releve de 3 a 10 (temporairement, diagnostic d'un "Insufficient
      // Permission" recurrent sur 7 pieces precises signale par l'utilisateur,
      // octobre 2026) : sans les noms de fichiers individuels, impossible de
      // savoir lesquelles sont en cause.
      return identifiants.length <= 10
        ? `${identifiants.join(", ")} : ${messageCourt}`
        : `${identifiants.length} document(s)/message(s) : ${messageCourt}`;
    })
    .join(" | ");
}

interface PieceJointeExtraite extends PieceJointe {
  attachmentId: string;
}

/**
 * Aplatit recursivement les parts MIME pour en extraire les pieces jointes.
 * Exclut les ressources integrees au corps du message (logo de signature,
 * icones de reseaux sociaux, images de newsletter/mailing...) : elles
 * portent techniquement un nom de fichier et un attachmentId comme une
 * vraie piece jointe, mais se reconnaissent a deux signaux standards :
 *  - un en-tete Content-ID, qui sert a les referencer depuis le HTML du
 *    message (`<img src="cid:...">`) ;
 *  - un Content-Disposition "inline" (par opposition a "attachment")
 *    SUR UNE IMAGE, utilise par la plupart des plateformes d'e-mailing
 *    pour leurs images de template meme sans Content-ID (constate en
 *    production : images "mailingassets_..." et images heergees par
 *    Google, sans Content-ID mais explicitement en disposition inline).
 *
 * Le deuxieme signal est volontairement restreint aux images (voir
 * estImage) depuis qu'une facture reelle (Trenois Decamps, fac01_01_...pdf,
 * mimeType application/octet-stream) a ete recue avec un Content-Disposition
 * "inline" sans Content-ID, et donc silencieusement ignoree de bout en
 * bout (signale par l'utilisateur, novembre 2026) : une plateforme de
 * facturation peut marquer un VRAI document "inline" par erreur ou par
 * choix technique, mais n'integre jamais un PDF de facture comme simple
 * ressource de mise en forme - ce risque n'existe que pour les images.
 */
export function extrairePiecesJointes(payload: gmail_v1.Schema$MessagePart | undefined): PieceJointeExtraite[] {
  if (!payload) return [];
  const pieces: PieceJointeExtraite[] = [];

  function visiter(part: gmail_v1.Schema$MessagePart) {
    const estIntegree = Boolean(extraireEntete(part.headers, "Content-ID"));
    const disposition = extraireEntete(part.headers, "Content-Disposition").trim().toLowerCase();
    const estInline = disposition.startsWith("inline");
    const estImage = (part.mimeType || "").toLowerCase().startsWith("image/");
    if (part.filename && part.body?.attachmentId && !estIntegree && !(estInline && estImage)) {
      pieces.push({
        nomFichier: part.filename,
        mimeType: part.mimeType || "application/octet-stream",
        attachmentId: part.body.attachmentId,
      });
    }
    (part.parts || []).forEach(visiter);
  }

  visiter(payload);
  return pieces;
}

export function extraireEntete(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, nom: string): string {
  return headers?.find((h) => h.name?.toLowerCase() === nom.toLowerCase())?.value || "";
}

function attendre(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Marque un message Gmail comme entierement traite (voir le commentaire du
 * modele GmailMessageTraite dans prisma/schema.prisma pour le pourquoi) :
 * idempotent via upsert, au cas ou deux cycles se recouvreraient malgre le
 * garde-fou du planificateur.
 */
async function marquerMessageTraite(prisma: PrismaClient, gmailMessageId: string): Promise<void> {
  await prisma.gmailMessageTraite.upsert({
    where: { gmailMessageId },
    create: { gmailMessageId },
    update: {},
  });
}

/**
 * Reessaie un appel a l'API Gmail avec un delai croissant en cas de quota
 * depasse ("Quota exceeded... Units per minute per user"). Bug reel
 * constate en production : l'elargissement de la fenetre de recherche
 * (voir plus bas) a fait passer le nombre de messages examines par
 * synchronisation bien au-dela de ce que Gmail accepte sans throttling
 * (204 messages, 119 erreurs de quota en un seul passage) - la plupart de
 * ces appels reussiraient s'ils etaient simplement espaces dans le temps
 * plutot que tous tentes en rafale.
 */
async function appelAvecRetryQuota<T>(appel: () => Promise<T>, tentativesRestantes = 3, delaiMs = 2000): Promise<T> {
  try {
    return await appel();
  } catch (err) {
    const quotaDepasse = /quota exceeded|rate limit/i.test((err as Error).message || "");
    if (!quotaDepasse || tentativesRestantes <= 0) throw err;
    await attendre(delaiMs);
    return appelAvecRetryQuota(appel, tentativesRestantes - 1, delaiMs * 3);
  }
}

/**
 * Interrupteur de securite (section 16 : prudence en cas de doute) :
 * transfert automatique des factures vers Dext desactivable sans toucher
 * au code, via la variable d'environnement DEXT_AUTO_FORWARD. Quand
 * desactive (valeur "false"), les factures sont etiquetees dans Gmail par
 * mois de reception plutot que transmises, pour un envoi manuel groupe en
 * fin de mois le temps d'observer le comportement du systeme.
 */
export function transfertAutomatiqueActif(): boolean {
  return process.env.DEXT_AUTO_FORWARD !== "false";
}

/** Nom du libelle Gmail (hierarchique) pour le mois de reception donne. */
function nomEtiquetteFacturesDuMois(date: Date): string {
  const moisAnnee = new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric" }).format(date);
  const capitalise = moisAnnee.charAt(0).toUpperCase() + moisAnnee.slice(1);
  return `Copilote/Factures a transferer/${capitalise}`;
}

/**
 * Retrouve un libelle Gmail existant par son nom ou le cree s'il n'existe
 * pas encore (les libelles imbriques du type "Parent/Enfant" sont crees
 * automatiquement par l'API sans que le parent doive prealablement
 * exister). Met en cache le resultat pour la duree d'une synchronisation,
 * un meme libelle (le mois en cours) etant reutilise pour tous les
 * messages traites lors du meme passage.
 */
async function obtenirOuCreerLabel(gmail: gmail_v1.Gmail, nom: string, cache: Map<string, string>): Promise<string> {
  const enCache = cache.get(nom);
  if (enCache) return enCache;

  const liste = await gmail.users.labels.list({ userId: "me" });
  const existant = liste.data.labels?.find((l) => l.name === nom);
  if (existant?.id) {
    cache.set(nom, existant.id);
    return existant.id;
  }

  const cree = await gmail.users.labels.create({
    userId: "me",
    requestBody: { name: nom, labelListVisibility: "labelShow", messageListVisibility: "show" },
  });
  const id = cree.data.id;
  if (!id) throw new Error(`Echec de creation du libelle Gmail "${nom}"`);
  cache.set(nom, id);
  return id;
}

/**
 * Synchronise la boite Gmail connectee : detecte les nouveaux e-mails avec
 * pieces jointes, les classifie, ecarte les doublons deja connus, transfere
 * les factures standard vers Dext (sauf pause via DEXT_AUTO_FORWARD, voir
 * plus bas), archive bons d'enlevement, releves et devis, et met en
 * attente de validation les documents ambigus. Reprend le pipeline de la
 * section 7.2 du cahier des charges.
 *
 * Idempotent par construction (deduplication sur le hash de chaque piece
 * jointe) : peut etre appelee autant de fois que necessaire, par exemple
 * depuis un planificateur externe (cron) toutes les quelques minutes, sans
 * jamais retransmettre un document deja envoye a Dext.
 */
/**
 * depuis (optionnel) : synchronisation historique ponctuelle au-dela de la
 * fenetre glissante habituelle de 14 jours (meme principe que
 * synchroniserStripe) - demande explicite de l'utilisateur pour retrouver
 * et envoyer vers Dext des factures recues avant la mise en route de
 * l'automatisation. ⚠️ Risque documente plus haut : une fenetre trop large
 * a deja provoque un depassement soutenu du quota Gmail en conditions
 * reelles (204 messages, 119 erreurs en un seul passage) - meme avec la
 * pagination et les nouvelles tentatives deja en place, une fenetre de
 * plusieurs mois peut rester lente et necessiter plusieurs appels
 * successifs (les messages deja examines sont ignores des le prochain
 * appel, voir idsTraites plus bas - jamais retraites en double).
 */
export async function synchroniserGmail(prisma: PrismaClient, depuis?: Date): Promise<ResultatSyncGmail> {
  const resultat: ResultatSyncGmail = {
    messagesExamines: 0,
    documentsTraites: 0,
    documentsDoublons: 0,
    documentsAmbigus: 0,
    erreurs: [],
  };

  const connexionGmail = await getGmailClient(prisma);
  if (!connexionGmail) {
    throw new Error("Aucune boite Gmail connectee. Se connecter via /auth/google d'abord.");
  }
  const { gmail, connexion } = connexionGmail;

  // Fenetre de recherche volontairement large (14 jours) : la deduplication
  // par hash de piece jointe rend le re-balayage de messages deja traites
  // sans consequence, et evite de manquer un message en cas d'arret
  // prolonge du service entre deux synchronisations (ex. jeton Google
  // expire plusieurs jours, deja constate en production). On exclut
  // d'office les e-mails de Dext lui-meme (accuses de reception,
  // recapitulatif quotidien) : ce sont des notifications sortantes de
  // Dext, jamais des documents fournisseurs a router.
  //
  // Pagination complete (pageToken) plutot qu'un seul appel limite a
  // maxResults : sans cela, au-dela du premier lot (ordonne du plus recent
  // au plus ancien par Gmail), les messages plus anciens dans la fenetre
  // n'etaient JAMAIS examines, sans la moindre erreur ni trace - bug reel
  // trouve en relisant ce fichier. Garde-fou a 1000 messages pour eviter
  // une boucle non bornee en cas de resultat anormalement volumineux.
  //
  // ⚠️ Historique : une premiere version utilisait 30 jours (alignee sur
  // Stripe), pour une securite maximale contre un arret prolonge du
  // service. En conditions reelles, cela a fait passer le nombre de
  // messages examines par synchronisation bien au-dela de ce que l'API
  // Gmail accepte sans throttling (204 messages, 119 erreurs "Quota
  // exceeded... Units per minute per user" en un seul passage, visible
  // dans le Journal). Reduit a 14 jours (toujours 2x la fenetre de 7 jours
  // qui posait probleme) et combine desormais avec une pause entre chaque
  // message et des nouvelles tentatives automatiques en cas de quota
  // depasse (voir appelAvecRetryQuota) plutot que de se reposer uniquement
  // sur une fenetre large.
  const filtreDate = depuis ? `after:${depuis.toISOString().slice(0, 10).replace(/-/g, "/")}` : "newer_than:14d";
  const messages: gmail_v1.Schema$Message[] = [];
  let pageToken: string | undefined;
  do {
    const liste = await gmail.users.messages.list({
      userId: "me",
      q: `has:attachment ${filtreDate} -from:dext.cc`,
      maxResults: 100,
      pageToken,
    });
    messages.push(...(liste.data.messages || []));
    pageToken = liste.data.nextPageToken || undefined;
  } while (pageToken && messages.length < 1000);

  // Cause reelle (et plus profonde que la simple rafale deja corrigee
  // ci-dessus) du depassement de quota Gmail constate en production de
  // facon soutenue (plusieurs heures d'affilee, meme avec des tentatives
  // bien espacees) : la deduplication par hashFichier n'intervenait
  // jusqu'ici qu'APRES avoir deja retelecharge chaque piece jointe
  // (messages.get PUIS attachments.get, les deux appels les plus couteux
  // en quota) - aucune economie n'etait donc jamais realisee pour un
  // message deja entierement connu, re-telecharge en entier a chaque
  // cycle (toutes les 5 minutes) pendant toute la fenetre de 14 jours. On
  // ecarte ici, avant le moindre appel couteux, tout message deja marque
  // "traite" (voir l'ecriture dans GmailMessageTraite en fin de boucle) :
  // le volume reel d'appels Gmail par cycle tombe ainsi au nombre de
  // messages vraiment nouveaux depuis le cycle precedent, au lieu du
  // volume total de la fenetre de 14 jours.
  const idsTraites = new Set(
    (
      await prisma.gmailMessageTraite.findMany({
        where: { gmailMessageId: { in: messages.map((m) => m.id).filter((id): id is string => !!id) } },
        select: { gmailMessageId: true },
      })
    ).map((m) => m.gmailMessageId)
  );

  const cacheLabels = new Map<string, string>();
  const cacheFournisseurs = new Map<string, string>();

  for (const ref of messages) {
    if (!ref.id) continue;
    if (idsTraites.has(ref.id)) continue;
    resultat.messagesExamines++;
    // Pause volontaire entre chaque message (voir la note ci-dessus sur le
    // quota Gmail) : etale les appels dans le temps plutot que de les
    // tenter tous en rafale, cause reelle du depassement de quota constate.
    await attendre(150);

    // Mis a true si une piece ou le message rencontre une erreur reelle
    // (quota, permission...) : empeche de marquer le message "traite" dans
    // ce cas precis, pour qu'il soit retente au prochain cycle plutot que
    // silencieusement abandonne. Un message qui se termine sans la moindre
    // erreur, lui, n'a plus rien a apporter aux cycles suivants.
    let messageEnErreur = false;

    try {
      const msg = await appelAvecRetryQuota(() => gmail.users.messages.get({ userId: "me", id: ref.id!, format: "full" }));
      const headers = msg.data.payload?.headers;
      const sujet = extraireEntete(headers, "Subject");
      const expediteur = extraireEntete(headers, "From");
      const dateReception = msg.data.internalDate ? new Date(Number(msg.data.internalDate)) : null;

      // Filet de securite en plus du "-from:dext.cc" de la recherche
      // (au cas ou Dext changerait un jour de sous-domaine d'envoi) :
      // jamais retraiter un e-mail dont l'expediteur est Dext.
      if (expediteur.toLowerCase().includes("dext.cc")) {
        await marquerMessageTraite(prisma, ref.id);
        continue;
      }

      const piecesBrutes = extrairePiecesJointes(msg.data.payload);
      if (piecesBrutes.length === 0) {
        await marquerMessageTraite(prisma, ref.id); // rien a router pour ce message
        continue;
      }

      const emailContexte: EmailAClassifier = {
        sujet,
        expediteur,
        extraitCorps: msg.data.snippet || "",
        piecesJointes: piecesBrutes,
      };

      // Phase 1 : telecharger chaque piece, ecarter les doublons deja
      // connus, puis classifier — en lisant le CONTENU d'un PDF (pas
      // seulement le sujet/corps/nom de fichier) via extractPdfText. Sans
      // cela, une facture reelle avec un sujet generique ("Voici vos
      // documents") et le mot "facture" uniquement a l'interieur du PDF
      // tombait a tort en ambigu (signale par l'utilisateur en production).
      interface PieceAClasser {
        piece: PieceJointeExtraite;
        type: TypeDocument;
        donnees: Buffer;
        hashFichier: string;
        numero: string | null;
        montantHT: number | null;
        montantTTC: number | null;
        classifiePar: "ia" | null;
      }
      const piecesAtraiter: PieceAClasser[] = [];

      for (const piece of piecesBrutes) {
        try {
          const attachment = await appelAvecRetryQuota(() =>
            gmail.users.messages.attachments.get({ userId: "me", messageId: ref.id!, id: piece.attachmentId })
          );
          const donnees = Buffer.from(attachment.data.data || "", "base64url");
          const hashFichier = sha256Hex(donnees);

          // La deduplication (par empreinte de fichier) doit s'appliquer
          // AVANT toute chose, ambigu compris : sans cela, le meme e-mail
          // non reconnu (image de newsletter, logo...) etait re-signale
          // comme une toute nouvelle anomalie a chaque passage du
          // planificateur (toutes les 5 minutes), y compris apres avoir ete
          // "ignore" par l'utilisateur, qui le voyait donc revenir sans
          // cesse (bug reel signale par l'utilisateur en production).
          const existant = await prisma.documentFournisseur.findUnique({ where: { hashFichier } });
          if (existant) {
            // Pas de ligne de Journal par doublon (compteur seul, voir
            // resultat.documentsDoublons) : la fenetre de recherche
            // re-balaie chaque cycle (toutes les 5 minutes) les memes
            // messages sur 14 jours par construction (idempotence
            // deliberee, voir plus haut) - la grande majorite des pieces
            // rencontrees sont donc des doublons deja connus a chaque
            // passage. Une ligne par doublon inondait le Journal de
            // dizaines d'entrees quasi identiques et sans valeur ajoutee
            // au fil du temps (signale en production, capture a l'appui),
            // noyant les entrees reellement utiles (nouveaux documents,
            // erreurs). Le compte agrege reste visible dans le resume de
            // synchronisation quand quelque chose de notable s'est produit.
            resultat.documentsDoublons++;
            continue;
          }

          let contenuExtrait: string | undefined;
          if (piece.mimeType.toLowerCase() === "application/pdf") {
            try {
              contenuExtrait = extractPdfText(donnees);
            } catch {
              // pdftotext manquant ou PDF illisible : ne bloque pas la
              // classification, qui se rabat simplement sur le
              // sujet/corps/nom de fichier comme avant cette amelioration.
            }
          } else if (estPieceJointeZip(piece.mimeType, piece.nomFichier)) {
            // Certains fournisseurs (ex. TotalEnergies / cartes carburant)
            // envoient leur facture sous forme d'archive ZIP contenant le
            // PDF, plutot qu'un PDF direct - voir importers/zipAttachment.ts.
            contenuExtrait = extraireTexteDepuisZip(donnees);
          }
          // pdftotext emet toujours au moins un saut de page ("\f"), jamais
          // une chaine vraiment vide, meme sur un PDF sans aucune couche de
          // texte (scan/photo integree) - sans cette normalisation, ce "\f"
          // isole est "truthy" en JS et le document est a tort traite comme
          // ayant du texte, sans jamais declencher le repli vision IA
          // (voir texteSignificatif).
          contenuExtrait = texteSignificatif(contenuExtrait);

          let type = classifierPieceJointe(emailContexte, piece, contenuExtrait);
          let classifiePar: "ia" | null = null;

          // Filet de securite par IA (demande explicite de l'utilisateur,
          // apres deux regressions reelles sur des regles de mots-cles trop
          // rigides) : n'intervient QUE quand la regle deterministe conclut
          // "ambigu" sur une piece qui est bien un document exploitable -
          // jamais a la place d'un match par mot-cle deja confiant, jamais
          // sur une piece dont le type n'est de toute facon pas gere
          // (estPieceDocument). Toute panne de ce filet (cle absente, erreur
          // reseau...) retombe silencieusement sur "ambigu", le comportement
          // actuel : aucune regression possible, uniquement des cas
          // recuperes en plus.
          if (type === "ambigu" && estPieceDocument(piece)) {
            const texteComplet = `Sujet : ${sujet}\nExtrait du corps : ${emailContexte.extraitCorps}\nNom du fichier : ${piece.nomFichier}\n${contenuExtrait ? `Contenu du document :\n${contenuExtrait}` : ""}`;
            // Une image n'a aucun contenu textuel exploitable (contrairement
            // a un PDF) : seul un veritable coup d'oeil sur l'image (vision)
            // permet de distinguer un logo/une signature d'un vrai document
            // photographie, voir classifierImageParIA.
            const typeIA = piece.mimeType.toLowerCase().startsWith("image/")
              ? await classifierImageParIA(donnees, piece.mimeType, texteComplet)
              : await classifierParIA(texteComplet);
            if (typeIA && typeIA !== "ambigu") {
              type = typeIA;
              classifiePar = "ia";
            }
          }

          const numero = extraireNumeroFacture(`${sujet} ${piece.nomFichier} ${contenuExtrait || ""}`);
          // Montants HT et TTC (demande explicite de l'utilisateur : suivre
          // les depenses par fournisseur, en HT comme en TTC - et plus
          // recemment, "coder correctement pour qu'il puisse lire tous les
          // montants") : uniquement pour le type "facture", le seul ou ces
          // champs sont effectivement utilises (voir depensesFournisseurs.ts,
          // renduMontantFacture) - inutile de solliciter l'IA (resoudreMontantsFacture)
          // sur un devis/bon d'enlevement/releve. Jamais dans le sujet/corps :
          // un sujet/corps peut mentionner un montant sans rapport (devis
          // precedent, relance...) a la difference du document lui-meme.
          const { montantHT, montantTTC } =
            type === "facture" ? await resoudreMontantsFacture(prisma, piece.mimeType, donnees, contenuExtrait) : { montantHT: null, montantTTC: null };
          piecesAtraiter.push({ piece, type, donnees, hashFichier, numero, montantHT, montantTTC, classifiePar });
        } catch (err) {
          resultat.erreurs.push(`${piece.nomFichier} : ${(err as Error).message}`);
          messageEnErreur = true;
        }
      }

      if (piecesAtraiter.length === 0) {
        if (!messageEnErreur) await marquerMessageTraite(prisma, ref.id);
        continue;
      }

      const nbFactures = piecesAtraiter.filter((p) => p.type === "facture").length;
      const adresseDext = choisirAdresseDext(nbFactures);
      // Fiche fournisseur (section 6) resolue une seule fois par message,
      // et seulement si au moins un document est reellement reconnu
      // (facture, avoir, bon d'enlevement, releve, devis) : un lot
      // uniquement ambigu vient souvent d'un expediteur qui n'est pas un
      // vrai fournisseur (newsletter, notification...) — lui creer une
      // fiche aurait pollue la liste des fournisseurs (signale par
      // l'utilisateur en production).
      // "autre" (ex. CV d'une agence d'interim, voir
      // DOMAINES_EXPEDITEURS_NON_FOURNISSEURS dans gmailClassify.ts) exclu au
      // meme titre que "ambigu" : ce n'est jamais un vrai fournisseur, lui
      // creer une fiche polluerait la liste des fournisseurs.
      // "devis" exclu au meme titre que "ambigu"/"autre" (demande explicite
      // de l'utilisateur, novembre 2026) : un devis seul ne doit jamais
      // creer de fiche fournisseur - ni une photo client mal classee avant
      // le correctif ci-dessus, ni meme un vrai devis fournisseur, qu'il ne
      // veut pas voir dans cet onglet.
      const auMoinsUnDocumentReconnu = piecesAtraiter.some((p) => p.type !== "ambigu" && p.type !== "autre" && p.type !== "devis");
      const fournisseurId = auMoinsUnDocumentReconnu ? await resoudreFournisseur(prisma, expediteur, cacheFournisseurs) : null;

      for (const { piece, type, donnees, hashFichier, numero, montantHT, montantTTC, classifiePar } of piecesAtraiter) {
        try {
          if (type === "ambigu") {
            // Enregistre aussi un DocumentFournisseur (type "ambigu") pour
            // que le hash ci-dessus serve de garde-fou a la prochaine
            // synchronisation, en plus de creer l'anomalie a valider.
            await prisma.documentFournisseur.create({
              data: {
                type: "ambigu",
                fournisseurId,
                fichierNom: piece.nomFichier,
                numero,
                hashFichier,
                statutDext: "a_valider",
                gmailMessageId: ref.id,
                gmailAttachmentId: piece.attachmentId,
                mimeType: piece.mimeType,
                gmailExpediteur: expediteur,
                gmailObjet: sujet,
                dateReceptionMail: dateReception,
              },
            });
            await prisma.anomalie.create({
              data: {
                type: "document_gmail_ambigu",
                gravite: "moyenne",
                preuves: JSON.stringify({
                  messageId: ref.id,
                  attachmentId: piece.attachmentId,
                  mimeType: piece.mimeType,
                  expediteur,
                  sujet,
                  fichier: piece.nomFichier,
                }),
                actionProposee: "Examiner la piece jointe et la classer manuellement (facture, avoir, bon, releve).",
              },
            });
            resultat.documentsAmbigus++;
            resultat.documentsTraites++;
            continue;
          }

          // Une classification par IA (classifiePar === "ia") n'emprunte
          // jamais la voie d'envoi automatique, meme si le transfert
          // automatique est actif : elle attend toujours une confirmation
          // manuelle (bouton "Envoyer a Dext"), a la difference d'un match
          // par mot-cle deterministe sur "facture", juge assez fiable pour
          // continuer a partir seul. Garde-fou explicite plutot qu'une
          // simple consequence indirecte du code, pour qu'il reste valable
          // meme si la logique environnante change un jour.
          if (type === "facture" && transfertAutomatiqueActif() && classifiePar !== "ia") {
            await envoyerVersDext(gmail, { destinataire: adresseDext, nomFichier: piece.nomFichier, mimeType: piece.mimeType, donnees, sujetOrigine: sujet });
            // Copie dans l'archive Comptabilite - demande explicite de
            // l'utilisateur (chaque facture envoyee a Dext doit aussi y
            // rester archivee). N'empeche jamais l'envoi reel, deja fait
            // juste au-dessus, de compter comme reussi en cas d'echec ici.
            await archiverFactureEnvoyeeDext(prisma, {
              fichierNom: piece.nomFichier,
              mimeType: piece.mimeType,
              donnees,
              fournisseurNom: extraireIdentiteExpediteur(expediteur).nom,
              numero,
              dateFacture: dateReception,
              montantHT,
              montantTTC,
            }).catch(async (err) => {
              await logEvenement(prisma, {
                evenement: "archive_comptable_copie_dext_erreur",
                action: `Archivage Comptabilite de la facture envoyee a Dext : ${piece.nomFichier}`,
                resultat: (err as Error).message,
              }).catch(() => {});
            });
            await prisma.documentFournisseur.create({
              data: {
                type: "facture",
                fournisseurId,
                fichierNom: piece.nomFichier,
                numero,
                montantHT,
                montantTTC,
                hashFichier,
                statutDext: "envoye",
                gmailMessageId: ref.id,
                gmailAttachmentId: piece.attachmentId,
                mimeType: piece.mimeType,
                gmailExpediteur: expediteur,
                gmailObjet: sujet,
                dateReceptionMail: dateReception,
              },
            });
            await logEvenement(prisma, {
              evenement: "gmail_document",
              action: `Facture recue de ${expediteur} : ${piece.nomFichier}`,
              resultat: `Transferee automatiquement vers ${adresseDext} (cas standard, section "exception deja validee").`,
            });
          } else if (type === "facture") {
            // Transfert automatique en pause (DEXT_AUTO_FORWARD=false), ou
            // classifiee par IA (toujours manuelle, voir plus haut) : on
            // etiquette dans Gmail par mois de reception pour un envoi
            // manuel groupe en fin de mois, plutot que de transmettre.
            const nomLabel = nomEtiquetteFacturesDuMois(dateReception || new Date());
            const labelId = await obtenirOuCreerLabel(gmail, nomLabel, cacheLabels);
            await gmail.users.messages.modify({ userId: "me", id: ref.id, requestBody: { addLabelIds: [labelId] } });
            await prisma.documentFournisseur.create({
              data: {
                type: "facture",
                fournisseurId,
                fichierNom: piece.nomFichier,
                numero,
                montantHT,
                montantTTC,
                hashFichier,
                statutDext: "a_valider",
                classifiePar,
                gmailMessageId: ref.id,
                gmailAttachmentId: piece.attachmentId,
                mimeType: piece.mimeType,
                gmailExpediteur: expediteur,
                gmailObjet: sujet,
                dateReceptionMail: dateReception,
              },
            });
            await logEvenement(prisma, {
              evenement: "gmail_document",
              action: `Facture recue de ${expediteur} : ${piece.nomFichier}`,
              resultat:
                (classifiePar === "ia" ? "Classee par IA (a verifier). " : "") +
                `Transfert automatique en pause : etiquetee "${nomLabel}" dans Gmail pour envoi manuel en fin de mois.`,
            });
          } else {
            // avoir | bon_enlevement | releve | devis | autre : jamais
            // envoyes a Dext, archives pour controle (sections 6.3, 6.4).
            // "devis" force fournisseurId a null meme si le message
            // contient par ailleurs une facture/avoir ayant deja resolu une
            // fiche fournisseur (variable partagee pour tout le message) :
            // un devis ne doit jamais s'y attacher (demande explicite de
            // l'utilisateur).
            await prisma.documentFournisseur.create({
              data: {
                type,
                fournisseurId: type === "devis" ? null : fournisseurId,
                fichierNom: piece.nomFichier,
                numero,
                hashFichier,
                statutDext: "archive",
                classifiePar,
                gmailMessageId: ref.id,
                gmailAttachmentId: piece.attachmentId,
                mimeType: piece.mimeType,
                gmailExpediteur: expediteur,
                gmailObjet: sujet,
                dateReceptionMail: dateReception,
              },
            });
            await logEvenement(prisma, {
              evenement: "gmail_document",
              action: `${type} recu de ${expediteur} : ${piece.nomFichier}`,
              resultat: (classifiePar === "ia" ? "Classee par IA (a verifier). " : "") + "Archive pour controle, non transmis a Dext.",
            });

            if (type === "releve") {
              await controlerReleveFournisseur(prisma, {
                fournisseurId,
                fournisseurNom: extraireIdentiteExpediteur(expediteur).nom,
                fichierNom: piece.nomFichier,
              });
            }
          }

          resultat.documentsTraites++;
        } catch (err) {
          resultat.erreurs.push(`${piece.nomFichier} : ${(err as Error).message}`);
          messageEnErreur = true;
        }
      }

      if (!messageEnErreur) await marquerMessageTraite(prisma, ref.id);
    } catch (err) {
      resultat.erreurs.push(`Message ${ref.id} : ${(err as Error).message}`);
    }
  }

  await prisma.gmailConnexion.update({
    where: { id: connexion.id },
    data: { derniereSynchro: new Date() },
  });

  return resultat;
}

/**
 * Envoie une piece jointe vers l'adresse Dext dediee, depuis la boite
 * Gmail connectee (via l'API Gmail, jamais de mot de passe SMTP separe).
 */
export async function envoyerVersDext(
  gmail: gmail_v1.Gmail,
  params: { destinataire: string; nomFichier: string; mimeType: string; donnees: Buffer; sujetOrigine: string }
) {
  const composer = new MailComposer({
    to: params.destinataire,
    subject: `Facture fournisseur - ${params.sujetOrigine}`.slice(0, 200),
    text: "Facture fournisseur transferee automatiquement par le copilote de gestion Atelier Brochant.",
    attachments: [{ filename: params.nomFichier, content: params.donnees, contentType: params.mimeType }],
  });

  const message = await composer.compile().build();
  const raw = message.toString("base64url");

  await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
}

export class DocumentFournisseurEnvoiError extends Error {}

/**
 * Envoi manuel vers Dext d'une facture fournisseur deja recue et
 * classifiee, mais pas encore transferee (statutDext "a_valider" : soit le
 * transfert automatique est en pause via DEXT_AUTO_FORWARD=false et la
 * facture attend l'envoi groupe de fin de mois, soit elle a ete corrigee
 * manuellement en "facture" depuis le centre de validation des anomalies).
 * Toujours a la demande explicite de l'utilisateur (bouton "Envoyer a
 * Dext"), jamais declenche automatiquement.
 */
export async function envoyerDocumentFournisseurVersDext(prisma: PrismaClient, documentId: string): Promise<void> {
  const document = await prisma.documentFournisseur.findUnique({ where: { id: documentId } });
  if (!document) throw new DocumentFournisseurEnvoiError("Document introuvable.");
  if (document.type !== "facture") {
    throw new DocumentFournisseurEnvoiError(`Seules les factures peuvent etre envoyees a Dext (type actuel : ${document.type}).`);
  }
  if (document.statutDext === "envoye") {
    throw new DocumentFournisseurEnvoiError("Cette facture a deja ete envoyee a Dext.");
  }
  // Deux sources possibles pour les octets du document : un document papier
  // numerise (cheminFichier, voir documentsScannes.ts) n'a jamais de message
  // Gmail a redemander, a la difference d'un document recu par e-mail.
  if (!document.cheminFichier && (!document.gmailMessageId || !document.gmailAttachmentId)) {
    throw new DocumentFournisseurEnvoiError("Piece jointe non disponible (document trop ancien, avant l'enregistrement de sa reference Gmail).");
  }

  const connexionGmail = await getGmailClient(prisma);
  if (!connexionGmail) throw new DocumentFournisseurEnvoiError("Gmail non connecte.");
  const { gmail } = connexionGmail;

  let donnees: Buffer;
  if (document.cheminFichier) {
    donnees = await fs.readFile(document.cheminFichier);
  } else {
    const attachment = await gmail.users.messages.attachments.get({
      userId: "me",
      messageId: document.gmailMessageId!,
      id: document.gmailAttachmentId!,
    });
    donnees = Buffer.from(attachment.data.data || "", "base64url");
  }

  // Un envoi manuel porte toujours sur un document a la fois : l'adresse
  // "multiple" (choisirAdresseDext) ne s'applique qu'au moment ou plusieurs
  // factures arrivent groupees dans le meme e-mail, contexte deja passe ici.
  const destinataire = choisirAdresseDext(1);
  await envoyerVersDext(gmail, {
    destinataire,
    nomFichier: document.fichierNom || "facture",
    mimeType: document.mimeType || "application/octet-stream",
    donnees,
    sujetOrigine: document.gmailObjet || document.fichierNom || "Facture fournisseur",
  });

  // Copie dans l'archive Comptabilite - meme principe que l'envoi
  // automatique ci-dessus (demande explicite de l'utilisateur). N'empeche
  // jamais l'envoi reel, deja fait juste au-dessus, de compter comme
  // reussi en cas d'echec ici.
  const fournisseurNom = document.fournisseurId
    ? (await prisma.fournisseur.findUnique({ where: { id: document.fournisseurId } }))?.nom ?? null
    : null;
  await archiverFactureEnvoyeeDext(prisma, {
    fichierNom: document.fichierNom || "facture",
    mimeType: document.mimeType || "application/octet-stream",
    donnees,
    fournisseurNom,
    numero: document.numero,
    dateFacture: document.date ?? document.dateReceptionMail ?? null,
    montantHT: document.montantHT,
    montantTTC: document.montantTTC,
  }).catch(async (err) => {
    await logEvenement(prisma, {
      evenement: "archive_comptable_copie_dext_erreur",
      action: `Archivage Comptabilite de la facture envoyee a Dext : ${document.fichierNom}`,
      resultat: (err as Error).message,
    }).catch(() => {});
  });

  await prisma.documentFournisseur.update({ where: { id: documentId }, data: { statutDext: "envoye" } });
  await logEvenement(prisma, {
    evenement: "gmail_document",
    action: `Facture recue de ${document.gmailExpediteur} : ${document.fichierNom}`,
    resultat: `Envoyee manuellement vers ${destinataire} depuis le centre de fournisseurs.`,
  });
}

export class AnomalieClassificationError extends Error {}

/**
 * Classification manuelle d'un document ambigu en facture fournisseur,
 * depuis le centre de validation des anomalies (section 7.2) : le document
 * rejoint "Factures fournisseurs reçues" (onglet Factures) comme une
 * facture reconnue automatiquement, et attend le meme geste volontaire
 * d'envoi vers Dext (voir envoyerDocumentFournisseurVersDext ci-dessus).
 */
export async function classerAnomalieCommeFacture(prisma: PrismaClient, anomalieId: string): Promise<void> {
  const anomalie = await prisma.anomalie.findUnique({ where: { id: anomalieId } });
  if (!anomalie) throw new AnomalieClassificationError("Anomalie introuvable.");
  if (anomalie.statut !== "a_valider") throw new AnomalieClassificationError("Cette anomalie a deja ete traitee.");

  let preuves: Record<string, string> = {};
  try {
    preuves = JSON.parse(anomalie.preuves || "{}");
  } catch {
    // preuves illisibles : traite comme absentes ci-dessous
  }
  if (!preuves.messageId || !preuves.attachmentId) {
    throw new AnomalieClassificationError("Document associe introuvable (piece jointe plus ancienne).");
  }

  const document = await prisma.documentFournisseur.findFirst({
    where: { gmailMessageId: preuves.messageId, gmailAttachmentId: preuves.attachmentId },
  });
  if (!document) throw new AnomalieClassificationError("Document associe introuvable.");

  // Un document "ambigu" (type d'origine) n'a jamais de fournisseur resolu
  // (voir auMoinsUnDocumentReconnu dans synchroniserGmail, qui l'exclut
  // explicitement) : le reclasser en facture ici doit donc aussi tenter la
  // resolution, sinon il reste "fournisseur non identifie" indefiniment
  // meme quand l'expediteur permet de le reconnaitre - bug reel constate en
  // production (novembre 2026, plusieurs tickets Leroy Merlin reclasses en
  // facture mais jamais rattaches au fournisseur).
  const fournisseurId = document.fournisseurId ?? (document.gmailExpediteur ? await resoudreFournisseur(prisma, document.gmailExpediteur) : null);

  await prisma.documentFournisseur.update({ where: { id: document.id }, data: { type: "facture", statutDext: "a_valider", fournisseurId } });
  await prisma.anomalie.update({ where: { id: anomalieId }, data: { statut: "validee" } });
  await logEvenement(prisma, {
    evenement: "gmail_document",
    action: `Document reclasse en facture : ${document.fichierNom}`,
    resultat: "Classification manuelle depuis le centre de validation des anomalies.",
  });
}

export interface ResultatBackfillMontants {
  traitees: number;
  miseAJour: number;
  toujoursSansMontant: number;
  ignorees: number;
  erreurs: string[];
}

/**
 * Re-extrait les montants HT/TTC des factures fournisseurs deja en base
 * qui n'en ont pas (montantHT et/ou montantTTC nuls) - necessaire pour
 * tout document recu AVANT l'introduction de extraireMontantHTFacture/
 * extraireMontantTTCFacture (section "Dépenses par fournisseur") :
 * l'extraction ne s'execute qu'au moment de la reception d'un nouvel
 * e-mail (voir synchroniserGmail), jamais retroactivement sur les
 * documents deja stockes - signale par l'utilisateur en production (la
 * quasi-totalite des factures existantes affichaient "0,00 €" faute
 * d'avoir jamais ete passees dans cette extraction).
 *
 * Re-telecharge chaque piece jointe via Gmail (gmailMessageId +
 * gmailAttachmentId, meme mecanisme que envoyerDocumentFournisseurVersDext
 * ci-dessus) pour en relire le contenu PDF, plutot que de deviner un
 * montant a partir des seules metadonnees deja en base. Un document sans
 * reference Gmail exploitable (trop ancien, ou facture papier numerisee
 * sans texte extractible) est compte a part (ignorees) plutot que de
 * provoquer une erreur bloquante pour les autres.
 */
export interface ResultatBackfillFournisseur {
  total: number;
  resolues: number;
}

/**
 * Resout retroactivement le fournisseur des factures/avoirs qui n'en ont
 * jamais eu (fournisseurId null) alors que leur expediteur Gmail le
 * permettrait. Cas reel : un document "ambigu" reclasse en facture depuis
 * le centre de validation des anomalies ne beneficiait jamais de cette
 * resolution (voir classerAnomalieCommeFacture, corrige pour les nouveaux
 * cas ci-dessus) - plusieurs tickets Leroy Merlin reclasses en facture sont
 * ainsi restes "fournisseur non identifie" malgre un expediteur parfaitement
 * reconnaissable (constate en production, novembre 2026). Aucun appel Gmail
 * necessaire (contrairement a backfillMontantsFacturesSansMontant ci-dessous) :
 * la resolution ne depend que de gmailExpediteur, deja en base - reste donc
 * synchrone, un lot de quelques centaines de documents se traite en
 * quelques secondes.
 */
export async function backfillFournisseurDocumentsSansFournisseur(prisma: PrismaClient): Promise<ResultatBackfillFournisseur> {
  const documents = await prisma.documentFournisseur.findMany({
    where: { type: { in: ["facture", "avoir"] }, fournisseurId: null, gmailExpediteur: { not: null } },
  });
  if (documents.length === 0) return { total: 0, resolues: 0 };

  const cache = new Map<string, string>();
  let resolues = 0;
  for (const document of documents) {
    try {
      const fournisseurId = await resoudreFournisseur(prisma, document.gmailExpediteur!, cache);
      await prisma.documentFournisseur.update({ where: { id: document.id }, data: { fournisseurId } });
      resolues++;
    } catch {
      // Un document isole en echec (ex. collision de nom rare deja geree
      // dans resoudreFournisseur, ou erreur base passagere) ne doit jamais
      // bloquer le reste du lot.
    }
  }

  await logEvenement(prisma, {
    evenement: "gmail_document",
    action: "Resolution retroactive du fournisseur des documents sans fiche",
    resultat: `${resolues} document(s) desormais rattaches a un fournisseur, sur ${documents.length} au total.`,
  });

  return { total: documents.length, resolues };
}

export async function backfillMontantsFacturesSansMontant(prisma: PrismaClient): Promise<ResultatBackfillMontants> {
  const resultat: ResultatBackfillMontants = { traitees: 0, miseAJour: 0, toujoursSansMontant: 0, ignorees: 0, erreurs: [] };

  const documents = await prisma.documentFournisseur.findMany({
    where: { type: "facture", OR: [{ montantHT: null }, { montantTTC: null }] },
  });

  const aTraiter = documents.filter((d) => d.gmailMessageId && d.gmailAttachmentId);
  resultat.ignorees = documents.length - aTraiter.length;
  if (aTraiter.length === 0) return resultat;

  const connexionGmail = await getGmailClient(prisma);
  if (!connexionGmail) throw new Error("Aucune boite Gmail connectee. Se connecter via /auth/google d'abord.");

  // Ne bloque plus la reponse HTTP jusqu'a la fin (voir traiterBackfillMontants
  // ci-dessous) : avec resoudreMontantsFacture (filet IA, vision sur PDF
  // sans texte...) ajoute depuis, quelques centaines de documents peuvent
  // largement depasser les delais d'attente HTTP (nginx, le serveur Node
  // lui-meme) - constate en production (reponse jamais recue cote client,
  // alors que le traitement continuait bel et bien cote serveur). Le
  // compte exact (mise a jour/toujours sans montant/erreurs) n'est donc
  // connu qu'a la fin, visible dans le Journal plutot que dans la reponse.
  resultat.traitees = aTraiter.length;
  traiterBackfillMontants(prisma, connexionGmail.gmail, aTraiter).catch(() => {
    // traiterBackfillMontants journalise deja chaque erreur individuelle
    // et son propre evenement de fin - rien de plus a faire ici, cette
    // securite n'existe que pour ne jamais laisser une promesse detachee
    // non geree faire planter le processus.
  });

  return resultat;
}

async function traiterBackfillMontants(
  prisma: PrismaClient,
  gmail: gmail_v1.Gmail,
  aTraiter: Awaited<ReturnType<typeof prisma.documentFournisseur.findMany>>
): Promise<void> {
  let miseAJour = 0;
  let toujoursSansMontant = 0;
  const erreurs: string[] = [];

  for (const document of aTraiter) {
    // Meme pause volontaire qu'en synchronisation normale (voir
    // appelAvecRetryQuota/synchroniserGmail) : un lot de plusieurs
    // centaines de documents en rafale a deja provoque un depassement de
    // quota Gmail soutenu en conditions reelles.
    await attendre(150);
    try {
      const attachment = await appelAvecRetryQuota(() =>
        gmail.users.messages.attachments.get({ userId: "me", messageId: document.gmailMessageId!, id: document.gmailAttachmentId! })
      );
      const donnees = Buffer.from(attachment.data.data || "", "base64url");
      const mimeType = (document.mimeType || "").toLowerCase();
      // pdftotext n'a de sens que sur un vrai PDF (ou un PDF enveloppe dans
      // un ZIP) - l'appeler sur une image (scan/photo) echouait
      // silencieusement en erreur auparavant, cette facture ne recevant
      // alors jamais aucune tentative d'extraction. Une image, ou un PDF
      // sans texte extractible, passe desormais par resoudreMontantsFacture
      // (vision IA), ci-dessous, plutot que d'etre ecartee ici.
      let contenuExtrait: string | undefined;
      if (estPieceJointeZip(mimeType, document.fichierNom || "")) {
        contenuExtrait = extraireTexteDepuisZip(donnees);
      } else if (mimeType === "application/pdf") {
        try {
          contenuExtrait = extractPdfText(donnees);
        } catch {
          // PDF illisible par pdftotext : repli sur la vision IA ci-dessous
          // (rendrePremierePageEnImage), contenuExtrait reste undefined.
        }
      }
      // Voir texteSignificatif : pdftotext emet toujours au moins un saut
      // de page ("\f"), jamais une chaine vraiment vide, meme sans aucune
      // couche de texte - sans cette normalisation, resoudreMontantsFacture
      // ne declenchait jamais son repli vision IA sur ces documents.
      contenuExtrait = texteSignificatif(contenuExtrait);
      const resolu = await resoudreMontantsFacture(prisma, mimeType, donnees, contenuExtrait);
      const montantTTC = document.montantTTC ?? resolu.montantTTC;
      const montantHT = document.montantHT ?? resolu.montantHT;
      if (montantHT != null || montantTTC != null) {
        await prisma.documentFournisseur.update({ where: { id: document.id }, data: { montantHT, montantTTC } });
        miseAJour++;
      } else {
        toujoursSansMontant++;
      }
    } catch (err) {
      erreurs.push(`${document.fichierNom || document.id} : ${(err as Error).message}`);
    }
  }

  await logEvenement(prisma, {
    evenement: "gmail_backfill_montants",
    action: "Re-extraction des montants HT/TTC des factures fournisseurs deja en base",
    resultat: `${miseAJour} mise(s) a jour, ${toujoursSansMontant} toujours sans montant exploitable, ${erreurs.length} erreur(s) sur ${aTraiter.length} traitee(s).`,
  });
}
