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
// Resume complet des styles calcules d'un element qui pourraient expliquer
// un assombrissement visuel SANS passer par une couleur de fond (ex.
// filter/backdrop-filter/mix-blend-mode, invisibles pour un simple controle
// de background-color - trou reel de la version precedente de cet outil,
// qui n'a rien trouve de suspect alors que l'utilisateur voyait bien le
// probleme au moment du signalement).
function resumeStyleElement(el) {
  const cs = getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  return {
    tag: el.tagName,
    classe: typeof el.className === "string" ? el.className : "",
    id: el.id || null,
    backgroundColor: cs.backgroundColor,
    opacity: cs.opacity,
    position: cs.position,
    zIndex: cs.zIndex,
    transform: cs.transform,
    filter: cs.filter,
    backdropFilter: cs.backdropFilter || cs.webkitBackdropFilter || null,
    mixBlendMode: cs.mixBlendMode,
    isolation: cs.isolation,
    willChange: cs.willChange,
    hidden: el.hasAttribute("hidden"),
    rect: { x: Math.round(rect.x), y: Math.round(rect.y), largeur: Math.round(rect.width), hauteur: Math.round(rect.height) },
  };
}

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
    const bgSuspect = bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent" && bg !== "rgb(255, 255, 255)";
    const filtreSuspect = cs.filter && cs.filter !== "none";
    const backdropSuspect = (cs.backdropFilter || cs.webkitBackdropFilter) && (cs.backdropFilter || cs.webkitBackdropFilter) !== "none";
    const fusionSuspecte = cs.mixBlendMode && cs.mixBlendMode !== "normal";
    const opaciteSuspecte = parseFloat(cs.opacity) > 0 && parseFloat(cs.opacity) < 1;
    if (!bgSuspect && !filtreSuspect && !backdropSuspect && !fusionSuspecte && !opaciteSuspecte) return;
    elementsSuspects.push(resumeStyleElement(el));
  });

  const cx = Math.round(window.innerWidth / 2);
  const cy = Math.round(window.innerHeight / 2);
  // Dump complet (pas seulement tag/classe) de CHAQUE ancetre reellement
  // empile a cet endroit precis - garantit une reponse exploitable meme si
  // le filtre "suspect" ci-dessus a encore un angle mort.
  const empilementCentre = (document.elementsFromPoint(cx, cy) || []).map(resumeStyleElement);

  // Pareil au-dessus de la barre de recherche (zone jamais touchee par le
  // probleme signale jusqu'ici) : sert de point de comparaison "normal".
  const empilementTemoin = (document.elementsFromPoint(Math.round(window.innerWidth / 2), 40) || []).map(resumeStyleElement);

  const rapport = {
    url: location.href,
    horodatage: new Date().toISOString(),
    viewport: { largeur: window.innerWidth, hauteur: window.innerHeight },
    scroll: { x: window.scrollX, y: window.scrollY },
    utilisateurAgent: navigator.userAgent,
    themeCouleurPreferee: window.matchMedia("(prefers-color-scheme: dark)").matches ? "sombre" : "clair",
    corpsEtHtml: { body: resumeStyleElement(document.body), html: resumeStyleElement(document.documentElement) },
    elementsSuspects,
    empilementCentre,
    empilementTemoin,
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
