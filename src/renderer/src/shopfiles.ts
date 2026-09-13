import type { ArticleUpload, MediaFile } from '@shared/types';
import { api } from './api';
import { toWebp } from './media';

/**
 * Fotky a videa z počítače rovnou na e-shop.
 *
 * Cesta má tři zastávky a každá je jinde:
 *
 *  1. **výběr a převod** — obrázky převádí tohle okno (kodér WebP je
 *     v Chromiu), video ffmpeg v hlavním procesu,
 *  2. **nahrání** do správce souborů na e-shopu, což dělá okno
 *     administrace ovládané hlavním procesem,
 *  3. **adresa**, kterou článek potřebuje k odkazu — čte se z výpisu
 *     souborů, protože Upgates soubor při nahrání přejmenují a adresu
 *     složit nejde.
 *
 * Bydlí to tady, a ne v samotném editoru: totéž potřebují obrázky i videa
 * v článcích a fotky u recenzí, a tři kopie by se dřív nebo později
 * rozešly v tom, co se vlastně na e-shop nahrálo.
 */

export type UploadStep = (text: string) => void;

/** Převede a nahraje vybrané soubory; vrací adresy pro vložení do článku. */
export async function uploadToShop(files: MediaFile[], step: UploadStep): Promise<ArticleUpload[]> {
  if (files.length === 0) return [];
  const setup = await api.media.setup();
  const ready: string[] = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    step(`Převádím ${i + 1} z ${files.length} — ${file.name}`);
    if (file.kind === 'video') {
      /*
       * Video dělá ffmpeg v hlavním procesu. Trvá to podle délky, a když
       * ffmpeg v počítači není, řekne se to rovnou — převést video
       * v prohlížeči by znamenalo přehrát ho celé a přijít o kvalitu.
       */
      const out = await api.media.video(file.path);
      ready.push(out.file);
      continue;
    }
    const bytes = await api.media.read(file.path);
    const webp = await toWebp(bytes, { ...setup, crop: null });
    const saved = await api.media.write(`${file.name.replace(/\.[^.]+$/, '')}.webp`, webp.bytes);
    ready.push(saved.file);
  }

  step('Nahrávám do souborů na e-shopu — v okně administrace to je vidět');
  return await api.articles.uploadFiles(ready);
}

/** Výběr souborů z počítače; prázdné pole znamená, že se výběr zrušil. */
export async function pickForArticle(): Promise<MediaFile[]> {
  return await api.media.pick();
}

/**
 * Rozměry obrázku po převodu.
 *
 * Zeď s recenzemi je potřebuje do `width`/`height` u fotky — bez nich
 * stránka při načítání poskakuje, jak se obrázky dokreslují.
 */
export async function sizeOf(url: string): Promise<{ width: number; height: number }> {
  return await new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = url;
  });
}
