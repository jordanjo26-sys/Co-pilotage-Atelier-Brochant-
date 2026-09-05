const fmtMontant = (n) => new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(n || 0);
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString("fr-FR") : "—");
const echapper = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function chargerCockpit() {
  const res = await fetch("/api/dashboard/summary");
  const data = await res.json();
  const cockpit = document.getElementById("cockpit");
  cockpit.innerHTML = `
    <div class="tuile"><div class="valeur">${fmtMontant(data.caVeille)}</div><div class="label">CA veille (${data.dateVeille})</div></div>
    <div class="tuile${data.impayes.nombre > 0 ? " alerte" : ""}"><div class="valeur">${data.impayes.nombre}</div><div class="label">Impayés (${fmtMontant(data.impayes.montantTotal)})</div></div>
    <div class="tuile"><div class="valeur">${data.aValiderImports}</div><div class="label">Imports à vérifier</div></div>
    <div class="tuile${data.anomaliesOuvertes > 0 ? " alerte" : ""}"><div class="valeur">${data.anomaliesOuvertes}</div><div class="label">Anomalies ouvertes</div></div>
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
      <button type="button" class="ghost" onclick="ignorerAnomalie('${a.id}')">Ignorer</button>
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

async function rafraichirTout() {
  await Promise.all([chargerCockpit(), chargerImports(), chargerFacturesImpayees(), chargerStatutGmail(), chargerAnomalies()]);
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
