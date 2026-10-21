-- CreateTable
CREATE TABLE "MailExamine" (
    "id" TEXT NOT NULL,
    "gmailMessageId" TEXT NOT NULL,
    "important" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MailExamine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DemandeIntervention" (
    "id" TEXT NOT NULL,
    "nom" TEXT NOT NULL,
    "telephone" TEXT,
    "adresse" TEXT,
    "codePostal" TEXT,
    "ville" TEXT,
    "typeLogement" TEXT,
    "etage" TEXT,
    "codeAcces" TEXT,
    "motif" TEXT,
    "urgence" TEXT,
    "statut" TEXT NOT NULL DEFAULT 'a_saisir',
    "saisieLe" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DemandeIntervention_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MailExamine_gmailMessageId_key" ON "MailExamine"("gmailMessageId");
