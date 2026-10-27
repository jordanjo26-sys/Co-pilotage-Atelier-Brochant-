const fmtMontant = (n) => new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(n || 0);
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString("fr-FR") : "—");
const echapper = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const ICONES_TUILE = {
  ca: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
  impayes: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/></svg>',
  imports: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>',
  anomalies: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>',
};

// --- Navigation par onglets + indicateurs partages -------------------------
//
// Refonte demandee par l'utilisateur apres 1 mois d'usage : la page etait
// une seule longue liste de 13 cartes a faire defiler, sans vue d'ensemble
// ("difficile de voir l'essentiel en un coup d'oeil"). etatIndicateurs
// centralise les compteurs deja calcules par chaque fonction de chargement
// existante (aucun nouvel appel reseau) pour alimenter trois choses a la
// fois : les badges numeriques sur les onglets, le bandeau d'alerte en cas
// de connexion Gmail/Stripe en panne, et le panneau "Actions requises" du
// tableau de bord.
const etatIndicateurs = {
  anomalies: 0,
  relances: 0,
  facturesFournisseurs: 0,
  aValiderImports: 0,
  gmailMotif: null,
  stripeMotif: null,
  synecMotif: null,
};

function definirBadge(onglet, valeur) {
  const span = document.querySelector(`.onglet-badge[data-badge="${onglet}"]`);
  if (!span) return;
  if (valeur > 0) {
    span.hidden = false;
    span.textContent = valeur > 99 ? "99+" : String(valeur);
  } else {
    span.hidden = true;
  }
}

function mettreAJourAlerteBandeau() {
  const bandeau = document.getElementById("alerte-bandeau");
  const problemes = [];
  if (etatIndicateurs.gmailMotif) problemes.push(`Gmail : ${etatIndicateurs.gmailMotif}`);
  if (etatIndicateurs.stripeMotif) problemes.push(`Stripe : ${etatIndicateurs.stripeMotif}`);
  if (etatIndicateurs.synecMotif) problemes.push(`Synec : ${etatIndicateurs.synecMotif}`);
  if (problemes.length === 0) {
    bandeau.hidden = true;
    bandeau.innerHTML = "";
    return;
  }
  bandeau.hidden = false;
  bandeau.innerHTML = `<span>⚠ ${problemes.map(echapper).join(" · ")}</span><button type="button" class="ghost" onclick="basculerOnglet('systeme')">Voir</button>`;
}

function mettreAJourActionsRequises() {
  const conteneur = document.getElementById("actions-requises");
  if (!conteneur) return;
  const actions = [];
  if (etatIndicateurs.gmailMotif) actions.push({ libelle: `Reconnecter Gmail (${etatIndicateurs.gmailMotif})`, onglet: "systeme" });
  if (etatIndicateurs.stripeMotif) actions.push({ libelle: `Reconnecter Stripe (${etatIndicateurs.stripeMotif})`, onglet: "tresorerie" });
  if (etatIndicateurs.synecMotif) actions.push({ libelle: `Reconnecter Synec (${etatIndicateurs.synecMotif})`, onglet: "tresorerie" });
  if (etatIndicateurs.anomalies > 0) actions.push({ libelle: "document(s) à classer manuellement", compte: etatIndicateurs.anomalies, onglet: "fournisseurs" });
  if (etatIndicateurs.relances > 0) actions.push({ libelle: "relance(s) client à envoyer", compte: etatIndicateurs.relances, onglet: "factures" });
  if (etatIndicateurs.facturesFournisseurs > 0) actions.push({ libelle: "facture(s) fournisseur en attente d'envoi à Dext", compte: etatIndicateurs.facturesFournisseurs, onglet: "factures" });
  if (etatIndicateurs.aValiderImports > 0) actions.push({ libelle: "import(s) à vérifier", compte: etatIndicateurs.aValiderImports, onglet: "tresorerie" });

  if (actions.length === 0) {
    conteneur.innerHTML = `<p class="liste-vide">Tout est à jour, rien n'attend de décision pour le moment.</p>`;
    return;
  }

  conteneur.innerHTML = actions
    .map(
      (a) => `
    <button type="button" class="action-requise" onclick="basculerOnglet('${a.onglet}')">
      <span class="pastille">${a.compte !== undefined ? a.compte : "!"}</span>
      <span class="libelle">${echapper(a.libelle)}</span>
      <span class="fleche">→</span>
    </button>`
    )
    .join("");
}

function mettreAJourBadges() {
  definirBadge("fournisseurs", etatIndicateurs.anomalies);
  definirBadge("factures", etatIndicateurs.relances + etatIndicateurs.facturesFournisseurs);
  definirBadge("tresorerie", etatIndicateurs.aValiderImports + (etatIndicateurs.stripeMotif ? 1 : 0) + (etatIndicateurs.synecMotif ? 1 : 0));
  definirBadge("systeme", etatIndicateurs.gmailMotif ? 1 : 0);
  mettreAJourAlerteBandeau();
  mettreAJourActionsRequises();
}

const CLE_ONGLET_ACTIF = "copilote_onglet_actif";

function basculerOnglet(nom) {
  const panneauExiste = document.querySelector(`.onglet-panneau[data-panneau="${nom}"]`);
  if (!panneauExiste) return;
  document.querySelectorAll(".onglet").forEach((b) => {
    const actif = b.dataset.onglet === nom;
    b.classList.toggle("actif", actif);
    b.setAttribute("aria-selected", actif ? "true" : "false");
  });
  document.querySelectorAll(".onglet-panneau").forEach((p) => {
    p.hidden = p.dataset.panneau !== nom;
  });
  try {
    localStorage.setItem(CLE_ONGLET_ACTIF, nom);
  } catch {
    // stockage indisponible (navigation privee...) : l'onglet choisi reste actif pour la session en cours seulement
  }
  window.scrollTo(0, 0);
}
window.basculerOnglet = basculerOnglet;

document.querySelectorAll(".onglet").forEach((b) => {
  b.addEventListener("click", () => basculerOnglet(b.dataset.onglet));
});

// L'accueil (accueil.html) pointe vers des onglets precis via l'URL
// (ex. /index.html#systeme) : la cible explicite dans le hash prime sur le
// dernier onglet consulte, elle-meme utilisee a defaut. Accepte aussi
// l'id d'une section precise a l'interieur d'un onglet (ex.
// #section-reseaux-sociaux) : bascule sur l'onglet qui la contient puis
// y defile - sans ca, plusieurs cartes de l'accueil pointant sur le meme
// onglet "systeme" (Google Ads, Reseaux sociaux, Systeme lui-meme)
// atterrissaient toutes en haut de l'onglet, sur la premiere carte
// (Google Ads), jamais sur celle visee (signale par l'utilisateur).
const ongletDepuisHash = location.hash.replace("#", "");
try {
  if (ongletDepuisHash && document.querySelector(`.onglet-panneau[data-panneau="${ongletDepuisHash}"]`)) {
    basculerOnglet(ongletDepuisHash);
  } else if (ongletDepuisHash && document.getElementById(ongletDepuisHash)?.closest(".onglet-panneau")) {
    const cible = document.getElementById(ongletDepuisHash);
    basculerOnglet(cible.closest(".onglet-panneau").dataset.panneau);
    requestAnimationFrame(() => cible.scrollIntoView({ behavior: "smooth", block: "start" }));
  } else {
    const dernierOnglet = localStorage.getItem(CLE_ONGLET_ACTIF);
    if (dernierOnglet) basculerOnglet(dernierOnglet);
  }
} catch {
  // ignore
}

