import type { MediaCrop, MediaSetup, MediaWatch } from '@shared/types';
import { api } from './api';

/**
 * Převod obrázků do WebP — v okně, ne v hlavním procesu.
 *
 * Electron má v sobě celé Chromium i s kodérem WebP: obrázek se vykreslí
 * na plátno a plátno se uloží. Žádná nativní knihovna, žádné překládání
 * při instalaci, na Macu i na Windows stejný výsledek.
 *
 * Bydlí to tady, a ne v modulu s rozhraním, protože **totéž potřebují dvě
 * místa**: modul konvertoru a hlídané složky pro focení, které běží i se
 * zavřeným modulem. Dvě kopie téhle funkce by se dřív nebo později
 * rozešly v tom nejhorším — v kvalitě výsledku.
 */

/*
 * Z přenesených bajtů blob. Přes IPC přijde `Uint8Array`, který může sedět
 * na sdílené paměti; `slice()` z něj udělá vlastní kopii, se kterou si
 * `Blob` i `createImageBitmap` rozumí všude.
 */
export function bytesToBlob(bytes: Uint8Array, type = ''): Blob {
  return new Blob([new Uint8Array(bytes).slice().buffer], type ? { type } : undefined);
}

/** Jak velký má být výsledek. Nastavení je stejné u dávky i u hlídané složky. */
export type SizeRules = Pick<MediaSetup,
  'resize' | 'maxWidth' | 'maxHeight' | 'exactWidth' | 'exactHeight' | 'percent' | 'keepSmaller'>;

/**
 * Cílový rozměr.
 *
 * Zvětšovat se zásadně nesmí: z malé fotky se velká neudělá, jen rozmazaná
 * — a soubor přitom naroste. Od toho je `keepSmaller`.
 */
export function targetSize(width: number, height: number, s: SizeRules):
  { width: number; height: number } {
  if (!width || !height) return { width, height };
  if (s.resize === 'keep') return { width, height };

  if (s.resize === 'percent') {
    const k = Math.max(1, Math.min(400, s.percent)) / 100;
    if (s.keepSmaller && k > 1) return { width, height };
    return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
  }
  if (s.resize === 'exact') {
    return { width: Math.max(1, s.exactWidth), height: Math.max(1, s.exactHeight) };
  }
  // `max` — zmenšit tak, aby se to vešlo do mezí; poměr stran zůstává
  const k = Math.min(s.maxWidth / width, s.maxHeight / height);
  if (k >= 1) return { width, height };
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

/**
 * Ořez → zmenšení → komprese, přesně v tomhle pořadí.
 *
 * Zmenšovat to, co se pak stejně ořízne, znamená zahodit pixely, které
 * jsou ještě potřeba: z oříznuté poloviny fotky zmenšené na 1600 px vyjde
 * ostřejší výsledek než z ořezu už zmenšené fotky.
 */
export async function toWebp(
  bytes: Uint8Array,
  options: SizeRules & { quality: number; crop?: MediaCrop | null }
): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  const bitmap = await createImageBitmap(bytesToBlob(bytes));
  try {
    const crop = options.crop ?? { x: 0, y: 0, w: 1, h: 1 };
    const sx = Math.max(0, Math.round(crop.x * bitmap.width));
    const sy = Math.max(0, Math.round(crop.y * bitmap.height));
    const sw = Math.max(1, Math.min(bitmap.width - sx, Math.round(crop.w * bitmap.width)));
    const sh = Math.max(1, Math.min(bitmap.height - sy, Math.round(crop.h * bitmap.height)));

    const target = targetSize(sw, sh, options);
    const canvas = document.createElement('canvas');
    canvas.width = target.width;
    canvas.height = target.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('plátno se nepodařilo připravit');
    /*
     * Vyhlazení na „high". Bez něj zmenšuje Chromium nejbližším sousedem
     * a na jemné struktuře látky — tedy přesně na tom, co se tu fotí —
     * z toho je moaré.
     */
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, target.width, target.height);

    const blob: Blob | null = await new Promise(resolve =>
      canvas.toBlob(resolve, 'image/webp', Math.max(1, Math.min(100, options.quality)) / 100));
    if (!blob) throw new Error('převod do WebP se nepovedl');
    return {
      bytes: new Uint8Array(await blob.arrayBuffer()),
      width: target.width,
      height: target.height
    };
  } finally {
    bitmap.close();
  }
}

/**
 * Zpracuje fotku, která přibyla v hlídané složce.
 *
 * Výsledek jde do podsložky vedle originálu a zapíše se do výpisu — ať je
 * vidět, že to jede, i když je modul zavřený. Chyba se taky zapíše: tichý
 * neúspěch u věci, která běží na pozadí, se pozná až podle chybějících
 * souborů.
 */
export async function handleIncoming(folder: MediaWatch, file: { path: string; name: string; size: number }) {
  const at = new Date().toISOString();
  try {
    const bytes = await api.media.read(file.path);
    const out = await toWebp(bytes, { ...folder, crop: folder.crop });
    const saved = await api.media.writeBeside(file.path, folder.subfolder, out.bytes);
    if (saved.skipped) return;
    await api.media.watchNote({
      at, folder: folder.path, name: file.name, before: file.size, after: saved.size, error: ''
    });
  } catch (e: any) {
    await api.media.watchNote({
      at, folder: folder.path, name: file.name, before: file.size, after: 0,
      error: String(e?.message ?? e)
    }).catch(() => {});
  }
}
