import { PrismaClient } from "@prisma/client";
import MailComposer from "nodemailer/lib/mail-composer";
import { getGmailClient } from "./googleAuth";
import { getDashboardSummary } from "./dashboardService";
import { logEvenement } from "./journalService";

const LIBELLES_TYPE: Record<string, string> = {
  facture: "facture(s)",
  avoir: "avoir(s)",
  bon_enlevement: "bon(s) d'enlèvement",
  releve: "relevé(s)",
  devis: "devis / offre(s) de prix",
  ambigu: "document(s) non reconnu(s)",
  autre: "autre(s) document(s)",
};

// Couleur de badge par type de document (coherente avec les badges deja
// utilises dans l'application, voir public/styles.css) : "ambigu" reprend
// la couleur d'alerte des anomalies (c'est litteralement un document en
// attente de validation), "autre" reste neutre/discret.
const COULEUR_TYPE: Record<string, { fond: string; texte: string }> = {
  facture: { fond: "#dbeafe", texte: "#1d4ed8" },
  avoir: { fond: "#ede9fe", texte: "#6d28d9" },
  bon_enlevement: { fond: "#ccfbf1", texte: "#0f766e" },
  releve: { fond: "#e5e7eb", texte: "#374151" },
  devis: { fond: "#fef3c7", texte: "#b45309" },
  ambigu: { fond: "#fef3c7", texte: "#b45309" },
  autre: { fond: "#e5e7eb", texte: "#4b5563" },
};

