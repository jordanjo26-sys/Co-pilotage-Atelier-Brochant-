-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "nom" TEXT NOT NULL,
    "email" TEXT,
    "telephone" TEXT,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Facture" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reference" TEXT NOT NULL,
    "clientId" TEXT,
    "clientNom" TEXT NOT NULL,
    "description" TEXT,
    "dateEmission" DATETIME,
    "dateEcheance" DATETIME,
    "montantHT" REAL,
    "montantTTC" REAL NOT NULL,
    "montantRegle" REAL NOT NULL DEFAULT 0,
    "statut" TEXT NOT NULL,
    "modePaiement" TEXT,
    "bonCommande" TEXT,
    "delaiAccordeJusqua" DATETIME,
    "financementOney" BOOLEAN NOT NULL DEFAULT false,
    "clotureSynec" BOOLEAN NOT NULL DEFAULT false,
    "sourceImportId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Facture_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Facture_sourceImportId_fkey" FOREIGN KEY ("sourceImportId") REFERENCES "ImportBatch" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Paiement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "source" TEXT NOT NULL,
    "paymentRef" TEXT NOT NULL,
    "brut" REAL NOT NULL,
    "frais" REAL NOT NULL DEFAULT 0,
    "net" REAL NOT NULL,
    "devise" TEXT NOT NULL DEFAULT 'EUR',
    "date" DATETIME NOT NULL,
    "clientEmail" TEXT,
    "payoutRef" TEXT,
    "factureId" TEXT,
    "sourceImportId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Paiement_factureId_fkey" FOREIGN KEY ("factureId") REFERENCES "Facture" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Paiement_sourceImportId_fkey" FOREIGN KEY ("sourceImportId") REFERENCES "ImportBatch" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Payout" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "payoutRef" TEXT NOT NULL,
    "date" DATETIME NOT NULL,
    "montantNet" REAL NOT NULL,
    "statut" TEXT,
    "destinationName" TEXT,
    "balanceTransactionRef" TEXT,
    "mouvementBancaireId" TEXT,
    "sourceImportId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Payout_sourceImportId_fkey" FOREIGN KEY ("sourceImportId") REFERENCES "ImportBatch" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MouvementBancaire" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "date" DATETIME NOT NULL,
    "libelle" TEXT NOT NULL,
    "debit" REAL NOT NULL DEFAULT 0,
    "credit" REAL NOT NULL DEFAULT 0,
    "montant" REAL NOT NULL,
    "rapprochementStatut" TEXT NOT NULL DEFAULT 'non_rapproche',
    "hashLigne" TEXT NOT NULL,
    "sourceImportId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MouvementBancaire_sourceImportId_fkey" FOREIGN KEY ("sourceImportId") REFERENCES "ImportBatch" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RecapitulatifSolde" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "categorie" TEXT NOT NULL,
    "libelle" TEXT NOT NULL,
    "montantNet" REAL NOT NULL,
    "devise" TEXT NOT NULL DEFAULT 'EUR',
    "sourceImportId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RecapitulatifSolde_sourceImportId_fkey" FOREIGN KEY ("sourceImportId") REFERENCES "ImportBatch" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Fournisseur" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "nom" TEXT NOT NULL,
    "modeReception" TEXT,
    "portailUrl" TEXT,
    "modePaiement" TEXT,
    "prelevementLcr" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "DocumentFournisseur" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "fournisseurId" TEXT,
    "type" TEXT NOT NULL,
    "fichierNom" TEXT,
    "numero" TEXT,
    "date" DATETIME,
    "montant" REAL,
    "statutDext" TEXT NOT NULL DEFAULT 'non_envoye',
    "hashFichier" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DocumentFournisseur_fournisseurId_fkey" FOREIGN KEY ("fournisseurId") REFERENCES "Fournisseur" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FactureFournisseur" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "fournisseurId" TEXT,
    "reference" TEXT,
    "echeance" DATETIME,
    "montant" REAL NOT NULL,
    "modePaiement" TEXT,
    "statut" TEXT NOT NULL DEFAULT 'a_payer',
    "sousTraitant" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FactureFournisseur_fournisseurId_fkey" FOREIGN KEY ("fournisseurId") REFERENCES "Fournisseur" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Decision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "motif" TEXT,
    "dateDebut" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dateFin" DATETIME,
    "auteur" TEXT,
    "objetType" TEXT,
    "objetId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Anomalie" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "gravite" TEXT NOT NULL DEFAULT 'moyenne',
    "preuves" TEXT,
    "actionProposee" TEXT,
    "statut" TEXT NOT NULL DEFAULT 'a_valider',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "JournalEvenement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "horodatage" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "evenement" TEXT NOT NULL,
    "action" TEXT,
    "resultat" TEXT,
    "details" TEXT
);

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "fichierNom" TEXT NOT NULL,
    "typeDetecte" TEXT NOT NULL,
    "hashFichier" TEXT NOT NULL,
    "dateImport" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "nbLignes" INTEGER NOT NULL DEFAULT 0,
    "nbNouveaux" INTEGER NOT NULL DEFAULT 0,
    "nbDoublons" INTEGER NOT NULL DEFAULT 0,
    "nbErreurs" INTEGER NOT NULL DEFAULT 0,
    "statut" TEXT NOT NULL DEFAULT 'ok',
    "details" TEXT
);

-- CreateIndex
CREATE UNIQUE INDEX "Facture_reference_key" ON "Facture"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "Paiement_paymentRef_key" ON "Paiement"("paymentRef");

-- CreateIndex
CREATE UNIQUE INDEX "Payout_payoutRef_key" ON "Payout"("payoutRef");

-- CreateIndex
CREATE UNIQUE INDEX "MouvementBancaire_hashLigne_key" ON "MouvementBancaire"("hashLigne");

-- CreateIndex
CREATE UNIQUE INDEX "RecapitulatifSolde_categorie_libelle_key" ON "RecapitulatifSolde"("categorie", "libelle");

-- CreateIndex
CREATE UNIQUE INDEX "Fournisseur_nom_key" ON "Fournisseur"("nom");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentFournisseur_hashFichier_key" ON "DocumentFournisseur"("hashFichier");

-- CreateIndex
CREATE UNIQUE INDEX "ImportBatch_hashFichier_key" ON "ImportBatch"("hashFichier");
