import { ask } from './ai';
import { getSettings } from './settings';

/**
 * Jednoduchá černá ikonka k odkazu pod bannerem.
 *
 * ## Proč vůbec
 *
 * Do kolečka v pruhu odkazů se dá dát emoji nebo vlastní obrázek. Emoji
 * je na každém systému jiné (a na Windows často škaredé), vlastní obrázek
 * se musí nakreslit a nahrát. Mezi tím chybělo to nejběžnější: „dej tam
 * něco jednoduchého, co vypadá jako kravata".
 *
 * ## Proč model nekreslí SVG, ale jen tvary
 *
 * Nechat model napsat celé SVG a vložit ho na e-shop by znamenalo pustit
 * na cizí stránku kus kódu, který nikdo nečetl — SVG umí skripty, odkazy
 * i vnořené obrázky. Model proto vrací **jen geometrii**: cesty, kružnice,
 * obdélníky a čáry v mřížce 24×24. Čísla a písmena cest se ověří a SVG
 * složí aplikace sama. Co model vymyslí navíc, prostě propadne sítem.
 *
 * ## Proč se to nenahrává na e-shop
 *
 * Hotová ikonka má pár set bajtů, takže jde do plánu rovnou jako
 * `data:` adresa. Odpadá tím nahrávání i čekání, jestli se adresa přečte,
 * a ikonka se ukáže i v náhledu, který ještě nebyl vystavený.
 */

/** Kolik variant se nabídne. Čtyři se vejdou do řádku a je z čeho vybírat. */
export const ICON_COUNT = 4;

const SYSTEM = `Jsi návrhář piktogramů pro e-shop. Kreslíš JEN geometrii, žádný kód.

Dostaneš název kategorie. Vrať ${ICON_COUNT} různé varianty jednoduché
jednobarevné ikonky, která ten pojem vystihuje — jako ikonky v mobilní
aplikaci: obrysové, bez stínů, bez textu, bez barev.

Pravidla kresby:
- Mřížka je 24 × 24. Kresli mezi 3 a 21, ať má ikonka okraj.
- Drž se 1 až 5 tvarů. Ikonka o dvaceti tazích je v kolečku 60 px šum.
- Varianty se mají lišit nápadem (jiný pohled, jiný detail), ne o pixel.

Vrať JEN JSON bez komentářů a bez markdownu:
{"ikony":[{"popis":"stručně co to je","plne":false,"tvary":[
  {"cesta":"M4 12 L20 12"},
  {"kruh":[12,12,5]},
  {"obdelnik":[5,7,14,10,2]},
  {"cara":[4,4,20,20]}
]}]}

"plne": true znamená plocha vyplněná černou, false obrys tahem (obvyklejší).
V "cesta" je obsah atributu d: jen písmena M L H V C S Q T A Z a čísla.`;

interface Shape { cesta?: string; kruh?: number[]; obdelnik?: number[]; cara?: number[] }

/** Souřadnice smí ven z mřížky jen kousek — zbytek by se oříznul. */
const num = (value: any): number | null => {
  const one = Number(value);
  return Number.isFinite(one) && one >= -6 && one <= 30 ? Math.round(one * 100) / 100 : null;
};

const nums = (value: any, count: number): number[] | null => {
  if (!Array.isArray(value) || value.length < count) return null;
  const out = value.slice(0, count).map(num);
  return out.every(one => one !== null) ? out as number[] : null;
};

/**
 * Obsah atributu `d`.
 *
 * Povolená jsou jen písmena příkazů a čísla. Cokoli jiného (uvozovka,
 * `<`, `url(`) by z geometrie udělalo cestu, jak do SVG dostat něco
 * jiného než čáru.
 */
function pathData(value: any): string {
  const one = String(value ?? '').trim();
  if (!/^[MmLlHhVvCcSsQqTtAaZz][MmLlHhVvCcSsQqTtAaZz0-9eE ,.+-]{3,900}$/.test(one)) return '';
  return one;
}

const attr = (value: number) => String(value);

