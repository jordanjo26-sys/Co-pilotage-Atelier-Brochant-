-- Ecran unifie "Factures fournisseurs" (V2) : DocumentFournisseur (Gmail/Dext)
-- et ArchiveComptable doivent etre fusionnes en une seule liste SANS jamais
-- doubler une facture deja envoyee a Dext - archiverFactureEnvoyeeDext copie
-- automatiquement CHAQUE document envoye a Dext dans ArchiveComptable (voir
-- archiveComptable.ts), donc sans marqueur explicite ces copies apparaitraient
-- deux fois (une fois comme DocumentFournisseur, une fois comme
-- ArchiveComptable). "origine" distingue desormais les trois provenances
-- reelles d'une ligne ArchiveComptable ; seule "dext_copie" est exclue de la
-- liste unifiee (deja representee par son DocumentFournisseur d'origine).
-- "documentFournisseurId" n'est pas une vraie relation Prisma (meme principe
-- que mouvementBancaireId plus haut dans ce modele) : juste l'identifiant du
-- DocumentFournisseur source, verifie par requete applicative.
--
-- Les lignes existantes ne peuvent pas etre reclassees avec certitude (avant
-- ce changement, rien ne distinguait une copie Dext d'un import ZIP manuel :
-- les deux chemins laissaient classifiePar a NULL) - sauf les imports OVH,
-- deja identifiables via classifiePar='ovh_api'. Choix delibere : laisser
-- "origine" a NULL pour le reste de l'historique plutot que de deviner,
-- quitte a ce qu'un ancien doublon Dext/archive reste visible un temps dans
-- l'ecran unifie (deja detectable via l'outil de doublons existant) - jamais
-- risquer de masquer une facture reellement distincte.
ALTER TABLE "ArchiveComptable" ADD COLUMN "origine" TEXT;
ALTER TABLE "ArchiveComptable" ADD COLUMN "documentFournisseurId" TEXT;

UPDATE "ArchiveComptable" SET "origine" = 'ovh_api' WHERE "classifiePar" = 'ovh_api';
