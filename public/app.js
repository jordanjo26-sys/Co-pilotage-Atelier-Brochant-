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
  // Chaque probleme porte desormais son propre onglet cible (le bouton
  // "Voir" pointait toujours vers "systeme", meme pour Stripe/Synec deja
  // gere dans "tresorerie" - incoherence reprise en deplacant Gmail -> Dext
  // vers l'onglet Fournisseurs, sa vraie place).
  const problemes = [];
  if (etatIndicateurs.gmailMotif) problemes.push({ message: `Gmail : ${etatIndicateurs.gmailMotif}`, onglet: "fournisseurs" });
  if (etatIndicateurs.stripeMotif) problemes.push({ message: `Stripe : ${etatIndicateurs.stripeMotif}`, onglet: "tresorerie" });
  if (etatIndicateurs.synecMotif) problemes.push({ message: `Synec : ${etatIndicateurs.synecMotif}`, onglet: "tresorerie" });
  if (problemes.length === 0) {
    bandeau.hidden = true;
    bandeau.innerHTML = "";
    return;
  }
  bandeau.hidden = false;
  bandeau.innerHTML = `<span>⚠ ${problemes.map((p) => echapper(p.message)).join(" · ")}</span><button type="button" class="ghost" onclick="basculerOnglet('${problemes[0].onglet}')">Voir</button>`;
}

function mettreAJourActionsRequises() {
  const conteneur = document.getElementById("actions-requises");
  if (!conteneur) return;
  const actions = [];
  if (etatIndicateurs.gmailMotif) actions.push({ libelle: `Reconnecter Gmail (${etatIndicateurs.gmailMotif})`, onglet: "fournisseurs" });
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
  // Gmail -> Dext a rejoint l'onglet Fournisseurs (sa vraie place, voir
  // plus haut) : son indicateur de panne rejoint donc ce badge plutot que
  // celui de "systeme", meme principe que Stripe/Synec regroupes sur le
  // badge Tresorerie ci-dessous.
  definirBadge("fournisseurs", etatIndicateurs.anomalies + (etatIndicateurs.gmailMotif ? 1 : 0));
  definirBadge("factures", etatIndicateurs.relances + etatIndicateurs.facturesFournisseurs);
  definirBadge("tresorerie", etatIndicateurs.aValiderImports + (etatIndicateurs.stripeMotif ? 1 : 0) + (etatIndicateurs.synecMotif ? 1 : 0));
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
// y defile - utile quand deux cartes de l'accueil visent le meme onglet
// mais pas la meme section (ex. Reseaux sociaux -> #section-reseaux-sociaux
// alors que la carte "Reseaux sociaux" de l'accueil vise directement cet
// onglet). Google Ads et Systeme ont desormais chacun leur propre onglet
// (#google-ads / #systeme), cas qui declenchait ce mecanisme avant d'etre
// separes (signale par l'utilisateur : "Google Ads" atterrissait dans
// "Systeme", jamais sur son propre contenu).
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

// Classe de bordure par statut - demande explicite de l'utilisateur :
// encadrement vert + coche pour un rapprochement valide, orange pour une
// correspondance incertaine ("a_verifier", desormais reellement persiste
// par le moteur - voir rapprochementBancaire.ts). Les classes .badge-* elles-
// memes restent inchangees (deja correctement colorees, partagees avec
// d'autres modules) : seule la bordure de ligne est nouvelle.
function classeLigneRapprochement(statut) {
  if (statut === "rapproche") return "rapprochement-ligne-ok";
  if (statut === "a_verifier") return "rapprochement-ligne-attention";
  return "";
}

async function chargerMouvementsBancaires() {
  const res = await fetch("/api/mouvements-bancaires");
  const mouvements = await res.json();
  const tbody = document.querySelector("#table-mouvements-bancaires tbody");
  tbody.innerHTML = mouvements
    .map(
      (m) => `
    <tr class="${classeLigneRapprochement(m.rapprochementStatut)}">
      <td>${fmtDate(m.date)}</td>
      <td>${echapper(m.libelle)}</td>
      <td>${m.debit > 0 ? fmtMontant(m.debit) : ""}</td>
      <td>${m.credit > 0 ? fmtMontant(m.credit) : ""}</td>
      <td><span class="badge badge-${m.rapprochementStatut}">${m.rapprochementStatut === "rapproche" ? "✓ " : ""}${echapper(m.rapprochementStatut.replace(/_/g, " "))}</span></td>
      <td><button type="button" class="ghost bouton-lien" onclick="basculerDetailMouvement('${m.id}', this)">Détail</button></td>
    </tr>
    <tr class="rapprochement-detail-ligne" data-detail-pour="${m.id}" hidden>
      <td colspan="6"><div class="rapprochement-detail"></div></td>
    </tr>`
    )
    .join("");
}

/**
 * Detail depliable d'un mouvement (facture(s) liee(s), historique, et selon
 * son statut un outil de rattachement manuel ou un bouton d'annulation) -
 * charge a la demande (pas de pre-chargement pour chaque ligne : la table
 * peut compter plusieurs milliers de mouvements).
 */
async function basculerDetailMouvement(id, bouton) {
  const ligneDetail = document.querySelector(`tr.rapprochement-detail-ligne[data-detail-pour="${id}"]`);
  if (!ligneDetail) return;
  if (!ligneDetail.hidden) {
    ligneDetail.hidden = true;
    bouton.textContent = "Détail";
    return;
  }
  bouton.textContent = "Masquer";
  ligneDetail.hidden = false;
  await rafraichirDetailMouvement(id);
}

async function rafraichirDetailMouvement(id) {
  const ligneDetail = document.querySelector(`tr.rapprochement-detail-ligne[data-detail-pour="${id}"]`);
  const conteneur = ligneDetail?.querySelector(".rapprochement-detail");
  if (!conteneur) return;
  // chargerMouvementsBancaires (appelee juste avant par les actions
  // valider/annuler ci-dessous) reconstruit toute la table, donc une
  // ligne de detail precedemment ouverte revient fermee par defaut - on la
  // rouvre ici pour que l'utilisateur voie immediatement le resultat de son
  // action, sans avoir a recliquer sur "Detail".
  ligneDetail.hidden = false;
  const boutonDetail = document.querySelector(`tr[class] button[onclick*="basculerDetailMouvement('${id}'"]`);
  if (boutonDetail) boutonDetail.textContent = "Masquer";
  conteneur.innerHTML = `<p class="aide-inline">Chargement…</p>`;
  try {
    const res = await fetch(`/api/mouvements-bancaires/${id}/detail`);
    const detail = await res.json();
    if (!res.ok) throw new Error(detail.erreur || "Chargement impossible.");

    let candidats = { archives: [], documents: [] };
    if (detail.mouvement.rapprochementStatut !== "rapproche") {
      const resCandidats = await fetch(`/api/mouvements-bancaires/${id}/candidats`);
      if (resCandidats.ok) candidats = await resCandidats.json();
    }

    conteneur.innerHTML = construireDetailMouvementHtml(detail, candidats);
    attacherActionsDetailMouvement(conteneur, id, detail);
  } catch (err) {
    conteneur.innerHTML = `<p class="aide-inline">Erreur : ${echapper(err.message)}</p>`;
  }
}

function libelleCible(cible) {
  if (!cible.detail) return `${cible.cibleType} ${cible.cibleId}`;
  if (cible.cibleType === "archive_comptable") {
    return `${echapper(cible.detail.fournisseurNom || "Fournisseur non identifié")} — ${echapper(cible.detail.fichierNom)}`;
  }
  return `${echapper(cible.detail.fournisseur?.nom || cible.detail.gmailExpediteur || "Fournisseur non identifié")} — ${echapper(cible.detail.fichierNom || cible.cibleId)}`;
}

function construireDetailMouvementHtml(detail, candidats) {
  const { mouvement, cibles, historique } = detail;
  const cibleLignes = cibles.length
    ? cibles
        .map(
          (c) => `
      <div class="rapprochement-detail-cible">
        <span>${libelleCible(c)}</span>
        <span class="badge badge-ok">${fmtMontant(c.montantAffecte)}</span>
        <span class="aide-inline">${c.origine === "manuel" ? "rattaché manuellement" : "automatique"}</span>
      </div>`
        )
        .join("")
    : `<p class="aide-inline">Aucune facture rattachée pour le moment.</p>`;

  const historiqueLignes = historique.length
    ? `<ul class="rapprochement-historique">${historique
        .map((h) => `<li>${fmtDate(h.createdAt)} — ${echapper(h.action.replace(/_/g, " "))}${h.auteur ? ` (${echapper(h.auteur)})` : ""}</li>`)
        .join("")}</ul>`
    : `<p class="aide-inline">Aucun historique pour le moment.</p>`;

  let actionHtml = "";
  if (mouvement.rapprochementStatut === "rapproche") {
    actionHtml = `<button type="button" class="ghost" data-action="annuler">Annuler ce rapprochement</button>`;
  } else {
    const tousLesCandidats = [
      ...candidats.archives.map((a) => ({ type: "archive_comptable", id: a.id, montant: a.montantTTC, libelle: `${a.fournisseurNom || "Fournisseur non identifié"} — ${a.fichierNom} (${fmtDate(a.dateFacture)})` })),
      ...candidats.documents.map((d) => ({ type: "document_fournisseur", id: d.id, montant: d.montantTTC, libelle: `${d.fichierNom || d.id} (${fmtDate(d.date)})` })),
    ];
    actionHtml = `
      <div class="rapprochement-picker">
        <p class="aide-inline">Rattacher manuellement une ou plusieurs factures (montant modifiable pour un règlement partiel) :</p>
        ${
          tousLesCandidats.length === 0
            ? `<p class="aide-inline">Aucune facture non rapprochée dans la fenêtre de dates habituelle.</p>`
            : tousLesCandidats
                .map(
                  (c) => `
          <label class="rapprochement-picker-ligne">
            <input type="checkbox" data-cible-type="${c.type}" data-cible-id="${c.id}" />
            ${echapper(c.libelle)}
            <input type="number" step="0.01" min="0" class="rapprochement-picker-montant" value="${c.montant}" />
          </label>`
                )
                .join("")
        }
        <button type="button" class="ghost" data-action="valider">Valider le rattachement</button>
      </div>`;
  }

  return `
    <div class="rapprochement-detail-section">
      <h4>Factures rattachées</h4>
      ${cibleLignes}
    </div>
    <div class="rapprochement-detail-section">
      <h4>Historique</h4>
      ${historiqueLignes}
    </div>
    <div class="rapprochement-detail-section">
      ${actionHtml}
    </div>`;
}

function attacherActionsDetailMouvement(conteneur, id, detail) {
  const boutonAnnuler = conteneur.querySelector('[data-action="annuler"]');
  if (boutonAnnuler) {
    boutonAnnuler.addEventListener("click", async () => {
      if (!confirm("Annuler ce rapprochement ? La ou les factures redeviendront disponibles pour un nouveau rattachement.")) return;
      boutonAnnuler.disabled = true;
      try {
        const res = await fetch(`/api/mouvements-bancaires/${id}/annuler`, { method: "POST" });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.erreur || "Annulation impossible.");
        }
        await chargerMouvementsBancaires();
        await chargerSuiviMensuel();
        await rafraichirDetailMouvement(id);
      } catch (err) {
        alert(err.message);
        boutonAnnuler.disabled = false;
      }
    });
  }

  const boutonValider = conteneur.querySelector('[data-action="valider"]');
  if (boutonValider) {
    boutonValider.addEventListener("click", async () => {
      const lignes = [...conteneur.querySelectorAll(".rapprochement-picker-ligne")];
      const cibles = lignes
        .filter((ligne) => ligne.querySelector("input[type=checkbox]").checked)
        .map((ligne) => ({
          type: ligne.querySelector("input[type=checkbox]").dataset.cibleType,
          id: ligne.querySelector("input[type=checkbox]").dataset.cibleId,
          montantAffecte: Number(ligne.querySelector(".rapprochement-picker-montant").value),
        }));
      if (cibles.length === 0) {
        alert("Cochez au moins une facture à rattacher.");
        return;
      }
      boutonValider.disabled = true;
      try {
        const res = await fetch(`/api/mouvements-bancaires/${id}/valider`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cibles }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.erreur || "Validation impossible.");
        await chargerMouvementsBancaires();
        await chargerSuiviMensuel();
        await rafraichirDetailMouvement(id);
      } catch (err) {
        alert(err.message);
        boutonValider.disabled = false;
      }
    });
  }
  void detail;
}

