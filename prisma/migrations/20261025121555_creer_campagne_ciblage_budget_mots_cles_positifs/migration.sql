-- AlterTable
ALTER TABLE "PropositionAds" ADD COLUMN     "ciblesGeographiques" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "numeroTelephone" TEXT,
ADD COLUMN     "typeCorrespondance" TEXT;
