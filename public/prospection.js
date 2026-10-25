const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString("fr-FR") : "—");
const echapper = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const LIBELLE_STATUT = {
  a_contacter: "À contacter",
  contacte: "Contacté",
  relance: "Relancé",
  rdv: "RDV",
  client: "Client",
  sans_suite: "Sans suite",
};

function pastilleStatut(statut) {
  return `<span class="pastille-statut pastille-${echapper(statut)}">${echapper(LIBELLE_STATUT[statut] || statut)}</span>`;
}

async function appelApi(url, options) {
  const res = await fetch(url, options);
  const isJson = res.headers.get("content-type")?.includes("application/json");
  const data = isJson ? await res.json() : null;
  if (!res.ok) throw new Error(data?.erreur || `Erreur HTTP ${res.status}`);
  return data;
}

// --- Tableau de bord ---------------------------------------------------

async function chargerDashboard() {
  const [statuts, campagnes] = await Promise.all([
    appelApi("/api/prospection/dashboard/statuts"),
    appelApi("/api/prospection/dashboard/campagnes"),
  ]);

  const total = statuts.reduce((s, x) => s + x.nombre, 0);
  const tuiles = document.getElementById("tuiles-statuts");
  tuiles.innerHTML =
    `<div class="tuile-statut"><div class="valeur">${total}</div><div class="label">Total prospects</div></div>` +
    Object.keys(LIBELLE_STATUT)
      .map((statut) => {
        const trouve = statuts.find((s) => s.statut === statut);
        return `<div class="tuile-statut"><div class="valeur">${trouve ? trouve.nombre : 0}</div><div class="label">${echapper(LIBELLE_STATUT[statut])}</div></div>`;
      })
      .join("");

  const tbody = document.querySelector("#table-stats-campagnes tbody");
  tbody.innerHTML =
    campagnes
      .map(
        (c) => `
    <tr>
      <td>${echapper(c.nom)}</td>
      <td>${echapper(c.statut)}</td>
      <td>${c.nbEnvois}</td>
      <td>${c.nbOuverts}</td>
      <td>${c.nbCliques}</td>
      <td>${c.nbRepondus}</td>
      <td>${c.nbDesabonnes}</td>
      <td>${c.tauxOuverture}%</td>
      <td>${c.tauxReponse}%</td>
    </tr>`
      )
      .join("") || `<tr><td colspan="9" class="liste-vide">Aucune campagne pour le moment.</td></tr>`;
}

// --- Sourcing ------------------------------------------------------------

document.getElementById("form-import-prospects").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fichier = document.getElementById("input-fichier-prospects").files[0];
  const div = document.getElementById("resultat-import-prospects");
  if (!fichier) return;

  const formData = new FormData();
  formData.append("fichier", fichier);
  div.textContent = "Import en cours…";
  try {
    const d = await appelApi("/api/prospection/import", { method: "POST", body: formData });
    div.innerHTML = `<span class="badge badge-${d.statut}">${echapper(d.statut)}</span> ${d.nbNouveaux} nouveau(x), ${d.nbDoublons} doublon(s), ${d.nbErreurs} erreur(s).`;
    e.target.reset();
    await rafraichirTout();
  } catch (err) {
    div.innerHTML = `<span class="badge badge-echec">Erreur</span> ${echapper(err.message)}`;
  }
});

document.getElementById("form-ajout-prospect").addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target).entries());
  try {
    await appelApi("/api/prospection/prospects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    e.target.reset();
    await chargerProspects();
    await chargerDashboard();
  } catch (err) {
    alert(err.message);
  }
});

// --- Mini-CRM --------------------------------------------------------------

function paramsFiltre() {
  const params = new URLSearchParams();
  const type = document.getElementById("filtre-type").value;
  const statut = document.getElementById("filtre-statut").value;
  const cp = document.getElementById("filtre-cp").value;
  const recherche = document.getElementById("filtre-recherche").value;
  if (type) params.set("type", type);
  if (statut) params.set("statut", statut);
  if (cp) params.set("codePostal", cp);
  if (recherche) params.set("recherche", recherche);
  return params.toString();
}

