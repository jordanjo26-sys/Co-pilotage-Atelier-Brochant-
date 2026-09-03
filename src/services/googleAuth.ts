import { google } from "googleapis";
import { PrismaClient } from "@prisma/client";
import { chiffrer, dechiffrer } from "./cipher";

/**
 * Connexion OAuth2 a Gmail (section 7 et 17 du cahier des charges) :
 * jamais de mot de passe, uniquement OAuth avec permissions minimales.
 * Le scope gmail.modify est necessaire pour marquer les messages traites
 * (libelle applique) sans donner acces a l'envoi au nom de l'utilisateur
 * au-dela de ce qui est strictement necessaire au transfert vers Dext.
 */
export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.labels",
];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} manquante. Creer un projet Google Cloud, activer l'API Gmail, configurer l'ecran ` +
        "de consentement OAuth et un identifiant client de type 'Application Web', puis renseigner " +
        "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI dans .env."
    );
  }
  return value;
}

export function buildOAuthClient() {
  return new google.auth.OAuth2(
    requireEnv("GOOGLE_CLIENT_ID"),
    requireEnv("GOOGLE_CLIENT_SECRET"),
    requireEnv("GOOGLE_REDIRECT_URI")
  );
}

/** URL vers laquelle rediriger l'utilisateur pour l'ecran de consentement Google. */
export function buildConsentUrl(): string {
  const client = buildOAuthClient();
  return client.generateAuthUrl({
    access_type: "offline", // necessaire pour obtenir un refresh_token
    prompt: "consent", // force le renvoi d'un refresh_token meme en reconnexion
    scope: GMAIL_SCOPES,
  });
}

/**
 * Echange le code d'autorisation renvoye par Google contre des jetons,
 * chiffre le refresh_token et l'enregistre (ou le met a jour) en base.
 */
export async function handleOAuthCallback(prisma: PrismaClient, code: string) {
  const client = buildOAuthClient();
  const { tokens } = await client.getToken(code);

  if (!tokens.refresh_token) {
    throw new Error(
      "Google n'a pas renvoye de refresh_token (cela arrive lors d'une reconnexion sans revoquer " +
        "l'acces precedent). Revoquer l'acces existant sur myaccount.google.com/permissions puis reessayer."
    );
  }

  client.setCredentials(tokens);
  const gmail = google.gmail({ version: "v1", auth: client });
  const profil = await gmail.users.getProfile({ userId: "me" });
  const compteEmail = profil.data.emailAddress;
  if (!compteEmail) throw new Error("Impossible de determiner l'adresse Gmail connectee.");

  const refreshTokenChiffre = chiffrer(tokens.refresh_token);

  await prisma.gmailConnexion.upsert({
    where: { compteEmail },
    update: { refreshTokenChiffre, scope: tokens.scope ?? null, actif: true },
    create: { compteEmail, refreshTokenChiffre, scope: tokens.scope ?? null },
  });

  return compteEmail;
}

/**
 * Retourne un client Gmail authentifie pour la connexion active, en
 * rafraichissant l'access token a partir du refresh token chiffre stocke.
 * Retourne null si aucune boite n'est connectee.
 */
export async function getGmailClient(prisma: PrismaClient) {
  const connexion = await prisma.gmailConnexion.findFirst({ where: { actif: true } });
  if (!connexion) return null;

  const client = buildOAuthClient();
  client.setCredentials({ refresh_token: dechiffrer(connexion.refreshTokenChiffre) });

  return { gmail: google.gmail({ version: "v1", auth: client }), connexion };
}
