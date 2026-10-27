import { test } from "node:test";
import assert from "node:assert/strict";
import { markdownSimpleVersHtml, construireEmailHtml } from "../src/services/emailFormat";

// Mise en forme HTML des e-mails automatiques (analyse Google Ads,
// recapitulatifs...) : jusqu'ici du texte brut uniquement, signale illisible
// par l'utilisateur des que le contenu depasse quelques lignes. Couvre le
// sous-ensemble de Markdown vraiment utilise par nos prompts (titres,
// listes, gras, tableaux) et la degradation gracieuse du reste.

test("markdownSimpleVersHtml : titres de niveau 1 a 3", () => {
  const html = markdownSimpleVersHtml("# Titre principal\n## Sous-titre\n### Sous-sous-titre");
  assert.match(html, /<h2[^>]*>Titre principal<\/h2>/);
  assert.match(html, /<h3[^>]*>Sous-titre<\/h3>/);
  assert.match(html, /<h4[^>]*>Sous-sous-titre<\/h4>/);
});

test("markdownSimpleVersHtml : liste a puces regroupee dans un seul <ul>", () => {
  const html = markdownSimpleVersHtml("- premier point\n- deuxieme point\n- troisieme point");
  assert.equal((html.match(/<ul/g) || []).length, 1);
  assert.equal((html.match(/<li/g) || []).length, 3);
  assert.match(html, /premier point/);
});

test("markdownSimpleVersHtml : gras **texte**", () => {
  const html = markdownSimpleVersHtml("Le cout est **12,50 EUR** aujourd'hui.");
  assert.match(html, /<strong>12,50 EUR<\/strong>/);
});

test("markdownSimpleVersHtml : paragraphe simple pour une ligne sans syntaxe particuliere", () => {
  const html = markdownSimpleVersHtml("Rien de notable aujourd'hui.");
  assert.match(html, /<p[^>]*>Rien de notable aujourd'hui\.<\/p>/);
});

test("markdownSimpleVersHtml : tableau avec ligne de separation", () => {
  const markdown = "| Mot-cle | Cout | Conversions |\n|---|---|---|\n| serrurier paris | 45,20 EUR | 0 |\n| depannage urgence | 12,00 EUR | 3 |";
  const html = markdownSimpleVersHtml(markdown);
  assert.match(html, /<table/);
  assert.match(html, /<th[^>]*>Mot-cle<\/th>/);
  assert.match(html, /<th[^>]*>Cout<\/th>/);
  assert.match(html, /<td[^>]*>serrurier paris<\/td>/);
  assert.match(html, /<td[^>]*>3<\/td>/);
  // La ligne de separation ne doit jamais apparaitre comme une ligne de donnees
  assert.ok(!html.includes("<td") || !html.match(/<td[^>]*>---<\/td>/));
});

test("markdownSimpleVersHtml : echappe le HTML (contenu genere, jamais fait confiance aveuglement)", () => {
  const html = markdownSimpleVersHtml("Le terme <script>alert(1)</script> & \"citation\" doit rester du texte.");
  assert.ok(!html.includes("<script>"));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&amp;/);
});

test("markdownSimpleVersHtml : lignes vides separent les blocs sans produire de paragraphes vides", () => {
  const html = markdownSimpleVersHtml("Premier paragraphe.\n\n\nDeuxieme paragraphe.");
  assert.equal((html.match(/<p/g) || []).length, 2);
});

test("construireEmailHtml : inclut le titre, le sous-titre et le corps converti", () => {
  const html = construireEmailHtml({ titre: "Analyse Google Ads", sousTitre: "27/10/2026", corpsMarkdown: "## Etat general\n- **3** conversions cette semaine" });
  assert.match(html, /<!doctype html>/);
  assert.match(html, /Analyse Google Ads/);
  assert.match(html, /27\/10\/2026/);
  assert.match(html, /<h3[^>]*>Etat general<\/h3>/);
  assert.match(html, /<strong>3<\/strong>/);
});

test("construireEmailHtml : sous-titre absent n'affiche rien a la place (pas de ligne vide incongrue)", () => {
  const html = construireEmailHtml({ titre: "Recapitulatif", corpsMarkdown: "Rien a signaler." });
  assert.match(html, /Recapitulatif/);
  assert.match(html, /Rien a signaler/);
});