async function chargerProspects() {
  const prospects = await appelApi(`/api/prospection/prospects?${paramsFiltre()}`);
  const tbody = document.querySelector("#table-prospects tbody");
  tbody.innerHTML =
    prospects
      .map(
        (p) => `
    <tr class="ligne-prospect" data-id="${p.id}">
      <td>${echapper(p.entreprise)}</td>
      <td>${echapper(p.type)}</td>
      <td>${echapper(p.contactNom || "—")}</td>
      <td>${echapper(p.email || "—")}</td>
      <td>${echapper(p.ville || "—")}</td>
      <td>${pastilleStatut(p.statut)}</td>
    </tr>`
      )
      .join("") || `<tr><td colspan="6" class="liste-vide">Aucun prospect pour ce filtre.</td></tr>`;

  tbody.querySelectorAll("tr[data-id]").forEach((tr) => {
    tr.addEventListener("click", () => afficherFicheProspect(tr.dataset.id));
  });
}

["filtre-type", "filtre-statut", "filtre-cp"].forEach((id) => document.getElementById(id).addEventListener("change", chargerProspects));
document.getElementById("filtre-recherche").addEventListener("input", () => {
  clearTimeout(window._t);
  window._t = setTimeout(chargerProspects, 300);
});

async function afficherFicheProspect(id) {
  const p = await appelApi(`/api/prospection/prospects/${id}`);
  const div = document.getElementById("fiche-prospect");

  div.innerHTML = `
    <div class="fiche-prospect">
      <h3>${echapper(p.entreprise)} ${pastilleStatut(p.statut)}</h3>
      <div class="form-grille">
        <label>Statut
          <select id="fiche-statut">
            ${Object.entries(LIBELLE_STATUT).map(([v, l]) => `<option value="${v}" ${v === p.statut ? "selected" : ""}>${echapper(l)}</option>`).join("")}
          </select>
        </label>
        <label>Email<input id="fiche-email" value="${echapper(p.email || "")}" /></label>
        <label>Téléphone<input id="fiche-telephone" value="${echapper(p.telephone || "")}" /></label>
        <label>Contact<input id="fiche-contact" value="${echapper(p.contactNom || "")}" /></label>
        <label class="champ-pleine-largeur">Notes<textarea id="fiche-notes">${echapper(p.notes || "")}</textarea></label>
      </div>
      <div class="ligne-boutons">
        <button type="button" id="btn-enregistrer-fiche">Enregistrer</button>
        ${!p.email && p.siteWeb ? `<button type="button" class="ghost" id="btn-enrichir-fiche">Rechercher un email</button>` : ""}
        <button type="button" class="ghost" id="btn-supprimer-fiche">Supprimer la fiche</button>
      </div>
      <div class="fiche-section">
        <h4>Historique des statuts</h4>
        ${
          p.historiqueStatuts
            .map((h) => `<div class="historique-ligne">${fmtDate(h.createdAt)} — ${echapper(h.ancienStatut || "création")} → ${echapper(LIBELLE_STATUT[h.nouveauStatut] || h.nouveauStatut)}</div>`)
            .join("") || `<p class="liste-vide">Aucun historique.</p>`
        }
      </div>
      <div class="fiche-section">
        <h4>Envois de campagne</h4>
        ${
          p.envois
            .map((env) => `<div class="historique-ligne">${fmtDate(env.dateEnvoi)} — ${echapper(env.campagne.nom)}${env.estRelance ? " (relance)" : ""} — ${echapper(env.statut)}</div>`)
            .join("") || `<p class="liste-vide">Aucun envoi.</p>`
        }
      </div>
    </div>
  `;

  document.getElementById("fiche-statut").addEventListener("change", async (e) => {
    await appelApi(`/api/prospection/prospects/${id}/statut`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ statut: e.target.value }),
    });
    await Promise.all([chargerProspects(), chargerDashboard(), afficherFicheProspect(id)]);
  });

  document.getElementById("btn-enregistrer-fiche").addEventListener("click", async () => {
    await appelApi(`/api/prospection/prospects/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: document.getElementById("fiche-email").value || null,
        telephone: document.getElementById("fiche-telephone").value || null,
        contactNom: document.getElementById("fiche-contact").value || null,
        notes: document.getElementById("fiche-notes").value || null,
      }),
    });
    await chargerProspects();
  });

  const btnEnrichir = document.getElementById("btn-enrichir-fiche");
  if (btnEnrichir) {
    btnEnrichir.addEventListener("click", async () => {
      try {
        const r = await appelApi(`/api/prospection/prospects/${id}/enrichir`, { method: "POST" });
        alert(r.email ? `Email trouvé : ${r.email} (fiabilité ${r.score}%)` : "Aucun email trouvé automatiquement.");
        await afficherFicheProspect(id);
      } catch (err) {
        alert(err.message);
      }
    });
  }

  document.getElementById("btn-supprimer-fiche").addEventListener("click", async () => {
    if (!confirm(`Supprimer définitivement la fiche "${p.entreprise}" ?`)) return;
    await appelApi(`/api/prospection/prospects/${id}`, { method: "DELETE" });
    div.innerHTML = "";
    await Promise.all([chargerProspects(), chargerDashboard()]);
  });
}

// --- Modèles de mail ---------------------------------------------------

async function chargerTemplates() {
  const templates = await appelApi("/api/prospection/templates");
  document.getElementById("liste-templates").innerHTML =
    templates
      .map(
        (t) => `
    <div class="historique-ligne" data-template="${t.id}">
      <strong>${echapper(t.nom)}</strong> — ${echapper(t.objet)}
      ${
        t.pieceJointeNom
          ? `<br/><span class="aide-inline">📎 ${echapper(t.pieceJointeNom)} <button type="button" class="ghost btn-retirer-piece-jointe" style="padding:2px 8px;margin-left:6px">Retirer</button></span>`
          : ""
      }
    </div>`
      )
      .join("") || `<p class="liste-vide">Aucun modèle créé pour le moment.</p>`;

  document.querySelectorAll(".btn-retirer-piece-jointe").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.closest("[data-template]").dataset.template;
      await appelApi(`/api/prospection/templates/${id}/piece-jointe`, { method: "DELETE" });
      await chargerTemplates();
    });
  });

  const select = document.getElementById("select-template-campagne");
  select.innerHTML = templates.map((t) => `<option value="${t.id}">${echapper(t.nom)}${t.pieceJointeNom ? " (avec plaquette)" : ""}</option>`).join("");
}

document.getElementById("form-template").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  const fichier = form.get("pieceJointe");
  const data = { nom: form.get("nom"), marque: form.get("marque"), objet: form.get("objet"), corpsHtml: form.get("corpsHtml") };

  try {
    const template = await appelApi("/api/prospection/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });

    if (fichier && fichier.size > 0) {
      const formPieceJointe = new FormData();
      formPieceJointe.append("pieceJointe", fichier);
      await appelApi(`/api/prospection/templates/${template.id}/piece-jointe`, { method: "POST", body: formPieceJointe });
    }

    e.target.reset();
    await chargerTemplates();
  } catch (err) {
    alert(err.message);
  }
});

// --- Campagnes ---------------------------------------------------------

async function chargerCampagnes() {
  const campagnes = await appelApi("/api/prospection/campagnes");
  const div = document.getElementById("liste-campagnes");
  div.innerHTML =
    campagnes
      .map(
        (c) => `
    <div class="historique-ligne" data-campagne="${c.id}">
      <strong>${echapper(c.nom)}</strong> — modèle "${echapper(c.template.nom)}" — statut ${echapper(c.statut)}
      — <span class="pastille-statut ${c.automatique ? "pastille-client" : "pastille-a_contacter"}">${c.automatique ? "Automatique" : "Manuel"}</span>
      <div class="ligne-boutons" style="margin-top:6px">
        <button type="button" class="ghost btn-envoyer-campagne" data-id="${c.id}">Envoyer aux prospects dus</button>
        <button type="button" class="ghost btn-basculer-auto" data-id="${c.id}" data-auto="${c.automatique}">${c.automatique ? "Repasser en manuel" : "Activer l'envoi automatique"}</button>
      </div>
    </div>`
      )
      .join("") || `<p class="liste-vide">Aucune campagne créée pour le moment.</p>`;

  div.querySelectorAll(".btn-basculer-auto").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const activerAuto = btn.dataset.auto !== "true";
      if (activerAuto && !confirm("Les prochains e-mails de cette campagne (premiers envois et relances) seront envoyés automatiquement, sans validation, dans la limite du quota quotidien. Confirmer ?")) {
        return;
      }
      try {
        await appelApi(`/api/prospection/campagnes/${btn.dataset.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ automatique: activerAuto }),
        });
        await chargerCampagnes();
      } catch (err) {
        alert(err.message);
      }
    });
  });

  div.querySelectorAll(".btn-envoyer-campagne").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Envoi en cours…";
      try {
        const r = await appelApi(`/api/prospection/campagnes/${btn.dataset.id}/envoyer`, { method: "POST" });
        alert(`${r.nbEnvoyes} envoyé(s), ${r.nbEchecs} échec(s).`);
        await Promise.all([chargerCampagnes(), chargerDashboard(), chargerProspects()]);
      } catch (err) {
        alert(err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = "Envoyer aux prospects dus";
      }
    });
  });
}