async function chargerCockpit() {
  const res = await fetch("/api/dashboard/summary");
  const data = await res.json();
  const cockpit = document.getElementById("cockpit");
  cockpit.innerHTML = `
    <div class="tuile tuile-ca"><div class="tuile-icone">${ICONES_TUILE.ca}</div><div class="valeur">${fmtMontant(data.caVeille)}</div><div class="label">CA veille (${data.dateVeille})</div></div>
    <div class="tuile tuile-impayes${data.impayes.nombre > 0 ? " alerte" : ""}"><div class="tuile-icone">${ICONES_TUILE.impayes}</div><div class="valeur">${data.impayes.nombre}</div><div class="label">Impayés (${fmtMontant(data.impayes.montantTotal)})</div></div>
    <div class="tuile tuile-imports"><div class="tuile-icone">${ICONES_TUILE.imports}</div><div class="valeur">${data.aValiderImports}</div><div class="label">Imports à vérifier</div></div>
    <div class="tuile tuile-anomalies${data.anomaliesOuvertes > 0 ? " alerte" : ""}"><div class="tuile-icone">${ICONES_TUILE.anomalies}</div><div class="valeur">${data.anomaliesOuvertes}</div><div class="label">Anomalies ouvertes</div></div>
  `;
  etatIndicateurs.aValiderImports = data.aValiderImports;
  mettreAJourBadges();
}

// --- Graphique du chiffre d'affaires (jour/mois/annee) ----------------------
//
// Demande explicite de l'utilisateur : pouvoir regarder le CA par jour, par
// mois ou par annee, pas seulement le chiffre brut de la veille. Construit
// a la main en SVG (pas de librairie de graphiques dans ce projet) en
// suivant les memes principes que le reste de l'interface : sobre, lisible,
// une seule serie (pas de legende necessaire, le titre de la carte suffit),
// etiquette de valeur a l'extremite de la courbe, survol avec infobulle.

const VB_GRAPHIQUE_L = 600;
const VB_GRAPHIQUE_H = 220;
const MARGE_GRAPHIQUE = { haut: 14, droite: 16, bas: 28, gauche: 46 };

function fmtCompact(n) {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1000) return `${(v / 1000).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} k€`;
  return `${Math.round(v)} €`;
}

const MOIS_COURTS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
const MOIS_LONGS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

function fmtPeriodeAxe(periode, granularite) {
  if (granularite === "jour") {
    const [, m, j] = periode.split("-");
    return `${parseInt(j, 10)} ${MOIS_COURTS[parseInt(m, 10) - 1]}`;
  }
  if (granularite === "mois") {
    const [a, m] = periode.split("-");
    return `${MOIS_COURTS[parseInt(m, 10) - 1]} ${a.slice(2)}`;
  }
  return periode;
}

function fmtPeriodeComplet(periode, granularite) {
  if (granularite === "jour") {
    const [a, m, j] = periode.split("-");
    return `${parseInt(j, 10)} ${MOIS_LONGS[parseInt(m, 10) - 1]} ${a}`;
  }
  if (granularite === "mois") {
    const [a, m] = periode.split("-");
    return `${MOIS_LONGS[parseInt(m, 10) - 1]} ${a}`;
  }
  return periode;
}

function creerElementSvg(tag, attrs) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  return el;
}

let granulariteCaActuelle = "jour";

