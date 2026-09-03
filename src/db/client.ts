import { PrismaClient } from "@prisma/client";

// Instance unique partagee de PrismaClient (evite l'epuisement des
// connexions en dev avec le rechargement a chaud).
export const prisma = new PrismaClient();
