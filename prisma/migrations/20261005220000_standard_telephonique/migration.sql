-- CreateTable
CREATE TABLE "Appel" (
    "id" TEXT NOT NULL,
    "callSid" TEXT NOT NULL,
    "numeroAppelant" TEXT,
    "statut" TEXT NOT NULL DEFAULT 'en_cours',
    "conversation" JSONB NOT NULL DEFAULT '[]',
    "transcription" JSONB NOT NULL DEFAULT '[]',
    "enAttente" TEXT,
    "silences" INTEGER NOT NULL DEFAULT 0,
    "erreurs" INTEGER NOT NULL DEFAULT 0,
    "nom" TEXT,
    "telephone" TEXT,
    "adresse" TEXT,
    "motif" TEXT,
    "urgence" TEXT,
    "rendezVousDebut" TIMESTAMP(3),
    "rendezVousFin" TIMESTAMP(3),
    "rendezVousEventId" TEXT,
    "enregistrementUrl" TEXT,
    "notifieLe" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Appel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Appel_callSid_key" ON "Appel"("callSid");