function dessinerGraphiqueCa(conteneur, points, granularite) {
  conteneur.innerHTML = "";
  if (!points || points.length === 0 || points.every((p) => p.montant === 0)) {
    conteneur.innerHTML = '<p class="aide">Pas encore de chiffre d\'affaires sur cette période.</p>';
    return;
  }

  const n = points.length;
  const maxBrut = Math.max(...points.map((p) => p.montant), 0);
  const maxY = maxBrut > 0 ? maxBrut * 1.15 : 100;
  const plotW = VB_GRAPHIQUE_L - MARGE_GRAPHIQUE.gauche - MARGE_GRAPHIQUE.droite;
  const plotH = VB_GRAPHIQUE_H - MARGE_GRAPHIQUE.haut - MARGE_GRAPHIQUE.bas;
  const x = (i) => MARGE_GRAPHIQUE.gauche + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v) => MARGE_GRAPHIQUE.haut + plotH - (v / maxY) * plotH;

  const svg = creerElementSvg("svg", {
    viewBox: `0 0 ${VB_GRAPHIQUE_L} ${VB_GRAPHIQUE_H}`,
    class: "graphique-ca-svg",
    role: "img",
    "aria-label": `Évolution du chiffre d'affaires sur ${n} périodes, dernière valeur ${fmtMontant(points[n - 1].montant)}`,
  });

  // Quadrillage + etiquettes Y (0 / 1/3 / 2/3 / max), compact (0 / 1k€...).
  const axes = creerElementSvg("g", { class: "graphique-axes" });
  for (let f = 0; f <= 1.0001; f += 1 / 3) {
    const valeur = maxY * f;
    const posY = y(valeur);
    axes.appendChild(
      creerElementSvg("line", { x1: MARGE_GRAPHIQUE.gauche, x2: VB_GRAPHIQUE_L - MARGE_GRAPHIQUE.droite, y1: posY, y2: posY, class: "graphique-grille" })
    );
    const label = creerElementSvg("text", { x: MARGE_GRAPHIQUE.gauche - 6, y: posY, class: "graphique-label-y", "text-anchor": "end", "dominant-baseline": "middle" });
    label.textContent = fmtCompact(valeur);
    axes.appendChild(label);
  }

  // Etiquettes X : un sous-ensemble seulement (jamais un libelle par point
  // sur 30 jours, illisible) - voir skill dataviz, "label selectively".
  const pasX = granularite === "jour" ? Math.ceil(n / 6) : 1;
  points.forEach((p, i) => {
    if (i % pasX !== 0 && i !== n - 1) return;
    const label = creerElementSvg("text", { x: x(i), y: VB_GRAPHIQUE_H - 8, class: "graphique-label-x", "text-anchor": "middle" });
    label.textContent = fmtPeriodeAxe(p.periode, granularite);
    axes.appendChild(label);
  });
  svg.appendChild(axes);

  // Aire (fondu, jamais un aplat sature) puis ligne (2px, jonctions rondes).
  const chemin = points.map((p, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(p.montant).toFixed(1)}`).join(" ");
  const cheminAire = `${chemin} L ${x(n - 1).toFixed(1)} ${y(0).toFixed(1)} L ${x(0).toFixed(1)} ${y(0).toFixed(1)} Z`;
  svg.appendChild(creerElementSvg("path", { d: cheminAire, class: "graphique-aire" }));
  svg.appendChild(creerElementSvg("path", { d: chemin, class: "graphique-ligne", fill: "none" }));

  // Point + etiquette de fin (la valeur se lit a l'extremite de la courbe,
  // pas un chiffre colle sur chaque point).
  const dernier = points[n - 1];
  const finX = x(n - 1);
  const finY = y(dernier.montant);
  svg.appendChild(creerElementSvg("circle", { cx: finX, cy: finY, r: 7, class: "graphique-marqueur-anneau" }));
  svg.appendChild(creerElementSvg("circle", { cx: finX, cy: finY, r: 4, class: "graphique-marqueur-point" }));
  const presDuBord = finX > VB_GRAPHIQUE_L - 70;
  const etiquetteFin = creerElementSvg("text", {
    x: presDuBord ? finX : finX,
    y: Math.max(finY - 12, MARGE_GRAPHIQUE.haut + 8),
    class: "graphique-etiquette-fin",
    "text-anchor": presDuBord ? "end" : "middle",
  });
  etiquetteFin.textContent = fmtMontant(dernier.montant);
  svg.appendChild(etiquetteFin);

  // Curseur de survol (crosshair) + infobulle HTML (plus simple a styler
  // qu'un <foreignObject> SVG) - cf. skill dataviz, "the hover layer is
  // part of the deliverable".
  const ligneCurseur = creerElementSvg("line", { y1: MARGE_GRAPHIQUE.haut, y2: VB_GRAPHIQUE_H - MARGE_GRAPHIQUE.bas, class: "graphique-curseur", visibility: "hidden" });
  const pointSurvole = creerElementSvg("circle", { r: 5, class: "graphique-point-survole", visibility: "hidden" });
  svg.appendChild(ligneCurseur);
  svg.appendChild(pointSurvole);

  conteneur.appendChild(svg);

  const infobulle = document.createElement("div");
  infobulle.className = "graphique-infobulle";
  infobulle.hidden = true;
  const infobulleValeur = document.createElement("div");
  infobulleValeur.className = "graphique-infobulle-valeur";
  const infobulleDate = document.createElement("div");
  infobulleDate.className = "graphique-infobulle-date";
  infobulle.appendChild(infobulleValeur);
  infobulle.appendChild(infobulleDate);
  conteneur.appendChild(infobulle);

  const zoneSurvol = creerElementSvg("rect", {
    x: MARGE_GRAPHIQUE.gauche,
    y: MARGE_GRAPHIQUE.haut,
    width: plotW,
    height: plotH,
    fill: "transparent",
    class: "graphique-zone-survol",
  });
  svg.appendChild(zoneSurvol);

  const majSurvol = (clientX) => {
    const rectSvg = svg.getBoundingClientRect();
    if (rectSvg.width === 0) return;
    const posViewBoxX = ((clientX - rectSvg.left) / rectSvg.width) * VB_GRAPHIQUE_L;
    const posRelative = (posViewBoxX - MARGE_GRAPHIQUE.gauche) / plotW;
    const i = Math.max(0, Math.min(n - 1, Math.round(posRelative * (n - 1))));
    const p = points[i];
    const px = x(i);
    const py = y(p.montant);

    ligneCurseur.setAttribute("x1", px);
    ligneCurseur.setAttribute("x2", px);
    ligneCurseur.setAttribute("visibility", "visible");
    pointSurvole.setAttribute("cx", px);
    pointSurvole.setAttribute("cy", py);
    pointSurvole.setAttribute("visibility", "visible");

    infobulle.hidden = false;
    infobulleValeur.textContent = fmtMontant(p.montant);
    infobulleDate.textContent = fmtPeriodeComplet(p.periode, granularite);
    const pctX = (px / VB_GRAPHIQUE_L) * 100;
    const pctY = (py / VB_GRAPHIQUE_H) * 100;
    infobulle.style.left = `${pctX}%`;
    infobulle.style.top = `${pctY}%`;
    infobulle.classList.toggle("a-droite", pctX > 60);
  };

  zoneSurvol.addEventListener("pointermove", (e) => majSurvol(e.clientX));
  zoneSurvol.addEventListener("pointerleave", () => {
    ligneCurseur.setAttribute("visibility", "hidden");
    pointSurvole.setAttribute("visibility", "hidden");
    infobulle.hidden = true;
  });
}

async function chargerGraphiqueCa(granularite = granulariteCaActuelle) {
  granulariteCaActuelle = granularite;
  const res = await fetch(`/api/dashboard/ca-serie?granularite=${granularite}`);
  const points = await res.json();
  dessinerGraphiqueCa(document.getElementById("graphique-ca"), points, granularite);
}

document.querySelectorAll(".filtre-periode-bouton").forEach((bouton) => {
  bouton.addEventListener("click", () => {
    document.querySelectorAll(".filtre-periode-bouton").forEach((b) => b.classList.remove("actif"));
    bouton.classList.add("actif");
    chargerGraphiqueCa(bouton.dataset.granularite);
  });
});

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
    etatIndicateurs.gmailMotif = data.motif || null;
    mettreAJourBadges();
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
  etatIndicateurs.gmailMotif = null;
  mettreAJourBadges();

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
    etatIndicateurs.stripeMotif = data.motif || null;
    mettreAJourBadges();
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
      <div class="ligne-boutons" style="margin: 10px 0;">
        <a class="ghost bouton-lien" href="/api/stripe/paiements/export-pdf">Exporter en PDF</a>
      </div>
      <div id="liste-paiements-stripe">Chargement…</div>
    </details>
  `;

  etatIndicateurs.stripeMotif = null;
  mettreAJourBadges();

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

// --- Synec (aucune API : automatisation par navigateur headless cote serveur) ---

async function chargerStatutSynec() {
  const res = await fetch("/api/synec/status");
  const data = await res.json();
  const div = document.getElementById("synec-statut");

  // Sans identifiants configures du tout (aucun motif) : rien a tenter,
  // pas de bouton. Mais un echec de la DERNIERE tentative (motif present)
  // ne veut pas dire que les identifiants sont invalides (contrairement a
  // Gmail/Stripe) - l'automatisation par navigateur peut echouer pour
  // d'autres raisons (navigation, mise a jour du site Synec...) sans que
  // les identifiants ne soient en cause. Le bouton doit rester disponible
  // pour reessayer, sinon un premier echec bloque definitivement toute
  // nouvelle tentative depuis l'interface (constate en production).
  if (!data.connecte && !data.motif) {
    div.innerHTML = `<p class="statut-dot off">Non connecté — identifiants à ajouter (voir docs/mise-en-service.md).</p>`;
    etatIndicateurs.synecMotif = null;
    mettreAJourBadges();
    return;
  }

  div.innerHTML = `
    ${
      data.connecte
        ? `<p class="gmail-connecte"><span class="statut-dot">Connecté</span><br/>Dernière synchronisation : ${data.derniereSynchro ? fmtDate(data.derniereSynchro) : "jamais"}</p>`
        : `<p class="statut-dot off">${echapper(data.motif)}</p><p class="aide-inline"><a href="/api/synec/capture-echec" target="_blank">Voir la capture d'écran du dernier échec</a></p>`
    }
    <button type="button" id="btn-sync-synec" class="ghost">Synchroniser maintenant</button>
    <div id="resultat-sync-synec"></div>
  `;

  etatIndicateurs.synecMotif = data.connecte ? null : data.motif;
  mettreAJourBadges();

  document.getElementById("btn-sync-synec").addEventListener("click", async () => {
    const resultatDiv = document.getElementById("resultat-sync-synec");
    // Plus long qu'une synchronisation Stripe/Gmail (ouverture d'un
    // navigateur complet et connexion reelle au site, pas un simple appel
    // API) : prevenir explicitement evite de penser l'interface figee.
    resultatDiv.textContent = "Synchronisation en cours (peut prendre jusqu'à une minute)…";
    try {
      const r = await fetch("/api/synec/sync", { method: "POST" });
      const d = await r.json();
      if (!r.ok) {
        resultatDiv.innerHTML = `<span class="badge badge-echec">Erreur</span> ${echapper(d.erreur)}`;
        return;
      }
      resultatDiv.innerHTML = `${d.nbNouveaux} nouveau(x), ${d.nbDoublons} doublon(s), ${d.nbErreurs} erreur(s).`;
      await rafraichirTout();
    } catch (err) {
      resultatDiv.innerHTML = `<span class="badge badge-echec">Erreur</span> ${echapper(err.message)}`;
    }
  });
}

// --- Google Ads (import manuel, en attendant l'acces API) ------------------

async function chargerStatutGoogleAds() {
  const res = await fetch("/api/google-ads/dernier-import");
  const data = await res.json();
  const div = document.getElementById("google-ads-statut");

  div.innerHTML = data
    ? `<p class="gmail-connecte"><span class="statut-dot">Dernier import</span> — ${echapper(data.fichierNom)}<br/>Déposé le ${fmtDate(data.importeLe)} · ${data.campagnes.length} campagne(s)</p>`
    : `<p class="statut-dot off">Aucun import pour l'instant.</p>`;
}

