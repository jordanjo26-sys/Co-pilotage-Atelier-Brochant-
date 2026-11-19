-- CreateTable
CREATE TABLE "Encaissement" (
    "id" TEXT NOT NULL,
    "factureId" TEXT NOT NULL,
    "date" TIMESTAMP(3),
    "montant" DOUBLE PRECISION NOT NULL,
    "mode" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Encaissement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Encaissement_factureId_idx" ON "Encaissement"("factureId");

-- AddForeignKey
ALTER TABLE "Encaissement" ADD CONSTRAINT "Encaissement_factureId_fkey" FOREIGN KEY ("factureId") REFERENCES "Facture"("id") ON DELETE CASCADE ON UPDATE CASCADE;
