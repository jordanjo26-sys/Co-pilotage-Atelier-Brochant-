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
      <p class="statut-dot off">${data.motif ? echapper(data.motif) : "Aucune boîte Gmail connectée."}</p>
      <a href="/auth/google"><button type="button">${data.motif ? "Reconnecter Gmail" : "Connecter Gmail"}</button></a>
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
      resultatDiv.innerHTML =
        `${d.messagesExamines} message(s) examiné(s), ${d.documentsTraites} document(s) traité(s), ${d.documentsDoublons} doublon(s), ${d.documentsAmbigus} ambigu(s), ${d.erreurs.length} erreur(s).` +
        (d.resumeErreurs ? `<br/><span class="anomalie-meta">${echapper(d.resumeErreurs)}</span>` : "");
      await rafraichirTout();
    } catch (err) {
      resultatDiv.innerHTML = `<span class="badge badge-echec">Erreur</span> ${echapper(err.message)}`;
    }
  });
}

// --- Stripe -----------------------------------------------------------------

async function chargerStatutStripe() {
  const res = await fetch("/api/stripe/status");
  const data = await res.json();
  const div = document.getElementById("stripe-statut");

  if (!data.connecte) {
    div.innerHTML = `<p class="statut-dot off">${data.motif ? echapper(data.motif) : "Non connecté — clé API à ajouter (voir docs/mise-en-service.md)."}</p>`;
    return;
  }

  div.innerHTML = `
    <p class="gmail-connecte">
      <span class="statut-dot">Connecté</span><br/>
      Dernière synchronisation : ${data.derniereSynchro ? fmtDate(data.derniereSynchro) : "jamais"}
    </p>
    <p class="aide-inline">Alimente uniquement le rapprochement bancaire (payout ↔ relevé) — jamais directement le statut payée/impayée d'une facture client, qui vient exclusivement du champ "règlements" de l'export Synec.</p>
    <button type="button" id="btn-sync-stripe" class="ghost">Synchroniser maintenant</button>
    <div id="resultat-sync-stripe"></div>
    <details class="fournisseur-documents">
      <summary>Voir les paiements captés</summary>
      <div id="liste-paiements-stripe">Chargement…</div>
    </details>
  `;

  chargerPaiementsStripe();

  document.getElementById("btn-sync-stripe").addEventListener("click", async () => {
    const resultatDiv = document.getElementById("resultat-sync-stripe");
    resultatDiv.textContent = "Synchronisation en cours…";
    try {
      const r = await fetch("/api/stripe/sync", { method: "POST" });
      const d = await r.json();
      if (!r.ok) {
        resultatDiv.innerHTML = `<span class="badge badge-echec">Erreur</span> ${echapper(d.erreur)}`;
        return;
      }
      resultatDiv.innerHTML =
        `${d.payoutsNouveaux} payout(s) nouveau(x), ${d.paiementsNouveaux} paiement(s) nouveau(x), ${d.erreurs.length} erreur(s).` +
        (d.erreurs.length > 0 ? `<br/><span class="anomalie-meta">${d.erreurs.map(echapper).join("<br/>")}</span>` : "");
      await rafraichirTout();
    } catch (err) {
      resultatDiv.innerHTML = `<span class="badge badge-echec">Erreur</span> ${echapper(err.message)}`;
    }
  });
}

// Liste individuelle des paiements Stripe deja captes : jusqu'ici seuls des
// compteurs agreges apparaissaient au moment d'un clic sur "Synchroniser
// maintenant", sans aucune trace consultable ensuite - impossible de
// verifier si un paiement precis a bien ete recu ou non (signale par
// l'utilisateur en production). Important : cette synchronisation ne
// decouvre un paiement qu'A TRAVERS le payout qui le contient (voir
// stripeSync.ts) - un paiement recu chez Stripe mais pas encore reverse sur
// le compte bancaire (delai habituel de quelques jours) n'apparait donc PAS
// encore ici, meme s'il est deja visible dans le tableau de bord Stripe.
// C'est un delai normal du fonctionnement de Stripe, pas un bug de cette
// synchronisation ni une raison pour laquelle une facture resterait impayee
// dans l'application (ce statut vient exclusivement de l'export Synec).
async function chargerPaiementsStripe() {
  const conteneur = document.getElementById("liste-paiements-stripe");
  if (!conteneur) return;
  try {
    const res = await fetch("/api/stripe/paiements");
    const paiements = await res.json();
    conteneur.innerHTML =
      paiements
        .map(
          (p) => `
      <div class="fournisseur-document-ligne">
        <span class="anomalie-meta">${fmtDate(p.date)}</span>
        <span>${fmtMontant(p.net)}</span>
        ${p.description ? `<span class="anomalie-meta">${echapper(p.description)}</span>` : ""}
      </div>`
        )
        .join("") ||
      `<p class="aide-inline">Aucun paiement capté pour le moment (un paiement tout juste reçu chez Stripe n'apparaît ici qu'une fois inclus dans un virement vers la banque, généralement sous quelques jours).</p>`;
  } catch (err) {
    conteneur.innerHTML = `<p class="aide-inline">Erreur : ${echapper(err.message)}</p>`;
  }
}

