/**
 * Rozpoznání zvláštních složek.
 *
 * Server o složce buď řekne, k čemu je (`specialUse`), nebo taky ne — pak
 * nezbývá než název. Heuristika je schválně stejná jako v `imap.ts`, aby
 * rozhraní a stahování nepovažovaly za odeslanou poštu každé svoji složky.
 */

interface FolderLike {
  path: string;
  specialUse?: string | null;
}

const NAMES: Record<string, string[]> = {
  '\\Sent': ['sent', 'odeslan'],
  '\\Drafts': ['draft', 'koncept'],
  '\\Trash': ['trash', 'deleted', 'kos', 'koš'],
  '\\Archive': ['archive', 'archiv']
};

export function isSpecialFolder(folder: FolderLike | undefined | null, use: string): boolean {
  if (!folder) return false;
  if (folder.specialUse === use) return true;
  // Bez příznaku ze serveru se jde podle názvu — jinak by u řady schránek
  // nebyla odeslaná pošta k rozeznání od kterékoli jiné složky
  if (folder.specialUse) return false;
  const path = folder.path.toLowerCase();
  return (NAMES[use] ?? []).some(name => path.includes(name));
}

/**
 * Složka, kde je zajímavý příjemce, ne odesílatel.
 *
 * V odeslané poště i v konceptech je odesílatel pořád tentýž — my. Sloupec
 * s naším vlastním jménem u každého řádku nedává smysl; hledá se v nich
 * podle toho, komu to šlo.
 */
export function isOutgoingFolder(folder: FolderLike | undefined | null): boolean {
  return isSpecialFolder(folder, '\\Sent') || isSpecialFolder(folder, '\\Drafts');
}
