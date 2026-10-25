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
      <form id="form-morgane" class="morgane-formulaire">
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

  function ajouterBulle(role, texte) {
    const fil = document.getElementById("morgane-fil");
    const bulle = document.createElement("div");
    bulle.className = `morgane-message ${role === "user" ? "morgane-bulle-utilisateur" : "morgane-bulle-assistant"}`;
    bulle.textContent = texte;
    fil.appendChild(bulle);
    fil.scrollTop = fil.scrollHeight;
    return bulle;
  }

  ajouterBulle("assistant", "Bonjour, je suis Morgane. Comment puis-je t'aider ?");
  for (const m of historique) ajouterBulle(m.role, m.content);

  document.getElementById("form-morgane").addEventListener("submit", async (e) => {
    e.preventDefault();
    const saisie = document.getElementById("morgane-saisie");
    const texte = saisie.value.trim();
    if (!texte) return;

    saisie.value = "";
    saisie.style.height = "auto";
    saisie.disabled = true;
    ajouterBulle("user", texte);
    historique.push({ role: "user", content: texte });
    sauverHistorique(historique);

    const bulleAttente = ajouterBulle("assistant", "…");
    bulleAttente.classList.add("morgane-bulle-attente");

    try {
      const res = await fetch("/api/morgane/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ historique }),
      });
      const data = await res.json();
      bulleAttente.classList.remove("morgane-bulle-attente");
      if (!res.ok) {
        bulleAttente.textContent = `Erreur : ${data.erreur}`;
        return;
      }
      bulleAttente.textContent = data.reponse;
      historique.push({ role: "assistant", content: data.reponse });
      sauverHistorique(historique);
      // rafraichirTout n'existe que sur le tableau de bord (index.html) :
      // optionnel partout ailleurs, jamais une erreur si absente.
      if (typeof window.rafraichirTout === "function") await window.rafraichirTout();
    } catch (err) {
      bulleAttente.classList.remove("morgane-bulle-attente");
      bulleAttente.textContent = `Erreur : ${err.message}`;
    } finally {
      saisie.disabled = false;
      saisie.focus();
    }
  });
})();