document.getElementById("form-campagne").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  const segmentFiltre = {};
  if (form.get("segType")) segmentFiltre.type = form.get("segType");
  if (form.get("segStatut")) segmentFiltre.statut = form.get("segStatut");
  if (form.get("segCodePostal")) segmentFiltre.codePostal = form.get("segCodePostal");

  const automatique = form.get("automatique") === "on";
  if (automatique && !confirm("Les e-mails de cette campagne (premiers envois et relances) seront envoyés automatiquement, sans validation, dans la limite du quota quotidien. Confirmer ?")) {
    return;
  }

  await appelApi("/api/prospection/campagnes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      nom: form.get("nom"),
      templateId: form.get("templateId"),
      relanceApresJours: form.get("relanceApresJours") ? Number(form.get("relanceApresJours")) : null,
      segmentFiltre,
      automatique,
    }),
  });
  e.target.reset();
  await chargerCampagnes();
});

// --- Relances dues -------------------------------------------------------

async function chargerRelancesDues() {
  const relances = await appelApi("/api/prospection/relances-dues");
  const div = document.getElementById("liste-relances-dues");
  div.innerHTML =
    relances
      .map(
        (r) => `
    <div class="historique-ligne" data-campagne="${r.campagneId}" data-prospect="${r.prospectId}">
      <strong>${echapper(r.entreprise)}</strong> — campagne "${echapper(r.campagneNom)}" — contacté il y a ${r.joursDepuisEnvoi} jour(s)
      <div class="ligne-boutons" style="margin-top:6px">
        <button type="button" class="ghost btn-envoyer-relance">Envoyer la relance</button>
      </div>
    </div>`
      )
      .join("") || `<p class="liste-vide">Aucune relance due pour le moment.</p>`;

  div.querySelectorAll(".btn-envoyer-relance").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const ligne = btn.closest("[data-campagne]");
      btn.disabled = true;
      try {
        await appelApi(`/api/prospection/campagnes/${ligne.dataset.campagne}/relancer/${ligne.dataset.prospect}`, { method: "POST" });
        await Promise.all([chargerRelancesDues(), chargerDashboard(), chargerProspects()]);
      } catch (err) {
        alert(err.message);
        btn.disabled = false;
      }
    });
  });
}

// --- Init ------------------------------------------------------------------

async function rafraichirTout() {
  await Promise.all([chargerDashboard(), chargerProspects(), chargerTemplates(), chargerCampagnes(), chargerRelancesDues()]);
}

rafraichirTout();
