const fmtMontant = (n) => new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(n || 0);
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString("fr-FR") : "—");

async function chargerCockpit() {
  const res = await fetch("/api/dashboard/summary");
  const data = await res.json();
  const cockpit = document.getElementById("cockpit");
  cockpit.innerHTML = `
    <div class="tuile"><div class="valeur">${fmtMontant(data.caVeille)}</div><div class="label">CA veille (${data.dateVeille})</div></div>
    <div class="tuile"><div class="valeur">${data.impayes.nombre}</div><div class="label">Factures impayées (${fmtMontant(data.impayes.montantTotal)})</div></div>
    <div class="tuile"><div class="valeur">${data.aValiderImports}</div><div class="label">Imports à vérifier</div></div>
    <div class="tuile"><div class="valeur">${data.anomaliesOuvertes}</div><div class="label">Anomalies ouvertes</div></div>
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
      <td>${i.fichierNom}</td>
      <td>${i.typeDetecte}</td>
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
  tbody.innerHTML = factures
    .map(
      (f) => `
    <tr>
      <td>${f.reference}</td>
      <td>${f.clientNom}</td>
      <td>${fmtDate(f.dateEcheance)}</td>
      <td>${fmtMontant(f.montantTTC)}</td>
      <td>${f.statut}</td>
    </tr>`
    )
    .join("");
}

async function chargerStatutGmail() {
  const res = await fetch("/api/gmail/status");
  const data = await res.json();
  const div = document.getElementById("gmail-statut");

  if (!data.connecte) {
    div.innerHTML = `
      <p>Aucune boîte Gmail connectée.</p>
      <a href="/auth/google"><button type="button">Connecter Gmail</button></a>
    `;
    return;
  }

  div.innerHTML = `
    <p>Connecté : <strong>${data.compteEmail}</strong><br/>
    Dernière synchronisation : ${data.derniereSynchro ? fmtDate(data.derniereSynchro) : "jamais"}</p>
    <button type="button" id="btn-sync-gmail">Synchroniser maintenant</button>
    <div id="resultat-sync-gmail"></div>
  `;

  document.getElementById("btn-sync-gmail").addEventListener("click", async () => {
    const resultatDiv = document.getElementById("resultat-sync-gmail");
    resultatDiv.textContent = "Synchronisation en cours…";
    try {
      const r = await fetch("/api/gmail/sync", { method: "POST" });
      const d = await r.json();
      if (!r.ok) {
        resultatDiv.innerHTML = `<span class="badge badge-echec">Erreur</span> ${d.erreur}`;
        return;
      }
      resultatDiv.innerHTML = `${d.messagesExamines} message(s) examiné(s), ${d.documentsTraites} document(s) traité(s), ${d.documentsDoublons} doublon(s), ${d.documentsAmbigus} ambigu(s), ${d.erreurs.length} erreur(s).`;
      await rafraichirTout();
    } catch (err) {
      resultatDiv.innerHTML = `<span class="badge badge-echec">Erreur</span> ${err.message}`;
    }
  });
}

async function chargerAnomalies() {
  const res = await fetch("/api/anomalies?statut=a_valider");
  const anomalies = await res.json();
  const tbody = document.querySelector("#table-anomalies tbody");
  tbody.innerHTML = anomalies
    .map((a) => {
      let preuves = {};
      try { preuves = JSON.parse(a.preuves || "{}"); } catch (e) { /* ignore */ }
      const detail = preuves.fichier ? `${preuves.fichier} (${preuves.expediteur || "?"})` : "—";
      return `
    <tr>
      <td>${fmtDate(a.createdAt)}</td>
      <td>${a.type}</td>
      <td>${detail}</td>
      <td>${a.actionProposee || ""}</td>
    </tr>`;
    })
    .join("");
}

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
      resultatDiv.innerHTML = `<span class="badge badge-echec">Erreur</span> ${data.erreur}`;
      return;
    }

    resultatDiv.innerHTML = `
      <span class="badge badge-${data.statut}">${data.statut}</span>
      Type détecté : <strong>${data.typeDetecte}</strong> —
      ${data.nbNouveaux} nouveau(x), ${data.nbDoublons} doublon(s), ${data.nbErreurs} erreur(s) sur ${data.nbLignes} ligne(s).
    `;

    input.value = "";
    await rafraichirTout();
  } catch (err) {
    resultatDiv.innerHTML = `<span class="badge badge-echec">Erreur</span> ${err.message}`;
  }
});

rafraichirTout();
