-- CreateTable
CREATE TABLE "Relance" (
    "id" TEXT NOT NULL,
    "factureId" TEXT NOT NULL,
    "palier" TEXT NOT NULL,
    "destinataire" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Relance_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Relance" ADD CONSTRAINT "Relance_factureId_fkey" FOREIGN KEY ("factureId") REFERENCES "Facture"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
