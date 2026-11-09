import { PrismaClient } from "@prisma/client";
import MailComposer from "nodemailer/lib/mail-composer";
import { getGmailClient } from "./googleAuth";
import { logEvenement } from "./journalService";
import { repondreMorgane } from "./morgane";
import { construireEmailHtml } from "./emailFormat";
import { obtenirEtatActualitesPagesJaunes } from "./pagesJaunesActions";

/**
 * Demande explicite de l'utilisateur : Morgane doit proposer elle-meme des
 * idees d'actualites/offres PagesJaunes, pas seulement sur demande dans la
 * conversation. Meme principe que l'analyse quotidienne Google Ads
 * (googleAdsRecap.ts) : reutilise repondreMorgane() plutot qu'un moteur
 * separe, et ne depose JAMAIS de proposition elle-meme - uniquement un
 * rapport de suggestions en texte, que l'utilisateur doit redemander
 * explicitement en conversation pour qu'une proposition soit deposee.
 *
 * Hebdomadaire (pas quotidien comme Ads) : l'objectif Solocal est mensuel (4
 * actualites/mois), un rythme quotidien n'aurait aucun sens et noierait
 * l'utilisateur. Egalement silencieux si l'objectif du mois est deja
 * atteint, pour ne jamais relancer inutilement.
 */
const PROMPT_ANALYSE_PAGESJAUNES = `Propose des idees d'actualites/offres PagesJaunes (Solocal Manager) pour A.B Atelier Brochant.
1. Appelle obtenir_etat_actualites_pagesjaunes pour savoir ou on en est ce mois-ci par rapport a l'objectif (4/mois) et quels angles ont deja ete utilises recemment (a ne pas repeter).
2. Propose 2 a 3 idees concretes et varieres (actualite de service, offre/promotion, conseil de saison...), redigees comme de vrais textes prets a affiner - pas juste des titres vagues. N'invente aucun fait precis sur une intervention ou un client (aucune donnee de ce type n'est disponible ici) : reste sur des themes generiques pertinents pour un plombier/chauffagiste (entretien de saison, disponibilite, intervention rapide...).
3. Ne depose AUCUNE proposition toi-meme (n'appelle jamais proposer_actualite_pagesjaunes depuis cette analyse automatique) : ce sont des idees a valider par l'utilisateur, qui doit te les redemander explicitement en conversation.

Format de reponse IMPORTANT (ce texte part directement dans un e-mail mis en forme automatiquement) :
- Une phrase d'etat en haut (ex. "X actualite(s) publiee(s) ce mois-ci sur l'objectif de 4").
- Une idee par puce "- ", avec le texte propose entre guillemets.
- Pas de phrase de conclusion generique.`;

export async function envoyerAnalysePagesJaunes(prisma: PrismaClient, maintenant: Date = new Date()): Promise<void> {
  const etat = await obtenirEtatActualitesPagesJaunes(prisma, maintenant);
  if (etat.nbPublieesCeMois >= etat.objectifMensuel) {
    await logEvenement(prisma, {
      evenement: "analyse_pagesjaunes_non_envoyee",
      action: "Analyse hebdomadaire PagesJaunes",
      resultat: `Ignoree : objectif du mois deja atteint (${etat.nbPublieesCeMois}/${etat.objectifMensuel}).`,
    });
    return;
  }

  const connexionGmail = await getGmailClient(prisma);
  if (!connexionGmail) {
    await logEvenement(prisma, {
      evenement: "analyse_pagesjaunes_non_envoyee",
      action: "Analyse hebdomadaire PagesJaunes",
      resultat: "Ignoree : aucune boite Gmail active (reconnexion necessaire via /auth/google).",
    });
    return;
  }

  let contenu: string;
  try {
    contenu = await repondreMorgane(prisma, [{ role: "user", content: PROMPT_ANALYSE_PAGESJAUNES }]);
  } catch (err) {
    await logEvenement(prisma, {
      evenement: "analyse_pagesjaunes_erreur",
      action: "Analyse hebdomadaire PagesJaunes",
      resultat: `Echec : ${(err as Error).message}`,
    });
    return;
  }

  const { gmail, connexion } = connexionGmail;
  const sujet = `Idées d'actualités PagesJaunes du ${maintenant.toLocaleDateString("fr-FR")} - Copilote Atelier Brochant`;
  const composer = new MailComposer({
    to: connexion.compteEmail,
    subject: sujet,
    text: contenu,
    html: construireEmailHtml({ titre: "Idées d'actualités PagesJaunes", sousTitre: maintenant.toLocaleDateString("fr-FR"), corpsMarkdown: contenu }),
  });
  const message = await composer.compile().build();
  const raw = message.toString("base64url");
  await gmail.users.messages.send({ userId: "me", requestBody: { raw } });

  await logEvenement(prisma, {
    evenement: "analyse_pagesjaunes_envoyee",
    action: `Analyse hebdomadaire PagesJaunes envoyee a ${connexion.compteEmail}`,
    resultat: "Envoi reussi.",
  });
}