document.getElementById("form-import-ads").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fichier = document.getElementById("fichier-import-ads").files[0];
  const resultatDiv = document.getElementById("resultat-import-ads");
  if (!fichier) return;

  const donnees = new FormData();
  donnees.append("fichier", fichier);
  resultatDiv.textContent = "Import en cours…";
  try {
    const r = await fetch("/api/google-ads/import", { method: "POST", body: donnees });
    const d = await r.json();
    if (!r.ok) {
      resultatDiv.innerHTML = `<span class="badge badge-echec">Erreur</span> ${echapper(d.erreur)}`;
      return;
    }
    resultatDiv.innerHTML = `${d.nbCampagnes} campagne(s) importée(s).`;
    e.target.reset();
    await chargerStatutGoogleAds();
  } catch (err) {
    resultatDiv.innerHTML = `<span class="badge badge-echec">Erreur</span> ${echapper(err.message)}`;
  }
});

// Propositions d'action Ads de Morgane (pause/reactivation de campagne) :
// ecran de validation dedie, distinct de la conversation (demande explicite
// de l'utilisateur - voir src/services/googleAdsActions.ts). Morgane ne
// modifie jamais une campagne directement ; elle depose une proposition ici,
// que l'utilisateur accepte ou refuse.
const LIBELLE_TYPE_PROPOSITION_ADS = {
  pause_campagne: "Mettre en pause",
  reactiver_campagne: "Réactiver",
  creer_campagne: "Nouvelle campagne",
  ajouter_mots_cles_exclus: "Mots-clés exclus",
  pause_mot_cle: "Pause mot-clé",
  reactiver_mot_cle: "Réactiver mot-clé",
  exclure_action_conversion: "Exclure du comptage",
  creer_action_conversion_site: "Nouvelle conversion web",
  modifier_budget_campagne: "Modifier le budget",
  ajouter_mots_cles_positifs: "Ajouter des mots-clés",
  ajouter_extensions_campagne: "Ajouter des extensions",
  modifier_strategie_encheres: "Changer la stratégie d'enchères",
  definir_horaires_campagne: "Programmer les horaires",
  ajouter_audiences_campagne: "Ajouter des audiences",
  ajouter_annonce_test: "Ajouter une annonce de test",
  supprimer_campagne: "Supprimer la campagne",
  ajuster_encheres_appareil: "Ajuster les enchères par appareil",
};
const BADGE_STATUT_PROPOSITION_ADS = {
  en_attente: "badge-partiel",
  acceptee: "badge-partiel",
  appliquee: "badge-ok",
  refusee: "badge-doublon_fichier",
  echec: "badge-echec",
};
const LIBELLE_STATUT_PROPOSITION_ADS = {
  en_attente: "En attente",
  acceptee: "Acceptée…",
  appliquee: "Appliquée",
  refusee: "Refusée",
  echec: "Échec",
};

function rendreExtensionsPropositionAds(p) {
  const sitelinks = p.sitelinks || [];
  const callouts = p.callouts || [];
  const snippets = p.structuredSnippets || [];
  const morceaux = [];
  if (sitelinks.length > 0) {
    morceaux.push(
      `<div class="anomalie-meta"><strong>Liens d'accroche</strong> : ${sitelinks
        .map((s) => echapper(s.texte) + (s.description1 ? ` (${echapper(s.description1)} ${echapper(s.description2 || "")})` : ""))
        .join(" · ")}</div>`
    );
  }
  if (callouts.length > 0) {
    morceaux.push(`<div class="anomalie-meta"><strong>Accroches</strong> : ${callouts.map(echapper).join(" · ")}</div>`);
  }
  if (snippets.length > 0) {
    morceaux.push(
      `<div class="anomalie-meta"><strong>Extraits structurés</strong> : ${snippets
        .map((s) => `${echapper(s.header)} : ${(s.valeurs || []).map(echapper).join(", ")}`)
        .join(" · ")}</div>`
    );
  }
  return morceaux.join("\n");
}

const LIBELLE_JOUR_HORAIRE = {
  MONDAY: "Lun",
  TUESDAY: "Mar",
  WEDNESDAY: "Mer",
  THURSDAY: "Jeu",
  FRIDAY: "Ven",
  SATURDAY: "Sam",
  SUNDAY: "Dim",
};

function rendreHorairesPropositionAds(p) {
  const horaires = p.horaires || [];
  if (horaires.length === 0) return "";
  const fmt = (h, m) => `${String(h).padStart(2, "0")}h${m ? String(m).padStart(2, "0") : ""}`;
  return `<div class="anomalie-meta"><strong>Horaires de diffusion</strong> : ${horaires
    .map((h) => `${LIBELLE_JOUR_HORAIRE[h.jour] || h.jour} ${fmt(h.heureDebut, h.minuteDebut)}-${fmt(h.heureFin, h.minuteFin)}`)
    .join(" · ")}</div>`;
}

function rendreStrategieEncheresPropositionAds(p) {
  if (!p.strategieEncheres || p.strategieEncheres === "MAXIMIZE_CONVERSIONS") return "";
  const libelle = p.strategieEncheres === "TARGET_CPA" ? `CPA cible${p.cpaCibleEuros != null ? ` (${p.cpaCibleEuros} €)` : ""}` : "CPC optimisé (manuel)";
  return `<div class="anomalie-meta"><strong>Stratégie d'enchères</strong> : ${echapper(libelle)}</div>`;
}

async function accepterPropositionAds(id, bouton) {
  bouton.disabled = true;
  const groupe = bouton.closest(".relance-actions");
  if (groupe) groupe.querySelectorAll("button").forEach((b) => (b.disabled = true));
  bouton.textContent = "…";
  try {
    const r = await fetch(`/api/google-ads/propositions/${id}/accepter`, { method: "POST" });
    const d = await r.json();
    if (!r.ok) throw new Error(d.erreur || "Échec de l'acceptation.");
    await chargerPropositionsAds();
  } catch (err) {
    if (groupe) groupe.querySelectorAll("button").forEach((b) => (b.disabled = false));
    alert(err.message);
  }
}
window.accepterPropositionAds = accepterPropositionAds;

async function refuserPropositionAds(id, bouton) {
  const groupe = bouton.closest(".relance-actions");
  if (groupe) groupe.querySelectorAll("button").forEach((b) => (b.disabled = true));
  bouton.textContent = "…";
  try {
    const r = await fetch(`/api/google-ads/propositions/${id}/refuser`, { method: "POST" });
    const d = await r.json();
    if (!r.ok) throw new Error(d.erreur || "Échec du refus.");
    await chargerPropositionsAds();
  } catch (err) {
    if (groupe) groupe.querySelectorAll("button").forEach((b) => (b.disabled = false));
    alert(err.message);
  }
}
window.refuserPropositionAds = refuserPropositionAds;