document.getElementById("btn-relancer-rapprochement").addEventListener("click", async (e) => {
  const bouton = e.currentTarget;
  const resultatDiv = document.getElementById("resultat-rapprochement");
  bouton.disabled = true;
  resultatDiv.textContent = "Rapprochement en cours…";
  try {
    const res = await fetch("/api/rapprochement-bancaire/executer", { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.erreur || "Échec du rapprochement.");
    resultatDiv.innerHTML = `
      Payouts Stripe : ${data.nbRapproches} rapproché(s), ${data.nbAmbigus} ambigu(s), ${data.nbSansCorrespondance} sans correspondance.<br>
      Factures fournisseurs : ${data.nbRapprochesDocuments} rapprochée(s), ${data.nbAmbigusDocuments} ambiguë(s), ${data.nbSansCorrespondanceDocuments} sans correspondance.<br>
      Factures archivées hors Dext (EDF, Bouygues…) : ${data.nbRapprochesArchives} rapprochée(s), ${data.nbAmbigusArchives} ambiguë(s), ${data.nbSansCorrespondanceArchives} sans correspondance.<br>
      Règlements multi-factures/partiels : ${data.nbRapprochesMultiFactures} rapproché(s), ${data.nbAmbigusMultiFactures} ambigu(s).<br>
      Règlements clients en carte (remises CB) : ${data.nbRapprochesRemisesCb} rapprochée(s), ${data.nbAmbigusRemisesCb} ambiguë(s), ${data.nbSansCorrespondanceRemisesCb} sans correspondance.<br>
      Règlements clients en chèque (remises chèques) : ${data.nbRapprochesRemisesCheques} rapprochée(s), ${data.nbAmbigusRemisesCheques} ambiguë(s), ${data.nbSansCorrespondanceRemisesCheques} sans correspondance.<br>
      Virements clients directs : ${data.nbRapprochesVirementsClients} rapproché(s), ${data.nbAmbigusVirementsClients} ambigu(s), ${data.nbSansCorrespondanceVirementsClients} sans correspondance.
    `;
    await chargerMouvementsBancaires();
    await chargerSuiviMensuel();
  } catch (err) {
    resultatDiv.innerHTML = `<span class="badge badge-echec">Erreur</span> ${echapper(err.message)}`;
  } finally {
    bouton.disabled = false;
  }
});

// --- Suivi mensuel du rapprochement bancaire -------------------------------
//
// Nouvel onglet (demande explicite de l'utilisateur) : un mois passe en
// "Termine et valide" uniquement par un geste manuel explicite (voir
// suiviMensuel.ts), jamais deduit automatiquement d'un taux de
// rapprochement de 100%.

const LIBELLES_STATUT_MOIS = { en_cours: "En cours", a_verifier: "À vérifier", termine_valide: "Terminé et validé" };

async function chargerSuiviMensuel() {
  const conteneur = document.getElementById("suivi-mensuel-liste");
  if (!conteneur) return;
  try {
    const res = await fetch("/api/suivi-mensuel");
    const statuts = await res.json();
    if (!res.ok) throw new Error(statuts.erreur || "Chargement impossible.");

    definirBadge("suivi-mensuel", statuts.filter((s) => s.statut === "a_verifier").length);

    conteneur.innerHTML = statuts.length
      ? statuts.map((s) => construireCarteSuiviMensuel(s)).join("")
      : `<p class="liste-vide">Aucun mouvement bancaire importé pour le moment.</p>`;

    conteneur.querySelectorAll("[data-valider-periode]").forEach((bouton) => {
      bouton.addEventListener("click", () => validerMoisDepuisUI(bouton.dataset.validerPeriode));
    });
    conteneur.querySelectorAll("[data-invalider-periode]").forEach((bouton) => {
      bouton.addEventListener("click", () => invaliderMoisDepuisUI(bouton.dataset.invaliderPeriode));
    });
  } catch (err) {
    conteneur.innerHTML = `<p class="aide-inline">Erreur : ${echapper(err.message)}</p>`;
  }
}

function construireCarteSuiviMensuel(s) {
  const libelleMois = libelleMoisAnnee(`${s.periode}-01`);
  const coche = s.statut === "termine_valide" ? "✓ " : "";
  const driftHtml =
    s.driftDetecte
      ? `<span class="suivi-mensuel-drift">⚠ Des mouvements ont changé depuis la validation.</span> <button type="button" class="ghost bouton-lien" data-invalider-periode="${s.periode}">Dé-valider ce mois</button>`
      : "";
  const boutonValider =
    s.statut !== "termine_valide"
      ? `<button type="button" class="ghost" data-valider-periode="${s.periode}">Je valide ce mois</button>`
      : "";

  return `
    <div class="suivi-mensuel-carte">
      <span class="suivi-mensuel-mois">${echapper(libelleMois)}</span>
      <span class="suivi-mensuel-compteurs">${s.nbRapproches}/${s.nbMouvements} rapproché(s)${s.nbAVerifier > 0 ? `, ${s.nbAVerifier} à vérifier` : ""}</span>
      <span class="badge suivi-mensuel-statut-${s.statut}">${coche}${echapper(LIBELLES_STATUT_MOIS[s.statut] || s.statut)}</span>
      ${driftHtml}
      ${boutonValider}
    </div>`;
}

async function validerMoisDepuisUI(periode) {
  // Avertissement renforce (jamais de blocage dur) si des mouvements
  // restent "a verifier" - la decision finale reste toujours celle de
  // l'utilisateur, jamais celle du systeme (demande explicite).
  const statuts = await (await fetch("/api/suivi-mensuel")).json();
  const mois = statuts.find((s) => s.periode === periode);
  if (mois && mois.nbAVerifier > 0) {
    if (!confirm(`${mois.nbAVerifier} mouvement(s) de ce mois restent "à vérifier". Valider quand même ce mois comme terminé ?`)) return;
  } else if (!confirm("Valider ce mois comme terminé et contrôlé ?")) {
    return;
  }
  try {
    const res = await fetch(`/api/suivi-mensuel/${periode}/valider`, { method: "POST" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.erreur || "Validation impossible.");
    }
    await chargerSuiviMensuel();
  } catch (err) {
    alert(err.message);
  }
}
window.validerMoisDepuisUI = validerMoisDepuisUI;

async function invaliderMoisDepuisUI(periode) {
  if (!confirm("Dé-valider ce mois ? Il repassera en \"En cours\" jusqu'à une nouvelle validation.")) return;
  try {
    const res = await fetch(`/api/suivi-mensuel/${periode}/invalider`, { method: "POST" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.erreur || "Dé-validation impossible.");
    }
    await chargerSuiviMensuel();
  } catch (err) {
    alert(err.message);
  }
}
window.invaliderMoisDepuisUI = invaliderMoisDepuisUI;

// Liste brute conservee en memoire : les filtres (date d'echeance, montant,
// client, statut - voir afficherFacturesImpayeesFiltrees) s'appliquent cote
// client sur les donnees deja chargees, sans redemander le serveur a chaque
// changement. Toujours impayee+partiellement_payee (jamais filtree par
// statut cote serveur) : le resume/la courbe ci-dessous portent sur
// l'ensemble reel, le filtre "Statut" ne fait que restreindre l'affichage
// du tableau (demande explicite de l'utilisateur, novembre 2026 : "petite
// courbe avec les montants... et le nombre de factures" plutot qu'un pavé
// brut, avec un filtre par periode/montant/client en plus).
let facturesImpayeesBrutes = [];

const LIBELLE_STATUT_FACTURE = { impayee: "Impayée", partiellement_payee: "Partiellement payée" };

// Sans aucun filtre actif, le tableau n'affiche que les N factures les plus
// anciennes (deja triees par date d'emission croissante cote serveur,
// donc les plus urgentes a relancer) : demande explicite de l'utilisateur
// ("restreindre ce pavé à 2 ou 3 factures pour que l'affichage soit plus
// ergonomique"), les filtres ci-dessus servant a aller chercher les autres
// plutot qu'un bouton "voir tout".
const LIMITE_FACTURES_SANS_FILTRE = 3;

function afficherFacturesImpayeesFiltrees() {
  const dateDebut = document.getElementById("filtre-facture-date-debut").value;
  const dateFin = document.getElementById("filtre-facture-date-fin").value;
  const montantMinBrut = document.getElementById("filtre-facture-montant-min").value;
  const montantMaxBrut = document.getElementById("filtre-facture-montant-max").value;
  const montantMin = montantMinBrut === "" ? null : Number(montantMinBrut);
  const montantMax = montantMaxBrut === "" ? null : Number(montantMaxBrut);
  const clientRecherche = document.getElementById("filtre-facture-client").value.trim().toLowerCase();
  const statutFiltre = document.getElementById("filtre-facture-statut").value;
  const filtreActif = Boolean(dateDebut || dateFin || montantMin !== null || montantMax !== null || clientRecherche || statutFiltre);

  // Filtre par date d'EMISSION, pas d'echeance : verifie en production
  // qu'aucune facture impayee reelle n'a de date d'echeance renseignee
  // (Synec n'exporte pas cette donnee) - un filtre sur l'echeance
  // n'aurait jamais rien retenu (voir getImpayesSerieTemporelle cote
  // serveur, meme constat).
  const factures = facturesImpayeesBrutes.filter((f) => {
    const emission = f.dateEmission ? f.dateEmission.slice(0, 10) : null;
    if (dateDebut && (!emission || emission < dateDebut)) return false;
    if (dateFin && (!emission || emission > dateFin)) return false;
    if (montantMin !== null && !(f.montantTTC >= montantMin)) return false;
    if (montantMax !== null && !(f.montantTTC <= montantMax)) return false;
    if (clientRecherche && !(f.clientNom || "").toLowerCase().includes(clientRecherche)) return false;
    if (statutFiltre && f.statut !== statutFiltre) return false;
    return true;
  });
  const facturesAffichees = filtreActif ? factures : factures.slice(0, LIMITE_FACTURES_SANS_FILTRE);

  const tbody = document.querySelector("#table-factures tbody");
  tbody.innerHTML =
    facturesAffichees
      .map(
        (f) => `
    <tr>
      <td>${echapper(f.reference)}</td>
      <td>${echapper(f.clientNom)}</td>
      <td>${fmtDate(f.dateEmission)}</td>
      <td>${fmtMontant(f.montantTTC)}</td>
      <td>${echapper(LIBELLE_STATUT_FACTURE[f.statut] || f.statut)}</td>
    </tr>`
      )
      .join("") || `<tr><td colspan="5" class="liste-vide">Aucune facture impayée.</td></tr>`;

  const compteEl = document.getElementById("compte-factures-filtrees");
  compteEl.textContent =
    facturesAffichees.length === facturesImpayeesBrutes.length
      ? `${facturesImpayeesBrutes.length} facture(s)`
      : filtreActif
        ? `${factures.length} sur ${facturesImpayeesBrutes.length} facture(s)`
        : `${facturesAffichees.length} sur ${facturesImpayeesBrutes.length} facture(s) — filtre pour voir les autres`;
}

const ID_FILTRES_FACTURES_IMPAYEES = [
  "filtre-facture-date-debut",
  "filtre-facture-date-fin",
  "filtre-facture-montant-min",
  "filtre-facture-montant-max",
  "filtre-facture-client",
  "filtre-facture-statut",
];

async function chargerGraphiqueImpayes() {
  const res = await fetch("/api/dashboard/impayes-serie");
  const points = await res.json();
  // Meme fonction de dessin que le graphique du chiffre d'affaires (voir
  // dessinerGraphiqueCa plus haut) : forme de donnees identique
  // ({periode, montant}), presentation coherente dans toute l'appli.
  dessinerGraphiqueCa(document.getElementById("graphique-impayes"), points, "mois");
}

async function chargerFacturesImpayees() {
  const res = await fetch("/api/factures?statut=impayee,partiellement_payee");
  facturesImpayeesBrutes = await res.json();
  afficherFacturesImpayeesFiltrees();
  await chargerGraphiqueImpayes();

  const montantTotal = facturesImpayeesBrutes.reduce((somme, f) => somme + Math.max(f.montantTTC - (f.montantRegle || 0), 0), 0);
  document.getElementById("resume-factures-impayees").innerHTML = `
    <div class="tuile tuile-impayes${facturesImpayeesBrutes.length > 0 ? " alerte" : ""}">
      <div class="tuile-icone">${ICONES_TUILE.impayes}</div>
      <div class="valeur">${facturesImpayeesBrutes.length}</div>
      <div class="label">facture(s) · ${fmtMontant(montantTotal)}</div>
    </div>`;

  // Ecouteurs attaches une seule fois (chargerFacturesImpayees n'est
  // appelee qu'au chargement initial de la page) : re-filtre a la volee a
  // chaque changement, sans bouton "Appliquer" a cliquer.
  if (!document.getElementById("filtre-facture-date-debut").dataset.initialise) {
    ID_FILTRES_FACTURES_IMPAYEES.forEach((id) => {
      document.getElementById(id).addEventListener("input", afficherFacturesImpayeesFiltrees);
    });
    document.getElementById("btn-reinitialiser-filtres-factures").addEventListener("click", () => {
      ID_FILTRES_FACTURES_IMPAYEES.forEach((id) => {
        document.getElementById(id).value = "";
      });
      afficherFacturesImpayeesFiltrees();
    });
    document.getElementById("filtre-facture-date-debut").dataset.initialise = "1";
  }
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
    <details class="fournisseur-documents">
      <summary>Synchronisation historique (au-delà des 14 derniers jours)</summary>
      <p class="aide-inline">La synchronisation automatique ne regarde que les 14 derniers jours (fenêtre volontairement limitée, une fenêtre plus large a déjà provoqué un dépassement du quota Gmail). Pour retrouver des factures plus anciennes et les envoyer vers Dext, choisis une date de départ — ça peut prendre du temps sur une longue période, c'est normal.</p>
      <div class="ligne-boutons" style="margin: 10px 0; flex-wrap: wrap; align-items: center; gap: 8px;">
        <label class="aide-inline">Depuis le <input type="date" id="gmail-sync-historique-depuis" /></label>
        <button type="button" id="btn-sync-gmail-historique" class="ghost">Synchroniser depuis cette date</button>
      </div>
      <div id="resultat-sync-gmail-historique"></div>
    </details>
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

  document.getElementById("btn-sync-gmail-historique").addEventListener("click", async () => {
    const depuis = document.getElementById("gmail-sync-historique-depuis").value;
    const resultatDiv = document.getElementById("resultat-sync-gmail-historique");
    if (!depuis) {
      resultatDiv.innerHTML = `<span class="badge badge-echec">Choisis d'abord une date</span>`;
      return;
    }
    resultatDiv.textContent = "Synchronisation historique en cours (peut prendre plusieurs minutes sur une longue période)…";
    try {
      const r = await fetch("/api/gmail/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ depuis }),
      });
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
      <summary>Synchronisation historique (au-delà des 30 derniers jours)</summary>
      <p class="aide-inline">La synchronisation automatique ne regarde que les 30 derniers jours : un paiement plus ancien que ça n'a jamais été récupéré s'il datait d'avant la mise en route de Stripe sur cette application. Pour le faire venir, choisis une date de départ et synchronise une fois.</p>
      <div class="ligne-boutons" style="margin: 10px 0; flex-wrap: wrap; align-items: center; gap: 8px;">
        <label class="aide-inline">Depuis le <input type="date" id="stripe-sync-historique-depuis" /></label>
        <button type="button" id="btn-sync-stripe-historique" class="ghost">Synchroniser depuis cette date</button>
      </div>
      <div id="resultat-sync-stripe-historique"></div>
    </details>
    <details class="fournisseur-documents">
      <summary>Voir les paiements captés</summary>
      <div class="ligne-boutons" style="margin: 10px 0; flex-wrap: wrap; align-items: center; gap: 8px;">
        <label class="aide-inline">Du <input type="date" id="paiements-stripe-depuis" /></label>
        <label class="aide-inline">au <input type="date" id="paiements-stripe-jusqua" /></label>
        <button type="button" id="btn-filtrer-paiements-stripe" class="ghost">Filtrer</button>
        <button type="button" id="btn-reinitialiser-paiements-stripe" class="ghost">Réinitialiser</button>
        <a class="ghost bouton-lien" id="lien-export-paiements-stripe" href="/api/stripe/paiements/export-pdf">Exporter en PDF</a>
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

  document.getElementById("btn-sync-stripe-historique").addEventListener("click", async () => {
    const depuis = document.getElementById("stripe-sync-historique-depuis").value;
    const resultatDiv = document.getElementById("resultat-sync-stripe-historique");
    if (!depuis) {
      resultatDiv.innerHTML = `<span class="badge badge-echec">Choisis d'abord une date</span>`;
      return;
    }
    resultatDiv.textContent = "Synchronisation historique en cours (peut prendre un moment selon la période)…";
    try {
      const r = await fetch("/api/stripe/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ depuis }),
      });
      const d = await r.json();
      if (!r.ok) {
        resultatDiv.innerHTML = `<span class="badge badge-echec">Erreur</span> ${echapper(d.erreur)}`;
        return;
      }
      resultatDiv.innerHTML =
        `${d.payoutsNouveaux} payout(s) nouveau(x), ${d.paiementsNouveaux} paiement(s) nouveau(x), ${d.erreurs.length} erreur(s).` +
        (d.erreurs.length > 0 ? `<br/><span class="anomalie-meta">${d.erreurs.map(echapper).join("<br/>")}</span>` : "");
      await rafraichirTout();
      await chargerPaiementsStripe();
    } catch (err) {
      resultatDiv.innerHTML = `<span class="badge badge-echec">Erreur</span> ${echapper(err.message)}`;
    }
  });

  document.getElementById("btn-filtrer-paiements-stripe").addEventListener("click", () => chargerPaiementsStripe());
  document.getElementById("btn-reinitialiser-paiements-stripe").addEventListener("click", () => {
    document.getElementById("paiements-stripe-depuis").value = "";
    document.getElementById("paiements-stripe-jusqua").value = "";
    chargerPaiementsStripe();
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
  ajouter_groupe_annonces: "Ajouter un groupe d'annonces",
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
                                    : p.type === "ajouter_groupe_annonces"
                                      ? `<div class="anomalie-meta"><strong>Nouveau groupe</strong> : ${echapper(p.nomGroupe || "—")} · URL : ${echapper(p.urlFinale || "—")}</div>
                                         <div class="anomalie-meta"><strong>Titres</strong> : ${(p.titres || []).map(echapper).join(" · ")}</div>
                                         <div class="anomalie-meta"><strong>Descriptions</strong> : ${(p.descriptions || []).map(echapper).join(" · ")}</div>
                                         <div class="anomalie-meta"><strong>Mots-clés</strong> : ${(p.motsCles || []).map(echapper).join(", ") || "—"}${p.typeCorrespondance ? ` (${echapper(p.typeCorrespondance)})` : ""}</div>
                                         <div class="anomalie-meta">Annonce créée <strong>en pause</strong> : à activer toi-même, même si la campagne est déjà active.</div>`
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

// Phase fondations (lecture seule) : confirme seulement que la connexion
// Google (meme compte que Gmail/Ads, nouveau scope business.manage) donne
// bien acces a au moins une fiche. Deux conditions independantes du scope
// peuvent faire echouer cet appel meme avec une connexion Google active :
// l'acces API Business Profile pas encore approuve par Google, et/ou la
// fiche pas encore rattachee (gestionnaire/proprietaire) au compte connecte
// - voir googleBusinessProfile.ts, message d'erreur affiche tel quel.
async function chargerStatutGoogleBusiness() {
  const div = document.getElementById("google-business-statut");
  if (!div) return;
  try {
    const res = await fetch("/api/google-business/connexion");
    const data = await res.json();
    if (data.connecte) {
      const noms = (data.comptes || []).map((c) => c.nomAffiche || c.nom).join(", ") || "aucun compte visible";
      div.innerHTML = `<p class="gmail-connecte"><span class="statut-dot">Connecté</span> — ${echapper(noms)}</p>`;
    } else {
      div.innerHTML = `<p class="statut-dot off">Non disponible : ${echapper(data.erreur || "connexion non etablie")}</p>`;
    }
  } catch (err) {
    div.innerHTML = `<p class="statut-dot off">Erreur : ${echapper(err.message)}</p>`;
  }
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

// Module PagesJaunes/Solocal Manager, mode "assiste" DEFINITIF (pas une
// phase transitoire) : Solocal Manager n'a pas d'API et son SSO bloque les
// navigateurs automatises (verifie en conditions reelles, Cloudflare) - il
// n'y a donc ici ni "appliquee" ni "echec" comme pour Reseaux sociaux, mais
// un statut "publiee" marque par l'utilisateur lui-meme une fois l'actualite
// collee a la main dans Solocal Manager.
const BADGE_STATUT_PAGESJAUNES = {
  en_attente: "badge-partiel",
  acceptee: "badge-partiel",
  publiee: "badge-ok",
  refusee: "badge-doublon_fichier",
};
const LIBELLE_STATUT_PAGESJAUNES = {
  en_attente: "En attente",
  acceptee: "Acceptée — à coller dans Solocal Manager",
  publiee: "Publiée",
  refusee: "Refusée",
};

let cheminMediaPagesJaunes = null;

const champFichierPagesJaunes = document.getElementById("fichier-media-pagesjaunes");
if (champFichierPagesJaunes) {
  champFichierPagesJaunes.addEventListener("change", async () => {
    const apercu = document.getElementById("apercu-media-pagesjaunes");
    const fichier = champFichierPagesJaunes.files[0];
    cheminMediaPagesJaunes = null;
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
      cheminMediaPagesJaunes = d.chemin;
      apercu.innerHTML = `<img src="/${echapper(d.chemin)}" alt="Aperçu" style="max-width:220px;max-height:220px;border-radius:8px;margin-top:6px" />`;
    } catch (err) {
      apercu.innerHTML = `<span class="badge badge-echec">Erreur</span> ${echapper(err.message)}`;
    }
  });
}

const boutonGenererPhotoPagesJaunes = document.getElementById("bouton-generer-photo-pagesjaunes");
if (boutonGenererPhotoPagesJaunes) {
  boutonGenererPhotoPagesJaunes.addEventListener("click", async () => {
    const description = document.getElementById("description-photo-ia-pagesjaunes").value.trim();
    const apercu = document.getElementById("apercu-media-pagesjaunes");
    if (!description) {
      apercu.innerHTML = `<span class="badge badge-echec">Erreur</span> Décris l'image souhaitée d'abord.`;
      return;
    }
    boutonGenererPhotoPagesJaunes.disabled = true;
    apercu.textContent = "Génération de l'image en cours…";
    try {
      const r = await fetch("/api/pagesjaunes/generer-photo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.erreur || "Échec de la génération.");
      cheminMediaPagesJaunes = d.chemin;
      apercu.innerHTML = `<img src="/${echapper(d.chemin)}" alt="Aperçu" style="max-width:220px;max-height:220px;border-radius:8px;margin-top:6px" /><div class="anomalie-meta">Image générée par IA — ne représente pas un vrai chantier.</div>`;
    } catch (err) {
      apercu.innerHTML = `<span class="badge badge-echec">Erreur</span> ${echapper(err.message)}`;
    } finally {
      boutonGenererPhotoPagesJaunes.disabled = false;
    }
  });
}

const formActualitePagesJaunes = document.getElementById("form-actualite-pagesjaunes");
if (formActualitePagesJaunes) {
  formActualitePagesJaunes.addEventListener("submit", async (e) => {
    e.preventDefault();
    const resultatDiv = document.getElementById("resultat-actualite-pagesjaunes");
    const texte = document.getElementById("texte-actualite-pagesjaunes").value.trim();

    if (!texte) {
      resultatDiv.innerHTML = `<span class="badge badge-echec">Erreur</span> Le texte de l'actualité est requis.`;
      return;
    }

    resultatDiv.textContent = "Dépôt de la proposition…";
    try {
      const r = await fetch("/api/pagesjaunes/propositions/actualite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          texte,
          cheminMedia: cheminMediaPagesJaunes || undefined,
          justification: "Actualité proposée depuis l'onglet PagesJaunes.",
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.erreur || "Échec du dépôt de la proposition.");
      resultatDiv.innerHTML = `Proposition déposée — à accepter ci-dessous.`;
      formActualitePagesJaunes.reset();
      document.getElementById("apercu-media-pagesjaunes").innerHTML = "";
      cheminMediaPagesJaunes = null;
      await chargerPropositionsPagesJaunes();
    } catch (err) {
      resultatDiv.innerHTML = `<span class="badge badge-echec">Erreur</span> ${echapper(err.message)}`;
    }
  });
}

async function accepterPropositionPagesJaunes(id, bouton) {
  const groupe = bouton.closest(".relance-actions");
  if (groupe) groupe.querySelectorAll("button").forEach((b) => (b.disabled = true));
  bouton.textContent = "…";
  try {
    const r = await fetch(`/api/pagesjaunes/propositions/${id}/accepter`, { method: "POST" });
    const d = await r.json();
    if (!r.ok) throw new Error(d.erreur || "Échec de l'acceptation.");
    await chargerPropositionsPagesJaunes();
  } catch (err) {
    if (groupe) groupe.querySelectorAll("button").forEach((b) => (b.disabled = false));
    alert(err.message);
  }
}
window.accepterPropositionPagesJaunes = accepterPropositionPagesJaunes;

async function refuserPropositionPagesJaunes(id, bouton) {
  const groupe = bouton.closest(".relance-actions");
  if (groupe) groupe.querySelectorAll("button").forEach((b) => (b.disabled = true));
  bouton.textContent = "…";
  try {
    const r = await fetch(`/api/pagesjaunes/propositions/${id}/refuser`, { method: "POST" });
    const d = await r.json();
    if (!r.ok) throw new Error(d.erreur || "Échec du refus.");
    await chargerPropositionsPagesJaunes();
  } catch (err) {
    if (groupe) groupe.querySelectorAll("button").forEach((b) => (b.disabled = false));
    alert(err.message);
  }
}
window.refuserPropositionPagesJaunes = refuserPropositionPagesJaunes;

async function marquerPublieePropositionPagesJaunes(id, bouton) {
  const groupe = bouton.closest(".relance-actions");
  if (groupe) groupe.querySelectorAll("button").forEach((b) => (b.disabled = true));
  bouton.textContent = "…";
  try {
    const r = await fetch(`/api/pagesjaunes/propositions/${id}/marquer-publiee`, { method: "POST" });
    const d = await r.json();
    if (!r.ok) throw new Error(d.erreur || "Échec de la mise à jour.");
    await chargerPropositionsPagesJaunes();
  } catch (err) {
    if (groupe) groupe.querySelectorAll("button").forEach((b) => (b.disabled = false));
    alert(err.message);
  }
}
window.marquerPublieePropositionPagesJaunes = marquerPublieePropositionPagesJaunes;

const LIBELLE_TYPE_PAGESJAUNES = { actualite: "Actualité/offre", info_fiche: "Fiche établissement", reponse_avis: "Réponse à un avis" };
const LIBELLE_CHAMP_FICHE_PAGESJAUNES = { description: "Description de l'activité", services: "Services proposés", horaires: "Horaires", autre: "Autre info" };

function rendreContenuPropositionPagesJaunes(p) {
  if (p.type === "info_fiche") {
    return `<div class="anomalie-meta"><strong>${echapper(LIBELLE_CHAMP_FICHE_PAGESJAUNES[p.champFiche] || p.champFiche)}</strong></div><div class="anomalie-meta">${echapper(p.texte)}</div>`;
  }
  if (p.type === "reponse_avis") {
    return `
      <div class="anomalie-meta">Avis${p.avisClientNom ? ` de ${echapper(p.avisClientNom)}` : ""}${p.avisNote ? ` (${p.avisNote}/5)` : ""} : « ${echapper(p.avisTexte)} »</div>
      <div class="anomalie-meta"><strong>Réponse proposée :</strong> ${echapper(p.texte)}</div>`;
  }
  const estVideo = (p.cheminMedia || "").toLowerCase().endsWith(".mp4");
  return `
    <div class="anomalie-meta">${echapper(p.texte)}</div>
    ${
      p.cheminMedia
        ? estVideo
          ? `<video src="/${echapper(p.cheminMedia)}" controls style="max-width:220px;max-height:220px;border-radius:8px;margin:6px 0" ></video>`
          : `<img src="/${echapper(p.cheminMedia)}" alt="Photo" style="max-width:160px;max-height:160px;border-radius:8px;margin:6px 0" />`
        : ""
    }`;
}

async function chargerPropositionsPagesJaunes() {
  const liste = document.getElementById("liste-propositions-pagesjaunes");
  if (!liste) return;
  const res = await fetch("/api/pagesjaunes/propositions");
  const propositions = await res.json();

  if (propositions.length === 0) {
    liste.innerHTML = `<p class="liste-vide">Aucune proposition PagesJaunes pour le moment.</p>`;
    return;
  }

  const nbActualitesPublieesCeMois = propositions.filter(
    (p) => p.type === "actualite" && p.statut === "publiee" && p.publieeLe && new Date(p.publieeLe).getMonth() === new Date().getMonth() && new Date(p.publieeLe).getFullYear() === new Date().getFullYear()
  ).length;

  liste.innerHTML =
    `<p class="anomalie-meta">${nbActualitesPublieesCeMois} actualité(s)/offre(s) publiée(s) ce mois-ci (objectif Solocal : au moins 4).</p>` +
    propositions
      .map((p) => {
        const badge = BADGE_STATUT_PAGESJAUNES[p.statut] || "badge-doublon_fichier";
        const libelleStatut = LIBELLE_STATUT_PAGESJAUNES[p.statut] || p.statut;
        const actions =
          p.statut === "en_attente"
            ? `<div class="relance-actions">
                 <button type="button" onclick="accepterPropositionPagesJaunes('${p.id}', this)">Accepter</button>
                 <button type="button" class="ghost" onclick="refuserPropositionPagesJaunes('${p.id}', this)">Refuser</button>
               </div>`
            : p.statut === "acceptee"
              ? `<div class="relance-actions">
                   <button type="button" onclick="marquerPublieePropositionPagesJaunes('${p.id}', this)">Marquer publiée</button>
                 </div>`
              : "";
        return `
      <div class="decision-carte">
        <div class="relance-entete">
          <span class="badge badge-palier-neutre">${echapper(LIBELLE_TYPE_PAGESJAUNES[p.type] || p.type)}</span>
          <span class="badge ${badge}">${echapper(libelleStatut)}</span>
        </div>
        ${rendreContenuPropositionPagesJaunes(p)}
        <div class="anomalie-meta">${echapper(p.justification)}</div>
        <div class="anomalie-meta">Déposée le ${fmtDate(p.creeLe)}${p.decideLe ? ` · décidée le ${fmtDate(p.decideLe)}` : ""}${p.publieeLe ? ` · publiée le ${fmtDate(p.publieeLe)}` : ""}</div>
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

// Periode (champs #paiements-stripe-depuis/#paiements-stripe-jusqua, demande
// explicite de l'utilisateur de pouvoir filtrer/exporter sur une plage de
// dates precise plutot que seulement les 100 paiements les plus recents).
// Construit la query string partagee par la liste et par le lien d'export
// PDF, et met ce dernier a jour a chaque chargement pour qu'il reflete
// toujours la periode actuellement affichee a l'ecran.
function querystringPeriodePaiementsStripe() {
  const depuis = document.getElementById("paiements-stripe-depuis")?.value || "";
  const jusqua = document.getElementById("paiements-stripe-jusqua")?.value || "";
  const params = new URLSearchParams();
  if (depuis) params.set("depuis", depuis);
  if (jusqua) params.set("jusqua", jusqua);
  return params.toString();
}

async function chargerPaiementsStripe() {
  const conteneur = document.getElementById("liste-paiements-stripe");
  if (!conteneur) return;
  const qs = querystringPeriodePaiementsStripe();
  const lienExport = document.getElementById("lien-export-paiements-stripe");
  if (lienExport) lienExport.href = `/api/stripe/paiements/export-pdf${qs ? `?${qs}` : ""}`;
  try {
    const res = await fetch(`/api/stripe/paiements${qs ? `?${qs}` : ""}`);
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

// --- Visualiseur en page (Comptabilite uniquement) -------------------------
//
// Contrairement a voirDocument ci-dessus (navigation pleine page, conservee
// telle quelle pour les autres modules), le module Comptabilite demande
// explicitement de pouvoir visualiser chaque facture SANS quitter
// l'application - une simple modale suffit ici car /api/archives-comptables
// deja en Content-Disposition: inline (voir archiveComptableRoutes.ts) rend
// un PDF nativement dans une iframe.
function ouvrirApercuDocument(url, mimeType) {
  const modal = document.getElementById("archive-v2-modal");
  const corps = document.getElementById("archive-v2-modal-corps");
  if (!modal || !corps) return voirDocument(url);
  corps.innerHTML =
    mimeType === "application/pdf"
      ? `<iframe src="${echapper(url)}" title="Aperçu du document"></iframe>`
      : `<img src="${echapper(url)}" alt="Aperçu du document" />`;
  modal.hidden = false;
}
window.ouvrirApercuDocument = ouvrirApercuDocument;

function fermerApercuDocument() {
  const modal = document.getElementById("archive-v2-modal");
  const corps = document.getElementById("archive-v2-modal-corps");
  if (!modal) return;
  modal.hidden = true;
  if (corps) corps.innerHTML = "";
}
window.fermerApercuDocument = fermerApercuDocument;

(function initialiserApercuDocumentModal() {
  const modal = document.getElementById("archive-v2-modal");
  if (!modal) return;
  document.getElementById("archive-v2-modal-fermer")?.addEventListener("click", fermerApercuDocument);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) fermerApercuDocument();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.hidden) fermerApercuDocument();
  });
})();

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

/**
 * Estime l'eclairage local (fond flou tres fort, via un aller-retour
 * downscale/upscale) pour pouvoir neutraliser ombres/gradient de lumiere
 * avant tout etirement de contraste - un simple etirement global (version
 * precedente) ne corrige pas une ombre qui traverse la page, le gradient
 * reste visible apres. Demande explicite de l'utilisateur : obtenir un
 * vrai fond blanc "comme un scan", pas juste une photo plus contrastee.
 * Reduire a ~24px puis agrandir avec lissage efface le texte (details
 * fins) mais conserve les variations lentes d'eclairage - exactement ce
 * qu'il faut comme estimation de fond.
 */
function scanEstimerArrierePlan(canvasSource, largeur, hauteur) {
  const diviseur = Math.max(largeur, hauteur) / 24;
  const pw = Math.max(6, Math.round(largeur / diviseur));
  const ph = Math.max(6, Math.round(hauteur / diviseur));

  const petit = document.createElement("canvas");
  petit.width = pw;
  petit.height = ph;
  petit.getContext("2d").drawImage(canvasSource, 0, 0, pw, ph);

  const flou = document.createElement("canvas");
  flou.width = largeur;
  flou.height = hauteur;
  const ctxFlou = flou.getContext("2d");
  ctxFlou.imageSmoothingEnabled = true;
  ctxFlou.imageSmoothingQuality = "high";
  ctxFlou.drawImage(petit, 0, 0, pw, ph, 0, 0, largeur, hauteur);
  return ctxFlou.getImageData(0, 0, largeur, hauteur).data;
}

/**
 * Corrige l'eclairage inegal (division par le fond local estime ci-dessus,
 * canal par canal - corrige aussi une dominante de couleur chaude due a
 * l'eclairage, pas seulement les ombres), etire ensuite le contraste
 * (percentile 1-99) et blanchit franchement ce qui est deja tres clair
 * (le fond, une fois l'eclairage corrige, doit tourner autour de 255
 * partout - le seuil nettoie le grain photo residuel). En mode noir et
 * blanc, repasse en niveaux de gris avec un contraste accentue en plus.
 */
function scanAmeliorerPixels(data, arrierePlan, noirEtBlanc) {
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const fond = Math.max(arrierePlan[i + c], 1);
      data[i + c] = Math.min(255, (data[i + c] * 255) / fond);
    }
  }

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
  const SEUIL_BLANCHIMENT = 235;

  for (let i = 0; i < data.length; i += 4) {
    if (noirEtBlanc) {
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      let v = (lum - p1) * facteur;
      v = (v - 128) * 1.35 + 128; // accentue le contraste autour du milieu (texte plus net)
      v = Math.max(0, Math.min(255, v));
      if (v >= SEUIL_BLANCHIMENT) v = 255;
      data[i] = data[i + 1] = data[i + 2] = v;
    } else {
      for (let c = 0; c < 3; c++) {
        let v = Math.max(0, Math.min(255, (data[i + c] - p1) * facteur));
        if (v >= SEUIL_BLANCHIMENT) v = 255;
        data[i + c] = v;
      }
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

  const arrierePlan = scanEstimerArrierePlan(canvasResultat, outW, outH);
  const noirEtBlanc = document.getElementById("scan-noir-blanc").checked;
  const imageData = ctx.getImageData(0, 0, outW, outH);
  scanAmeliorerPixels(imageData.data, arrierePlan, noirEtBlanc);
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
      await Promise.all([chargerFacturesFournisseurs(), chargerFacturesDextEnvoyees(), chargerFournisseurs(), chargerCockpit()]);
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
    await Promise.all([chargerFacturesFournisseurs(), chargerFacturesDextEnvoyees()]);
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

// "Mercredi 4 novembre 2026" - meme principe que libelleMoisAnnee, au jour
// pres : demande explicite de l'utilisateur, besoin d'un visuel clair de ce
// que Morgane a deja transmis a Dext, jour par jour.
function libelleJour(date) {
  const texte = new Date(date).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  return texte.charAt(0).toUpperCase() + texte.slice(1);
}

// Conserve le dernier resultat pour filtrer cote client sans refaire
// d'appel reseau a chaque frappe (meme principe que facturesImpayeesBrutes
// ci-dessus) : demande explicite de l'utilisateur (video, novembre 2026),
// cette liste devient tres longue avec l'historique et un filtre texte
// permet de retrouver un fournisseur sans tout faire defiler a la main.
let facturesDextEnvoyeesBrutes = [];

function afficherFacturesDextEnvoyeesFiltrees() {
  const conteneur = document.getElementById("liste-factures-dext-envoyees");
  if (!conteneur) return;

  const recherche = (document.getElementById("filtre-dext-fournisseur")?.value || "").trim().toLowerCase();
  const documents = recherche
    ? facturesDextEnvoyeesBrutes.filter((d) => {
        const fournisseurNom = d.fournisseur ? d.fournisseur.nom : d.gmailExpediteur || "";
        return (d.fichierNom || "").toLowerCase().includes(recherche) || fournisseurNom.toLowerCase().includes(recherche);
      })
    : facturesDextEnvoyeesBrutes;

  if (documents.length === 0) {
    conteneur.innerHTML = `<p class="liste-vide">${facturesDextEnvoyeesBrutes.length === 0 ? "Aucune facture envoyée à Dext pour le moment." : "Aucune facture ne correspond à cette recherche."}</p>`;
    return;
  }

  // Deja triees du plus recent au plus ancien par le serveur (voir
  // /documents-fournisseurs) : les groupes par jour apparaissent eux aussi
  // du plus recent au plus ancien dans l'ordre ou Map les rencontre. Seul
  // le jour le plus recent est ouvert par defaut (<details open> sur le
  // premier uniquement) pour ne pas noyer la page sous l'historique complet.
  const groupes = new Map();
  for (const d of documents) {
    const cle = libelleJour(d.createdAt);
    if (!groupes.has(cle)) groupes.set(cle, []);
    groupes.get(cle).push(d);
  }

  conteneur.innerHTML = [...groupes.entries()]
    .map(
      ([jour, docs], index) => `
    <details class="fournisseur-documents fournisseur-documents-encadre"${index === 0 ? " open" : ""}>
      <summary>${echapper(jour)} <span class="groupe-mois-compte">${docs.length}</span></summary>
      <div class="fournisseur-documents-liste">
        ${docs
          .map(
            (d) => `
        <div class="fournisseur-document-ligne" id="document-ligne-${d.id}">
          <span><span class="fournisseur-nom-icone">📄</span>${echapper(d.fichierNom || "Document")}</span>
          <span class="anomalie-meta"><span class="fournisseur-nom-resolu-${d.id}">${d.fournisseur ? echapper(d.fournisseur.nom) : echapper(d.gmailExpediteur || "Expéditeur inconnu")}</span> · ${new Date(d.createdAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</span>
          ${!d.fournisseur ? `<button type="button" class="ghost bouton-lien" onclick="corrigerFournisseurDocument('${d.id}', this)">Corriger le fournisseur</button>` : ""}
          ${renduMontantFacture(d)}
          <button type="button" class="ghost bouton-lien" onclick="voirDocument('/api/documents-fournisseurs/${d.id}/document')">Voir</button>
          <button type="button" class="ghost bouton-lien" onclick="supprimerDocumentFournisseur('${d.id}', this, true)">Supprimer</button>
        </div>`
          )
          .join("")}
      </div>
    </details>`
    )
    .join("");
}

async function chargerFacturesDextEnvoyees() {
  const res = await fetch("/api/documents-fournisseurs?type=facture&statutDext=envoye");
  facturesDextEnvoyeesBrutes = await res.json();
  afficherFacturesDextEnvoyeesFiltrees();

  const champFiltre = document.getElementById("filtre-dext-fournisseur");
  if (champFiltre && !champFiltre.dataset.initialise) {
    champFiltre.addEventListener("input", afficherFacturesDextEnvoyeesFiltrees);
    champFiltre.dataset.initialise = "1";
  }
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
        <div class="fournisseur-nom"><span class="fournisseur-nom-icone">📄</span>${echapper(d.fichierNom || "Document")}</div>
        <div class="anomalie-meta">
          <span class="fournisseur-nom-resolu-${d.id}">${d.fournisseur ? echapper(d.fournisseur.nom) : echapper(d.gmailExpediteur || "Expéditeur inconnu")}</span>
          ${!d.fournisseur ? `<button type="button" class="ghost bouton-lien" onclick="corrigerFournisseurDocument('${d.id}', this)">Corriger le fournisseur</button>` : ""}
          ${d.dateReceptionMail ? ` · reçu le ${fmtDate(d.dateReceptionMail)}` : ""}
          ${d.numero ? ` · n° ${echapper(d.numero)}` : ""}
          ${d.classifiePar === "ia" ? ` · <span class="badge badge-palier-ambre">classé par IA, à vérifier</span>` : ""}
        </div>
        <div class="fournisseur-actions fournisseur-actions-ligne" id="document-ligne-${d.id}">
          ${renduMontantFacture(d)}
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

// --- Dépenses par fournisseur ----------------------------------------------
//
// Demande explicite de l'utilisateur : "connaître mes dépenses chez les
// fournisseurs... pour savoir ce que représente les dépenses autour de
// l'année chez mes différents fournisseurs", en HT comme en TTC. Fondé sur
// DocumentFournisseur.montantHT/montantTTC (voir depensesFournisseurs.ts) -
// une facture sans l'un de ces montants renseigné (extraction automatique
// infructueuse, pas encore saisie à la main) est explicitement exclue du
// total correspondant plutôt que comptée comme 0 €, pour ne jamais
// sous-estimer silencieusement une dépense réelle.

function libellePeriodeDepense(periode, granularite) {
  if (granularite === "annee") return periode;
  if (granularite === "mois") return libelleMoisAnnee(`${periode}-01`);
  return libelleJour(periode);
}

// Donnees de la derniere requete, mises en cache pour que la recherche par
// nom (demande explicite de l'utilisateur) filtre instantanement sans
// refaire d'appel reseau a chaque frappe.
let derniereDepensesLignes = [];
let derniereDepensesGranularite = "mois";

function rendreDepensesFournisseurs() {
  const resume = document.getElementById("depenses-fournisseurs-resume");
  const detail = document.getElementById("depenses-fournisseurs-detail");
  if (!resume || !detail) return;
  const granularite = derniereDepensesGranularite;
  const recherche = (document.getElementById("depenses-recherche")?.value || "").trim().toLowerCase();
  const lignes = recherche ? derniereDepensesLignes.filter((l) => l.fournisseurNom.toLowerCase().includes(recherche)) : derniereDepensesLignes;

  if (derniereDepensesLignes.length === 0) {
    resume.innerHTML = "";
    detail.innerHTML = `<p class="liste-vide">Aucune facture avec un montant renseigné pour le moment.</p>`;
    return;
  }
  if (lignes.length === 0) {
    resume.innerHTML = "";
    detail.innerHTML = `<p class="liste-vide">Aucun fournisseur ne correspond à "${echapper(recherche)}".</p>`;
    return;
  }

  // Resume : total toutes periodes confondues, par fournisseur, du plus
  // gros au plus petit (sur le TTC) - repond directement a "ce que
  // representent mes depenses chez mes differents fournisseurs".
  const totauxParFournisseur = new Map();
  for (const l of lignes) {
    const cle = l.fournisseurId || l.fournisseurNom;
    const existant = totauxParFournisseur.get(cle) || { nom: l.fournisseurNom, totalHT: 0, totalTTC: 0, nombreSansMontantHT: 0, nombreSansMontantTTC: 0 };
    existant.totalHT += l.totalHT;
    existant.totalTTC += l.totalTTC;
    existant.nombreSansMontantHT += l.nombreSansMontantHT;
    existant.nombreSansMontantTTC += l.nombreSansMontantTTC;
    totauxParFournisseur.set(cle, existant);
  }
  const tous = [...totauxParFournisseur.values()].sort((a, b) => b.totalTTC - a.totalTTC);
  // Separe les fournisseurs sans le moindre montant exploitable (ni HT ni
  // TTC sur toute la periode) - les afficher en tete, tous a "0,00 €",
  // noyait les vrais totaux dans un mur de zeros (signale par
  // l'utilisateur) sans rien apporter : releguees dans un repli replie
  // par defaut plutot que dans le classement principal.
  const avecMontant = tous.filter((f) => f.totalHT > 0 || f.totalTTC > 0);
  const sansMontant = tous.filter((f) => f.totalHT === 0 && f.totalTTC === 0);

  const ligneResume = (f) => `
      <div class="depense-ligne">
        <span class="depense-nom">${echapper(f.nom)}</span>
        <span class="depense-montants">
          <span class="depense-montant-ttc">${fmtMontant(f.totalTTC)}</span>
          <span class="depense-montant-ht">HT ${fmtMontant(f.totalHT)}</span>
          ${
            f.nombreSansMontantHT > 0 || f.nombreSansMontantTTC > 0
              ? `<span class="depense-anomalie">⚠️ ${Math.max(f.nombreSansMontantHT, f.nombreSansMontantTTC)} facture(s) incomplète(s)</span>`
              : ""
          }
        </span>
      </div>`;

  resume.innerHTML =
    (avecMontant.length > 0
      ? avecMontant.map(ligneResume).join("")
      : `<p class="liste-vide">Aucun montant exploitable sur cette période - voir "Récupérer les montants manquants" ci-dessus.</p>`) +
    (sansMontant.length > 0
      ? `<details class="depense-sans-montant">
             <summary>${sansMontant.length} fournisseur(s) sans aucun montant extrait</summary>
             ${sansMontant.map(ligneResume).join("")}
           </details>`
      : "");

  // Detail : par periode, du plus recent au plus ancien (l'API renvoie
  // deja trie du plus ancien au plus recent, regroupe par periode donc
  // inverse ici).
  const groupes = new Map();
  for (const l of lignes) {
    if (!groupes.has(l.periode)) groupes.set(l.periode, []);
    groupes.get(l.periode).push(l);
  }
  detail.innerHTML = [...groupes.entries()]
    .reverse()
    .map(
      ([periode, docs], index) => `
      <details class="fournisseur-documents"${index === 0 ? " open" : ""}>
        <summary>${echapper(libellePeriodeDepense(periode, granularite))}</summary>
        <div>
          ${docs
            .map(
              (l) => `
            <div class="depense-ligne">
              <span class="depense-nom">${echapper(l.fournisseurNom)} <span class="depense-montant-ht">· ${l.nombreFactures} facture(s)</span></span>
              <span class="depense-montants">
                <span class="depense-montant-ttc">${fmtMontant(l.totalTTC)}</span>
                <span class="depense-montant-ht">HT ${fmtMontant(l.totalHT)}</span>
              </span>
            </div>`
            )
            .join("")}
        </div>
      </details>`
    )
    .join("");
}
document.getElementById("depenses-recherche")?.addEventListener("input", rendreDepensesFournisseurs);

async function chargerDepensesFournisseurs() {
  const resume = document.getElementById("depenses-fournisseurs-resume");
  const detail = document.getElementById("depenses-fournisseurs-detail");
  if (!resume || !detail) return;
  const granularite = document.getElementById("depenses-granularite")?.value || "mois";
  try {
    const res = await fetch(`/api/depenses-fournisseurs?granularite=${granularite}`);
    const lignes = await res.json();
    if (!res.ok) throw new Error(lignes.erreur || "Chargement impossible.");
    derniereDepensesLignes = lignes;
    derniereDepensesGranularite = granularite;
    rendreDepensesFournisseurs();
  } catch (err) {
    resume.innerHTML = `<p class="aide-inline">Erreur : ${echapper(err.message)}</p>`;
    detail.innerHTML = "";
  }
}
document.getElementById("depenses-granularite")?.addEventListener("change", chargerDepensesFournisseurs);

// Re-extrait les montants HT/TTC des factures deja en base qui n'en ont
// aucun (voir backfillMontantsFacturesSansMontant dans gmailSync.ts) -
// necessaire pour tout document recu AVANT l'introduction de cette
// extraction (la quasi-totalite des factures existantes au moment de ce
// module, signale par l'utilisateur : un mur de "0,00 €" sur chaque
// fournisseur). Ne bloque plus en attendant la fin (voir gmailSync.ts) :
// avec plusieurs centaines de documents et le filet IA (vision...) ajoute
// depuis, l'extraction peut desormais prendre plusieurs minutes, bien au
// dela de ce qu'une requete HTTP peut attendre de maniere fiable - le
// resultat exact (mise a jour/toujours sans montant/erreurs) n'arrive
// qu'a la fin, visible dans le Journal, pas dans cette reponse.
async function backfillMontantsFournisseurs(bouton) {
  const resultatConteneur = document.getElementById("depenses-backfill-resultat");
  bouton.disabled = true;
  const texteInitial = bouton.textContent;
  bouton.textContent = "Lancement…";
  if (resultatConteneur) resultatConteneur.innerHTML = "";
  try {
    const res = await fetch("/api/depenses-fournisseurs/backfill-montants", { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.erreur || "Récupération impossible.");
    if (resultatConteneur) {
      resultatConteneur.innerHTML =
        data.traitees > 0
          ? `<p class="aide-inline">${data.traitees} facture(s) en cours de traitement en arrière-plan${data.ignorees > 0 ? ` (${data.ignorees} ignorée(s), document trop ancien ou sans pièce jointe retrouvable)` : ""} — peut prendre plusieurs minutes pour un gros volume, voir le Journal pour le résultat final.</p>`
          : `<p class="aide-inline">Aucune facture à retraiter${data.ignorees > 0 ? ` (${data.ignorees} ignorée(s), document trop ancien ou sans pièce jointe retrouvable)` : ""}.</p>`;
    }
  } catch (err) {
    if (resultatConteneur) resultatConteneur.innerHTML = `<p class="aide-inline">Erreur : ${echapper(err.message)}</p>`;
  } finally {
    bouton.disabled = false;
    bouton.textContent = texteInitial;
  }
}
window.backfillMontantsFournisseurs = backfillMontantsFournisseurs;

// Rattache retroactivement le fournisseur des factures/avoirs qui n'en ont
// jamais eu (voir backfillFournisseurDocumentsSansFournisseur dans
// gmailSync.ts) - cas reel : un document reclasse en facture depuis le
// centre de validation des anomalies restait "fournisseur non identifie"
// meme quand l'expediteur permettait de le reconnaitre. Synchrone (aucun
// appel Gmail necessaire) : le resultat exact arrive directement dans la
// reponse, pas besoin de consulter le Journal.
async function backfillFournisseurManquant(bouton) {
  const resultatConteneur = document.getElementById("depenses-backfill-fournisseur-resultat");
  bouton.disabled = true;
  const texteInitial = bouton.textContent;
  bouton.textContent = "Lancement…";
  if (resultatConteneur) resultatConteneur.innerHTML = "";
  try {
    const res = await fetch("/api/documents-fournisseurs/backfill-fournisseur", { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.erreur || "Rattachement impossible.");
    if (resultatConteneur) {
      resultatConteneur.innerHTML =
        data.total > 0
          ? `<p class="aide-inline">${data.resolues} document(s) sur ${data.total} désormais rattaché(s) à un fournisseur.</p>`
          : `<p class="aide-inline">Aucun document sans fournisseur à rattacher.</p>`;
    }
  } catch (err) {
    if (resultatConteneur) resultatConteneur.innerHTML = `<p class="aide-inline">Erreur : ${echapper(err.message)}</p>`;
  } finally {
    bouton.disabled = false;
    bouton.textContent = texteInitial;
  }
}
window.backfillFournisseurManquant = backfillFournisseurManquant;

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

// Corrige le nom d'une fiche (ex. le contact commercial individuel affiche
// a la place de la raison sociale) : fusionne automatiquement cote serveur
// si une fiche du nom cible existe deja, jamais de conflit a gerer ici.
async function renommerFournisseur(id, nomActuel) {
  const nouveauNom = prompt("Nouveau nom du fournisseur :", nomActuel);
  if (!nouveauNom || !nouveauNom.trim() || nouveauNom.trim() === nomActuel) return;
  try {
    const res = await fetch(`/api/fournisseurs/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nom: nouveauNom.trim() }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.erreur || "Renommage impossible.");
    await chargerFournisseurs();
  } catch (err) {
    alert(err.message);
  }
}
window.renommerFournisseur = renommerFournisseur;

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
      <div class="fournisseur-document-ligne" id="document-ligne-${d.id}">
        <span class="badge badge-palier-neutre">${echapper(LIBELLE_TYPE_DOCUMENT[d.type] || d.type)}</span>
        ${d.classifiePar === "ia" ? `<span class="badge badge-palier-ambre">classé par IA</span>` : ""}
        <span>${echapper(d.fichierNom || "Document")}</span>
        ${d.dateReceptionMail ? `<span class="anomalie-meta">reçu le ${fmtDate(d.dateReceptionMail)}</span>` : ""}
        ${renduMontantFacture(d)}
        <button type="button" class="ghost bouton-lien" onclick="voirDocument('/api/documents-fournisseurs/${d.id}/document')">Voir</button>
        <button type="button" class="ghost bouton-lien" onclick="supprimerDocumentFournisseur('${d.id}', this, ${d.statutDext === "envoye"})">Supprimer</button>
      </div>`
        )
        .join("") || `<p class="aide-inline">Aucun document.</p>`;
  } catch (err) {
    conteneur.innerHTML = `<p class="aide-inline">Erreur : ${echapper(err.message)}</p>`;
  }
}
window.chargerDocumentsFournisseur = chargerDocumentsFournisseur;

// Supprime un document isole mal rattache a une fiche fournisseur (CV,
// photo, logo...), ou une facture envoyee a Dext par erreur. L'application
// n'a aucun acces a l'API de Dext (seulement a l'adresse e-mail d'import,
// voir envoyerVersDext dans gmailSync.ts) : la suppression ne retire donc
// QUE le suivi local, jamais le document lui-meme dans Dext si celui-ci l'a
// deja recu - d'ou l'avertissement explicite quand dejaEnvoye est vrai.
async function supprimerDocumentFournisseur(id, bouton, dejaEnvoye) {
  const message = dejaEnvoye
    ? "Cette facture a deja ete envoyee a Dext. Cette suppression retire uniquement le suivi dans Copilote Atelier Brochant, PAS la facture dans Dext (l'application n'a pas d'acces direct a Dext, seulement a son adresse e-mail d'import) : si elle y a ete ajoutee par erreur, supprimez-la aussi directement dans Dext. Continuer ?"
    : "Supprimer ce document ? Cette action est definitive.";
  if (!confirm(message)) return;
  bouton.disabled = true;
  bouton.textContent = "Suppression…";
  try {
    const res = await fetch(`/api/documents-fournisseurs/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.erreur || "Suppression impossible.");
    }
    // Retrait direct de la ligne, sans recharger toute la liste des
    // fournisseurs : un rechargement complet refermerait le "Voir les
    // documents" en cours de nettoyage, genant pour supprimer plusieurs
    // documents a la suite.
    document.getElementById(`document-ligne-${id}`)?.remove();
  } catch (err) {
    bouton.disabled = false;
    bouton.textContent = "Supprimer";
    alert(err.message);
  }
}
window.supprimerDocumentFournisseur = supprimerDocumentFournisseur;

// Correction manuelle du fournisseur (demande explicite de l'utilisateur :
// un document reclasse manuellement en facture - ex. une photo envoyee a
// soi-meme pour archivage - ne passe jamais par la resolution automatique
// par e-mail et reste "Expéditeur inconnu" indefiniment sans cette action).
async function corrigerFournisseurDocument(id, bouton) {
  const nom = prompt("Nom du fournisseur tel qu'il apparaît sur le document (créé s'il n'existe pas encore) :");
  if (nom === null || !nom.trim()) return;
  bouton.disabled = true;
  try {
    const res = await fetch(`/api/documents-fournisseurs/${id}/fournisseur`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nom: nom.trim() }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.erreur || "Enregistrement impossible.");
    }
    // Remplace le nom affiche et retire le bouton directement, sans
    // recharger toute la liste (meme raisonnement que supprimerDocumentFournisseur
    // ci-dessus) - un nouveau fournisseur peut avoir ete cree, donc
    // rafraichit aussi l'onglet Fournisseurs pour qu'il y apparaisse.
    document.querySelectorAll(`.fournisseur-nom-resolu-${id}`).forEach((el) => {
      el.textContent = nom.trim();
    });
    bouton.remove();
    await chargerFournisseurs();
  } catch (err) {
    bouton.disabled = false;
    alert(err.message);
  }
}
window.corrigerFournisseurDocument = corrigerFournisseurDocument;

