-- CreateTable
CREATE TABLE "ArchiveComptable" (
    "id" TEXT NOT NULL,
    "fichierNom" TEXT NOT NULL,
    "cheminFichier" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "fournisseurNom" TEXT,
    "numero" TEXT,
    "dateFacture" TIMESTAMP(3),
    "montantHT" DOUBLE PRECISION,
    "montantTTC" DOUBLE PRECISION,
    "statut" TEXT NOT NULL DEFAULT 'a_verifier',
    "classifiePar" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArchiveComptable_pkey" PRIMARY KEY ("id")
);
