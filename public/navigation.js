// navigation.js — comportement partagé de la coquille de navigation V2
// (sidebar desktop permanente + barre mobile basse + feuilles basses par
// pôle), injecté sur les 4 pages (index.html, accueil.html,
// prospection.html, nouvelle-demande.html). Ne touche jamais à
// basculerOnglet()/l'état des onglets internes au SPA (app.js,
// index.html uniquement) : gère seulement l'ouverture/fermeture des
// groupes de la sidebar et des feuilles basses mobiles, indépendamment
// de la présence ou non d'app.js sur la page.

// Outil de diagnostic TEMPORAIRE (a retirer une fois le "fondu" assombri
// persistant resolu) : plusieurs correctifs bases sur des hypotheses
// (restauration bfcache, calque de composition GPU, reflow force) ont ete
// deployes sans succes - demande explicite de l'utilisateur d'arreter de
// deviner. Capture ici, directement depuis l'appareil ou le probleme se
// produit, l'etat REEL du rendu (styles calcules, empilement des elements
// a l'ecran) au moment ou il est visible, et l'envoie au Journal (meme
// mecanisme que tout autre evenement, deja relu via /api/journal) - seule
// methode fiable face a un rendu qui ne se reproduit ni en local ni en
// emulation mobile.
function signalerAffichageIncorrect(bouton) {
  const texteOriginal = bouton.textContent;
  bouton.disabled = true;
  bouton.textContent = "Analyse…";

  const elementsSuspects = [];
  document.querySelectorAll("body *").forEach((el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 80 || rect.height < 80) return;
    const cs = getComputedStyle(el);
    const bg = cs.backgroundColor;
    if (bg === "rgba(0, 0, 0, 0)" || bg === "transparent" || bg === "rgb(255, 255, 255)") return;
    elementsSuspects.push({
      tag: el.tagName,
      classe: typeof el.className === "string" ? el.className : "",
      id: el.id || null,
      backgroundColor: bg,
      opacity: cs.opacity,
      position: cs.position,
      zIndex: cs.zIndex,
      transform: cs.transform,
      filter: cs.filter,
      mixBlendMode: cs.mixBlendMode,
      hidden: el.hasAttribute("hidden"),
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), largeur: Math.round(rect.width), hauteur: Math.round(rect.height) },
    });
  });

  const cx = Math.round(window.innerWidth / 2);
  const cy = Math.round(window.innerHeight / 2);
  const empilementCentre = (document.elementsFromPoint(cx, cy) || []).map((el) => ({
    tag: el.tagName,
    classe: typeof el.className === "string" ? el.className : "",
    id: el.id || null,
  }));

  const rapport = {
    url: location.href,
    horodatage: new Date().toISOString(),
    viewport: { largeur: window.innerWidth, hauteur: window.innerHeight },
    scroll: { x: window.scrollX, y: window.scrollY },
    utilisateurAgent: navigator.userAgent,
    themeCouleurPreferee: window.matchMedia("(prefers-color-scheme: dark)").matches ? "sombre" : "clair",
    elementsSuspects,
    empilementCentre,
  };

  fetch("/api/diagnostic-affichage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(rapport),
  })
    .then(() => {
      bouton.textContent = "Envoyé ✓";
      setTimeout(() => {
        bouton.textContent = texteOriginal;
        bouton.disabled = false;
      }, 2500);
    })
    .catch(() => {
      bouton.textContent = "Erreur, réessaie";
      bouton.disabled = false;
    });
}

(() => {
  const bouton = document.createElement("button");
  bouton.type = "button";
  bouton.id = "diagnostic-bouton-signaler";
  bouton.className = "diagnostic-bouton-signaler";
  bouton.textContent = "🐞 Signaler l'affichage";
  bouton.addEventListener("click", () => signalerAffichageIncorrect(bouton));
  document.body.appendChild(bouton);
})();

document.querySelectorAll("[data-groupe-toggle]").forEach((bouton) => {
  bouton.addEventListener("click", () => {
    const groupe = bouton.closest(".cab-sidebar-groupe");
    if (groupe) groupe.classList.toggle("ouvert");
  });
});

const feuilleOverlay = document.getElementById("cab-feuille-overlay");

function fermerFeuillesBasses() {
  document.querySelectorAll(".cab-feuille-bas").forEach((feuille) => {
    feuille.classList.remove("ouverte");
    feuille.hidden = true;
  });
  if (feuilleOverlay) feuilleOverlay.hidden = true;
}

document.querySelectorAll("[data-feuille]").forEach((bouton) => {
  bouton.addEventListener("click", () => {
    const cible = document.getElementById(`cab-feuille-${bouton.dataset.feuille}`);
    if (!cible) return;
    const dejaOuverte = cible.classList.contains("ouverte");
    fermerFeuillesBasses();
    if (!dejaOuverte) {
      cible.hidden = false;
      if (feuilleOverlay) feuilleOverlay.hidden = false;
      requestAnimationFrame(() => cible.classList.add("ouverte"));
    }
  });
});

if (feuilleOverlay) feuilleOverlay.addEventListener("click", fermerFeuillesBasses);

document.querySelectorAll(".cab-feuille-bas").forEach((feuille) => {
  feuille.addEventListener("click", (ev) => {
    if (ev.target.closest("a, button")) fermerFeuillesBasses();
  });
});

document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") fermerFeuillesBasses();
});

// Restauration bfcache (retour arriere Safari/iOS apres avoir quitte une
// feuille basse ouverte par un lien <a href>, ou le panneau detail facture) :
// le navigateur restaure alors le DOM EXACTEMENT comme il etait au moment du
// depart (overlay/panneau encore ouverts), sans rejouer le chargement initial
// de la page - d'ou un fondu sombre qui reste affiche en permanence, sans
// aucune feuille ni panneau visiblement ouverts (signale par l'utilisateur,
// "fondu derangeant" persistant sur Accueil comme sur Factures fournisseurs).
// Force la fermeture de tout calque de ce type des que la page est restauree
// depuis le bfcache, quelle que soit la page (les classes/ids absents d'une
// page donnee sont simplement ignores par querySelectorAll).
window.addEventListener("pageshow", (ev) => {
  if (!ev.persisted) return;
  fermerFeuillesBasses();
  document.querySelectorAll(".cab-overlay").forEach((overlay) => {
    overlay.hidden = true;
  });
  document.querySelectorAll(".cab-detail-panneau").forEach((panneau) => {
    panneau.classList.remove("ouvert");
    panneau.hidden = true;
  });
});