// Affichage des montants HT et TTC d'une facture fournisseur (demande
// explicite de l'utilisateur : suivre les depenses par fournisseur, en HT
// comme en TTC) - uniquement pour le type "facture", jamais pour un
// devis/bon d'enlevement/releve ou autre type sans rapport avec une
// depense. Montant non trouve automatiquement (extraireMontantHTFacture/
// extraireMontantTTCFacture, mise en page atypique...) : alerte visible
// plutot qu'un silence qui laisserait croire a tort que cette facture
// represente 0 € de depense dans le module de suivi.
function renduMontantFacture(d) {
  if (d.type !== "facture") return "";
  const ht =
    d.montantHT != null
      ? `<span class="badge badge-ok">HT ${fmtMontant(d.montantHT)}</span>`
      : `<span class="alerte-montant-manquant montant-ht-manquant" title="Le montant HT n'a pas pu être extrait automatiquement de ce document">HT non renseigné</span>`;
  const ttc =
    d.montantTTC != null
      ? `<span class="badge badge-ok">TTC ${fmtMontant(d.montantTTC)}</span>`
      : `<span class="alerte-montant-manquant montant-ttc-manquant" title="Le montant TTC n'a pas pu être extrait automatiquement de ce document">TTC non renseigné</span>`;
  const boutonSaisie =
    d.montantHT == null || d.montantTTC == null
      ? `<button type="button" class="ghost bouton-lien" onclick="saisirMontantFacture('${d.id}', this, ${d.montantHT ?? "null"}, ${d.montantTTC ?? "null"})">Renseigner le(s) montant(s)</button>`
      : "";
  return `${ht} ${ttc} ${boutonSaisie}`;
}

