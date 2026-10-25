-- CreateTable
CREATE TABLE "CampagneAdsImport" (
    "id" TEXT NOT NULL,
    "nom" TEXT NOT NULL,
    "statut" TEXT,
    "type" TEXT,
    "budgetQuotidien" DOUBLE PRECISION,
    "impressions" INTEGER,
    "clics" INTEGER,
    "cout" DOUBLE PRECISION,
    "conversions" DOUBLE PRECISION,
    "ctr" DOUBLE PRECISION,
    "cpcMoyen" DOUBLE PRECISION,
    "sourceImportId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampagneAdsImport_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "CampagneAdsImport" ADD CONSTRAINT "CampagneAdsImport_sourceImportId_fkey" FOREIGN KEY ("sourceImportId") REFERENCES "ImportBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
