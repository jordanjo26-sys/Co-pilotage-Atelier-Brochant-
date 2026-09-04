-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL,
    "synecId" TEXT,
    "nom" TEXT NOT NULL,
    "email" TEXT,
    "telephone" TEXT,
    "type" TEXT,
    "source" TEXT,
    "adresse" TEXT,
    "codePostal" TEXT,
    "ville" TEXT,
    "pays" TEXT,
    "notes" TEXT,
    "sourceImportId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Facture" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "clientId" TEXT,
    "clientNom" TEXT NOT NULL,
    "description" TEXT,
    "dateEmission" TIMESTAMP(3),
    "dateEcheance" TIMESTAMP(3),
    "montantHT" DOUBLE PRECISION,
    "montantTTC" DOUBLE PRECISION NOT NULL,
    "montantRegle" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "statut" TEXT NOT NULL,
    "modePaiement" TEXT,
    "bonCommande" TEXT,
    "delaiAccordeJusqua" TIMESTAMP(3),
    "financementOney" BOOLEAN NOT NULL DEFAULT false,
    "clotureSynec" BOOLEAN NOT NULL DEFAULT false,
    "sourceImportId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Facture_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Paiement" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "paymentRef" TEXT NOT NULL,
    "brut" DOUBLE PRECISION NOT NULL,
    "frais" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "net" DOUBLE PRECISION NOT NULL,
    "devise" TEXT NOT NULL DEFAULT 'EUR',
    "date" TIMESTAMP(3) NOT NULL,
    "clientEmail" TEXT,
    "payoutRef" TEXT,
    "factureId" TEXT,
    "sourceImportId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Paiement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payout" (
    "id" TEXT NOT NULL,
    "payoutRef" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "montantNet" DOUBLE PRECISION NOT NULL,
    "statut" TEXT,
    "destinationName" TEXT,
    "balanceTransactionRef" TEXT,
    "mouvementBancaireId" TEXT,
    "sourceImportId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MouvementBancaire" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "libelle" TEXT NOT NULL,
    "debit" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "credit" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "montant" DOUBLE PRECISION NOT NULL,
    "rapprochementStatut" TEXT NOT NULL DEFAULT 'non_rapproche',
    "hashLigne" TEXT NOT NULL,
    "sourceImportId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MouvementBancaire_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecapitulatifSolde" (
    "id" TEXT NOT NULL,
    "categorie" TEXT NOT NULL,
    "libelle" TEXT NOT NULL,
    "montantNet" DOUBLE PRECISION NOT NULL,
    "devise" TEXT NOT NULL DEFAULT 'EUR',
    "sourceImportId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecapitulatifSolde_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Fournisseur" (
    "id" TEXT NOT NULL,
    "nom" TEXT NOT NULL,
    "modeReception" TEXT,
    "portailUrl" TEXT,
    "modePaiement" TEXT,
    "prelevementLcr" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Fournisseur_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentFournisseur" (
    "id" TEXT NOT NULL,
    "fournisseurId" TEXT,
    "type" TEXT NOT NULL,
    "fichierNom" TEXT,
    "numero" TEXT,
    "date" TIMESTAMP(3),
    "montant" DOUBLE PRECISION,
    "statutDext" TEXT NOT NULL DEFAULT 'non_envoye',
    "hashFichier" TEXT,
    "gmailMessageId" TEXT,
    "gmailExpediteur" TEXT,
    "gmailObjet" TEXT,
    "dateReceptionMail" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentFournisseur_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GmailConnexion" (
    "id" TEXT NOT NULL,
    "compteEmail" TEXT NOT NULL,
    "refreshTokenChiffre" TEXT NOT NULL,
    "scope" TEXT,
    "actif" BOOLEAN NOT NULL DEFAULT true,
    "connecteLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "derniereSynchro" TIMESTAMP(3),
    "dernierHistoryId" TEXT,

    CONSTRAINT "GmailConnexion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FactureFournisseur" (
    "id" TEXT NOT NULL,
    "fournisseurId" TEXT,
    "reference" TEXT,
    "echeance" TIMESTAMP(3),
    "montant" DOUBLE PRECISION NOT NULL,
    "modePaiement" TEXT,
    "statut" TEXT NOT NULL DEFAULT 'a_payer',
    "sousTraitant" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FactureFournisseur_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Decision" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "motif" TEXT,
    "dateDebut" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dateFin" TIMESTAMP(3),
    "auteur" TEXT,
    "objetType" TEXT,
    "objetId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Decision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Anomalie" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "gravite" TEXT NOT NULL DEFAULT 'moyenne',
    "preuves" TEXT,
    "actionProposee" TEXT,
    "statut" TEXT NOT NULL DEFAULT 'a_valider',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Anomalie_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalEvenement" (
    "id" TEXT NOT NULL,
    "horodatage" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "evenement" TEXT NOT NULL,
    "action" TEXT,
    "resultat" TEXT,
    "details" TEXT,

    CONSTRAINT "JournalEvenement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL,
    "fichierNom" TEXT NOT NULL,
    "typeDetecte" TEXT NOT NULL,
    "hashFichier" TEXT NOT NULL,
    "dateImport" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "nbLignes" INTEGER NOT NULL DEFAULT 0,
    "nbNouveaux" INTEGER NOT NULL DEFAULT 0,
    "nbDoublons" INTEGER NOT NULL DEFAULT 0,
    "nbErreurs" INTEGER NOT NULL DEFAULT 0,
    "statut" TEXT NOT NULL DEFAULT 'ok',
    "details" TEXT,

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Client_synecId_key" ON "Client"("synecId");

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
CREATE INDEX "DocumentFournisseur_gmailMessageId_idx" ON "DocumentFournisseur"("gmailMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "GmailConnexion_compteEmail_key" ON "GmailConnexion"("compteEmail");

-- CreateIndex
CREATE UNIQUE INDEX "ImportBatch_hashFichier_key" ON "ImportBatch"("hashFichier");

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_sourceImportId_fkey" FOREIGN KEY ("sourceImportId") REFERENCES "ImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Facture" ADD CONSTRAINT "Facture_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Facture" ADD CONSTRAINT "Facture_sourceImportId_fkey" FOREIGN KEY ("sourceImportId") REFERENCES "ImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Paiement" ADD CONSTRAINT "Paiement_factureId_fkey" FOREIGN KEY ("factureId") REFERENCES "Facture"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Paiement" ADD CONSTRAINT "Paiement_sourceImportId_fkey" FOREIGN KEY ("sourceImportId") REFERENCES "ImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_sourceImportId_fkey" FOREIGN KEY ("sourceImportId") REFERENCES "ImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MouvementBancaire" ADD CONSTRAINT "MouvementBancaire_sourceImportId_fkey" FOREIGN KEY ("sourceImportId") REFERENCES "ImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecapitulatifSolde" ADD CONSTRAINT "RecapitulatifSolde_sourceImportId_fkey" FOREIGN KEY ("sourceImportId") REFERENCES "ImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentFournisseur" ADD CONSTRAINT "DocumentFournisseur_fournisseurId_fkey" FOREIGN KEY ("fournisseurId") REFERENCES "Fournisseur"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FactureFournisseur" ADD CONSTRAINT "FactureFournisseur_fournisseurId_fkey" FOREIGN KEY ("fournisseurId") REFERENCES "Fournisseur"("id") ON DELETE SET NULL ON UPDATE CASCADE;