async function saisirMontantFacture(id, bouton, montantHTActuel, montantTTCActuel) {
  const saisieHT = prompt(
    "Montant HT de cette facture (en euros, laissez vide pour ne pas le renseigner) :",
    montantHTActuel != null ? String(montantHTActuel).replace(".", ",") : ""
  );
  if (saisieHT === null) return;
  const saisieTTC = prompt(
    "Montant TTC de cette facture (en euros, laissez vide pour ne pas le renseigner) :",
    montantTTCActuel != null ? String(montantTTCActuel).replace(".", ",") : ""
  );
  if (saisieTTC === null) return;

  const montantHT = saisieHT.trim() === "" ? null : Number(saisieHT.replace(",", "."));
  const montantTTC = saisieTTC.trim() === "" ? null : Number(saisieTTC.replace(",", "."));
  if (montantHT == null && montantTTC == null) {
    alert("Indiquez au moins un des deux montants.");
    return;
  }
  if ((montantHT != null && (!Number.isFinite(montantHT) || montantHT <= 0)) || (montantTTC != null && (!Number.isFinite(montantTTC) || montantTTC <= 0))) {
    alert("Montant invalide : indiquez un nombre positif (ex. 123,45).");
    return;
  }
  bouton.disabled = true;
  try {
    const res = await fetch(`/api/documents-fournisseurs/${id}/montant`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ montantHT, montantTTC }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.erreur || "Enregistrement impossible.");
    }
    // Remplace l'alerte par le montant saisi, sans recharger toute la liste
    // (meme raisonnement que supprimerDocumentFournisseur ci-dessus).
    const ligne = document.getElementById(`document-ligne-${id}`);
    if (ligne) {
      if (montantHT != null) {
        const alerteHT = ligne.querySelector(".montant-ht-manquant");
        if (alerteHT) alerteHT.outerHTML = `<span class="badge badge-ok">HT ${fmtMontant(montantHT)}</span>`;
      }
      if (montantTTC != null) {
        const alerteTTC = ligne.querySelector(".montant-ttc-manquant");
        if (alerteTTC) alerteTTC.outerHTML = `<span class="badge badge-ok">TTC ${fmtMontant(montantTTC)}</span>`;
      }
      if (ligne.querySelector(".montant-ht-manquant") || ligne.querySelector(".montant-ttc-manquant")) {
        bouton.disabled = false;
      } else {
        bouton.remove();
      }
    }
  } catch (err) {
    bouton.disabled = false;
    alert(err.message);
  }
}
window.saisirMontantFacture = saisirMontantFacture;

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
      <div class="fournisseur-actions fournisseur-actions-ligne">
        <button type="button" class="ghost" onclick="renommerFournisseur('${f.id}', '${echapper(f.nom).replace(/'/g, "\\'")}')">Renommer</button>
        ${f.nbFactures === 0 ? `<button type="button" class="ghost" onclick="supprimerFournisseur('${f.id}', this)">Supprimer</button>` : ""}
      </div>
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

