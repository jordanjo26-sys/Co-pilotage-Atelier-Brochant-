// Morgane, partout : bulle flottante injectee sur chaque page (au lieu
// d'etre enfermee dans la carte du Tableau de bord) - demande explicite de
// l'utilisateur apres avoir remarque qu'elle n'etait pas accessible depuis
// les autres onglets/pages. Remplace l'ancienne carte integree a
// index.html (meme logique de conversation, extraite ici pour etre
// partagee par toutes les pages) : historique commun entre les pages via
// sessionStorage (meme onglet de navigateur), comme avant.
(function () {
  if (document.getElementById("morgane-flottante")) return; // deja injectee

  const conteneur = document.createElement("div");
  conteneur.id = "morgane-flottante";
  conteneur.innerHTML = `
    <button type="button" class="morgane-bulle-ouvrir" id="morgane-bouton-ouvrir" aria-label="Ouvrir Morgane" aria-expanded="false">
      <svg viewBox="0 0 28 28" fill="none" stroke="#fff" stroke-width="1.8" stroke-linejoin="round">
        <rect x="4" y="4" width="20" height="14" rx="7"/>
        <polygon points="10,18 14,18 8,24" fill="#fff" stroke="none"/>
        <circle cx="10.5" cy="11" r="1.4" fill="#fff" stroke="none"/>
        <circle cx="14.5" cy="11" r="1.4" fill="#fff" stroke="none"/>
        <circle cx="18.5" cy="11" r="1.4" fill="#fff" stroke="none"/>
      </svg>
    </button>
    <div class="morgane-panneau-flottant" id="morgane-panneau-flottant" hidden>
      <div class="morgane-entete-flottant">
        <strong>Morgane</strong>
        <button type="button" id="morgane-bouton-fermer" aria-label="Fermer">×</button>
      </div>
      <div id="morgane-fil" class="morgane-fil"></div>
      <div class="morgane-piece-jointe-apercu" id="morgane-piece-jointe-apercu" hidden>
        <img id="morgane-piece-jointe-miniature" alt="" hidden />
        <span id="morgane-piece-jointe-nom"></span>
        <button type="button" id="morgane-piece-jointe-retirer" aria-label="Retirer la piece jointe">×</button>
      </div>
      <form id="form-morgane" class="morgane-formulaire">
        <input type="file" id="morgane-fichier" accept="image/*,application/pdf" hidden />
        <button type="button" class="morgane-bouton-joindre" id="morgane-bouton-joindre" aria-label="Joindre une photo ou un fichier" title="Joindre une photo ou un fichier">📎</button>
        <textarea id="morgane-saisie" rows="1" placeholder="Écris à Morgane…"></textarea>
        <button type="submit">Envoyer</button>
      </form>
    </div>
  `;
  document.body.appendChild(conteneur);

  const bouton = document.getElementById("morgane-bouton-ouvrir");
  const panneau = document.getElementById("morgane-panneau-flottant");
  const boutonFermer = document.getElementById("morgane-bouton-fermer");
  const CLE_OUVERTE = "copilote_morgane_ouverte";

  function basculer(ouvrir) {
    panneau.hidden = !ouvrir;
    bouton.setAttribute("aria-expanded", String(ouvrir));
    try {
      sessionStorage.setItem(CLE_OUVERTE, ouvrir ? "1" : "0");
    } catch {
      // stockage indisponible : le panneau reste pilotable, juste pas memorise entre les pages
    }
    if (ouvrir) document.getElementById("morgane-saisie")?.focus();
  }
  bouton.addEventListener("click", () => basculer(panneau.hidden));
  boutonFermer.addEventListener("click", () => basculer(false));

  // Champ de saisie qui grandit avec le texte (jusqu'a ~6 lignes, voir
  // styles.css) au lieu d'un champ sur une seule ligne qui defile
  // horizontalement - demande explicite de l'utilisateur, qui ne pouvait
  // pas se relire en dictant un message un peu long. Entree envoie (comme
  // avant, habitude d'un chat), Maj+Entree insere un saut de ligne.
  const champSaisie = document.getElementById("morgane-saisie");
  function ajusterHauteurSaisie() {
    champSaisie.style.height = "auto";
    champSaisie.style.height = `${champSaisie.scrollHeight}px`;
  }
  champSaisie.addEventListener("input", ajusterHauteurSaisie);
  champSaisie.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      document.getElementById("form-morgane").requestSubmit();
    }
  });

  // Rouvre automatiquement si elle etait ouverte juste avant de changer de
  // page (meme onglet de navigateur) : evite d'avoir a recliquer la bulle
  // apres chaque navigation interne a l'appli.
  try {
    if (sessionStorage.getItem(CLE_OUVERTE) === "1") basculer(true);
  } catch {
    // ignore
  }

  // --- Conversation : meme logique que l'ancienne carte integree au tableau de bord ---
  const MORGANE_CLE_SESSION = "copilote_morgane_historique";

  function chargerHistorique() {
    try {
      const brut = sessionStorage.getItem(MORGANE_CLE_SESSION);
      return brut ? JSON.parse(brut) : [];
    } catch {
      return [];
    }
  }
  function sauverHistorique(historique) {
    try {
      sessionStorage.setItem(MORGANE_CLE_SESSION, JSON.stringify(historique.slice(-20)));
    } catch {
      // stockage indisponible (navigation privee...) : la conversation reste en memoire pour la page en cours
    }
  }
  let historique = chargerHistorique();

  // Rend le texte d'une bulle en transformant les liens de telechargement
  // de document genere (/api/documents-generes/..., voir generer_document_pdf
  // et generer_dossier_comptable cote serveur) en vrai lien cliquable,
  // plutot qu'une URL brute illisible sur mobile. Construit uniquement via
  // createTextNode/createElement (jamais innerHTML) : aucun risque
  // d'injection meme si le texte contenait des caracteres HTML.
  function rendreTexteAvecLiens(element, texte) {
    element.textContent = "";
    const regex = /\/api\/documents-generes\/[a-z0-9-]+\.pdf/gi;
    let dernierIndex = 0;
    let correspondance;
    while ((correspondance = regex.exec(texte))) {
      if (correspondance.index > dernierIndex) {
        element.appendChild(document.createTextNode(texte.slice(dernierIndex, correspondance.index)));
      }
      const lien = document.createElement("a");
      lien.href = correspondance[0];
      lien.target = "_blank";
      lien.rel = "noopener";
      lien.textContent = "📄 Télécharger le document";
      element.appendChild(lien);
      dernierIndex = correspondance.index + correspondance[0].length;
    }
    if (dernierIndex < texte.length) {
      element.appendChild(document.createTextNode(texte.slice(dernierIndex)));
    }
  }

  function ajouterBulle(role, texte, apercuPieceJointe) {
    const fil = document.getElementById("morgane-fil");
    const bulle = document.createElement("div");
    bulle.className = `morgane-message ${role === "user" ? "morgane-bulle-utilisateur" : "morgane-bulle-assistant"}`;
    rendreTexteAvecLiens(bulle, texte);
    // Apercu de la piece jointe envoyee par l'utilisateur, affiche
    // uniquement pour la session en cours (pas persiste dans l'historique
    // sauvegarde, qui ne conserve que du texte - voir sauverHistorique).
    if (apercuPieceJointe) {
      if (apercuPieceJointe.miniatureUrl) {
        const img = document.createElement("img");
        img.src = apercuPieceJointe.miniatureUrl;
        img.alt = apercuPieceJointe.nomFichier;
        img.className = "morgane-bulle-miniature";
        bulle.appendChild(img);
      } else {
        const ligneFichier = document.createElement("div");
        ligneFichier.className = "morgane-bulle-nom-fichier";
        ligneFichier.textContent = `📎 ${apercuPieceJointe.nomFichier}`;
        bulle.appendChild(ligneFichier);
      }
    }
    fil.appendChild(bulle);
    fil.scrollTop = fil.scrollHeight;
    return bulle;
  }

  // --- Piece jointe (photo ou fichier) a joindre au prochain message ---
  // Convertie cote client (jamais le fichier d'origine renvoye tel quel,
  // sauf PDF) : une photo peut sortir du telephone dans a peu pres
  // n'importe quel format/poids (HEIC, plusieurs Mo) - un passage par
  // canvas garantit un JPEG, format systematiquement accepte a la fois par
  // la vision Claude et par la mise en page PDF cote serveur (pdfkit), et
  // borne la taille envoyee (limite du corps de requete cote serveur).
  let pieceJointeActuelle = null; // { nomFichier, mimeType, donneesBase64 }
  const MAX_COTE_IMAGE = 1800;

  function afficherApercuPieceJointe(nomFichier, miniatureUrl) {
    const conteneur = document.getElementById("morgane-piece-jointe-apercu");
    const img = document.getElementById("morgane-piece-jointe-miniature");
    const nom = document.getElementById("morgane-piece-jointe-nom");
    conteneur.hidden = false;
    nom.textContent = nomFichier;
    if (miniatureUrl) {
      img.src = miniatureUrl;
      img.hidden = false;
    } else {
      img.hidden = true;
      img.removeAttribute("src");
    }
  }

  function retirerPieceJointe() {
    pieceJointeActuelle = null;
    document.getElementById("morgane-piece-jointe-apercu").hidden = true;
    document.getElementById("morgane-fichier").value = "";
  }

  document.getElementById("morgane-bouton-joindre").addEventListener("click", () => {
    document.getElementById("morgane-fichier").click();
  });

  document.getElementById("morgane-piece-jointe-retirer").addEventListener("click", retirerPieceJointe);

  document.getElementById("morgane-fichier").addEventListener("change", (e) => {
    const fichier = e.target.files[0];
    if (!fichier) return;

    if (fichier.type === "application/pdf") {
      const lecteur = new FileReader();
      lecteur.onload = () => {
        pieceJointeActuelle = { nomFichier: fichier.name, mimeType: "application/pdf", donneesBase64: lecteur.result.split(",")[1] };
        afficherApercuPieceJointe(fichier.name, null);
      };
      lecteur.onerror = () => alert("Impossible de lire ce fichier.");
      lecteur.readAsDataURL(fichier);
      return;
    }

    if (!fichier.type.startsWith("image/")) {
      alert("Formats acceptes : photo (JPEG/PNG...) ou PDF.");
      e.target.value = "";
      return;
    }

    const urlObjet = URL.createObjectURL(fichier);
    const image = new Image();
    image.onload = () => {
      let { width, height } = image;
      if (width > MAX_COTE_IMAGE || height > MAX_COTE_IMAGE) {
        const ratio = Math.min(MAX_COTE_IMAGE / width, MAX_COTE_IMAGE / height);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(image, 0, 0, width, height);
      URL.revokeObjectURL(urlObjet);
      canvas.toBlob(
        (blob) => {
          const lecteur = new FileReader();
          lecteur.onload = () => {
            const nomFichier = fichier.name.replace(/\.[^.]+$/, "") + ".jpg";
            pieceJointeActuelle = { nomFichier, mimeType: "image/jpeg", donneesBase64: lecteur.result.split(",")[1] };
            afficherApercuPieceJointe(nomFichier, canvas.toDataURL("image/jpeg", 0.6));
          };
          lecteur.readAsDataURL(blob);
        },
        "image/jpeg",
        0.85
      );
    };
    image.onerror = () => {
      URL.revokeObjectURL(urlObjet);
      alert("Impossible de lire cette image.");
    };
    image.src = urlObjet;
  });

  ajouterBulle("assistant", "Bonjour, je suis Morgane. Comment puis-je t'aider ?");
  for (const m of historique) ajouterBulle(m.role, m.content);

  document.getElementById("form-morgane").addEventListener("submit", async (e) => {
    e.preventDefault();
    const saisie = document.getElementById("morgane-saisie");
    const texte = saisie.value.trim();
    const pieceJointeAEnvoyer = pieceJointeActuelle;
    if (!texte && !pieceJointeAEnvoyer) return;
    // Texte par defaut si l'utilisateur envoie une piece jointe sans rien
    // ecrire : historique.content doit rester du texte (voir MessageMorgane
    // cote serveur), et une bulle vide serait illisible.
    const texteAEnvoyer = texte || "(photo/fichier joint)";

    saisie.value = "";
    saisie.style.height = "auto";
    saisie.disabled = true;
    retirerPieceJointe();
    ajouterBulle(
      "user",
      texteAEnvoyer,
      pieceJointeAEnvoyer
        ? {
            nomFichier: pieceJointeAEnvoyer.nomFichier,
            miniatureUrl: pieceJointeAEnvoyer.mimeType === "image/jpeg" ? `data:image/jpeg;base64,${pieceJointeAEnvoyer.donneesBase64}` : null,
          }
        : null
    );
    historique.push({ role: "user", content: texteAEnvoyer });
    sauverHistorique(historique);

    const bulleAttente = ajouterBulle("assistant", "…");
    bulleAttente.classList.add("morgane-bulle-attente");

    try {
      const res = await fetch("/api/morgane/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ historique, pieceJointe: pieceJointeAEnvoyer || undefined }),
      });
      const data = await res.json();
      bulleAttente.classList.remove("morgane-bulle-attente");
      if (!res.ok) {
        rendreTexteAvecLiens(bulleAttente, `Erreur : ${data.erreur}`);
        return;
      }
      rendreTexteAvecLiens(bulleAttente, data.reponse);
      historique.push({ role: "assistant", content: data.reponse });
      sauverHistorique(historique);
      // rafraichirTout n'existe que sur le tableau de bord (index.html) :
      // optionnel partout ailleurs, jamais une erreur si absente.
      if (typeof window.rafraichirTout === "function") await window.rafraichirTout();
    } catch (err) {
      bulleAttente.classList.remove("morgane-bulle-attente");
      rendreTexteAvecLiens(bulleAttente, `Erreur : ${err.message}`);
    } finally {
      saisie.disabled = false;
      saisie.focus();
    }
  });
})();
