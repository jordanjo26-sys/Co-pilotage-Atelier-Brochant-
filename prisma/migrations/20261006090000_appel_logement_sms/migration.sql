-- AlterTable
ALTER TABLE "Appel" ADD COLUMN "codePostal" TEXT,
ADD COLUMN "ville" TEXT,
ADD COLUMN "typeLogement" TEXT,
ADD COLUMN "etage" TEXT,
ADD COLUMN "codeAcces" TEXT,
ADD COLUMN "smsUrgenceEnvoyeLe" TIMESTAMP(3);
