-- CreateTable
CREATE TABLE "GmailMessageTraite" (
    "id" TEXT NOT NULL,
    "gmailMessageId" TEXT NOT NULL,
    "traiteLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GmailMessageTraite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GmailMessageTraite_gmailMessageId_key" ON "GmailMessageTraite"("gmailMessageId");