// --- Apercu d'un document -------------------------------------------------
//
// Historique : cinq tentatives successives de previsualisation ont chacune
// echoue sur l'appareil de l'utilisateur (iPhone/Safari) : modale avec
// iframe/img sur blob URL, window.open apres fetch, window.open isole dans
// une fonction non-async, un lien direct <a target="_blank"> (nouvel
// onglet qui restait blanc, cause identifiee ensuite : X-Frame-Options
// DENY empechait tout cadrage), puis une iframe integree sur la page une
// fois X-Frame-Options corrige en SAMEORIGIN - qui s'est ouverte
// correctement (bouton Fermer/Telecharger visibles) mais dont le contenu
// restait vide : limite connue et documentee de Safari iOS, qui ne rend
// pas toujours un PDF de facon fiable a l'interieur d'une iframe, meme sur
// une URL reseau reelle (pas seulement un blob).
//
// Seul mecanisme non encore essaye : une navigation NORMALE, dans le MEME
// onglet (ni nouvel onglet, ni cadre). C'est le cas le mieux supporte par
// Safari pour afficher un PDF nativement (zoom, recherche, bouton
// telecharger integres) - au prix de devoir utiliser le bouton "Retour"
// du navigateur pour revenir au tableau de bord, contrepartie assumee
// apres cinq echecs des approches plus "integrees".
function voirDocument(url) {
  window.location.href = url;
}
window.voirDocument = voirDocument;

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
        <button type="button" class="ghost bouton-lien" onclick="voirDocument('/api/anomalies/${a.id}/document')">Voir</button>
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

// --- Memoire de Morgane (decisions) ------------------------------------------

const LIBELLE_TYPE_DECISION = {
  delai_accorde: "Délai accordé",
  exception: "Exception",
  financement_oney: "Financement Oney",
  correction: "Correction",
};

async function terminerDecision(id, bouton) {
  bouton.disabled = true;
  bouton.textContent = "…";
  try {
    await fetch(`/api/decisions/${id}/terminer`, { method: "PATCH" });
    await chargerDecisions();
  } catch (err) {
    bouton.disabled = false;
    bouton.textContent = "Terminer";
    alert(err.message);
  }
}
window.terminerDecision = terminerDecision;