/** Z ověřených tvarů poskládané SVG. Skládá ho aplikace, ne model. */
export function iconSvg(shapes: Shape[], solid = false): string {
  const parts: string[] = [];
  for (const shape of (shapes ?? []).slice(0, 6)) {
    const d = pathData(shape?.cesta);
    if (d) { parts.push(`<path d="${d}"/>`); continue; }
    const kruh = nums(shape?.kruh, 3);
    if (kruh && kruh[2] > 0) {
      parts.push(`<circle cx="${attr(kruh[0])}" cy="${attr(kruh[1])}" r="${attr(kruh[2])}"/>`);
      continue;
    }
    const box = nums(shape?.obdelnik, 4);
    if (box && box[2] > 0 && box[3] > 0) {
      const r = nums(shape?.obdelnik, 5)?.[4] ?? 0;
      parts.push(`<rect x="${attr(box[0])}" y="${attr(box[1])}" width="${attr(box[2])}"`
        + ` height="${attr(box[3])}" rx="${attr(Math.max(0, r))}"/>`);
      continue;
    }
    const cara = nums(shape?.cara, 4);
    if (cara) {
      parts.push(`<line x1="${attr(cara[0])}" y1="${attr(cara[1])}"`
        + ` x2="${attr(cara[2])}" y2="${attr(cara[3])}"/>`);
    }
  }
  if (parts.length === 0) return '';
  /*
   * Tah, ne výplň. Obrysová ikonka drží tvar i v kolečku o 54 px, kdežto
   * vyplněná plocha se v té velikosti slije do černé skvrny. Zaoblené
   * konce tahů jsou tu kvůli e-shopu — jeho písmo je měkké a ostře
   * useknuté čáry vedle něj působí technicky.
   */
  const paint = solid
    ? 'fill="#000000" stroke="none"'
    : 'fill="none" stroke="#000000" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ${paint}>${parts.join('')}</svg>`;
}

/** SVG jako adresa. Base64 schválně — v `url(...)` na e-shopu nesmí být uvozovka ani mezera. */
export function svgUrl(svg: string): string {
  if (!svg) return '';
  const url = `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
  // Pojistka proti ikonce, která by nafoukla plán pro web
  return url.length <= 6000 ? url : '';
}

export interface IconIdea { url: string; note: string }

/**
 * Návrhy ikonek k názvu.
 *
 * Vrací víc variant naráz: první nápad modelu bývá ten nejobecnější
 * (krabička, nákupní taška) a teprve mezi čtyřmi je z čeho vybírat.
 */
export async function iconIdeas(label: string, hint = ''): Promise<IconIdea[]> {
  const name = String(label ?? '').trim().slice(0, 60);
  if (!name) throw new Error('Napiš nejdřív název odkazu — podle čeho jinak kreslit?');

  const prompt = hint.trim()
    ? `Kategorie: ${name}\nUpřesnění: ${hint.trim().slice(0, 200)}`
    : `Kategorie: ${name}`;
  const raw = await ask(getSettings().draftModel, SYSTEM, prompt, 2000);

  let data: any = null;
  try {
    // Model občas obalí JSON do bloku s ```; bere se to, co je mezi závorkami
    const cut = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
    data = JSON.parse(cut);
  } catch {
    throw new Error('Model nevrátil použitelný návrh. Zkus to ještě jednou.');
  }

  const out: IconIdea[] = [];
  for (const one of (Array.isArray(data?.ikony) ? data.ikony : []).slice(0, ICON_COUNT)) {
    const url = svgUrl(iconSvg(one?.tvary, !!one?.plne));
    if (!url) continue;
    // Dvě varianty stejné do puntíku jsou k ničemu — vybírá se mezi rozdíly
    if (out.some(hotovo => hotovo.url === url)) continue;
    out.push({ url, note: String(one?.popis ?? '').trim().slice(0, 40) });
  }
  if (out.length === 0) throw new Error('Z návrhu nezbyl žádný použitelný tvar. Zkus to ještě jednou.');
  return out;
}

export const __test = { iconSvg, svgUrl, pathData };
