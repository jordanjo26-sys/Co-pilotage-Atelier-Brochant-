import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { LeadInput } from "./lead-schema";

// Base SQLite locale et autonome pour ce site : aucun lien avec la base
// Postgres du copilote Atelier Brochant (autre projet, autre dépôt logique).
// Pour la production, DATABASE_PATH peut pointer vers un volume persistant ;
// à terme, cette couche peut être remplacée par un vrai CRM (voir README).
const dbPath = process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "leads.db");

declare global {
  var __leadsDb: Database.Database | undefined;
}

function createConnection() {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS leads (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      type_logement TEXT NOT NULL,
      statut_occupant TEXT NOT NULL,
      travaux TEXT NOT NULL,
      surface TEXT NOT NULL,
      code_postal TEXT NOT NULL,
      delai_travaux TEXT NOT NULL,
      prenom TEXT NOT NULL,
      nom TEXT NOT NULL,
      telephone TEXT NOT NULL,
      email TEXT NOT NULL,
      consentement INTEGER NOT NULL,
      source TEXT,
      campagne TEXT,
      support TEXT,
      contenu_annonce TEXT,
      mot_cle TEXT,
      gclid TEXT,
      fbclid TEXT,
      page_origine TEXT,
      statut TEXT NOT NULL DEFAULT 'nouveau'
    );
    CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads(created_at);
    CREATE INDEX IF NOT EXISTS idx_leads_code_postal ON leads(code_postal);
  `);
  return db;
}

// Réutilise la connexion entre hot-reloads en dev (évite les erreurs
// "database is locked" / trop de handles ouverts avec `next dev`).
const db = globalThis.__leadsDb ?? createConnection();
if (process.env.NODE_ENV !== "production") {
  globalThis.__leadsDb = db;
}

export interface StoredLead extends LeadInput {
  id: string;
  createdAt: string;
  statut: string;
}

const insertStmt = db.prepare(`
  INSERT INTO leads (
    id, created_at, type_logement, statut_occupant, travaux, surface,
    code_postal, delai_travaux, prenom, nom, telephone, email, consentement,
    source, campagne, support, contenu_annonce, mot_cle, gclid, fbclid,
    page_origine, statut
  ) VALUES (
    @id, @createdAt, @typeLogement, @statutOccupant, @travaux, @surface,
    @codePostal, @delaiTravaux, @prenom, @nom, @telephone, @email, @consentement,
    @source, @campagne, @support, @contenuAnnonce, @motCle, @gclid, @fbclid,
    @pageOrigine, @statut
  )
`);

export function saveLead(input: LeadInput): StoredLead {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const statut = "nouveau";

  insertStmt.run({
    id,
    createdAt,
    typeLogement: input.typeLogement,
    statutOccupant: input.statutOccupant,
    travaux: input.travaux,
    surface: input.surface,
    codePostal: input.codePostal,
    delaiTravaux: input.delaiTravaux,
    prenom: input.prenom,
    nom: input.nom,
    telephone: input.telephone,
    email: input.email,
    consentement: input.consentement ? 1 : 0,
    source: input.source ?? null,
    campagne: input.campagne ?? null,
    support: input.support ?? null,
    contenuAnnonce: input.contenuAnnonce ?? null,
    motCle: input.motCle ?? null,
    gclid: input.gclid ?? null,
    fbclid: input.fbclid ?? null,
    pageOrigine: input.pageOrigine ?? null,
    statut,
  });

  return { ...input, id, createdAt, statut };
}

export function countLeads(): number {
  const row = db.prepare("SELECT COUNT(*) as n FROM leads").get() as { n: number };
  return row.n;
}
