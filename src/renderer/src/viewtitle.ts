import type { Category, FolderInfo } from '@shared/types';
import { CATEGORY_LABELS } from '@shared/types';
import type { View } from './components/Sidebar';

/**
 * Jak se jmenuje to, na co se právě člověk dívá.
 *
 * Bylo to spočítané na dvou místech — v seznamu zpráv a v hlavičce na
 * telefonu — a pokaždé trochu jinak. Hlavička brala název složky rovnou ze
 * serveru, takže nad doručenou poštou svítilo velkými písmeny `INBOX`.
 * Uživatel přitom v panelu vidí „Vše" a v seznamu „Doručená pošta"; tři
 * jména pro jednu věc.
 *
 * `INBOX` je název, který si vymyslel protokol, ne člověk — proto se
 * překládá. U ostatních složek se bere to, jak si je pojmenoval sám
 * uživatel na serveru, jen bez cesty k nadřazené složce.
 */
export function viewTitle(view: View, folders: FolderInfo[]): string {
  switch (view.type) {
    case 'orderInbox': return 'K objednávkám';
    case 'archive': return 'Archiv';
    case 'category': return CATEGORY_LABELS[view.category as Category] ?? 'Pošta';
    case 'folder': {
      if (view.folder.toUpperCase() === 'INBOX') return 'Doručená pošta';
      const known = folders.find(f => f.path === view.folder);
      return known?.name || view.folder.split('/').pop() || view.folder;
    }
    default: return 'Pošta';
  }
}

/**
 * Kolik nepřečtených v tomhle pohledu čeká.
 *
 * Vrací `0` tam, kde se to spočítat nedá (archiv, zprávy k objednávkám) —
 * ukazovat u nich prázdný odznak by jen mátlo.
 */
export function viewUnread(
  view: View,
  folders: FolderInfo[],
  catStats: Record<string, { cnt: number; unseen: number } | undefined>
): number {
  if (view.type === 'category') return catStats[view.category]?.unseen ?? 0;
  if (view.type === 'folder') return folders.find(f => f.path === view.folder)?.unseen ?? 0;
  return 0;
}