// --- Réalisations (galerie photos pour les prestataires externes) --------
//
// Demande explicite de l'utilisateur (novembre 2026) : il envoyait a la
// main par WhatsApp des photos de chantiers a deux prestataires externes
// (Google Maps/avis, site/referencement), en choisissant a chaque fois qui
// devait recevoir quoi. Remplace par un upload unique ici, avec le choix de
// l'activite (donc du prestataire) au moment de l'envoi - chaque lundi
// matin, un lien de galerie est envoye automatiquement au prestataire
// concerne si de nouvelles photos existent pour son activite (voir
// realisations.ts).

let activitesRealisationsCache = [];

async function chargerActivitesRealisations() {
  const conteneur = document.getElementById("liste-activites-realisations");
  const selectActivite = document.getElementById("realisations-activite");
  if (!conteneur) return;
  try {
    const res = await fetch("/api/realisations/activites");
    const activites = await res.json();
    if (!res.ok) throw new Error(activites.erreur || "Chargement impossible.");
    activitesRealisationsCache = activites;

    conteneur.innerHTML = activites
      .map(
        (a) => `
      <div class="depense-ligne">
        <span class="depense-nom">${echapper(a.nom)} <span class="depense-montant-ht">· ${a._count.photos} photo(s)</span></span>
        <span class="depense-montants" style="align-items:flex-end">
          <button type="button" class="ghost bouton-lien" onclick="modifierEmailActiviteRealisation('${a.id}', '${echapper(a.email)}', this)">${echapper(a.email)}</button>
          <button type="button" class="ghost bouton-lien" onclick="copierLienGalerieRealisation('${a.tokenGalerie}', this)">Copier le lien de la galerie</button>
        </span>
      </div>`
      )
      .join("");

    if (selectActivite && selectActivite.options.length === 0) {
      selectActivite.innerHTML = activites.map((a) => `<option value="${a.id}">${echapper(a.nom)}</option>`).join("");
    }
  } catch (err) {
    conteneur.innerHTML = `<p class="aide-inline">Erreur : ${echapper(err.message)}</p>`;
  }
}

