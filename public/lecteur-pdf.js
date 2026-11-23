// Lecteur PDF partage (Factures fournisseurs + Comptabilite).
//
// Remplace les tentatives precedentes par <iframe src="...">, documentees
// dans app.js (voirDocument) : fiable sur Safari iOS mais Chrome Android
// n'integre pas de visionneuse PDF pour les iframes (cadre vide ou
// telechargement force selon les versions) - exactement le symptome
// signale ("le PDF ne s'affiche pas correctement"). pdf.js (Mozilla) rend
// chaque page sur un <canvas> : identique sur toutes les plateformes, avec
// de vrais boutons de zoom (un canvas raster ne peut pas etre zoome
// nativement sans perte, contrairement a un vrai lecteur).
(() => {
  const echapperLocal = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const ECHELLE_MIN = 0.4;
  const ECHELLE_MAX = 3;
  const PAS_ECHELLE = 0.2;

  let chargementPdfjs = null;
  function chargerPdfjs() {
    if (!chargementPdfjs) {
      chargementPdfjs = import("/vendor/pdfjs/pdf.min.mjs").then((pdfjsLib) => {
        pdfjsLib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.mjs";
        return pdfjsLib;
      });
    }
    return chargementPdfjs;
  }

  // conteneur : element DOM qui recevra le lecteur en entier (barre d'outils
  // + pages). url : endpoint deja existant servant le PDF (inchange, voir
  // routes.ts). nomFichier : pour le nom propose au telechargement.
  async function afficherPdfDansConteneur(conteneur, url, nomFichier) {
    if (!conteneur) return;
    const jeton = {};
    conteneur._lecteurPdfJeton = jeton;
    conteneur.innerHTML = `<div class="lecteur-pdf-etat">Chargement du document…</div>`;

    let pdfjsLib;
    let pdfDoc;
    try {
      pdfjsLib = await chargerPdfjs();
      if (conteneur._lecteurPdfJeton !== jeton) return; // conteneur reaffecte entre-temps
      pdfDoc = await pdfjsLib.getDocument({
        url,
        cMapUrl: "/vendor/pdfjs/cmaps/",
        cMapPacked: true,
        standardFontDataUrl: "/vendor/pdfjs/standard_fonts/",
      }).promise;
      if (conteneur._lecteurPdfJeton !== jeton) return;
    } catch {
      if (conteneur._lecteurPdfJeton !== jeton) return;
      conteneur.innerHTML = `
        <div class="lecteur-pdf-erreur">
          <p>Impossible d'afficher l'aperçu de ce document ici.</p>
          <a href="${echapperLocal(url)}" target="_blank" rel="noopener">Ouvrir le document dans un nouvel onglet</a>
        </div>`;
      return;
    }

    let echelle = 1;
    conteneur.innerHTML = `
      <div class="lecteur-pdf">
        <div class="lecteur-pdf-barre">
          <button type="button" class="lecteur-pdf-bouton" data-action="zoom-moins" aria-label="Réduire">−</button>
          <span class="lecteur-pdf-zoom-valeur">100%</span>
          <button type="button" class="lecteur-pdf-bouton" data-action="zoom-plus" aria-label="Agrandir">+</button>
          <span class="lecteur-pdf-pages-info"></span>
          <span class="lecteur-pdf-spacer"></span>
          <a class="lecteur-pdf-bouton" href="${echapperLocal(url)}" download="${echapperLocal(nomFichier || "document.pdf")}">Télécharger</a>
          <a class="lecteur-pdf-bouton" href="${echapperLocal(url)}" target="_blank" rel="noopener">Ouvrir ↗</a>
        </div>
        <div class="lecteur-pdf-pages-conteneur"></div>
      </div>`;

    const zoneValeur = conteneur.querySelector(".lecteur-pdf-zoom-valeur");
    const zonePages = conteneur.querySelector(".lecteur-pdf-pages-conteneur");
    const infoPages = conteneur.querySelector(".lecteur-pdf-pages-info");

    async function rendreToutesPages() {
      if (conteneur._lecteurPdfJeton !== jeton) return;
      zonePages.innerHTML = "";
      zoneValeur.textContent = `${Math.round(echelle * 100)}%`;
      const ratioEcran = window.devicePixelRatio || 1;
      for (let num = 1; num <= pdfDoc.numPages; num++) {
        const page = await pdfDoc.getPage(num);
        if (conteneur._lecteurPdfJeton !== jeton) return;
        const vue = page.getViewport({ scale: echelle * ratioEcran });
        const canvas = document.createElement("canvas");
        canvas.className = "lecteur-pdf-page";
        canvas.width = Math.round(vue.width);
        canvas.height = Math.round(vue.height);
        canvas.style.width = `${Math.round(vue.width / ratioEcran)}px`;
        canvas.style.height = `${Math.round(vue.height / ratioEcran)}px`;
        zonePages.appendChild(canvas);
        await page.render({ canvasContext: canvas.getContext("2d"), viewport: vue }).promise;
      }
      infoPages.textContent = pdfDoc.numPages > 1 ? `${pdfDoc.numPages} pages` : "1 page";
    }

    conteneur.querySelector('[data-action="zoom-moins"]').addEventListener("click", () => {
      echelle = Math.max(ECHELLE_MIN, Math.round((echelle - PAS_ECHELLE) * 100) / 100);
      rendreToutesPages();
    });
    conteneur.querySelector('[data-action="zoom-plus"]').addEventListener("click", () => {
      echelle = Math.min(ECHELLE_MAX, Math.round((echelle + PAS_ECHELLE) * 100) / 100);
      rendreToutesPages();
    });

    // Echelle de depart ajustee a la largeur disponible plutot qu'un 100%
    // arbitraire : sur mobile, une page A4 a 100% depasse tres largement
    // l'ecran et oblige a defiler horizontalement avant meme de pouvoir
    // lire quoi que ce soit.
    try {
      const page1 = await pdfDoc.getPage(1);
      const vueBase = page1.getViewport({ scale: 1 });
      const largeurDisponible = zonePages.clientWidth || conteneur.clientWidth || 320;
      if (largeurDisponible > 0) {
        echelle = Math.max(ECHELLE_MIN, Math.min(ECHELLE_MAX, (largeurDisponible - 16) / vueBase.width));
      }
    } catch {
      // echec du calcul d'ajustement : reste sur l'echelle par defaut (1)
    }

    await rendreToutesPages();
  }

  window.afficherPdfDansConteneur = afficherPdfDansConteneur;
})();
