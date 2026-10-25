-- AlterTable
ALTER TABLE "PropositionAds" ADD COLUMN     "callouts" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "sitelinks" JSONB,
ADD COLUMN     "structuredSnippets" JSONB;
