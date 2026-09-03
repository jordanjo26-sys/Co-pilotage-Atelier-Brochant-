import crypto from "node:crypto";

export function sha256Hex(input: Buffer | string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

/**
 * Empreinte stable d'une ligne de mouvement bancaire, utilisee pour detecter
 * les doublons lorsque la banque ne fournit pas d'identifiant unique.
 */
export function hashBankRow(date: string, libelle: string, montant: number): string {
  return sha256Hex(`${date}|${libelle.trim().toLowerCase()}|${montant.toFixed(2)}`);
}
