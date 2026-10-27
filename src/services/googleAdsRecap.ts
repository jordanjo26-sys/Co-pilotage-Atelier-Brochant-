import { PrismaClient } from "@prisma/client";
import MailComposer from "nodemailer/lib/mail-composer";
import { getGmailClient } from "./googleAuth";
import { logEvenement } from "./journalService";
import { repondreMorgane } from "./morgane";
import { googleAdsEstConfigure } from "./googleAds";
import { construireEmailHtml } from "./emailFormat";

/**
 * Demande explicite de l'utilisateur : Morgane doit analyser automatiquement
 * les campagnes Google Ads chaque jour et remonter des recommandations
 * concretes (mots-cles a exclure, mots-cles a ajouter, points a ameliorer) -
 * pas seulement sur demande dans la conversation. Reutilise directement
 * repondreMorgane() (meme intelligence, memes outils que le chat) plutot
 * qu'un moteur de regles separe a maintenir en double : Morgane "analyse
 * elle-meme" exactement comme l'utilisateur le demande.
 *
 * Volontairement un rapport de LECTURE (aucune proposition deposee ici) :
 * meme principe de prudence que le reste de l'application - une
 * recommandation automatique n'est jamais appliquee sans que l'utilisateur
 * ne la redemande explicitement dans la conversation.
 */
const PROMPT_ANALYSE_QUOTIDIENNE = `Fais une analyse quotidienne de mes campagnes Google Ads actives (celles qui ont reellement du budget/de l'activite - ignore les campagnes en pause ou sans trafic). Pour la ou les campagnes actives :
1. Etat general (budget, depense, conversions, CTR) via obtenir_campagnes_ads.
2. Mots-cles a exclure : ceux avec un cout notable et zero conversion sur 30 jours (obtenir_mots_cles_ads).
3. Mots-cles a ajouter : des termes de recherche (obtenir_termes_recherche_ads) qui convertissent bien mais ne sont pas encore des mots-cles positifs.
4. Points d'amelioration eventuels : budget limite, score de qualite faible, annonce non approuvee (verifier_politique_annonces_ads si pertinent).

Donne une synthese claire et actionnable en francais. Pour chaque recommandation precise, donne le chiffre qui la justifie (pas d'affirmation sans donnee). Priorise les 3 a 5 points les plus importants plutot que tout lister - c'est un rapport quotidien court, pas une analyse exhaustive. Si rien de notable aujourd'hui, dis-le simplement en une phrase plutot que de forcer des recommandations. N'appelle JAMAIS proposer_action_ads ici : c'est un rapport de lecture seule, l'utilisateur redemandera lui-meme dans la conversation s'il veut agir sur une recommandation.

Format de reponse IMPORTANT (ce texte part directement dans un e-mail mis en forme automatiquement, l'utilisateur s'est plaint que les versions precedentes etaient "un pave de texte illisible") :
- Un titre "## " court par section (ex. "## Etat general", "## Mots-cles a exclure").
- Les chiffres cles en gras avec **...**.
- Une liste a puces "- " par recommandation individuelle (jamais un paragraphe qui enchaine plusieurs recommandations a la suite).
- Si tu listes plusieurs mots-cles avec chacun un cout/des conversions a comparer, utilise un tableau Markdown ("| Mot-cle | Cout | Conversions |" puis une ligne "|---|---|---|" puis une ligne par mot-cle) plutot qu'une liste - bien plus lisible pour comparer des chiffres.
- Pas de phrase d'introduction ni de conclusion generique ("Voici l'analyse...", "N'hesitez pas...") : va directement aux sections.`;

export async function envoyerAnalyseQuotidienneAds(prisma: PrismaClient, maintenant: Date = new Date()): Promise<void> {
  if (!googleAdsEstConfigure()) {
    await logEvenement(prisma, {
      evenement: "analyse_ads_non_envoyee",
      action: "Analyse quotidienne Google Ads",
      resultat: "Ignoree : Google Ads non configure.",
    });
    return;
  }

  const connexionGmail = await getGmailClient(prisma);
  if (!connexionGmail) {
    // Meme logique que envoyerRecapQuotidien (dailyRecap.ts) : journaliser
    // explicitement l'absence d'envoi, jamais un retour silencieux - une
    // panne prolongee de ce planificateur doit rester diagnosticable depuis
    // l'application elle-meme.
    await logEvenement(prisma, {
      evenement: "analyse_ads_non_envoyee",
      action: "Analyse quotidienne Google Ads",
      resultat: "Ignoree : aucune boite Gmail active (reconnexion necessaire via /auth/google).",
    });
    return;
  }

  let contenu: string;
  try {
    contenu = await repondreMorgane(prisma, [{ role: "user", content: PROMPT_ANALYSE_QUOTIDIENNE }]);
  } catch (err) {
    await logEvenement(prisma, {
      evenement: "analyse_ads_erreur",
      action: "Analyse quotidienne Google Ads",
      resultat: `Echec : ${(err as Error).message}`,
    });
    return;
  }

  const { gmail, connexion } = connexionGmail;
  const sujet = `Analyse Google Ads du ${maintenant.toLocaleDateString("fr-FR")} - Copilote Atelier Brochant`;
  const composer = new MailComposer({
    to: connexion.compteEmail,
    subject: sujet,
    text: contenu,
    html: construireEmailHtml({ titre: "Analyse Google Ads", sousTitre: maintenant.toLocaleDateString("fr-FR"), corpsMarkdown: contenu }),
  });
  const message = await composer.compile().build();
  const raw = message.toString("base64url");
  await gmail.users.messages.send({ userId: "me", requestBody: { raw } });

  await logEvenement(prisma, {
    evenement: "analyse_ads_envoyee",
    action: `Analyse quotidienne Google Ads envoyee a ${connexion.compteEmail}`,
    resultat: "Envoi reussi.",
  });
}