async function chargerDecisions() {
  const res = await fetch("/api/decisions");
  const decisions = await res.json();
  const liste = document.getElementById("liste-decisions");

  if (decisions.length === 0) {
    liste.innerHTML = `<p class="liste-vide">Aucune décision active pour le moment.</p>`;
    return;
  }

  liste.innerHTML = decisions
    .map(
      (d) => `
    <div class="decision-carte">
      <div class="relance-entete">
        <span class="badge badge-palier-neutre">${echapper(LIBELLE_TYPE_DECISION[d.type] || d.type)}</span>
        ${d.objetType ? `<span class="relance-retard">${echapper(d.objetType)}${d.objetId ? " · " + echapper(d.objetId) : ""}</span>` : ""}
      </div>
      <div class="anomalie-meta">${echapper(d.motif || "")}</div>
      <div class="anomalie-meta">Depuis le ${fmtDate(d.dateDebut)}${d.dateFin ? ` · jusqu'au ${fmtDate(d.dateFin)}` : ""}${d.auteur ? ` · ${echapper(d.auteur)}` : ""}</div>
      <div class="relance-actions">
        <button type="button" class="ghost" onclick="terminerDecision('${d.id}', this)">Terminer</button>
      </div>
    </div>`
    )
    .join("");
}

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

// --- Factures fournisseurs recues, pas encore envoyees a Dext -------------
//
// Une facture correctement reconnue par la classification (type "facture")
// mais dont le transfert automatique est en pause (DEXT_AUTO_FORWARD=false,
// cas standard : etiquetee dans Gmail pour un envoi manuel groupe en fin de
// mois) n'apparaissait auparavant nulle part dans l'interface — ni dans les
// anomalies (elle est reconnue, pas ambigue), ni ailleurs qu'un chiffre sur
// la fiche du fournisseur concerne, invisible en pratique. Signale par
// l'utilisateur : une facture bien recue par e-mail, introuvable "dans les
// factures". Cette section la rend visible individuellement, avec un envoi
// manuel immediat en plus de l'attente de fin de mois.

async function envoyerFactureFournisseurVersDext(id, bouton) {
  const texteInitial = bouton.textContent;
  bouton.disabled = true;
  bouton.textContent = "Envoi…";
  try {
    const res = await fetch(`/api/documents-fournisseurs/${id}/envoyer`, { method: "POST" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.erreur || "Envoi impossible.");
    }
    await chargerFacturesFournisseurs();
  } catch (err) {
    bouton.disabled = false;
    bouton.textContent = texteInitial;
    alert(err.message);
  }
}
window.envoyerFactureFournisseurVersDext = envoyerFactureFournisseurVersDext;

async function chargerFacturesFournisseurs() {
  const res = await fetch("/api/documents-fournisseurs?type=facture&statutDext=a_valider");
  const documents = await res.json();
  const liste = document.getElementById("liste-factures-fournisseurs");

  if (documents.length === 0) {
    liste.innerHTML = `<p class="liste-vide">Aucune facture fournisseur en attente d'envoi.</p>`;
    return;
  }

  liste.innerHTML = documents
    .map(
      (d) => `
    <div class="fournisseur-carte">
      <div class="fournisseur-nom">${echapper(d.fichierNom || "Document")}</div>
      <div class="anomalie-meta">
        ${d.fournisseur ? echapper(d.fournisseur.nom) : echapper(d.gmailExpediteur || "Expéditeur inconnu")}
        ${d.dateReceptionMail ? ` · reçu le ${fmtDate(d.dateReceptionMail)}` : ""}
        ${d.numero ? ` · n° ${echapper(d.numero)}` : ""}
        ${d.classifiePar === "ia" ? ` · <span class="badge badge-palier-ambre">classé par IA, à vérifier</span>` : ""}
      </div>
      <div class="fournisseur-actions fournisseur-actions-ligne">
        <button type="button" class="ghost bouton-lien" onclick="voirDocument('/api/documents-fournisseurs/${d.id}/document')">Voir</button>
        <button type="button" class="ghost" onclick="envoyerFactureFournisseurVersDext('${d.id}', this)">Envoyer à Dext</button>
      </div>
    </div>`
    )
    .join("");
}

// --- Fournisseurs ---------------------------------------------------------

// Le nom seul ne permet pas de deviner si un expediteur est un vrai
// fournisseur (section 14 : jamais deviner) : la suppression manuelle
// laisse la decision a l'utilisateur, plutot qu'un filtre automatique qui
// se tromperait forcement dans un sens ou dans l'autre. Le serveur refuse
// toute suppression d'un fournisseur ayant deja de vraies factures
// rattachees (voir supprimerFournisseur) : le bouton n'est propose que
// pour les fiches sans facture, ou les documents restent consultables et
// traitables individuellement dans "Anomalies à valider" ci-dessus.
async function supprimerFournisseur(id, bouton) {
  if (!confirm("Supprimer cette fiche fournisseur ? Les documents deja recus ne sont pas supprimes, seul le rattachement disparait.")) return;
  bouton.disabled = true;
  bouton.textContent = "Suppression…";
  try {
    const res = await fetch(`/api/fournisseurs/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.erreur || "Suppression impossible.");
    }
    await chargerFournisseurs();
  } catch (err) {
    bouton.disabled = false;
    bouton.textContent = "Supprimer";
    alert(err.message);
  }
}
window.supprimerFournisseur = supprimerFournisseur;

// Libelles des types de document autres que "facture" (voir gmailClassify.ts) :
// avoir/bon_enlevement/releve/devis ne sont jamais transmis a Dext ni
// signales en anomalie (jamais ambigus, jamais a valider), donc totalement
// invisibles sans ce detail - une mauvaise classification (ex. le mot
// "avoir" present incidemment dans une vraie facture) passait inapercue
// jusqu'a ce que l'utilisateur constate qu'une facture recue avait disparu
// sans laisser de trace (signale en production).
const LIBELLE_TYPE_DOCUMENT = {
  facture: "Facture",
  avoir: "Avoir",
  bon_enlevement: "Bon d'enlèvement",
  releve: "Relevé",
  devis: "Devis",
  ambigu: "Non classé",
};

async function chargerDocumentsFournisseur(fournisseurId, conteneur) {
  conteneur.innerHTML = `<p class="aide-inline">Chargement…</p>`;
  try {
    const res = await fetch(`/api/fournisseurs/${fournisseurId}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.erreur || "Chargement impossible.");
    const documents = data.documents || [];
    conteneur.innerHTML =
      documents
        .map(
          (d) => `
      <div class="fournisseur-document-ligne">
        <span class="badge badge-palier-neutre">${echapper(LIBELLE_TYPE_DOCUMENT[d.type] || d.type)}</span>
        ${d.classifiePar === "ia" ? `<span class="badge badge-palier-ambre">classé par IA</span>` : ""}
        <span>${echapper(d.fichierNom || "Document")}</span>
        ${d.dateReceptionMail ? `<span class="anomalie-meta">reçu le ${fmtDate(d.dateReceptionMail)}</span>` : ""}
        <button type="button" class="ghost bouton-lien" onclick="voirDocument('/api/documents-fournisseurs/${d.id}/document')">Voir</button>
      </div>`
        )
        .join("") || `<p class="aide-inline">Aucun document.</p>`;
  } catch (err) {
    conteneur.innerHTML = `<p class="aide-inline">Erreur : ${echapper(err.message)}</p>`;
  }
}
window.chargerDocumentsFournisseur = chargerDocumentsFournisseur;

