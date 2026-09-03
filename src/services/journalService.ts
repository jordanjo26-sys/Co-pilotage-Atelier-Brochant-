import { PrismaClient } from "@prisma/client";

export interface JournalEntryInput {
  evenement: string;
  action?: string;
  resultat?: string;
  details?: unknown;
}

/**
 * Enregistre une ligne dans le journal de decisions (section 12 du cahier
 * des charges) : evenement, interprétation/action, resultat, horodatage.
 */
export async function logEvenement(prisma: PrismaClient, entry: JournalEntryInput) {
  return prisma.journalEvenement.create({
    data: {
      evenement: entry.evenement,
      action: entry.action,
      resultat: entry.resultat,
      details: entry.details ? JSON.stringify(entry.details) : null,
    },
  });
}