function debutDeJournee(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

interface DonneesRecap {
  maintenant: Date;
  dateVeille: string;
  caVeille: number;
  impayesNombre: number;
  impayesMontant: number;
  documentsParType: [string, number][];
  totalDocuments: number;
  facturesEnvoyees: number;
  facturesEnAttente: number;
  transfertAutoActif: boolean;
  anomaliesAujourdhui: number;
  anomaliesOuvertesTotal: number;
  aValiderImports: number;
}

/**
 * Rassemble les donnees du recapitulatif quotidien, independamment de leur
 * mise en forme finale (texte brut pour l'apercu web/Morgane, HTML pour
 * l'e-mail - voir construireRecapQuotidien/construireRecapQuotidienHtml
 * plus bas) : une seule source de requetes, jamais deux implementations
 * divergentes des memes chiffres.
 */
async function collecterDonneesRecap(prisma: PrismaClient, maintenant: Date): Promise<DonneesRecap> {
  const debutJour = debutDeJournee(maintenant);
  const dashboard = await getDashboardSummary(prisma, maintenant);

  const documentsAujourdhui = await prisma.documentFournisseur.findMany({
    where: { createdAt: { gte: debutJour } },
    select: { type: true, statutDext: true },
  });

  const parType = new Map<string, number>();
  let facturesEnvoyees = 0;
  let facturesEnAttente = 0;
  for (const doc of documentsAujourdhui) {
    parType.set(doc.type, (parType.get(doc.type) || 0) + 1);
    if (doc.type === "facture") {
      if (doc.statutDext === "envoye") facturesEnvoyees++;
      else if (doc.statutDext === "a_valider") facturesEnAttente++;
    }
  }

  const anomaliesAujourdhui = await prisma.anomalie.count({ where: { createdAt: { gte: debutJour } } });
  const anomaliesOuvertesTotal = await prisma.anomalie.count({ where: { statut: "a_valider" } });

  return {
    maintenant,
    dateVeille: dashboard.dateVeille,
    caVeille: dashboard.caVeille,
    impayesNombre: dashboard.impayes.nombre,
    impayesMontant: dashboard.impayes.montantTotal,
    documentsParType: [...parType.entries()],
    totalDocuments: documentsAujourdhui.length,
    facturesEnvoyees,
    facturesEnAttente,
    transfertAutoActif: process.env.DEXT_AUTO_FORWARD !== "false",
    anomaliesAujourdhui,
    anomaliesOuvertesTotal,
    aValiderImports: dashboard.aValiderImports,
  };
}

/**
 * Construit le contenu (texte brut) du recapitulatif quotidien (demande
 * initiale de l'utilisateur : "un recapitulatif clair des actions
 * effectuees, des documents traites, des eventuels points en attente et
 * des actions necessitant mon attention"). Utilise pour l'apercu web
 * (/api/recap/apercu) et l'apercu dans Morgane : jamais d'e-mail, format
 * volontairement simple.
 */
export async function construireRecapQuotidien(prisma: PrismaClient, maintenant: Date = new Date()): Promise<string> {
  const d = await collecterDonneesRecap(prisma, maintenant);

  const lignes: string[] = [];
  lignes.push(`Recapitulatif du ${d.maintenant.toLocaleDateString("fr-FR")} - Copilote Atelier Brochant`);
  lignes.push("");
  lignes.push("== Chiffres du jour ==");
  lignes.push(`CA de la veille (${d.dateVeille}) : ${d.caVeille.toFixed(2)} EUR`);
  lignes.push(`Impayes en cours : ${d.impayesNombre} facture(s), ${d.impayesMontant.toFixed(2)} EUR`);
  lignes.push("");
  lignes.push("== Documents recus aujourd'hui (Gmail) ==");
  if (d.totalDocuments === 0) {
    lignes.push("Aucun document recu aujourd'hui.");
  } else {
    for (const [type, nombre] of d.documentsParType) {
      lignes.push(`- ${nombre} ${LIBELLES_TYPE[type] || type}`);
    }
    const nbFactures = d.documentsParType.find(([t]) => t === "facture")?.[1];
    if (nbFactures) {
      if (d.transfertAutoActif) {
        lignes.push(`  dont ${d.facturesEnvoyees} transferee(s) automatiquement vers Dext.`);
      } else {
        lignes.push(
          `  dont ${d.facturesEnAttente} mise(s) de cote (transfert automatique en pause) : ` +
            "a retrouver dans Gmail sous le libelle \"Copilote/Factures a transferer\", a transmettre vous-meme."
        );
      }
    }
  }
  lignes.push("");
  lignes.push("== Points necessitant votre attention ==");
  if (d.anomaliesOuvertesTotal === 0) {
    lignes.push("Aucun document en attente de validation.");
  } else {
    lignes.push(
      `${d.anomaliesOuvertesTotal} document(s) en attente de validation au total` +
        (d.anomaliesAujourdhui > 0 ? ` (dont ${d.anomaliesAujourdhui} recu(s) aujourd'hui).` : ".")
    );
    lignes.push("A consulter dans le centre de validation de l'application.");
  }
  if (d.aValiderImports > 0) {
    lignes.push(`${d.aValiderImports} import(s) CSV a verifier (type non reconnu, partiel ou en echec).`);
  }
  lignes.push("");
  lignes.push(
    d.transfertAutoActif ? "Transfert automatique vers Dext : actif." : "Transfert automatique vers Dext : en pause (periode d'observation)."
  );

  return lignes.join("\n");
}

function echapperHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function fmtMontant(n: number): string {
  return `${n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}

function fmtDateLongue(iso: string): string {
  return new Date(`${iso}T12:00:00`).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
}

/**
 * Version HTML du recapitulatif, pour l'e-mail uniquement (demande
 * explicite de l'utilisateur : le texte brut recu dans Gmail n'etait "pas
 * trop clair", chiffres en couleur souhaites). Table-based + styles
 * inline uniquement (aucune feuille de style externe, aucun JS) : c'est
 * la seule approche fiable dans les clients mail (Gmail iOS inclus, voir
 * la capture fournie par l'utilisateur), contrairement a une page web
 * normale.
 */
export async function construireRecapQuotidienHtml(prisma: PrismaClient, maintenant: Date = new Date()): Promise<string> {
  const d = await collecterDonneesRecap(prisma, maintenant);

  const impayesCouleur = d.impayesNombre > 0 ? { fond: "#fee2e2", texte: "#b91c1c" } : { fond: "#dcfce7", texte: "#15803d" };
  const caCouleur = { fond: "#dcfce7", texte: "#15803d" };

  const carteChiffre = (titre: string, valeur: string, sousTitre: string, couleur: { fond: string; texte: string }) => `
    <td width="50%" style="padding:4px;" valign="top">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${couleur.fond};border-radius:10px;">
        <tr><td style="padding:14px 16px;">
          <div style="font-size:11px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;color:${couleur.texte};opacity:.8;">${echapperHtml(titre)}</div>
          <div style="font-size:22px;font-weight:700;color:${couleur.texte};margin-top:2px;">${echapperHtml(valeur)}</div>
          <div style="font-size:12px;color:${couleur.texte};opacity:.85;margin-top:2px;">${echapperHtml(sousTitre)}</div>
        </td></tr>
      </table>
    </td>`;

  const badgesDocuments =
    d.totalDocuments === 0
      ? `<p style="margin:0;font-size:14px;color:#6b7280;">Aucun document reçu aujourd'hui.</p>`
      : `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;">
          <tr><td style="line-height:30px;">
          ${d.documentsParType
            .map(([type, nombre]) => {
              const c = COULEUR_TYPE[type] || COULEUR_TYPE.autre;
              return `<span style="display:inline-block;background:${c.fond};color:${c.texte};font-size:13px;font-weight:600;padding:4px 10px;border-radius:999px;margin:0 6px 6px 0;">${nombre} ${echapperHtml(LIBELLES_TYPE[type] || type)}</span>`;
            })
            .join("")}
          </td></tr>
        </table>`;

  const nbFactures = d.documentsParType.find(([t]) => t === "facture")?.[1];
  const detailFactures = nbFactures
    ? d.transfertAutoActif
      ? `<p style="margin:6px 0 0;font-size:13px;color:#4b5563;">↳ dont <strong>${d.facturesEnvoyees}</strong> transférée(s) automatiquement vers Dext.</p>`
      : `<p style="margin:6px 0 0;font-size:13px;color:#4b5563;">↳ dont <strong>${d.facturesEnAttente}</strong> mise(s) de côté (transfert automatique en pause) : à retrouver dans Gmail sous le libellé « Copilote/Factures à transférer », à transmettre vous-même.</p>`
    : "";

  const attentionCouleur = d.anomaliesOuvertesTotal > 0 ? { fond: "#fef3c7", texte: "#92400e" } : { fond: "#dcfce7", texte: "#15803d" };
  const attentionTexte =
    d.anomaliesOuvertesTotal === 0
      ? "Aucun document en attente de validation."
      : `<strong>${d.anomaliesOuvertesTotal}</strong> document(s) en attente de validation au total` +
        (d.anomaliesAujourdhui > 0 ? ` (dont <strong>${d.anomaliesAujourdhui}</strong> reçu(s) aujourd'hui).` : ".") +
        " À consulter dans le centre de validation de l'application.";
  const importsTexte =
    d.aValiderImports > 0 ? `<p style="margin:8px 0 0;font-size:13px;color:${attentionCouleur.texte};">${d.aValiderImports} import(s) CSV à vérifier (type non reconnu, partiel ou en échec).</p>` : "";

  const statutDot = d.transfertAutoActif ? "#16a34a" : "#9ca3af";
  const statutTexte = d.transfertAutoActif ? "Transfert automatique vers Dext : actif." : "Transfert automatique vers Dext : en pause (période d'observation).";

  return `<!doctype html>
<html lang="fr">
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /></head>
<body style="margin:0;padding:0;background:#f3f4f6;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:20px 0;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
        <tr><td style="background:#1e293b;padding:18px 20px;">
          <div style="color:#ffffff;font-size:17px;font-weight:700;">Copilote Atelier Brochant</div>
          <div style="color:#cbd5e1;font-size:13px;margin-top:2px;">Récapitulatif du ${echapperHtml(d.maintenant.toLocaleDateString("fr-FR"))}</div>
        </td></tr>
        <tr><td style="padding:20px;">

          <div style="font-size:12px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;color:#6b7280;margin-bottom:8px;">Chiffres du jour</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            ${carteChiffre("CA de la veille", fmtMontant(d.caVeille), fmtDateLongue(d.dateVeille), caCouleur)}
            ${carteChiffre("Impayés en cours", fmtMontant(d.impayesMontant), `${d.impayesNombre} facture(s)`, impayesCouleur)}
          </tr></table>

          <div style="font-size:12px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;color:#6b7280;margin:22px 0 8px;">Documents reçus aujourd'hui (Gmail)</div>
          ${badgesDocuments}
          ${detailFactures}

          <div style="font-size:12px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;color:#6b7280;margin:22px 0 8px;">Points nécessitant votre attention</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${attentionCouleur.fond};border-radius:10px;">
            <tr><td style="padding:14px 16px;font-size:14px;color:${attentionCouleur.texte};">
              ${attentionTexte}
              ${importsTexte}
            </td></tr>
          </table>

          <div style="margin-top:20px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:13px;color:#4b5563;">
            <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${statutDot};margin-right:6px;"></span>${echapperHtml(statutTexte)}
          </div>

        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/**
 * Envoie le recapitulatif quotidien a la boite Gmail connectee elle-meme
 * (pas de destinataire distinct a configurer : c'est deja l'adresse que
 * l'utilisateur consulte). Ne fait rien si aucune boite n'est connectee.
 */
export async function envoyerRecapQuotidien(prisma: PrismaClient, maintenant: Date = new Date()): Promise<void> {
  const connexionGmail = await getGmailClient(prisma);
  if (!connexionGmail) {
    // Journalise explicitement l'absence d'envoi (pas seulement un retour
    // silencieux) : sans boite Gmail active, ce planificateur ne peut RIEN
    // envoyer, ni le jour meme ni les suivants tant que la connexion n'est
    // pas retablie - un silence prolonge (constate en production) doit
    // rester diagnosticable depuis l'application elle-meme.
    await logEvenement(prisma, {
      evenement: "recap_quotidien_non_envoye",
      action: "Envoi du recapitulatif quotidien",
      resultat: "Ignore : aucune boite Gmail active (reconnexion necessaire via /auth/google).",
    });
    return;
  }

  const { gmail, connexion } = connexionGmail;
  // Les deux formats sont construits a partir des memes donnees
  // (collecterDonneesRecap) : jamais de chiffres divergents entre le texte
  // brut (repli pour les clients mail sans HTML) et le HTML (affiche par
  // defaut partout ailleurs, dont Gmail iOS).
  const [contenuTexte, contenuHtml] = await Promise.all([
    construireRecapQuotidien(prisma, maintenant),
    construireRecapQuotidienHtml(prisma, maintenant),
  ]);

  const composer = new MailComposer({
    to: connexion.compteEmail,
    subject: `Recapitulatif du ${maintenant.toLocaleDateString("fr-FR")} - Copilote Atelier Brochant`,
    text: contenuTexte,
    html: contenuHtml,
  });
  const message = await composer.compile().build();
  const raw = message.toString("base64url");
  await gmail.users.messages.send({ userId: "me", requestBody: { raw } });

  await logEvenement(prisma, {
    evenement: "recap_quotidien_envoye",
    action: `Recapitulatif quotidien envoye a ${connexion.compteEmail}`,
    resultat: "Envoi reussi.",
  });
}