async function chargerPropositionsAds() {
  const liste = document.getElementById("liste-propositions-ads");
  if (!liste) return;
  const res = await fetch("/api/google-ads/propositions");
  const propositions = await res.json();

  if (propositions.length === 0) {
    liste.innerHTML = `<p class="liste-vide">Aucune proposition pour le moment.</p>`;
    return;
  }

  liste.innerHTML = propositions
    .map((p) => {
      const badge = BADGE_STATUT_PROPOSITION_ADS[p.statut] || "badge-doublon_fichier";
      const libelleStatut = LIBELLE_STATUT_PROPOSITION_ADS[p.statut] || p.statut;
      const actions =
        p.statut === "en_attente"
          ? `<div class="relance-actions">
               <button type="button" onclick="accepterPropositionAds('${p.id}', this)">Accepter</button>
               <button type="button" class="ghost" onclick="refuserPropositionAds('${p.id}', this)">Refuser</button>
             </div>`
          : "";
      const detailsCreation =
        p.type === "creer_campagne"
          ? `<div class="anomalie-meta">Budget : ${p.budgetQuotidien != null ? p.budgetQuotidien.toLocaleString("fr-FR", { minimumFractionDigits: 2 }) + " €/jour" : "—"} · URL : ${echapper(p.urlFinale || "—")}</div>
             <div class="anomalie-meta"><strong>Titres</strong> : ${(p.titres || []).map(echapper).join(" · ")}</div>
             <div class="anomalie-meta"><strong>Descriptions</strong> : ${(p.descriptions || []).map(echapper).join(" · ")}</div>
             <div class="anomalie-meta"><strong>Mots-clés</strong> : ${(p.motsCles || []).map(echapper).join(", ") || "—"}${p.typeCorrespondance ? ` (${echapper(p.typeCorrespondance)})` : ""}</div>
             ${(p.motsClesExclus || []).length > 0 ? `<div class="anomalie-meta"><strong>Mots-clés exclus</strong> : ${p.motsClesExclus.map(echapper).join(", ")}</div>` : ""}
             ${(p.ciblesGeographiques || []).length > 0 ? `<div class="anomalie-meta"><strong>Ciblage géographique</strong> : ${p.ciblesGeographiques.map(echapper).join(", ")}</div>` : ""}
             ${p.numeroTelephone ? `<div class="anomalie-meta"><strong>Extension d'appel</strong> : ${echapper(p.numeroTelephone)}, créée avec la campagne</div>` : ""}
             ${rendreExtensionsPropositionAds(p)}
             ${rendreStrategieEncheresPropositionAds(p)}
             ${rendreHorairesPropositionAds(p)}
             ${(p.audiences || []).length > 0 ? `<div class="anomalie-meta"><strong>Audiences (observation)</strong> : ${p.audiences.map(echapper).join(", ")}</div>` : ""}
             <div class="anomalie-meta">Sera créée <strong>en pause</strong> : aucune dépense tant que tu ne l'actives pas toi-même dans Google Ads.</div>`
          : p.type === "ajouter_mots_cles_exclus"
            ? `<div class="anomalie-meta"><strong>Mots-clés exclus à ajouter</strong> : ${(p.motsClesExclus || []).map(echapper).join(", ") || "—"}</div>`
            : p.type === "pause_mot_cle" || p.type === "reactiver_mot_cle"
              ? `<div class="anomalie-meta"><strong>Mot-clé</strong> : ${echapper(p.motCleTexte || "—")}</div>`
              : p.type === "exclure_action_conversion"
                ? `<div class="anomalie-meta">Cette action de conversion ne comptera plus dans les conversions (elle n'est pas supprimée).</div>`
                : p.type === "creer_action_conversion_site"
                  ? `<div class="anomalie-meta">Type : ${p.typeConversionSite === "CLICK_TO_CALL" ? "Clic sur le numéro de téléphone" : "Envoi de formulaire"}. Une fois acceptée, demande le code à coller sur le site directement à Morgane.</div>`
                  : p.type === "modifier_budget_campagne"
                    ? `<div class="anomalie-meta"><strong>Nouveau budget</strong> : ${p.budgetQuotidien != null ? p.budgetQuotidien.toLocaleString("fr-FR", { minimumFractionDigits: 2 }) + " €/jour" : "—"}</div>`
                    : p.type === "ajouter_mots_cles_positifs"
                      ? `<div class="anomalie-meta"><strong>Mots-clés à ajouter</strong> : ${(p.motsCles || []).map(echapper).join(", ") || "—"}${p.typeCorrespondance ? ` (${echapper(p.typeCorrespondance)})` : ""}</div>`
                      : p.type === "ajouter_extensions_campagne"
                        ? rendreExtensionsPropositionAds(p)
                        : p.type === "modifier_strategie_encheres"
                          ? `<div class="anomalie-meta"><strong>Nouvelle stratégie</strong> : ${p.strategieEncheres === "TARGET_CPA" ? `CPA cible (${p.cpaCibleEuros} €)` : p.strategieEncheres === "MANUAL_CPC" ? "CPC optimisé (manuel)" : "Maximiser les conversions"}</div>`
                          : p.type === "definir_horaires_campagne"
                            ? rendreHorairesPropositionAds(p)
                            : p.type === "ajouter_audiences_campagne"
                              ? `<div class="anomalie-meta"><strong>Audiences (observation)</strong> : ${(p.audiences || []).map(echapper).join(", ") || "—"}</div>`
                              : p.type === "ajouter_annonce_test"
                                ? `<div class="anomalie-meta">Groupe ${echapper(p.groupeId || "—")}</div>
                                   <div class="anomalie-meta"><strong>Titres</strong> : ${(p.titres || []).map(echapper).join(" · ")}</div>
                                   <div class="anomalie-meta"><strong>Descriptions</strong> : ${(p.descriptions || []).map(echapper).join(" · ")}</div>
                                   <div class="anomalie-meta">Sera créée <strong>en pause</strong> : à activer toi-même pour démarrer la comparaison.</div>`
                                : p.type === "supprimer_campagne"
                                  ? `<div class="anomalie-meta" style="color:var(--critical)"><strong>Action définitive</strong> : la campagne ne pourra plus être réactivée ni modifiée après suppression.</div>`
                                  : p.type === "ajuster_encheres_appareil"
                                    ? `<div class="anomalie-meta"><strong>Ajustements</strong> : ${((p.ajustementsAppareil || [])).map((a) => `${echapper(a.appareil)} ${a.pourcentage > 0 ? "+" : ""}${a.pourcentage}%`).join(", ") || "—"}</div>`
                                    : "";
      return `
    <div class="decision-carte">
      <div class="relance-entete">
        <span class="badge badge-palier-neutre">${echapper(LIBELLE_TYPE_PROPOSITION_ADS[p.type] || p.type)}</span>
        <span class="relance-retard">${echapper(p.campagneNom)}</span>
        <span class="badge ${badge}">${echapper(libelleStatut)}</span>
      </div>
      <div class="anomalie-meta">${echapper(p.justification)}</div>
      ${detailsCreation}
      <div class="anomalie-meta">Déposée le ${fmtDate(p.creeLe)}${p.decideLe ? ` · décidée le ${fmtDate(p.decideLe)}` : ""}</div>
      ${p.erreur ? `<div class="anomalie-meta" style="color:var(--critical)">${echapper(p.erreur)}</div>` : ""}
      ${actions}
    </div>`;
    })
    .join("");
}

// Module Reseaux sociaux (Facebook/Instagram), phase fondations : connexion
// Meta + publication manuelle apres validation. Meme principe que les
// propositions Ads (statuts en_attente/acceptee/appliquee/refusee/echec),
// on reutilise donc les memes libelles/badges.
async function chargerStatutReseauxSociaux() {
  const div = document.getElementById("reseaux-sociaux-statut");
  if (!div) return;
  const res = await fetch("/api/reseaux-sociaux/connexion");
  const data = await res.json();
  div.innerHTML = data.connecte
    ? `<p class="gmail-connecte"><span class="statut-dot">Connecté</span> — Page « ${echapper(data.pageNom)} »${data.instagramUsername ? ` · Instagram @${echapper(data.instagramUsername)}` : " · Instagram non lié"}</p>`
    : `<p class="statut-dot off">Non connecté. <a href="/auth/meta">Connecter Facebook/Instagram →</a></p>`;
}

let cheminMediaReseauxSociaux = null;

const champFichierReseauxSociaux = document.getElementById("fichier-media-reseaux-sociaux");
if (champFichierReseauxSociaux) {
  champFichierReseauxSociaux.addEventListener("change", async () => {
    const apercu = document.getElementById("apercu-media-reseaux-sociaux");
    const fichier = champFichierReseauxSociaux.files[0];
    cheminMediaReseauxSociaux = null;
    if (!fichier) {
      apercu.innerHTML = "";
      return;
    }
    apercu.textContent = "Envoi de la photo…";
    const donnees = new FormData();
    donnees.append("fichier", fichier);
    try {
      const r = await fetch("/api/reseaux-sociaux/media", { method: "POST", body: donnees });
      const d = await r.json();
      if (!r.ok) throw new Error(d.erreur || "Échec de l'envoi de la photo.");
      cheminMediaReseauxSociaux = d.chemin;
      apercu.innerHTML = `<img src="/${echapper(d.chemin)}" alt="Aperçu" style="max-width:220px;max-height:220px;border-radius:8px;margin-top:6px" />`;
    } catch (err) {
      apercu.innerHTML = `<span class="badge badge-echec">Erreur</span> ${echapper(err.message)}`;
    }
  });
}

