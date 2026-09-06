const fmtMontant = (n) => new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(n || 0);
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString("fr-FR") : "—");
const echapper = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const ICONES_TUILE = {
  ca: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
  impayes: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/></svg>',
  imports: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>',
  anomalies: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>',
};

async function chargerCockpit() {
  const res = await fetch("/api/dashboard/summary");
  const data = await res.json();
  const cockpit = document.getElementById("cockpit");
  cockpit.innerHTML = `
    <div class="tuile"><div class="tuile-icone">${ICONES_TUILE.ca}</div><div class="valeur">${fmtMontant(data.caVeille)}</div><div class="label">CA veille (${data.dateVeille})</div></div>
    <div class="tuile${data.impayes.nombre > 0 ? " alerte" : ""}"><div class="tuile-icone">${ICONES_TUILE.impayes}</div><div class="valeur">${data.impayes.nombre}</div><div class="label">Impayés (${fmtMontant(data.impayes.montantTotal)})</div></div>
    <div class="tuile"><div class="tuile-icone">${ICONES_TUILE.imports}</div><div class="valeur">${data.aValiderImports}</div><div class="label">Imports à vérifier</div></div>
    <div class="tuile${data.anomaliesOuvertes > 0 ? " alerte" : ""}"><div class="tuile-icone">${ICONES_TUILE.anomalies}</div><div class="valeur">${data.anomaliesOuvertes}</div><div class="label">Anomalies ouvertes</div></div>
  `;
}

async function chargerImports() {
  const res = await fetch("/api/imports");
  const imports = await res.json();
  const tbody = document.querySelector("#table-imports tbody");
  tbody.innerHTML = imports
    .map(
      (i) => `
    <tr>
      <td>${fmtDate(i.dateImport)}</td>
      <td>${echapper(i.fichierNom)}</td>
      <td>${echapper(i.typeDetecte)}</td>
      <td><span class="badge badge-${i.statut}">${i.statut}</span></td>
      <td>${i.nbNouveaux}</td>
      <td>${i.nbDoublons}</td>
      <td>${i.nbErreurs}</td>
    </tr>`
    )
    .join("");
}

async function chargerFacturesImpayees() {
  const res = await fetch("/api/factures?statut=impayee");
  const factures = await res.json();
  const tbody = document.querySelector("#table-factures tbody");
  tbody.innerHTML =
    factures
      .map(
        (f) => `
    <tr>
      <td>${echapper(f.reference)}</td>
      <td>${echapper(f.clientNom)}</td>
      <td>${fmtDate(f.dateEcheance)}</td>
      <td>${fmtMontant(f.montantTTC)}</td>
      <td>${f.statut}</td>
    </tr>`
      )
      .join("") || `<tr><td colspan="5" class="liste-vide">Aucune facture impayée.</td></tr>`;
}

async function chargerStatutGmail() {
  const res = await fetch("/api/gmail/status");
  const data = await res.json();
  const div = document.getElementById("gmail-statut");

  if (!data.connecte) {
    div.innerHTML = `
      <p class="statut-dot off">Aucune boîte Gmail connectée.</p>
      <a href="/auth/google"><button type="button">Connecter Gmail</button></a>
    `;
    return;
  }

  div.innerHTML = `
    <p class="gmail-connecte">
      <span class="statut-dot">Connecté</span> — <span class="adresse">${echapper(data.compteEmail)}</span><br/>
      Dernière synchronisation : ${data.derniereSynchro ? fmtDate(data.derniereSynchro) : "jamais"}
    </p>
    <button type="button" id="btn-sync-gmail" class="ghost">Synchroniser maintenant</button>
    <div id="resultat-sync-gmail"></div>
  `;

  document.getElementById("btn-sync-gmail").addEventListener("click", async () => {
    const resultatDiv = document.getElementById("resultat-sync-gmail");
    resultatDiv.textContent = "Synchronisation en cours…";
    try {
      const r = await fetch("/api/gmail/sync", { method: "POST" });
      const d = await r.json();
      if (!r.ok) {
        resultatDiv.innerHTML = `<span class="badge badge-echec">Erreur</span> ${echapper(d.erreur)}`;
        return;
      }
      resultatDiv.innerHTML = `${d.messagesExamines} message(s) examiné(s), ${d.documentsTraites} document(s) traité(s), ${d.documentsDoublons} doublon(s), ${d.documentsAmbigus} ambigu(s), ${d.erreurs.length} erreur(s).`;
      await rafraichirTout();
    } catch (err) {
      resultatDiv.innerHTML = `<span class="badge badge-echec">Erreur</span> ${echapper(err.message)}`;
    }
  });
}

