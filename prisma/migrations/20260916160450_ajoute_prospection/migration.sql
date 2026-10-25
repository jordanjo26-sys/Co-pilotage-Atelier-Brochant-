-- CreateTable
CREATE TABLE "Prospect" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "entreprise" TEXT NOT NULL,
    "contactNom" TEXT,
    "contactFonction" TEXT,
    "email" TEXT,
    "emailScoreFiabilite" INTEGER,
    "emailSource" TEXT,
    "telephone" TEXT,
    "siteWeb" TEXT,
    "adresse" TEXT,
    "codePostal" TEXT,
    "ville" TEXT,
    "marqueProposee" TEXT,
    "serviceCible" TEXT,
    "statut" TEXT NOT NULL DEFAULT 'a_contacter',
    "notes" TEXT,
    "datePremierContact" TIMESTAMP(3),
    "dateDerniereRelance" TIMESTAMP(3),
    "desinscrit" BOOLEAN NOT NULL DEFAULT false,
    "dateDesinscription" TIMESTAMP(3),
    "source" TEXT,
    "sourceImportId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Prospect_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProspectStatutChangement" (
    "id" TEXT NOT NULL,
    "prospectId" TEXT NOT NULL,
    "ancienStatut" TEXT,
    "nouveauStatut" TEXT NOT NULL,
    "auteur" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProspectStatutChangement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProspectionImport" (
    "id" TEXT NOT NULL,
    "fichierNom" TEXT NOT NULL,
    "hashFichier" TEXT NOT NULL,
    "dateImport" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "nbLignes" INTEGER NOT NULL DEFAULT 0,
    "nbNouveaux" INTEGER NOT NULL DEFAULT 0,
    "nbDoublons" INTEGER NOT NULL DEFAULT 0,
    "nbErreurs" INTEGER NOT NULL DEFAULT 0,
    "details" TEXT,

    CONSTRAINT "ProspectionImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailTemplate" (
    "id" TEXT NOT NULL,
    "nom" TEXT NOT NULL,
    "marque" TEXT,
    "service" TEXT,
    "objet" TEXT NOT NULL,
    "corpsHtml" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Campagne" (
    "id" TEXT NOT NULL,
    "nom" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "segmentFiltre" TEXT NOT NULL,
    "statut" TEXT NOT NULL DEFAULT 'brouillon',
    "relanceApresJours" INTEGER,
    "arretSiReponse" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campagne_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EnvoiCampagne" (
    "id" TEXT NOT NULL,
    "campagneId" TEXT NOT NULL,
    "prospectId" TEXT NOT NULL,
    "tokenSuivi" TEXT NOT NULL,
    "estRelance" BOOLEAN NOT NULL DEFAULT false,
    "gmailMessageId" TEXT,
    "gmailThreadId" TEXT,
    "statut" TEXT NOT NULL DEFAULT 'envoye',
    "dateEnvoi" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dateOuverture" TIMESTAMP(3),
    "dateClic" TIMESTAMP(3),
    "dateReponse" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EnvoiCampagne_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Prospect_type_statut_idx" ON "Prospect"("type", "statut");

-- CreateIndex
CREATE INDEX "Prospect_codePostal_idx" ON "Prospect"("codePostal");

-- CreateIndex
CREATE UNIQUE INDEX "Prospect_entreprise_email_key" ON "Prospect"("entreprise", "email");

-- CreateIndex
CREATE UNIQUE INDEX "ProspectionImport_hashFichier_key" ON "ProspectionImport"("hashFichier");

-- CreateIndex
CREATE UNIQUE INDEX "EnvoiCampagne_tokenSuivi_key" ON "EnvoiCampagne"("tokenSuivi");

-- CreateIndex
CREATE INDEX "EnvoiCampagne_campagneId_idx" ON "EnvoiCampagne"("campagneId");

-- CreateIndex
CREATE INDEX "EnvoiCampagne_prospectId_idx" ON "EnvoiCampagne"("prospectId");

-- AddForeignKey
ALTER TABLE "Prospect" ADD CONSTRAINT "Prospect_sourceImportId_fkey" FOREIGN KEY ("sourceImportId") REFERENCES "ProspectionImport"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProspectStatutChangement" ADD CONSTRAINT "ProspectStatutChangement_prospectId_fkey" FOREIGN KEY ("prospectId") REFERENCES "Prospect"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campagne" ADD CONSTRAINT "Campagne_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "EmailTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnvoiCampagne" ADD CONSTRAINT "EnvoiCampagne_campagneId_fkey" FOREIGN KEY ("campagneId") REFERENCES "Campagne"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnvoiCampagne" ADD CONSTRAINT "EnvoiCampagne_prospectId_fkey" FOREIGN KEY ("prospectId") REFERENCES "Prospect"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
