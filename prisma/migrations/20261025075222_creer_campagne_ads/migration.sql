-- AlterTable
ALTER TABLE "PropositionAds" ADD COLUMN     "budgetQuotidien" DOUBLE PRECISION,
ADD COLUMN     "descriptions" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "motsCles" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "motsClesExclus" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "titres" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "urlFinale" TEXT;