const formPublicationReseauxSociaux = document.getElementById("form-publication-reseaux-sociaux");
if (formPublicationReseauxSociaux) {
  formPublicationReseauxSociaux.addEventListener("submit", async (e) => {
    e.preventDefault();
    const resultatDiv = document.getElementById("resultat-publication-reseaux-sociaux");
    const texte = document.getElementById("texte-publication-reseaux-sociaux").value.trim();
    const plateformes = [];
    if (document.getElementById("plateforme-facebook").checked) plateformes.push("FACEBOOK");
    if (document.getElementById("plateforme-instagram").checked) plateformes.push("INSTAGRAM");

    if (!texte) {
      resultatDiv.innerHTML = `<span class="badge badge-echec">Erreur</span> Le texte de la publication est requis.`;
      return;
    }
    if (plateformes.length === 0) {
      resultatDiv.innerHTML = `<span class="badge badge-echec">Erreur</span> Choisis au moins une plateforme.`;
      return;
    }

    resultatDiv.textContent = "Dépôt de la proposition…";
    try {
      const r = await fetch("/api/reseaux-sociaux/propositions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          plateformes,
          texte,
          cheminMedia: cheminMediaReseauxSociaux || undefined,
          justification: "Publication proposée depuis l'onglet Réseaux sociaux.",
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.erreur || "Échec du dépôt de la proposition.");
      resultatDiv.innerHTML = `Proposition déposée — à accepter ci-dessous pour publier.`;
      formPublicationReseauxSociaux.reset();
      document.getElementById("apercu-media-reseaux-sociaux").innerHTML = "";
      document.getElementById("plateforme-facebook").checked = true;
      cheminMediaReseauxSociaux = null;
      await chargerPropositionsReseauxSociaux();
    } catch (err) {
      resultatDiv.innerHTML = `<span class="badge badge-echec">Erreur</span> ${echapper(err.message)}`;
    }
  });
}

async function accepterPropositionReseauxSociaux(id, bouton) {
  const groupe = bouton.closest(".relance-actions");
  if (groupe) groupe.querySelectorAll("button").forEach((b) => (b.disabled = true));
  bouton.textContent = "…";
  try {
    const r = await fetch(`/api/reseaux-sociaux/propositions/${id}/accepter`, { method: "POST" });
    const d = await r.json();
    if (!r.ok) throw new Error(d.erreur || "Échec de l'acceptation.");
    await chargerPropositionsReseauxSociaux();
  } catch (err) {
    if (groupe) groupe.querySelectorAll("button").forEach((b) => (b.disabled = false));
    alert(err.message);
  }
}
window.accepterPropositionReseauxSociaux = accepterPropositionReseauxSociaux;

async function refuserPropositionReseauxSociaux(id, bouton) {
  const groupe = bouton.closest(".relance-actions");
  if (groupe) groupe.querySelectorAll("button").forEach((b) => (b.disabled = true));
  bouton.textContent = "…";
  try {
    const r = await fetch(`/api/reseaux-sociaux/propositions/${id}/refuser`, { method: "POST" });
    const d = await r.json();
    if (!r.ok) throw new Error(d.erreur || "Échec du refus.");
    await chargerPropositionsReseauxSociaux();
  } catch (err) {
    if (groupe) groupe.querySelectorAll("button").forEach((b) => (b.disabled = false));
    alert(err.message);
  }
}
window.refuserPropositionReseauxSociaux = refuserPropositionReseauxSociaux;

const LIBELLE_PLATEFORME_RESEAUX_SOCIAUX = { FACEBOOK: "Facebook", INSTAGRAM: "Instagram" };

