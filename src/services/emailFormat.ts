/**
 * Mise en forme HTML des e-mails generes automatiquement (analyse
 * quotidienne Google Ads, recapitulatifs...). Jusqu'ici ces e-mails
 * n'envoyaient que du texte brut (MailComposer "text" seul) : illisible des
 * que le contenu depasse quelques lignes - "trop de texte, pave illisible,
 * pas comprehensible" (signale par l'utilisateur, octobre 2026).
 *
 * Convertit un sous-ensemble volontairement etroit de Markdown (titres #/##,
 * listes a puces -/*, gras **texte**, tableaux |colonnes|) en HTML avec une
 * mise en page claire (titres, espacements, tableaux bordes). Pas de
 * dependance externe (marked, etc.) : le contenu vient exclusivement de nos
 * propres prompts, le sous-ensemble necessaire est donc connu et etroit -
 * toute ligne qui ne correspond a aucun de ces motifs degrade simplement en
 * paragraphe, jamais d'erreur.
 */

function echapperHtml(texte: string): string {
  return texte.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function inlineVersHtml(texte: string): string {
  return echapperHtml(texte).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

const COULEUR_INK = "#16213E";
const COULEUR_INK_2 = "#3D4A6B";
const COULEUR_INK_MUTED = "#78829C";
const COULEUR_LIGNE = "#E2E7F1";
const COULEUR_SURFACE_2 = "#EDF1F8";
const COULEUR_BRAND_BLEU = "#3E72CE";

function cellulesDeLigneTableau(ligne: string): string[] {
  return ligne
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((c) => c.trim());
}

function tableauVersHtml(lignesTableau: string[]): string {
  if (lignesTableau.length < 2) {
    return lignesTableau.map((l) => `<p style="margin:0 0 8px;font-size:13.5px;color:${COULEUR_INK_2};">${inlineVersHtml(l)}</p>`).join("\n");
  }
  const entetes = cellulesDeLigneTableau(lignesTableau[0]);
  const estSeparateur = /^:?-{2,}:?$/;
  const ligneSuivante = cellulesDeLigneTableau(lignesTableau[1]);
  const aLigneSeparatrice = ligneSuivante.every((c) => estSeparateur.test(c));
  const lignesCorps = aLigneSeparatrice ? lignesTableau.slice(2) : lignesTableau.slice(1);

  const th = entetes
    .map(
      (e) =>
        `<th style="text-align:left;padding:8px 10px;font-size:12px;font-weight:700;color:${COULEUR_INK_MUTED};background:${COULEUR_SURFACE_2};border-bottom:1px solid ${COULEUR_LIGNE};">${inlineVersHtml(e)}</th>`
    )
    .join("");
  const tr = lignesCorps
    .map((l) => {
      const cellules = cellulesDeLigneTableau(l);
      const td = cellules
        .map((c) => `<td style="padding:8px 10px;font-size:13px;color:${COULEUR_INK_2};border-bottom:1px solid ${COULEUR_LIGNE};">${inlineVersHtml(c)}</td>`)
        .join("");
      return `<tr>${td}</tr>`;
    })
    .join("\n");

  return `<table style="width:100%;border-collapse:collapse;margin:4px 0 16px;border:1px solid ${COULEUR_LIGNE};border-radius:8px;overflow:hidden;"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`;
}

/** Convertit le sous-ensemble de Markdown decrit ci-dessus en HTML. */
export function markdownSimpleVersHtml(markdown: string): string {
  const lignes = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocs: string[] = [];
  let listeOuverte = false;
  let tableauEnCours: string[] | null = null;

  const fermerListe = () => {
    if (listeOuverte) {
      blocs.push("</ul>");
      listeOuverte = false;
    }
  };
  const fermerTableau = () => {
    if (tableauEnCours) {
      blocs.push(tableauVersHtml(tableauEnCours));
      tableauEnCours = null;
    }
  };

  for (const ligneBrute of lignes) {
    const ligne = ligneBrute.trimEnd();

    if (/^\s*\|.*\|\s*$/.test(ligne)) {
      fermerListe();
      if (!tableauEnCours) tableauEnCours = [];
      tableauEnCours.push(ligne.trim());
      continue;
    }
    fermerTableau();

    if (ligne.trim() === "") {
      fermerListe();
      continue;
    }

    const titre = ligne.match(/^(#{1,3})\s+(.*)$/);
    if (titre) {
      fermerListe();
      const niveau = titre[1].length;
      const styleParNiveau = [
        `font-size:16px;font-weight:700;color:${COULEUR_INK};margin:20px 0 8px;`,
        `font-size:14.5px;font-weight:700;color:${COULEUR_INK};margin:18px 0 6px;`,
        `font-size:13.5px;font-weight:700;color:${COULEUR_INK_2};margin:14px 0 4px;`,
      ][niveau - 1];
      const balise = niveau === 1 ? "h2" : niveau === 2 ? "h3" : "h4";
      blocs.push(`<${balise} style="${styleParNiveau}">${inlineVersHtml(titre[2])}</${balise}>`);
      continue;
    }

    const puce = ligne.match(/^[-*]\s+(.*)$/);
    if (puce) {
      if (!listeOuverte) {
        blocs.push(`<ul style="margin:0 0 12px;padding-left:20px;">`);
        listeOuverte = true;
      }
      blocs.push(`<li style="font-size:13.5px;color:${COULEUR_INK_2};line-height:1.55;margin-bottom:5px;">${inlineVersHtml(puce[1])}</li>`);
      continue;
    }

    fermerListe();
    blocs.push(`<p style="margin:0 0 10px;font-size:13.5px;color:${COULEUR_INK_2};line-height:1.55;">${inlineVersHtml(ligne)}</p>`);
  }
  fermerListe();
  fermerTableau();

  return blocs.join("\n");
}

/**
 * Enrobe un corps Markdown converti dans la mise en page commune des
 * e-mails automatiques (en-tete titre/sous-titre, carte blanche sur fond
 * clair, pied de page) - meme identite visuelle que l'application elle-meme
 * (memes couleurs que styles.css, dupliquees ici en dur : un client mail
 * n'a pas acces aux variables CSS de l'application).
 */
export function construireEmailHtml(params: { titre: string; sousTitre?: string; corpsMarkdown: string }): string {
  const corpsHtml = markdownSimpleVersHtml(params.corpsMarkdown);
  return `<!doctype html>
<html lang="fr">
  <body style="margin:0;padding:0;background:#F3F6FB;">
    <div style="max-width:640px;margin:0 auto;padding:24px 16px;font-family:'IBM Plex Sans',Arial,Helvetica,sans-serif;">
      <div style="background:#FFFFFF;border:1px solid ${COULEUR_LIGNE};border-left:4px solid ${COULEUR_BRAND_BLEU};border-radius:14px;padding:22px 20px;">
        <h1 style="font-size:17px;font-weight:800;color:${COULEUR_INK};margin:0 0 4px;">${echapperHtml(params.titre)}</h1>
        ${params.sousTitre ? `<p style="font-size:12.5px;color:${COULEUR_INK_MUTED};margin:0 0 18px;">${echapperHtml(params.sousTitre)}</p>` : ""}
        ${corpsHtml}
      </div>
      <p style="text-align:center;font-size:11px;color:${COULEUR_INK_MUTED};margin:16px 0 0;">Copilote de gestion Atelier Brochant</p>
    </div>
  </body>
</html>`;
}