async function chargerFournisseurs() {
  const res = await fetch("/api/fournisseurs");
  const fournisseurs = await res.json();
  const liste = document.getElementById("liste-fournisseurs");

  if (fournisseurs.length === 0) {
    liste.innerHTML = `<p class="liste-vide">Aucun fournisseur identifié pour le moment.</p>`;
    return;
  }

  liste.innerHTML = fournisseurs
    .map(
      (f) => `
    <div class="fournisseur-carte">
      <div class="fournisseur-nom">${echapper(f.nom)}</div>
      <div class="anomalie-meta">
        ${f.nbFactures} facture(s) · ${f.nbDocuments} document(s) au total
        ${f.nbEnAttente > 0 ? ` · <strong>${f.nbEnAttente} en attente</strong>` : ""}
        ${f.dernierDocumentLe ? ` · dernier reçu le ${fmtDate(f.dernierDocumentLe)}` : ""}
      </div>
      ${
        f.nbDocuments > 0
          ? `<details class="fournisseur-documents" ontoggle="if(this.open) chargerDocumentsFournisseur('${f.id}', this.querySelector('.fournisseur-documents-liste'))">
        <summary>Voir les documents (${f.nbDocuments})</summary>
        <div class="fournisseur-documents-liste">Chargement…</div>
      </details>`
          : ""
      }
      ${f.nbFactures === 0 ? `<div class="fournisseur-actions"><button type="button" class="ghost" onclick="supprimerFournisseur('${f.id}', this)">Supprimer</button></div>` : ""}
    </div>`
    )
    .join("");
}

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

// --- Journal ---------------------------------------------------------------
//
// Les planificateurs automatiques (synchronisation Gmail, recapitulatif
// quotidien, synchronisation Stripe) journalisent desormais aussi leurs
// echecs en base (pas seulement dans les logs du serveur, inaccessibles
// sans acces SSH) : cette section les rend visibles directement dans
// l'application. Root cause reelle d'une panne silencieuse constatee en
// production (plus de recapitulatif depuis plusieurs jours, factures non
// traitees) : le jeton Google expire automatiquement au bout de 7 jours
// tant que l'ecran de consentement OAuth reste en statut "Testing" (voir
// docs/mise-en-service.md section 3) - jusqu'ici invisible car /api/gmail/status
// ne verifiait pas la validite reelle du jeton, seulement sa presence.

function classeJournal(evenement) {
  return /erreur|echec|non_envoye/.test(evenement) ? "badge-echec" : "badge-ok";
}

async function chargerJournal() {
  const res = await fetch("/api/journal");
  const journal = await res.json();
  const liste = document.getElementById("liste-journal");

  if (journal.length === 0) {
    liste.innerHTML = `<p class="liste-vide">Aucun evenement journalise.</p>`;
    return;
  }

  liste.innerHTML = journal
    .slice(0, 30)
    .map(
      (j) => `
    <div class="fournisseur-document-ligne">
      <span class="badge ${classeJournal(j.evenement)}">${echapper(j.evenement)}</span>
      <span class="anomalie-meta">${fmtDate(j.horodatage)}</span>
      ${j.action ? `<span>${echapper(j.action)}</span>` : ""}
      ${j.resultat ? `<span class="anomalie-meta">${echapper(j.resultat)}</span>` : ""}
    </div>`
    )
    .join("");
}

async function rafraichirTout() {
  await Promise.all([chargerCockpit(), chargerImports(), chargerFacturesImpayees(), chargerStatutGmail(), chargerStatutStripe(), chargerAnomalies(), chargerRelances(), chargerFacturesFournisseurs(), chargerFournisseurs(), chargerDecisions(), chargerJournal()]);
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