async function chargerPropositionsReseauxSociaux() {
  const liste = document.getElementById("liste-propositions-reseaux-sociaux");
  if (!liste) return;
  const res = await fetch("/api/reseaux-sociaux/propositions");
  const propositions = await res.json();

  if (propositions.length === 0) {
    liste.innerHTML = `<p class="liste-vide">Aucune proposition pour le moment.</p>`;
    return;
  }

  liste.innerHTML = propositions
    .map((p) => {
      const badge = BADGE_STATUT_PROPOSITION_ADS[p.statut] || "badge-doublon_fichier";
      const libelleStatut = LIBELLE_STATUT_PROPOSITION_ADS[p.statut] || p.statut;
      const actions =
        p.statut === "en_attente"
          ? `<div class="relance-actions">
               <button type="button" onclick="accepterPropositionReseauxSociaux('${p.id}', this)">Accepter</button>
               <button type="button" class="ghost" onclick="refuserPropositionReseauxSociaux('${p.id}', this)">Refuser</button>
             </div>`
          : "";
      return `
    <div class="decision-carte">
      <div class="relance-entete">
        <span class="badge badge-palier-neutre">${(p.plateformes || []).map((pf) => echapper(LIBELLE_PLATEFORME_RESEAUX_SOCIAUX[pf] || pf)).join(" + ")}</span>
        <span class="badge ${badge}">${echapper(libelleStatut)}</span>
      </div>
      <div class="anomalie-meta">${echapper(p.texte)}</div>
      ${p.cheminMedia ? `<img src="/${echapper(p.cheminMedia)}" alt="Photo" style="max-width:160px;max-height:160px;border-radius:8px;margin:6px 0" />` : ""}
      <div class="anomalie-meta">${echapper(p.justification)}</div>
      <div class="anomalie-meta">Déposée le ${fmtDate(p.creeLe)}${p.decideLe ? ` · décidée le ${fmtDate(p.decideLe)}` : ""}</div>
      ${p.erreur ? `<div class="anomalie-meta" style="color:var(--critical)">${echapper(p.erreur)}</div>` : ""}
      ${actions}
    </div>`;
    })
    .join("");
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
// Libelle du moyen de paiement Stripe (section tresorerie, demande
// explicite de l'utilisateur de distinguer Tap to Pay/terminal des
// paiements par carte en ligne). "card_present" couvre aussi bien le
// lecteur de carte physique que l'app Tap to Pay sur mobile cote Stripe,
// les deux etant pour l'atelier un encaissement en face a face.
const LIBELLE_MOYEN_PAIEMENT = {
  card_present: "Tap to Pay / terminal",
  card: "Carte en ligne",
};

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
        <span class="badge badge-palier-neutre">${echapper(LIBELLE_MOYEN_PAIEMENT[p.moyenPaiement] || p.moyenPaiement || "Moyen inconnu")}</span>
        ${p.facture ? `<span class="badge badge-ok">${echapper(p.facture.clientNom)} · ${echapper(p.facture.reference)}</span>` : ""}
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

async function classerAnomalieFacture(id, bouton) {
  bouton.disabled = true;
  bouton.textContent = "Classement…";
  try {
    const res = await fetch(`/api/anomalies/${id}/classer-facture`, { method: "POST" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.erreur || "Classement impossible.");
    }
    await Promise.all([chargerAnomalies(), chargerCockpit(), chargerFacturesFournisseurs()]);
  } catch (err) {
    bouton.disabled = false;
    bouton.textContent = "Classer en facture";
    alert(err.message);
  }
}
window.classerAnomalieFacture = classerAnomalieFacture;

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
    etatIndicateurs.anomalies = 0;
    mettreAJourBadges();
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
        <button type="button" class="ghost" onclick="classerAnomalieFacture('${a.id}', this)">Classer en facture</button>
        <button type="button" class="ghost" onclick="ignorerAnomalie('${a.id}')">Ignorer</button>
      </div>
    </div>`;
    })
    .join("");

  document.querySelectorAll(".case-anomalie").forEach((c) => c.addEventListener("change", majBarreSelection));
  majBarreSelection();
  etatIndicateurs.anomalies = anomalies.length;
  mettreAJourBadges();
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

// Morgane (assistante IA) : deplacee dans morgane.js (bulle flottante
// injectee sur chaque page, plus seulement sur ce tableau de bord) -
// rafraichirTout() reste exposee plus bas pour que ce script la detecte
// (window.rafraichirTout) apres une action deleguee a Morgane.

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

// --- Scanner un document papier (photo -> recadrage -> amelioration) -----
// Demande explicite de l'utilisateur : les photos de factures/tickets
// papier prises au telephone "sortent mal" une fois envoyees telles
// quelles. Recadrage (4 poignees ajustables sur les bords du document) puis
// amelioration du contraste directement dans le navigateur (aucune
// bibliotheque externe), avant envoi au serveur qui met le resultat en PDF
// et le fait rejoindre le meme circuit qu'un document recu par e-mail (voir
// documentsScannes.ts) : "Factures fournisseurs reçues" ci-dessous pour une
// facture, simple archive pour les autres types (meme regle que par e-mail).

let scanImage = null; // <img> en pleine resolution, une fois la photo choisie
let scanRect = null; // { x1, y1, x2, y2 } en pixels CSS du canvas source affiche
// Taille du canvas source au moment de la photo, memorisee a part :
// canvas.clientWidth/clientHeight retombent a 0 une fois la zone d'edition
// masquee (hidden -> display:none), ce qui cassait le retraitement lors
// d'une simple bascule noir et blanc / couleur apres le rognage (bug reel
// trouve en testant la fonctionnalite avec Playwright avant deploiement).
let scanCanvasSourceTaille = null; // { largeur, hauteur }
const MAX_LARGEUR_AFFICHAGE_SCAN = 420;
const MAX_DIMENSION_SCAN_TRAITEE = 1600;

function scanElementsPoignees() {
  const wrap = document.getElementById("scan-canvas-wrap");
  return wrap ? [...wrap.querySelectorAll(".scan-poignee")] : [];
}

function scanPositionnerPoignees() {
  if (!scanRect) return;
  for (const el of scanElementsPoignees()) {
    const coin = el.dataset.coin;
    const x = coin.endsWith("gauche") ? scanRect.x1 : scanRect.x2;
    const y = coin.startsWith("haut") ? scanRect.y1 : scanRect.y2;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }
}

function scanDeplacerPoignee(coin, x, y) {
  const canvas = document.getElementById("scan-canvas-source");
  const largeur = canvas.clientWidth;
  const hauteur = canvas.clientHeight;
  const marge = 24; // taille minimale du cadre, evite un rectangle degenere
  const xBorne = Math.max(0, Math.min(x, largeur));
  const yBorne = Math.max(0, Math.min(y, hauteur));
  if (coin.endsWith("gauche")) scanRect.x1 = Math.min(xBorne, scanRect.x2 - marge);
  else scanRect.x2 = Math.max(xBorne, scanRect.x1 + marge);
  if (coin.startsWith("haut")) scanRect.y1 = Math.min(yBorne, scanRect.y2 - marge);
  else scanRect.y2 = Math.max(yBorne, scanRect.y1 + marge);
  scanRect.x1 = Math.max(0, scanRect.x1);
  scanRect.y1 = Math.max(0, scanRect.y1);
  scanRect.x2 = Math.min(largeur, scanRect.x2);
  scanRect.y2 = Math.min(hauteur, scanRect.y2);
  scanPositionnerPoignees();
}

function scanInitPoignees() {
  for (const el of scanElementsPoignees()) {
    el.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const wrap = document.getElementById("scan-canvas-wrap");
      const rectWrap = wrap.getBoundingClientRect();
      const deplacer = (ev) => scanDeplacerPoignee(el.dataset.coin, ev.clientX - rectWrap.left, ev.clientY - rectWrap.top);
      const arreter = () => {
        window.removeEventListener("pointermove", deplacer);
        window.removeEventListener("pointerup", arreter);
      };
      window.addEventListener("pointermove", deplacer);
      window.addEventListener("pointerup", arreter);
    });
  }
}
scanInitPoignees();

/** Etire le contraste (percentile 1-99 de la luminance) et, en mode noir et blanc, accentue le texte sur fond clair — l'effet "document scanné" plutôt qu'une simple photo. */
function scanAmeliorerPixels(data, noirEtBlanc) {
  const histogramme = new Array(256).fill(0);
  let total = 0;
  for (let i = 0; i < data.length; i += 4) {
    const lum = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    histogramme[lum]++;
    total++;
  }
  const seuilBas = total * 0.01;
  const seuilHaut = total * 0.99;
  let cumul = 0;
  let p1 = 0;
  let p99 = 255;
  for (let v = 0; v < 256; v++) {
    cumul += histogramme[v];
    if (cumul >= seuilBas) {
      p1 = v;
      break;
    }
  }
  cumul = 0;
  for (let v = 255; v >= 0; v--) {
    cumul += histogramme[v];
    if (cumul >= total - seuilHaut) {
      p99 = v;
      break;
    }
  }
  const etendue = Math.max(p99 - p1, 1);
  const facteur = 255 / etendue;

  for (let i = 0; i < data.length; i += 4) {
    if (noirEtBlanc) {
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      let v = (lum - p1) * facteur;
      v = (v - 128) * 1.35 + 128; // accentue le contraste autour du milieu (texte plus net)
      v = Math.max(0, Math.min(255, v));
      data[i] = data[i + 1] = data[i + 2] = v;
    } else {
      data[i] = Math.max(0, Math.min(255, (data[i] - p1) * facteur));
      data[i + 1] = Math.max(0, Math.min(255, (data[i + 1] - p1) * facteur));
      data[i + 2] = Math.max(0, Math.min(255, (data[i + 2] - p1) * facteur));
    }
  }
}

function scanAppliquerRognageEtAmelioration() {
  if (!scanImage || !scanRect || !scanCanvasSourceTaille) return;
  const scaleX = scanImage.naturalWidth / scanCanvasSourceTaille.largeur;
  const scaleY = scanImage.naturalHeight / scanCanvasSourceTaille.hauteur;
  const sx = scanRect.x1 * scaleX;
  const sy = scanRect.y1 * scaleY;
  const sw = (scanRect.x2 - scanRect.x1) * scaleX;
  const sh = (scanRect.y2 - scanRect.y1) * scaleY;

  const echelleSortie = Math.min(1, MAX_DIMENSION_SCAN_TRAITEE / Math.max(sw, sh));
  const outW = Math.max(1, Math.round(sw * echelleSortie));
  const outH = Math.max(1, Math.round(sh * echelleSortie));

  const canvasResultat = document.getElementById("scan-canvas-resultat");
  canvasResultat.width = outW;
  canvasResultat.height = outH;
  const ctx = canvasResultat.getContext("2d");
  ctx.drawImage(scanImage, sx, sy, sw, sh, 0, 0, outW, outH);

  const noirEtBlanc = document.getElementById("scan-noir-blanc").checked;
  const imageData = ctx.getImageData(0, 0, outW, outH);
  scanAmeliorerPixels(imageData.data, noirEtBlanc);
  ctx.putImageData(imageData, 0, 0);

  document.getElementById("scan-zone-edition").hidden = true;
  document.getElementById("scan-zone-resultat").hidden = false;
}

// Ne touche jamais #scan-resultat-envoi : appelee juste apres y avoir
// affiche la confirmation d'enregistrement, qui doit rester visible
// jusqu'au prochain scan (bug reel trouve en testant avec Playwright -
// la reinitialisation effacait son propre message de succes).
function scanReinitialiser() {
  scanImage = null;
  scanRect = null;
  scanCanvasSourceTaille = null;
  document.getElementById("scan-fichier-photo").value = "";
  document.getElementById("scan-zone-edition").hidden = true;
  document.getElementById("scan-zone-resultat").hidden = true;
  const form = document.getElementById("form-scan-document");
  if (form) form.reset();
}

const champFichierScan = document.getElementById("scan-fichier-photo");
if (champFichierScan) {
  champFichierScan.addEventListener("change", () => {
    const fichier = champFichierScan.files[0];
    if (!fichier) return;
    document.getElementById("scan-resultat-envoi").innerHTML = "";
    const img = new Image();
    img.onload = () => {
      scanImage = img;
      const canvasSource = document.getElementById("scan-canvas-source");
      const ratio = img.naturalWidth / img.naturalHeight;
      const largeurAffichage = Math.min(MAX_LARGEUR_AFFICHAGE_SCAN, img.naturalWidth);
      canvasSource.width = largeurAffichage;
      canvasSource.height = Math.round(largeurAffichage / ratio);
      canvasSource.getContext("2d").drawImage(img, 0, 0, canvasSource.width, canvasSource.height);
      scanCanvasSourceTaille = { largeur: canvasSource.width, hauteur: canvasSource.height };

      // Cadre initial legerement en retrait des bords (le document occupe
      // rarement toute la photo) : l'utilisateur ajuste ensuite les 4
      // poignees sur les bords reels du document.
      const marge = 0.08;
      scanRect = {
        x1: canvasSource.width * marge,
        y1: canvasSource.height * marge,
        x2: canvasSource.width * (1 - marge),
        y2: canvasSource.height * (1 - marge),
      };
      scanPositionnerPoignees();

      document.getElementById("scan-zone-resultat").hidden = true;
      document.getElementById("scan-zone-edition").hidden = false;
      URL.revokeObjectURL(img.src);
    };
    img.src = URL.createObjectURL(fichier);
  });
}

const btnScanRogner = document.getElementById("scan-btn-rogner");
if (btnScanRogner) btnScanRogner.addEventListener("click", scanAppliquerRognageEtAmelioration);

const btnScanAnnuler = document.getElementById("scan-btn-annuler");
if (btnScanAnnuler) {
  btnScanAnnuler.addEventListener("click", () => {
    scanReinitialiser();
    document.getElementById("scan-resultat-envoi").innerHTML = "";
  });
}

const btnScanReprendre = document.getElementById("scan-btn-reprendre");
if (btnScanReprendre) {
  btnScanReprendre.addEventListener("click", () => {
    document.getElementById("scan-zone-resultat").hidden = true;
    document.getElementById("scan-zone-edition").hidden = false;
  });
}

const caseScanNoirEtBlanc = document.getElementById("scan-noir-blanc");
if (caseScanNoirEtBlanc) caseScanNoirEtBlanc.addEventListener("change", scanAppliquerRognageEtAmelioration);

const formScanDocument = document.getElementById("form-scan-document");
if (formScanDocument) {
  formScanDocument.addEventListener("submit", async (e) => {
    e.preventDefault();
    const resultatDiv = document.getElementById("scan-resultat-envoi");
    const bouton = formScanDocument.querySelector("button[type='submit']");
    const canvasResultat = document.getElementById("scan-canvas-resultat");

    bouton.disabled = true;
    resultatDiv.textContent = "Enregistrement…";
    try {
      const blob = await new Promise((resolve) => canvasResultat.toBlob(resolve, "image/jpeg", 0.9));
      if (!blob) throw new Error("Impossible de préparer l'image.");

      const donnees = new FormData();
      donnees.append("image", blob, "scan.jpg");
      donnees.append("type", document.getElementById("scan-type-document").value);
      donnees.append("fournisseurNom", document.getElementById("scan-fournisseur-nom").value);
      const numero = document.getElementById("scan-numero").value.trim();
      if (numero) donnees.append("numero", numero);

      const res = await fetch("/api/documents-fournisseurs/scan", { method: "POST", body: donnees });
      const d = await res.json();
      if (!res.ok) throw new Error(d.erreur || "Échec de l'enregistrement.");

      const suffixe =
        d.type !== "facture"
          ? "."
          : d.statutDext === "envoye"
            ? " — envoyée automatiquement à Dext."
            : " — visible ci-dessous, en attente d'envoi à Dext.";
      resultatDiv.innerHTML = `Document enregistré${suffixe}`;
      scanReinitialiser();
      await Promise.all([chargerFacturesFournisseurs(), chargerFournisseurs(), chargerCockpit()]);
    } catch (err) {
      resultatDiv.innerHTML = `<span class="badge badge-echec">Erreur</span> ${echapper(err.message)}`;
    } finally {
      bouton.disabled = false;
    }
  });
}

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

// Libelle "Mois Annee" (ex. "Octobre 2026"), meme format que le libelle
// Gmail cree par nomEtiquetteFacturesDuMois cote serveur (gmailSync.ts).
function libelleMoisAnnee(date) {
  const texte = new Date(date).toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
  return texte.charAt(0).toUpperCase() + texte.slice(1);
}

async function chargerFacturesFournisseurs() {
  const res = await fetch("/api/documents-fournisseurs?type=facture&statutDext=a_valider");
  const documents = await res.json();
  const liste = document.getElementById("liste-factures-fournisseurs");

  etatIndicateurs.facturesFournisseurs = documents.length;
  mettreAJourBadges();

  if (documents.length === 0) {
    liste.innerHTML = `<p class="liste-vide">Aucune facture fournisseur en attente d'envoi.</p>`;
    return;
  }

  // Regroupement automatique par mois de reception (demande explicite de
  // l'utilisateur : retrouver facilement "les factures d'octobre" sans
  // classement manuel) : chaque document rejoint son mois des sa reception,
  // sans aucune action de l'utilisateur. Les documents arrivent deja tries
  // du plus recent au plus ancien (voir /documents-fournisseurs), donc les
  // groupes apparaissent eux aussi du plus recent au plus ancien dans
  // l'ordre ou Map les rencontre.
  const groupes = new Map();
  for (const d of documents) {
    const cle = libelleMoisAnnee(d.dateReceptionMail || d.createdAt);
    if (!groupes.has(cle)) groupes.set(cle, []);
    groupes.get(cle).push(d);
  }

  liste.innerHTML = [...groupes.entries()]
    .map(
      ([mois, docs]) => `
    <div class="groupe-mois">
      <h3 class="groupe-mois-titre">${echapper(mois)} <span class="groupe-mois-compte">${docs.length}</span></h3>
      ${docs
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
        .join("")}
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

  // Suggestions pour le champ "Fournisseur" du scanner de documents papier
  // (voir plus haut) : evite de retaper un nom deja connu, sans empecher
  // d'en saisir un nouveau.
  const datalistScan = document.getElementById("scan-liste-fournisseurs");
  if (datalistScan) datalistScan.innerHTML = fournisseurs.map((f) => `<option value="${echapper(f.nom)}"></option>`).join("");

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

  etatIndicateurs.relances = relances.length;
  mettreAJourBadges();

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
  await Promise.all([chargerCockpit(), chargerGraphiqueCa(), chargerImports(), chargerFacturesImpayees(), chargerStatutGmail(), chargerStatutStripe(), chargerStatutSynec(), chargerStatutGoogleAds(), chargerPropositionsAds(), chargerStatutReseauxSociaux(), chargerPropositionsReseauxSociaux(), chargerAnomalies(), chargerRelances(), chargerFacturesFournisseurs(), chargerFournisseurs(), chargerDecisions(), chargerJournal()]);
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

// Rafraichissement automatique ("plus dynamique", demande explicite) : toutes
// les 2 minutes, uniquement si l'onglet du navigateur est au premier plan -
// inutile de solliciter le serveur pendant que la page est en arriere-plan,
// et surtout d'interrompre une saisie en cours dans le formulaire Morgane ou
// la selection d'anomalies (rafraichirTout() ne touche a aucun champ de
// formulaire, uniquement a des listes en lecture).
setInterval(() => {
  if (document.visibilityState === "visible") rafraichirTout();
}, 120000);