async function modifierEmailActiviteRealisation(id, emailActuel, bouton) {
  const nouvelEmail = prompt("Adresse e-mail du prestataire pour cette activité :", emailActuel);
  if (!nouvelEmail || !nouvelEmail.trim() || nouvelEmail.trim() === emailActuel) return;
  bouton.disabled = true;
  try {
    const res = await fetch(`/api/realisations/activites/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: nouvelEmail.trim() }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.erreur || "Enregistrement impossible.");
    }
    await chargerActivitesRealisations();
  } catch (err) {
    bouton.disabled = false;
    alert(err.message);
  }
}
window.modifierEmailActiviteRealisation = modifierEmailActiviteRealisation;

async function copierLienGalerieRealisation(token, bouton) {
  const lien = `${location.origin}/galerie-realisations/${token}`;
  try {
    await navigator.clipboard.writeText(lien);
    const texteInitial = bouton.textContent;
    bouton.textContent = "Lien copié !";
    setTimeout(() => (bouton.textContent = texteInitial), 2000);
  } catch {
    prompt("Copiez ce lien :", lien);
  }
}
window.copierLienGalerieRealisation = copierLienGalerieRealisation;

async function chargerPhotosRealisations() {
  const conteneur = document.getElementById("liste-photos-realisations");
  if (!conteneur) return;
  try {
    const res = await fetch("/api/realisations");
    const photos = await res.json();
    if (!res.ok) throw new Error(photos.erreur || "Chargement impossible.");
    conteneur.innerHTML =
      photos
        .map(
          (p) => `
      <div class="fournisseur-document-ligne" id="photo-realisation-${p.id}">
        <img src="/media-publics/realisations/${encodeURIComponent(p.fichierNom)}" alt="" style="width:48px;height:48px;object-fit:cover;border-radius:6px" />
        <span class="badge badge-palier-neutre">${echapper(p.activite.nom)}</span>
        ${p.chantierNom ? `<span>${echapper(p.chantierNom)}</span>` : ""}
        <span class="anomalie-meta">${fmtDate(p.createdAt)}</span>
        <button type="button" class="ghost bouton-lien" onclick="supprimerPhotoRealisation('${p.id}', this)">Supprimer</button>
      </div>`
        )
        .join("") || `<p class="aide-inline">Aucune photo pour le moment.</p>`;
  } catch (err) {
    conteneur.innerHTML = `<p class="aide-inline">Erreur : ${echapper(err.message)}</p>`;
  }
}

async function supprimerPhotoRealisation(id, bouton) {
  if (!confirm("Supprimer cette photo ?")) return;
  bouton.disabled = true;
  try {
    const res = await fetch(`/api/realisations/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.erreur || "Suppression impossible.");
    }
    document.getElementById(`photo-realisation-${id}`)?.remove();
    await chargerActivitesRealisations();
  } catch (err) {
    bouton.disabled = false;
    alert(err.message);
  }
}
window.supprimerPhotoRealisation = supprimerPhotoRealisation;

const formRealisations = document.getElementById("form-realisations");
if (formRealisations) {
  formRealisations.addEventListener("submit", async (e) => {
    e.preventDefault();
    const resultatDiv = document.getElementById("resultat-realisations");
    const champFichiers = document.getElementById("realisations-fichiers");
    const activiteId = document.getElementById("realisations-activite").value;
    const chantierNom = document.getElementById("realisations-chantier").value.trim();
    if (!champFichiers.files.length) {
      resultatDiv.innerHTML = `<span class="badge badge-echec">Erreur</span> Choisissez au moins une photo.`;
      return;
    }

    const donnees = new FormData();
    donnees.append("activiteId", activiteId);
    if (chantierNom) donnees.append("chantierNom", chantierNom);
    for (const fichier of champFichiers.files) donnees.append("photos", fichier);

    resultatDiv.textContent = "Envoi en cours…";
    try {
      const res = await fetch("/api/realisations", { method: "POST", body: donnees });
      const data = await res.json();
      if (!res.ok) throw new Error(data.erreur || "Échec de l'envoi.");
      resultatDiv.innerHTML = `${data.length} photo(s) ajoutée(s).`;
      formRealisations.reset();
      await Promise.all([chargerActivitesRealisations(), chargerPhotosRealisations()]);
    } catch (err) {
      resultatDiv.innerHTML = `<span class="badge badge-echec">Erreur</span> ${echapper(err.message)}`;
    }
  });
}

// --- Comptabilité : archive de factures (independante de Dext) ------------
//
// Module distinct du circuit "Factures fournisseurs" (demande explicite de
// l'utilisateur, novembre 2026 : archive de secours apres suppression des
// factures sur Dext par l'ancien comptable). L'ensemble des archives est
// recupere une seule fois puis filtre cote client (meme principe que
// chargerFacturesImpayees ci-dessus) : pas de nouvel appel reseau a chaque
// frappe dans les filtres.
let archivesComptablesBrutes = [];
// Derniere liste affichee (apres tous les filtres, y compris "Doublons
// uniquement") - alimentee par afficherArchivesComptablesFiltrees, lue par
// exporterArchivesComptablesCsv pour n'exporter que ce qui est visible.
let archivesComptablesFiltreesCourantes = [];
// Categories comptables fixes (voir CATEGORIES_FACTURE cote serveur,
// archiveComptableIA.ts) - chargees une fois depuis le serveur pour que le
// filtre et la correction manuelle restent toujours synchronises avec la
// liste reellement utilisee par l'IA, sans la dupliquer en dur ici.
let categoriesFactureDisponibles = [];

const ID_FILTRES_ARCHIVE_COMPTABLE = [
  "filtre-archive-date-debut",
  "filtre-archive-date-fin",
  "filtre-archive-fournisseur",
  "filtre-archive-montant-min",
  "filtre-archive-montant-max",
  "filtre-archive-categorie",
];

/**
 * Detecte les doublons probables parmi TOUTES les archives (pas seulement
 * celles deja filtrees par date/montant/fournisseur) - demande explicite de
 * l'utilisateur. Deux signaux, jamais devines : meme fournisseur + meme
 * numero de facture (quasi certain), ou meme fournisseur + meme date + meme
 * montant TTC (tres probable). Retourne l'ensemble des id d'archives
 * appartenant a un groupe de 2 archives ou plus partageant l'une de ces cles.
 */
function detecterIdsDoublonsArchives(archives) {
  const groupes = new Map();
  const ajouter = (cle, id) => {
    if (!groupes.has(cle)) groupes.set(cle, []);
    groupes.get(cle).push(id);
  };
  for (const a of archives) {
    const fournisseur = (a.fournisseurNom || "").trim().toLowerCase();
    if (!fournisseur) continue;
    if (a.numero && a.numero.trim()) {
      ajouter(`numero:${fournisseur}:${a.numero.trim().toLowerCase()}`, a.id);
    }
    if (a.dateFacture && a.montantTTC != null) {
      ajouter(`montant:${fournisseur}:${a.dateFacture.slice(0, 10)}:${a.montantTTC}`, a.id);
    }
  }
  const idsDoublons = new Set();
  for (const liste of groupes.values()) {
    if (liste.length > 1) liste.forEach((id) => idsDoublons.add(id));
  }
  return idsDoublons;
}

/**
 * Markup d'une carte facture, partage entre les 3 sous-vues (Mois en cours,
 * Archives, A verifier) - evite de dupliquer 3 fois le meme gabarit. La
 * raison affichee en plus du badge "a verifier"/"doublon possible" habituel
 * (idsDoublons) est optionnelle : fournie uniquement par la sous-vue
 * "A verifier" (voir listerArchivesAVerifier cote serveur).
 */
function construireCarteArchiveComptable(a, { doublon = false } = {}) {
  return `
      <div class="archive-v2-carte" id="archive-comptable-${a.id}">
        <div class="archive-v2-carte-entete">
          <span>📄</span>
          <span class="archive-v2-carte-fournisseur">${echapper(a.fournisseurNom || "Fournisseur non identifié")}</span>
        </div>
        <div class="archive-v2-carte-fichier">${echapper(a.fichierNom)}</div>
        <div class="archive-v2-carte-meta">
          ${a.dateFacture ? `<span>${fmtDate(a.dateFacture)}</span>` : ""}
          ${a.numero ? `<span>n° ${echapper(a.numero)}</span>` : ""}
          ${a.categorie ? `<span class="badge badge-categorie">${echapper(a.categorie)}</span>` : ""}
          ${a.statut === "a_verifier" ? `<span class="badge badge-palier-ambre">à vérifier</span>` : ""}
          ${doublon ? `<span class="badge badge-palier-ambre">doublon possible</span>` : ""}
          <span class="badge badge-${a.rapproche ? "rapproche" : "non_rapproche"}">${a.rapproche ? "✓ rapproché" : "non rapproché"}</span>
        </div>
        <div class="archive-v2-carte-montants">
          ${a.montantHT != null ? `<span class="badge badge-ok">HT ${fmtMontant(a.montantHT)}</span>` : `<span class="alerte-montant-manquant">HT non renseigné</span>`}
          ${a.montantTTC != null ? `<span class="badge badge-ok">TTC ${fmtMontant(a.montantTTC)}</span>` : `<span class="alerte-montant-manquant">TTC non renseigné</span>`}
        </div>
        <div class="archive-v2-carte-actions">
          <button type="button" class="archive-v2-bouton-voir" onclick="ouvrirApercuDocument('/api/archives-comptables/${a.id}/fichier', '${echapper(a.mimeType || "")}')">👁 Voir</button>
          <button type="button" class="archive-v2-bouton-corriger" onclick="ouvrirCorrectionArchive('${a.id}')">✏️ Corriger</button>
          <button type="button" class="archive-v2-bouton-supprimer" onclick="supprimerArchiveComptable('${a.id}', this)">🗑 Supprimer</button>
        </div>
      </div>`;
}

function afficherArchivesComptablesFiltrees() {
  const conteneur = document.getElementById("liste-archives-comptables");
  if (!conteneur) return;

  const dateDebut = document.getElementById("filtre-archive-date-debut").value;
  const dateFin = document.getElementById("filtre-archive-date-fin").value;
  const fournisseurRecherche = document.getElementById("filtre-archive-fournisseur").value.trim().toLowerCase();
  const montantMinBrut = document.getElementById("filtre-archive-montant-min").value;
  const montantMaxBrut = document.getElementById("filtre-archive-montant-max").value;
  const montantMin = montantMinBrut === "" ? null : Number(montantMinBrut);
  const montantMax = montantMaxBrut === "" ? null : Number(montantMaxBrut);
  const doublonsUniquement = document.getElementById("filtre-archive-doublons-uniquement").checked;
  const categorieChoisie = document.getElementById("filtre-archive-categorie").value;
  const idsDoublons = detecterIdsDoublonsArchives(archivesComptablesBrutes);

  const archives = archivesComptablesBrutes.filter((a) => {
    const date = a.dateFacture ? a.dateFacture.slice(0, 10) : null;
    if (dateDebut && (!date || date < dateDebut)) return false;
    if (dateFin && (!date || date > dateFin)) return false;
    if (fournisseurRecherche && !(a.fournisseurNom || "").toLowerCase().includes(fournisseurRecherche)) return false;
    // Un montant filtre peut correspondre au HT ou au TTC (l'utilisateur ne
    // sait pas forcement lequel il cherche) - meme principe que le filtre
    // serveur de listerArchivesComptables.
    if (montantMin !== null && !(a.montantHT >= montantMin || a.montantTTC >= montantMin)) return false;
    if (montantMax !== null && !(a.montantHT <= montantMax || a.montantTTC <= montantMax)) return false;
    if (doublonsUniquement && !idsDoublons.has(a.id)) return false;
    if (categorieChoisie && a.categorie !== categorieChoisie) return false;
    return true;
  });
  archivesComptablesFiltreesCourantes = archives;

  document.getElementById("compte-archives-filtrees").textContent =
    archives.length === archivesComptablesBrutes.length
      ? `${archivesComptablesBrutes.length} archive(s)`
      : `${archives.length} sur ${archivesComptablesBrutes.length} archive(s)`;

  if (archives.length === 0) {
    conteneur.innerHTML = `<p class="liste-vide">Aucune archive${archivesComptablesBrutes.length > 0 ? " ne correspond a ces filtres" : " pour le moment"}.</p>`;
    return;
  }

  // Deja triees du plus recent au plus ancien par le serveur (voir
  // listerArchivesComptables) : les groupes par mois apparaissent eux aussi
  // du plus recent au plus ancien dans l'ordre ou Map les rencontre. Les
  // archives sans date lisible (echec d'extraction) rejoignent un groupe a
  // part, en dernier, plutot que de fausser le mois le plus recent.
  const groupes = new Map();
  for (const a of archives) {
    const cle = a.dateFacture ? libelleMoisAnnee(a.dateFacture) : "Date inconnue";
    if (!groupes.has(cle)) groupes.set(cle, []);
    groupes.get(cle).push(a);
  }
  if (groupes.has("Date inconnue")) {
    const sansDate = groupes.get("Date inconnue");
    groupes.delete("Date inconnue");
    groupes.set("Date inconnue", sansDate);
  }

  conteneur.innerHTML = [...groupes.entries()]
    .map(
      ([mois, docs]) => `
    <div class="groupe-mois">
      <h3 class="groupe-mois-titre">${echapper(mois)} <span class="groupe-mois-compte">${docs.length}</span></h3>
      ${docs.map((a) => construireCarteArchiveComptable(a, { doublon: idsDoublons.has(a.id) })).join("")}
    </div>`
    )
    .join("");
}

