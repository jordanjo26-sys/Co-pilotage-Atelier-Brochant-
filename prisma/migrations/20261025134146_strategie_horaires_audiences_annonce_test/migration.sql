-- AlterTable
ALTER TABLE "PropositionAds" ADD COLUMN     "audiences" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "cpaCibleEuros" DOUBLE PRECISION,
ADD COLUMN     "horaires" JSONB,
ADD COLUMN     "strategieEncheres" TEXT;
