// navigation.js — comportement partagé de la coquille de navigation V2
// (sidebar desktop permanente + barre mobile basse + feuilles basses par
// pôle), injecté sur les 4 pages (index.html, accueil.html,
// prospection.html, nouvelle-demande.html). Ne touche jamais à
// basculerOnglet()/l'état des onglets internes au SPA (app.js,
// index.html uniquement) : gère seulement l'ouverture/fermeture des
// groupes de la sidebar et des feuilles basses mobiles, indépendamment
// de la présence ou non d'app.js sur la page.

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