async function chargerArchivesComptables() {
  const conteneur = document.getElementById("liste-archives-comptables");
  if (!conteneur) return;

  const selectCategorie = document.getElementById("filtre-archive-categorie");
  if (selectCategorie && categoriesFactureDisponibles.length === 0) {
    try {
      const resCategories = await fetch("/api/archives-comptables/categories");
      categoriesFactureDisponibles = await resCategories.json();
      const valeurActuelle = selectCategorie.value;
      selectCategorie.innerHTML =
        `<option value="">Toutes catégories</option>` +
        categoriesFactureDisponibles.map((c) => `<option value="${echapper(c)}">${echapper(c)}</option>`).join("");
      selectCategorie.value = valeurActuelle;
    } catch {
      // Liste de categories indisponible : le filtre reste simplement vide,
      // sans bloquer l'affichage des archives elles-memes.
    }
  }

  try {
    const res = await fetch("/api/archives-comptables");
    archivesComptablesBrutes = await res.json();
    if (!res.ok) throw new Error(archivesComptablesBrutes.erreur || "Chargement impossible.");
    afficherArchivesComptablesFiltrees();
  } catch (err) {
    conteneur.innerHTML = `<p class="aide-inline">Erreur : ${echapper(err.message)}</p>`;
    return;
  }

  // Ecouteurs attaches une seule fois (chargerArchivesComptables est rappelee
  // toutes les 2 minutes par rafraichirTout) : re-filtre a la volee a chaque
  // changement, sans bouton "Appliquer" a cliquer - meme principe que les
  // filtres de factures impayees ci-dessus.
  if (!document.getElementById("filtre-archive-date-debut").dataset.initialise) {
    ID_FILTRES_ARCHIVE_COMPTABLE.forEach((id) => {
      document.getElementById(id).addEventListener("input", afficherArchivesComptablesFiltrees);
    });
    document.getElementById("filtre-archive-doublons-uniquement").addEventListener("input", afficherArchivesComptablesFiltrees);
    document.getElementById("btn-reinitialiser-filtres-archive").addEventListener("click", () => {
      ID_FILTRES_ARCHIVE_COMPTABLE.forEach((id) => {
        document.getElementById(id).value = "";
      });
      document.getElementById("filtre-archive-doublons-uniquement").checked = false;
      afficherArchivesComptablesFiltrees();
    });
    document.getElementById("filtre-archive-date-debut").dataset.initialise = "1";
  }

  const boutonReextraire = document.getElementById("btn-reextraire-archives");
  if (boutonReextraire && !boutonReextraire.dataset.initialise) {
    boutonReextraire.addEventListener("click", () => reextraireArchivesComptables(boutonReextraire));
    boutonReextraire.dataset.initialise = "1";
  }

  const boutonExporterCsv = document.getElementById("btn-exporter-archives-csv");
  if (boutonExporterCsv && !boutonExporterCsv.dataset.initialise) {
    boutonExporterCsv.addEventListener("click", exporterArchivesComptablesCsv);
    boutonExporterCsv.dataset.initialise = "1";
  }
}

// --- Comptabilite : sous-vues Mois en cours / Archives / A verifier -------
//
// Restructuration demandee par l'utilisateur : le mois en cours par defaut,
// un onglet Archives classe par annee/mois, un espace dedie "A verifier"
// (doublons + infos manquantes) - voir le plan greedy-puzzling-quail.
// basculerOnglet (plus haut) gere les onglets de PREMIER niveau ; ces
// sous-onglets sont internes au panneau Comptabilite, geres separement.

function basculerSousVueComptabilite(nom) {
  document.querySelectorAll(".archive-v2-sousonglet").forEach((b) => {
    const actif = b.dataset.sousvue === nom;
    b.classList.toggle("actif", actif);
    b.setAttribute("aria-selected", actif ? "true" : "false");
  });
  document.querySelectorAll(".archive-v2-sousvue").forEach((p) => {
    p.hidden = p.dataset.sousvuePanneau !== nom;
  });
}
window.basculerSousVueComptabilite = basculerSousVueComptabilite;

document.querySelectorAll(".archive-v2-sousonglet").forEach((b) => {
  b.addEventListener("click", () => basculerSousVueComptabilite(b.dataset.sousvue));
});

/**
 * Vue par defaut du module : uniquement les factures dont la date de
 * FACTURATION (dateFacture, pas la date d'import) tombe dans le mois en
 * cours - demande explicite de l'utilisateur. Un mois qui se termine
 * disparait de cette vue de lui-meme au changement de mois (nouvel appel
 * avec un anneeMois different), sans aucun deplacement de fichier : il
 * reste consultable via l'onglet Archives (meme donnees, filtre different).
 */
async function chargerArchivesMoisCourant() {
  const conteneur = document.getElementById("archive-v2-mois-courant-liste");
  const libelleEl = document.getElementById("archive-v2-mois-courant-libelle");
  if (!conteneur) return;

  const maintenant = new Date();
  const anneeMois = `${maintenant.getFullYear()}-${String(maintenant.getMonth() + 1).padStart(2, "0")}`;
  if (libelleEl) libelleEl.textContent = `Factures datées de ${libelleMoisAnnee(maintenant.toISOString())}.`;

  try {
    const res = await fetch(`/api/archives-comptables?anneeMois=${anneeMois}`);
    const archives = await res.json();
    if (!res.ok) throw new Error(archives.erreur || "Chargement impossible.");
    const idsDoublons = detecterIdsDoublonsArchives(archives);
    conteneur.innerHTML =
      archives.length === 0
        ? `<p class="liste-vide">Aucune facture datée du mois en cours pour le moment.</p>`
        : archives.map((a) => construireCarteArchiveComptable(a, { doublon: idsDoublons.has(a.id) })).join("");
  } catch (err) {
    conteneur.innerHTML = `<p class="aide-inline">Erreur : ${echapper(err.message)}</p>`;
  }
}

/**
 * Raccourci "Aller à un mois" de l'onglet Archives - menu deroulant compact
 * (pas un mur de boutons, demande explicite de l'utilisateur : "j'aime pas
 * le pavé... plutôt mettre quelque chose avec un filtre où on peut chercher
 * les dates qu'on veut"). Choisir un mois ici n'est qu'un raccourci qui
 * renseigne les memes champs Du/au que l'utilisateur peut aussi remplir
 * lui-meme a la main - la recherche par dates libres (barre-filtres)
 * reste le moyen principal, jamais remplace.
 */
async function chargerArchivesAnnees() {
  const select = document.getElementById("archive-v2-mois-select");
  if (!select) return;
  try {
    const res = await fetch("/api/archives-comptables/mois-disponibles");
    const mois = await res.json();
    if (!res.ok) throw new Error(mois.erreur || "Chargement impossible.");
    const valeurActuelle = select.value;
    select.innerHTML =
      `<option value="">— choisir —</option>` +
      mois.map((m) => `<option value="${echapper(m.periode)}">${echapper(m.libelle)} (${m.nombre})</option>`).join("");
    select.value = valeurActuelle;

    if (!select.dataset.initialise) {
      select.addEventListener("change", () => {
        if (!select.value) return;
        const [annee, moisNum] = select.value.split("-").map(Number);
        const dernierJour = new Date(annee, moisNum, 0).getDate();
        document.getElementById("filtre-archive-date-debut").value = `${select.value}-01`;
        document.getElementById("filtre-archive-date-fin").value = `${select.value}-${String(dernierJour).padStart(2, "0")}`;
        afficherArchivesComptablesFiltrees();
      });
      select.dataset.initialise = "1";
    }
  } catch {
    // Raccourci indisponible : la recherche par dates libres reste possible.
  }
}

/**
 * Espace "A verifier" (doublons probables + informations manquantes) -
 * demande explicite de l'utilisateur, espace dedie plutot qu'une simple
 * case a cocher perdue dans les filtres de l'onglet Archives.
 */
async function chargerArchivesAVerifier() {
  const conteneur = document.getElementById("archive-v2-a-verifier-liste");
  if (!conteneur) return;
  try {
    const res = await fetch("/api/archives-comptables/a-verifier");
    const archives = await res.json();
    if (!res.ok) throw new Error(archives.erreur || "Chargement impossible.");
    definirBadge("archive-a-verifier", archives.length);
    conteneur.innerHTML =
      archives.length === 0
        ? `<p class="liste-vide">Rien à vérifier pour le moment.</p>`
        : archives.map((a) => construireCarteArchiveComptable(a, { doublon: a.raisonAVerifier.startsWith("doublon") })).join("");
  } catch (err) {
    conteneur.innerHTML = `<p class="aide-inline">Erreur : ${echapper(err.message)}</p>`;
  }
}

/**
 * Exporte en CSV les archives actuellement affichees (apres tous les
 * filtres en cours, y compris "Doublons uniquement"/categorie) - demande
 * explicite de l'utilisateur. Genere entierement cote client : les donnees
 * sont deja en memoire (archivesComptablesFiltreesCourantes), pas besoin
 * d'un nouvel appel au serveur.
 */