// --- Anomalies : liste de cartes avec selection multiple -------------------

async function ignorerAnomalie(id) {
  await fetch(`/api/anomalies/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ statut: "ignoree" }),
  });
  await Promise.all([chargerAnomalies(), chargerCockpit()]);
}
window.ignorerAnomalie = ignorerAnomalie;

function majBarreSelection() {
  const cases = [...document.querySelectorAll(".case-anomalie")];
  const cochees = cases.filter((c) => c.checked);
  const barre = document.getElementById("barre-actions-anomalies");
  const compte = document.getElementById("compte-selection");
  const btnIgnorer = document.getElementById("btn-ignorer-selection");
  const toutSelectionner = document.getElementById("case-tout-selectionner");

  barre.hidden = cases.length === 0;
  compte.textContent = cochees.length > 0 ? `${cochees.length} sélectionnée(s)` : "";
  btnIgnorer.disabled = cochees.length === 0;
  if (cases.length > 0) {
    toutSelectionner.checked = cochees.length === cases.length;
    toutSelectionner.indeterminate = cochees.length > 0 && cochees.length < cases.length;
  }
}

async function chargerAnomalies() {
  const res = await fetch("/api/anomalies?statut=a_valider");
  const anomalies = await res.json();
  const liste = document.getElementById("liste-anomalies");

  if (anomalies.length === 0) {
    liste.innerHTML = `<p class="liste-vide">Aucune anomalie en attente.</p>`;
    document.getElementById("barre-actions-anomalies").hidden = true;
    return;
  }

  liste.innerHTML = anomalies
    .map((a) => {
      let preuves = {};
      try { preuves = JSON.parse(a.preuves || "{}"); } catch (e) { /* ignore */ }
      const detail = preuves.fichier ? `${echapper(preuves.fichier)}` : echapper(a.type);
      const expediteur = preuves.expediteur ? ` — ${echapper(preuves.expediteur)}` : "";
      return `
    <div class="anomalie-carte">
      <input type="checkbox" class="case-anomalie" data-id="${a.id}" />
      <div class="anomalie-corps">
        <div class="anomalie-fichier">${detail}</div>
        <div class="anomalie-meta">${fmtDate(a.createdAt)}${expediteur}</div>
      </div>
      <div class="anomalie-actions">
        <a class="ghost bouton-lien" href="/api/anomalies/${a.id}/document" target="_blank" rel="noopener">Voir</a>
        <button type="button" class="ghost" onclick="ignorerAnomalie('${a.id}')">Ignorer</button>
      </div>
    </div>`;
    })
    .join("");

  document.querySelectorAll(".case-anomalie").forEach((c) => c.addEventListener("change", majBarreSelection));
  majBarreSelection();
}

document.getElementById("case-tout-selectionner").addEventListener("change", (e) => {
  document.querySelectorAll(".case-anomalie").forEach((c) => (c.checked = e.target.checked));
  majBarreSelection();
});

document.getElementById("btn-ignorer-selection").addEventListener("click", async () => {
  const ids = [...document.querySelectorAll(".case-anomalie")].filter((c) => c.checked).map((c) => c.dataset.id);
  if (ids.length === 0) return;
  await fetch("/api/anomalies/ignorer-en-masse", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  await Promise.all([chargerAnomalies(), chargerCockpit()]);
});

// --- Morgane (assistante IA) -------------------------------------------------

const MORGANE_CLE_SESSION = "copilote_morgane_historique";

function morganeChargerHistorique() {
  try {
    const brut = sessionStorage.getItem(MORGANE_CLE_SESSION);
    return brut ? JSON.parse(brut) : [];
  } catch {
    return [];
  }
}

function morganeSauverHistorique(historique) {
  try {
    sessionStorage.setItem(MORGANE_CLE_SESSION, JSON.stringify(historique.slice(-20)));
  } catch {
    // stockage indisponible (navigation privee...) : la conversation reste en memoire pour la session en cours
  }
}

let morganeHistorique = morganeChargerHistorique();

function morganeAjouterBulle(role, texte) {
  const fil = document.getElementById("morgane-fil");
  const bulle = document.createElement("div");
  bulle.className = `morgane-message ${role === "user" ? "morgane-bulle-utilisateur" : "morgane-bulle-assistant"}`;
  bulle.textContent = texte;
  fil.appendChild(bulle);
  fil.scrollTop = fil.scrollHeight;
  return bulle;
}

// Rejoue la conversation deja en cours (sessionStorage) au chargement de la page.
for (const m of morganeHistorique) {
  morganeAjouterBulle(m.role, m.content);
}

document.getElementById("form-morgane").addEventListener("submit", async (e) => {
  e.preventDefault();
  const saisie = document.getElementById("morgane-saisie");
  const texte = saisie.value.trim();
  if (!texte) return;

  saisie.value = "";
  saisie.disabled = true;
  morganeAjouterBulle("user", texte);
  morganeHistorique.push({ role: "user", content: texte });
  morganeSauverHistorique(morganeHistorique);

  const bulleAttente = morganeAjouterBulle("assistant", "…");
  bulleAttente.classList.add("morgane-bulle-attente");

  try {
    const res = await fetch("/api/morgane/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ historique: morganeHistorique }),
    });
    const data = await res.json();
    bulleAttente.classList.remove("morgane-bulle-attente");
    if (!res.ok) {
      bulleAttente.textContent = `Erreur : ${data.erreur}`;
      return;
    }
    bulleAttente.textContent = data.reponse;
    morganeHistorique.push({ role: "assistant", content: data.reponse });
    morganeSauverHistorique(morganeHistorique);
    // Une action deleguee (ignorer une anomalie, lancer une synchro...) a pu
    // changer les donnees affichees ailleurs sur la page.
    await rafraichirTout();
  } catch (err) {
    bulleAttente.classList.remove("morgane-bulle-attente");
    bulleAttente.textContent = `Erreur : ${err.message}`;
  } finally {
    saisie.disabled = false;
    saisie.focus();
  }
});

// --- Relances -----------------------------------------------------------

const LIBELLE_PALIER_CLASSE = { rappel: "neutre", relance: "ambre", mise_en_demeure: "critique" };

async function envoyerRelance(factureId, bouton) {
  const texteInitial = bouton.textContent;
  bouton.disabled = true;
  bouton.textContent = "Envoi…";
  try {
    const res = await fetch(`/api/relances/${factureId}/envoyer`, { method: "POST" });
    const data = await res.json();
    if (!res.ok) {
      bouton.textContent = "Erreur";
      alert(data.erreur || "Echec de l'envoi.");
      bouton.disabled = false;
      bouton.textContent = texteInitial;
      return;
    }
    await chargerRelances();
  } catch (err) {
    bouton.disabled = false;
    bouton.textContent = texteInitial;
    alert(err.message);
  }
}
window.envoyerRelance = envoyerRelance;

async function chargerRelances() {
  const res = await fetch("/api/relances");
  const relances = await res.json();
  const liste = document.getElementById("liste-relances");

  if (relances.length === 0) {
    liste.innerHTML = `<p class="liste-vide">Aucune relance à envoyer pour le moment.</p>`;
    return;
  }

  liste.innerHTML = relances
    .map((r) => {
      const classePalier = LIBELLE_PALIER_CLASSE[r.palier.id] || "neutre";
      const boutonEnvoi = r.clientEmail
        ? `<button type="button" class="ghost" onclick="envoyerRelance('${r.factureId}', this)">Envoyer</button>`
        : `<span class="aide-inline">E-mail client inconnu</span>`;
      return `
    <div class="relance-carte">
      <div class="relance-entete">
        <span class="badge badge-palier-${classePalier}">${echapper(r.palier.libelle)}</span>
        <span class="relance-retard">${r.joursRetard} j de retard</span>
      </div>
      <div class="relance-corps">
        <div class="relance-client">${echapper(r.clientNom)} — ${echapper(r.reference)}</div>
        <div class="anomalie-meta">${fmtMontant(r.resteAPercevoir)} restant · échéance ${fmtDate(r.dateEcheance)}</div>
      </div>
      <details class="relance-details">
        <summary>Voir le texte proposé</summary>
        <p><strong>${echapper(r.objet)}</strong></p>
        <p>${echapper(r.corps)}</p>
      </details>
      <div class="relance-actions">${boutonEnvoi}</div>
    </div>`;
    })
    .join("");
}

// --- Bilan de sante ---------------------------------------------------------

document.getElementById("btn-generer-bilan").addEventListener("click", async () => {
  const zone = document.getElementById("contenu-bilan");
  zone.hidden = false;
  zone.textContent = "Generation en cours…";
  try {
    const res = await fetch("/api/bilan-sante/apercu");
    zone.textContent = await res.text();
  } catch (err) {
    zone.textContent = `Erreur : ${err.message}`;
  }
});

document.getElementById("btn-envoyer-bilan").addEventListener("click", async (e) => {
  const bouton = e.currentTarget;
  bouton.disabled = true;
  const texteInitial = bouton.textContent;
  bouton.textContent = "Envoi…";
  try {
    const res = await fetch("/api/bilan-sante/envoyer", { method: "POST" });
    const data = await res.json();
    bouton.textContent = res.ok ? "Envoye !" : `Erreur : ${data.erreur}`;
  } catch (err) {
    bouton.textContent = `Erreur : ${err.message}`;
  } finally {
    setTimeout(() => {
      bouton.textContent = texteInitial;
      bouton.disabled = false;
    }, 2500);
  }
});

async function rafraichirTout() {
  await Promise.all([chargerCockpit(), chargerImports(), chargerFacturesImpayees(), chargerStatutGmail(), chargerAnomalies(), chargerRelances()]);
}

document.getElementById("form-import").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("input-fichier");
  const resultatDiv = document.getElementById("resultat-import");
  if (!input.files[0]) return;

  const formData = new FormData();
  formData.append("fichier", input.files[0]);

  resultatDiv.textContent = "Import en cours…";

  try {
    const res = await fetch("/api/import", { method: "POST", body: formData });
    const data = await res.json();

    if (!res.ok) {
      resultatDiv.innerHTML = `<span class="badge badge-echec">Erreur</span> ${echapper(data.erreur)}`;
      return;
    }

    resultatDiv.innerHTML = `
      <span class="badge badge-${data.statut}">${data.statut}</span>
      Type détecté : <strong>${echapper(data.typeDetecte)}</strong> —
      ${data.nbNouveaux} nouveau(x), ${data.nbDoublons} doublon(s), ${data.nbErreurs} erreur(s) sur ${data.nbLignes} ligne(s).
    `;

    input.value = "";
    await rafraichirTout();
  } catch (err) {
    resultatDiv.innerHTML = `<span class="badge badge-echec">Erreur</span> ${echapper(err.message)}`;
  }
});

rafraichirTout();