function exporterArchivesComptablesCsv() {
  if (archivesComptablesFiltreesCourantes.length === 0) {
    alert("Aucune archive à exporter avec les filtres actuels.");
    return;
  }

  const echapperCsv = (valeur) => `"${String(valeur ?? "").replace(/"/g, '""')}"`;
  const lignes = [["Fournisseur", "Date", "Numéro", "Catégorie", "Montant HT", "Montant TTC", "Statut"].map(echapperCsv).join(";")];
  for (const a of archivesComptablesFiltreesCourantes) {
    lignes.push(
      [
        a.fournisseurNom || "",
        a.dateFacture ? a.dateFacture.slice(0, 10) : "",
        a.numero || "",
        a.categorie || "",
        a.montantHT != null ? String(a.montantHT).replace(".", ",") : "",
        a.montantTTC != null ? String(a.montantTTC).replace(".", ",") : "",
        a.statut === "a_verifier" ? "À vérifier" : "Complète",
      ]
        .map(echapperCsv)
        .join(";")
    );
  }
  // BOM UTF-8 en tete : sans lui, Excel (Windows) affiche les caracteres
  // accentues de travers a l'ouverture du CSV.
  const contenu = "﻿" + lignes.join("\r\n");
  const lien = document.createElement("a");
  lien.href = URL.createObjectURL(new Blob([contenu], { type: "text/csv;charset=utf-8;" }));
  lien.download = `archives-comptables-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(lien);
  lien.click();
  lien.remove();
  URL.revokeObjectURL(lien.href);
}

/**
 * Attend la fin reelle d'un traitement Comptabilite en arriere-plan (import
 * ou re-extraction) en interrogeant le Journal (deja utilise partout dans ce
 * module), puis affiche le resultat exact - demande explicite de
 * l'utilisateur : actuellement, apres un import, rien ne confirme jamais si
 * les factures ont bien ete enregistrees ou non ("je sais pas si c'est bon
 * ou pas"). Ne bloque jamais l'interface (boucle d'attente asynchrone, sans
 * await de l'appelant) - juste une mise a jour differee du message affiche.
 */
async function attendreResultatTraitementArchiveComptable(resultatConteneur, evenementSucces, evenementErreur, depuis) {
  const limite = Date.now() + 10 * 60 * 1000; // 10 minutes : largement au-dessus du temps reel observe, meme pour plusieurs centaines de fichiers.
  while (Date.now() < limite) {
    await new Promise((resolve) => setTimeout(resolve, 4000));
    try {
      const res = await fetch("/api/journal");
      const journal = await res.json();
      const evenement = journal.find(
        (e) => (e.evenement === evenementSucces || e.evenement === evenementErreur) && new Date(e.horodatage) >= depuis
      );
      if (evenement) {
        if (resultatConteneur) {
          resultatConteneur.innerHTML =
            evenement.evenement === evenementErreur
              ? `<span class="badge badge-echec">Erreur</span> ${echapper(evenement.resultat || "Échec du traitement.")}`
              : `<span class="badge badge-ok">Terminé</span> ${echapper(evenement.resultat || "")}`;
        }
        await chargerArchivesComptables();
        return;
      }
    } catch {
      // Panne reseau passagere lors d'un sondage : on reessaie au prochain
      // tour plutot que d'abandonner l'attente pour si peu.
    }
  }
  if (resultatConteneur) {
    resultatConteneur.innerHTML += ` <span class="aide-inline">(toujours en cours après 10 minutes — actualisez la page plus tard pour voir le résultat.)</span>`;
  }
}

// Relance l'extraction sur les archives restees "a verifier" (voir
// demarrerReextractionArchivesIncompletes dans archiveComptable.ts) - utile
// apres un correctif de l'extraction pour que les archives deja importees
// en beneficient sans tout re-deposer. Ne bloque pas en attendant la fin
// (meme principe que backfillMontantsFournisseurs), mais affiche bien le
// resultat exact des qu'il est connu (voir attendreResultatTraitementArchiveComptable).
async function reextraireArchivesComptables(bouton) {
  const resultatConteneur = document.getElementById("resultat-reextraction-archives");
  bouton.disabled = true;
  const texteInitial = bouton.textContent;
  bouton.textContent = "Lancement…";
  if (resultatConteneur) resultatConteneur.innerHTML = "";
  const depuis = new Date();
  try {
    const res = await fetch("/api/archives-comptables/reextraire", { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.erreur || "Relance impossible.");
    if (resultatConteneur) {
      resultatConteneur.innerHTML =
        data.total > 0
          ? `<p class="aide-inline">${data.total} archive(s) en cours de re-traitement en arrière-plan…</p>`
          : `<p class="aide-inline">Aucune archive à re-traiter pour le moment.</p>`;
    }
    if (data.total > 0) {
      attendreResultatTraitementArchiveComptable(resultatConteneur, "archive_comptable_reextraction_terminee", "archive_comptable_reextraction_erreur", depuis);
    }
  } catch (err) {
    if (resultatConteneur) resultatConteneur.innerHTML = `<p class="aide-inline">Erreur : ${echapper(err.message)}</p>`;
  } finally {
    bouton.disabled = false;
    bouton.textContent = texteInitial;
  }
}

// --- Formulaire de correction d'une facture (modale) -----------------------
//
// Remplace l'ancienne chaine de prompt() natifs (demande explicite : "une
// fenêtre de correction parfaitement utilisable sur smartphone" - un prompt()
// natif a la chaine reste utilisable mais n'est pas un vrai formulaire).
// Memes champs, meme endpoint PATCH, meme validation qu'avant - uniquement
// l'interface change.
let archiveEnCoursDeCorrectionId = null;

function ouvrirCorrectionArchive(id) {
  const archive = archivesComptablesBrutes.find((a) => a.id === id);
  if (!archive) return;
  archiveEnCoursDeCorrectionId = id;

  document.getElementById("archive-v2-correction-fournisseur").value = archive.fournisseurNom || "";
  document.getElementById("archive-v2-correction-numero").value = archive.numero || "";
  document.getElementById("archive-v2-correction-date").value = archive.dateFacture ? archive.dateFacture.slice(0, 10) : "";
  document.getElementById("archive-v2-correction-ht").value = archive.montantHT != null ? archive.montantHT : "";
  document.getElementById("archive-v2-correction-ttc").value = archive.montantTTC != null ? archive.montantTTC : "";

  const selectCategorie = document.getElementById("archive-v2-correction-categorie");
  if (selectCategorie.options.length <= 1 && categoriesFactureDisponibles.length > 0) {
    selectCategorie.innerHTML =
      `<option value="">— Aucune —</option>` + categoriesFactureDisponibles.map((c) => `<option value="${echapper(c)}">${echapper(c)}</option>`).join("");
  }
  selectCategorie.value = archive.categorie || "";

  const erreurDiv = document.getElementById("archive-v2-correction-erreur");
  erreurDiv.hidden = true;
  erreurDiv.textContent = "";

  document.getElementById("archive-v2-correction-modal").hidden = false;
}
window.ouvrirCorrectionArchive = ouvrirCorrectionArchive;

function fermerCorrectionArchive() {
  const modal = document.getElementById("archive-v2-correction-modal");
  if (modal) modal.hidden = true;
  archiveEnCoursDeCorrectionId = null;
}

(function initialiserCorrectionArchiveModal() {
  const modal = document.getElementById("archive-v2-correction-modal");
  const form = document.getElementById("archive-v2-correction-form");
  if (!modal || !form) return;

  document.getElementById("archive-v2-correction-annuler")?.addEventListener("click", fermerCorrectionArchive);
  document.getElementById("archive-v2-correction-fermer")?.addEventListener("click", fermerCorrectionArchive);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) fermerCorrectionArchive();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.hidden) fermerCorrectionArchive();
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!archiveEnCoursDeCorrectionId) return;
    const erreurDiv = document.getElementById("archive-v2-correction-erreur");
    erreurDiv.hidden = true;

    const fournisseurNom = document.getElementById("archive-v2-correction-fournisseur").value.trim();
    const numero = document.getElementById("archive-v2-correction-numero").value.trim();
    const dateSaisie = document.getElementById("archive-v2-correction-date").value; // input type=date : deja AAAA-MM-JJ ou vide
    const htBrut = document.getElementById("archive-v2-correction-ht").value;
    const ttcBrut = document.getElementById("archive-v2-correction-ttc").value;
    const categorie = document.getElementById("archive-v2-correction-categorie").value;

    const montantHT = htBrut === "" ? null : Number(htBrut);
    const montantTTC = ttcBrut === "" ? null : Number(ttcBrut);
    if ((montantHT != null && (!Number.isFinite(montantHT) || montantHT <= 0)) || (montantTTC != null && (!Number.isFinite(montantTTC) || montantTTC <= 0))) {
      erreurDiv.textContent = "Montant invalide : indiquez un nombre positif.";
      erreurDiv.hidden = false;
      return;
    }

    const boutonValider = form.querySelector('button[type="submit"]');
    boutonValider.disabled = true;
    try {
      const res = await fetch(`/api/archives-comptables/${archiveEnCoursDeCorrectionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fournisseurNom: fournisseurNom === "" ? null : fournisseurNom,
          numero: numero === "" ? null : numero,
          dateFacture: dateSaisie === "" ? null : dateSaisie,
          montantHT,
          montantTTC,
          categorie: categorie === "" ? null : categorie,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.erreur || "Enregistrement impossible.");
      const index = archivesComptablesBrutes.findIndex((a) => a.id === archiveEnCoursDeCorrectionId);
      if (index !== -1) archivesComptablesBrutes[index] = data;
      afficherArchivesComptablesFiltrees();
      // Une correction peut faire sortir/entrer l'archive de "Factures en
      // cours" (date modifiee) ou de "A verifier" (champ complete) - les 2
      // autres sous-vues doivent refleter ca tout de suite.
      chargerArchivesMoisCourant();
      chargerArchivesAVerifier();
      fermerCorrectionArchive();
    } catch (err) {
      erreurDiv.textContent = err.message;
      erreurDiv.hidden = false;
    } finally {
      boutonValider.disabled = false;
    }
  });
})();

async function supprimerArchiveComptable(id, bouton) {
  if (!confirm("Supprimer définitivement cette archive ?")) return;
  bouton.disabled = true;
  try {
    const res = await fetch(`/api/archives-comptables/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.erreur || "Suppression impossible.");
    }
    archivesComptablesBrutes = archivesComptablesBrutes.filter((a) => a.id !== id);
    afficherArchivesComptablesFiltrees();
    chargerArchivesMoisCourant();
    chargerArchivesAVerifier();
  } catch (err) {
    bouton.disabled = false;
    alert(err.message);
  }
}
window.supprimerArchiveComptable = supprimerArchiveComptable;

// Zone de depot unique (glisser-deposer + clic) pour l'import de l'archive
// Comptabilite - demande explicite de l'utilisateur ("une importation plus
// ergonomique"). Remplace les deux anciens formulaires separes (ZIP / fichiers
// individuels) : un seul ZIP depose -> /import (deballage cote serveur),
// n'importe quelle autre combinaison de PDF/JPEG/PNG -> /import-fichiers.
// Resout aussi de lui-meme le piege Windows signale en video (double-cliquer
// un ZIP dans la boite de depot NATIVE l'ouvre parfois comme un dossier) :
// un glisser-deposer ne passe jamais par cette boite de dialogue.
let fichiersArchiveComptableSelectionnes = [];

function rendreSelectionArchiveComptable() {
  const liste = document.getElementById("zone-depot-archive-comptable-liste");
  const boutonImporter = document.getElementById("btn-lancer-import-archive-comptable");
  const boutonVider = document.getElementById("btn-vider-import-archive-comptable");
  if (!liste) return;
  liste.innerHTML = fichiersArchiveComptableSelectionnes.map((f) => `<li>${echapper(f.name)}</li>`).join("");
  const vide = fichiersArchiveComptableSelectionnes.length === 0;
  boutonImporter.disabled = vide;
  boutonVider.disabled = vide;
  boutonImporter.textContent = vide ? "Importer" : `Importer (${fichiersArchiveComptableSelectionnes.length} fichier${fichiersArchiveComptableSelectionnes.length > 1 ? "s" : ""})`;
}

function ajouterFichiersArchiveComptable(fileList) {
  const resultatDiv = document.getElementById("resultat-import-archive-comptable");
  const EXTENSIONS_AUTORISEES = [".zip", ".pdf", ".jpg", ".jpeg", ".png"];
  const retenus = [...fileList].filter((f) => EXTENSIONS_AUTORISEES.some((ext) => f.name.toLowerCase().endsWith(ext)));
  if (retenus.length < fileList.length && resultatDiv) {
    resultatDiv.innerHTML = `<p class="aide-inline">${fileList.length - retenus.length} fichier(s) ignoré(s) (format non reconnu, seuls PDF/JPEG/PNG/ZIP sont acceptés).</p>`;
  }
  fichiersArchiveComptableSelectionnes = fichiersArchiveComptableSelectionnes.concat(retenus);
  rendreSelectionArchiveComptable();
}

const zoneDepotArchiveComptable = document.getElementById("zone-depot-archive-comptable");
if (zoneDepotArchiveComptable) {
  const entreeFichiers = document.getElementById("archive-comptable-entree");
  zoneDepotArchiveComptable.addEventListener("click", () => entreeFichiers.click());
  zoneDepotArchiveComptable.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      entreeFichiers.click();
    }
  });
  entreeFichiers.addEventListener("change", () => {
    ajouterFichiersArchiveComptable(entreeFichiers.files);
    entreeFichiers.value = "";
  });
  ["dragenter", "dragover"].forEach((evt) =>
    zoneDepotArchiveComptable.addEventListener(evt, (e) => {
      e.preventDefault();
      zoneDepotArchiveComptable.classList.add("zone-depot-survol");
    })
  );
  ["dragleave", "drop"].forEach((evt) =>
    zoneDepotArchiveComptable.addEventListener(evt, (e) => {
      e.preventDefault();
      zoneDepotArchiveComptable.classList.remove("zone-depot-survol");
    })
  );
  zoneDepotArchiveComptable.addEventListener("drop", (e) => {
    if (e.dataTransfer?.files?.length) ajouterFichiersArchiveComptable(e.dataTransfer.files);
  });

  document.getElementById("btn-vider-import-archive-comptable").addEventListener("click", () => {
    fichiersArchiveComptableSelectionnes = [];
    rendreSelectionArchiveComptable();
  });

  document.getElementById("btn-lancer-import-archive-comptable").addEventListener("click", async () => {
    const resultatDiv = document.getElementById("resultat-import-archive-comptable");
    const boutonImporter = document.getElementById("btn-lancer-import-archive-comptable");
    const fichiers = fichiersArchiveComptableSelectionnes;
    if (fichiers.length === 0) return;

    // Un unique .zip -> deballage cote serveur ; toute autre combinaison
    // (un ou plusieurs PDF/JPEG/PNG, meme un seul) -> depot direct.
    const estUnZipSeul = fichiers.length === 1 && fichiers[0].name.toLowerCase().endsWith(".zip");
    const donnees = new FormData();
    if (estUnZipSeul) {
      donnees.append("archive", fichiers[0]);
    } else {
      for (const f of fichiers) {
        if (f.name.toLowerCase().endsWith(".zip")) continue; // melange zip + fichiers : le zip seul n'est pas deballe ici, ignore plutot que mal interprete.
        donnees.append("fichiers", f);
      }
    }

    boutonImporter.disabled = true;
    resultatDiv.textContent = "Envoi en cours… (peut prendre un moment pour plusieurs centaines de fichiers)";
    const depuis = new Date();
    try {
      const res = await fetch(estUnZipSeul ? "/api/archives-comptables/import" : "/api/archives-comptables/import-fichiers", {
        method: "POST",
        body: donnees,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.erreur || "Échec de l'import.");
      resultatDiv.innerHTML = `${data.total} fichier(s) reçu(s), analyse en cours en arrière-plan…`;
      fichiersArchiveComptableSelectionnes = [];
      rendreSelectionArchiveComptable();
      attendreResultatTraitementArchiveComptable(resultatDiv, "archive_comptable_import_termine", "archive_comptable_import_erreur", depuis);
    } catch (err) {
      resultatDiv.innerHTML = `<span class="badge badge-echec">Erreur</span> ${echapper(err.message)}`;
      boutonImporter.disabled = fichiersArchiveComptableSelectionnes.length === 0;
    }
  });
}

async function rafraichirTout() {
  await Promise.all([chargerCockpit(), chargerGraphiqueCa(), chargerImports(), chargerMouvementsBancaires(), chargerFacturesImpayees(), chargerStatutGmail(), chargerStatutStripe(), chargerStatutSynec(), chargerStatutGoogleAds(), chargerPropositionsAds(), chargerStatutReseauxSociaux(), chargerPropositionsReseauxSociaux(), chargerStatutGoogleBusiness(), chargerPropositionsPagesJaunes(), chargerAnomalies(), chargerRelances(), chargerFacturesFournisseurs(), chargerFacturesDextEnvoyees(), chargerFournisseurs(), chargerDepensesFournisseurs(), chargerDecisions(), chargerJournal(), chargerActivitesRealisations(), chargerPhotosRealisations(), chargerArchivesComptables(), chargerArchivesMoisCourant(), chargerArchivesAnnees(), chargerArchivesAVerifier(), chargerSuiviMensuel()]);
}

document.getElementById("form-import").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("input-fichier");
  const resultatDiv = document.getElementById("resultat-import");
  const fichiers = Array.from(input.files || []);
  if (fichiers.length === 0) return;

  // Un fichier a la fois vers /api/import (le serveur ne lit qu'un fichier
  // par appel) - une ligne de resultat par fichier, affichee au fur et a
  // mesure plutot que d'attendre la fin de tous les envois.
  const lignes = fichiers.map((f) => `<li>${echapper(f.name)} — en cours…</li>`);
  resultatDiv.innerHTML = `<ul class="zone-depot-liste">${lignes.join("")}</ul>`;
  const items = resultatDiv.querySelectorAll("li");

  for (let i = 0; i < fichiers.length; i++) {
    const formData = new FormData();
    formData.append("fichier", fichiers[i]);
    try {
      const res = await fetch("/api/import", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) {
        items[i].innerHTML = `${echapper(fichiers[i].name)} — <span class="badge badge-echec">Erreur</span> ${echapper(data.erreur)}`;
        continue;
      }
      items[i].innerHTML = `
        ${echapper(fichiers[i].name)} —
        <span class="badge badge-${data.statut}">${data.statut}</span>
        Type détecté : <strong>${echapper(data.typeDetecte)}</strong> —
        ${data.nbNouveaux} nouveau(x), ${data.nbDoublons} doublon(s), ${data.nbErreurs} erreur(s) sur ${data.nbLignes} ligne(s).
      `;
    } catch (err) {
      items[i].innerHTML = `${echapper(fichiers[i].name)} — <span class="badge badge-echec">Erreur</span> ${echapper(err.message)}`;
    }
  }

  input.value = "";
  await rafraichirTout();
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
