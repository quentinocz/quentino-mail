import type { ShootFix } from '../../../shared/types';

/**
 * Korekce barev a bílého pozadí.
 *
 * ## Proč se to počítá tady a ne v hlavním procesu
 *
 * Fotka se stejně musí vykreslit na plátno, aby se dala převést do WebP —
 * a jakmile je na plátně, jsou její pixely po ruce zadarmo. Počítat totéž
 * v hlavním procesu by znamenalo nativní knihovnu navíc a obrázek by putoval
 * přes IPC dvakrát.
 *
 * ## Proč zrovna tyhle kroky
 *
 * Produktová fotka na bílém pozadí má dvě typické vady, a obě vzniknou ještě
 * před zmáčknutím spouště. Zaprvé **barva světla**: LED panel je nazelenalý,
 * okno namodralé, žárovka oranžová — tělo to v automatu srovná různě u každé
 * fotky, takže série není jednotná. Zadruhé **pozadí není bílé**: papír je
 * bílý, ale ve stínu je šedý, a na e-shopu se to pozná okamžitě, protože
 * stránka kolem bílá je.
 *
 * Proto je pořadí kroků dané a ne libovolné: nejdřív se srovná bílá (jinak
 * by se do dalších kroků táhl barevný nádech), pak expozice a kontrast
 * (mění, co je „skoro bílé"), a **až úplně nakonec se dočišťuje pozadí** —
 * kdyby se čistilo dřív, kontrast by z vybělené plochy zase udělal šedou.
 */

export type Rgb = { r: number; g: number; b: number };

/**
 * Jak dlouhý je přechod mezi „ještě produkt" a „už pozadí".
 *
 * Šest úrovní jasu. Míň by kolem produktu udělalo ostrý obrys — přesně ten
 * „vystřižený" vzhled, kterého si na špatně retušovaných fotkách všimne
 * každý. Víc by znamenalo, že „dočistit na sto procent" papír nevybělí:
 * když se přechod táhne až k 255, skončí pozadí na 250 a na e-shopu bude
 * pořád vidět jako šedý obdélník.
 */
const BG_RAMP = 6;

export function parseWhite(text: string): Rgb | null {
  const parts = String(text ?? '').split(',').map(one => Number(one.trim()));
  if (parts.length !== 3 || parts.some(one => !Number.isFinite(one))) return null;
  const [r, g, b] = parts;
  if (r <= 0 || g <= 0 || b <= 0) return null;
  return { r, g, b };
}

/**
 * Zesílení kanálů tak, aby vybrané místo vyšlo neutrálně šedé.
 *
 * Zesílení je omezené na dvojnásobek a polovinu. Bez toho stačí kliknout
 * do stínu nebo na barevný produkt a jeden kanál vyletí tak, že z fotky
 * zbude barevná kaše — a protože se kliká do náhledu, splete se to snadno.
 */
export function whiteGains(white: Rgb): Rgb {
  const gray = (white.r + white.g + white.b) / 3;
  const clamp = (value: number) => Math.max(0.5, Math.min(2, value));
  return {
    r: clamp(gray / white.r),
    g: clamp(gray / white.g),
    b: clamp(gray / white.b)
  };
}

/** Jas, jak ho vnímá oko. Zelené je pro oko světlejší než modré při stejném čísle. */
export function luma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function clamp255(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

/**
 * Nastavení, které z fotky vyjde samo.
 *
 * ## Jak se hledá bílá bez toho, aby ji člověk klikal
 *
 * Nejsvětlejší bod fotky bílá není — bývá to odlesk, a ten je přepálený,
 * takže má všechny kanály na 255 a o barvě světla neřekne nic. Proto se
 * bere pásmo **pod** nejsvětlejším procentem: to už je papír pozadí, ještě
 * neořezaný, a jeho barevný nádech je přesně ten, který se má srovnat.
 *
 * Práh pro dočištění pozadí se pak posadí těsně pod tohle pásmo, aby se
 * vybělil papír a ne produkt.
 */
export function autoFix(data: Uint8ClampedArray): Partial<ShootFix> {
  const histogram = new Uint32Array(256);
  let count = 0;
  // Každý čtvrtý pixel stačí — histogram z milionu bodů vypadá stejně jako ze čtyř
  for (let i = 0; i < data.length; i += 16) {
    histogram[Math.round(luma(data[i], data[i + 1], data[i + 2]))]++;
    count++;
  }
  if (!count) return {};

  // Hranice nejsvětlejšího procenta: nad ní jsou odlesky, pod ní papír
  const skip = Math.round(count * 0.01);
  let seen = 0;
  let top = 255;
  for (let level = 255; level >= 0; level--) {
    seen += histogram[level];
    if (seen >= skip) { top = level; break; }
  }
  /*
   * Pod hranicí odlesků nic dost světlého není — focené neleží na bílém
   * pozadí. Bílá se pak nehádá vůbec: vymyslet ji z tmavé fotky znamená
   * posunout barvy náhodně a to je horší než nechat je být. Práh je 170,
   * protože tak světlý je i papír ve slabém světle, ale šedé pozadí
   * ani stůl už ne.
   */
  if (top < 170) return { white: '', background: 0 };

  // Pásmo papíru: pět procent pod hranicí odlesků
  const low = Math.max(0, top - 13);

  let r = 0, g = 0, b = 0, hits = 0;
  for (let i = 0; i < data.length; i += 16) {
    const value = luma(data[i], data[i + 1], data[i + 2]);
    if (value < low || value > top) continue;
    r += data[i]; g += data[i + 1]; b += data[i + 2];
    hits++;
  }
  // Pár rozstřelených bodů není pozadí, ze kterého by se dala číst barva
  if (hits < 20) return { white: '', background: 0 };

  return {
    white: `${Math.round(r / hits)},${Math.round(g / hits)},${Math.round(b / hits)}`,
    background: 60,
    // O tři níž, aby se chytil i papír ve stínu, ale ne světlá látka pod ním
    backgroundLevel: Math.max(200, Math.min(250, low - 3))
  };
}

/**
 * Hotové sady pro opakované focení.
 *
 * Nejsou to filtry pro efekt — každá odpovídá jedné situaci u stolu, do
 * které se člověk při focení zboží opakovaně dostane.
 */
export const PRESETS: { id: string; label: string; hint: string; fix: Partial<ShootFix> }[] = [
  {
    id: 'bile-pozadi', label: 'Bílé pozadí', hint: 'Papír do čista, barvy beze změny',
    fix: { exposure: 0.1, contrast: 4, saturation: 0, temperature: 0, background: 70, backgroundLevel: 240 }
  },
  {
    id: 'latka', label: 'Látka a vazba', hint: 'Vytáhne strukturu, pozadí nechá jen srovnat',
    fix: { exposure: 0.05, contrast: 12, saturation: 6, temperature: 0, background: 35, backgroundLevel: 244 }
  },
  {
    id: 'verne', label: 'Věrné barvy', hint: 'Jen vyvážení bílé, nic dalšího',
    fix: { exposure: 0, contrast: 0, saturation: 0, temperature: 0, background: 0, backgroundLevel: 242 }
  },
  {
    id: 'teple', label: 'Teplejší', hint: 'Pro hnědé a béžové zboží, ať není šedivé',
    fix: { exposure: 0.05, contrast: 3, saturation: 4, temperature: 12, background: 50, backgroundLevel: 241 }
  },
  {
    id: 'studene', label: 'Studenější', hint: 'Pro bílé a stříbrné, ať nežloutne',
    fix: { exposure: 0.05, contrast: 3, saturation: 2, temperature: -12, background: 60, backgroundLevel: 240 }
  }
];

export function preset(id: string): Partial<ShootFix> | null {
  return PRESETS.find(one => one.id === id)?.fix ?? null;
}

/**
 * Projede pixely a upraví je na místě.
 *
 * Pracuje se přímo v poli z plátna, bez kopie: u dvacetimegapixelové fotky
 * je to osmdesát megabajtů a druhá kopie by na slabším stroji znamenala
 * vteřinu čekání navíc u každého snímku.
 */
export function applyFix(data: Uint8ClampedArray, fix: ShootFix): void {
  if (!fix.on) return;

  const white = parseWhite(fix.white);
  const gains = white ? whiteGains(white) : { r: 1, g: 1, b: 1 };

  // Teplota: teplejší přidá červenou a ubere modrou, studenější naopak
  const warm = (fix.temperature || 0) / 100;
  const gainR = gains.r * (1 + warm * 0.3);
  const gainG = gains.g;
  const gainB = gains.b * (1 - warm * 0.3);

  const exposure = Math.pow(2, fix.exposure || 0);
  // Standardní vzorec pro kontrast; 0 nechá obraz beze změny
  const c = Math.max(-100, Math.min(100, fix.contrast || 0));
  const contrast = (259 * (c + 255)) / (255 * (259 - c));
  const saturation = 1 + (fix.saturation || 0) / 100;

  const bgStrength = Math.max(0, Math.min(100, fix.background || 0)) / 100;
  const bgLevel = Math.max(0, Math.min(255, fix.backgroundLevel ?? 242));

  for (let i = 0; i < data.length; i += 4) {
    let r = data[i] * gainR * exposure;
    let g = data[i + 1] * gainG * exposure;
    let b = data[i + 2] * gainB * exposure;

    if (c !== 0) {
      r = contrast * (r - 128) + 128;
      g = contrast * (g - 128) + 128;
      b = contrast * (b - 128) + 128;
    }

    if (saturation !== 1) {
      const value = luma(r, g, b);
      r = value + (r - value) * saturation;
      g = value + (g - value) * saturation;
      b = value + (b - value) * saturation;
    }

    r = clamp255(r); g = clamp255(g); b = clamp255(b);

    if (bgStrength > 0) {
      /*
       * Bělí se podle **nejtmavšího** kanálu, ne podle jasu. Sytě žlutá má
       * vysoký jas, ale nízkou modrou — podle jasu by se vybělila spolu
       * s papírem, podle nejtmavšího kanálu zůstane.
       *
       * Přechod je plynulý (`t`), ne skokový: ostrá hranice by kolem
       * produktu udělala viditelný obrys, přesně ten „vystřižený" vzhled,
       * kterého si na špatně retušovaných fotkách všimne každý.
       */
      const floor = r < g ? (r < b ? r : b) : (g < b ? g : b);
      if (floor > bgLevel) {
        const t = Math.min(1, (floor - bgLevel) / BG_RAMP) * bgStrength;
        r += (255 - r) * t;
        g += (255 - g) * t;
        b += (255 - b) * t;
      }
    }

    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
  }
}

/** Dá se z nastavení poznat, že se na obrázku něco změní? */
export function fixActive(fix: ShootFix): boolean {
  if (!fix.on) return false;
  return !!parseWhite(fix.white)
    || !!fix.exposure || !!fix.contrast || !!fix.saturation
    || !!fix.temperature || !!fix.background;
}

/** Totéž jako `applyFix`, ale pro náhled — jako filtr CSS, bez čtení pixelů. */
export function cssFilter(fix: ShootFix): string {
  if (!fix.on) return '';
  const parts: string[] = [];
  if (fix.exposure) parts.push(`brightness(${(Math.pow(2, fix.exposure)).toFixed(3)})`);
  if (fix.contrast) parts.push(`contrast(${(1 + fix.contrast / 100).toFixed(3)})`);
  if (fix.saturation) parts.push(`saturate(${(1 + fix.saturation / 100).toFixed(3)})`);
  if (fix.temperature) parts.push(`sepia(${Math.min(0.4, Math.abs(fix.temperature) / 250).toFixed(3)})`);
  return parts.join(' ');
}

/* ---------- kontrola snímku ---------- */

/**
 * Ostrost podle hran.
 *
 * ## Proč se to vůbec počítá
 *
 * Na displeji fotoaparátu ani na náhledu v okně se rozmazání nepozná —
 * náhled má osminu rozlišení, takže i fotka mimo zaostření v něm vypadá
 * dobře. Zjistí se to až u počítače, kdy je zboží dávno uklizené a znovu
 * se stejně nepostaví.
 *
 * ## Jak
 *
 * Laplace: rozdíl bodu proti čtyřem sousedům. Na ostré hraně je velký,
 * v rozmazané ploše malý. Měří se **rozptyl** těch rozdílů, ne jejich
 * průměr — průměr je u souměrné hrany nula.
 *
 * ## Co číslo znamená
 *
 * Samo o sobě nic. Fotka kravaty s výraznou vazbou má i rozostřená větší
 * čísla než hladká jednobarevná ostrá — hodnota závisí na obsahu. Smysl
 * dává **porovnání v rámci jednoho focení**, kde se fotí totéž: tam
 * nejnižší hodnota v sérii opravdu znamená nejhůř zaostřený kus.
 */
export function sharpness(data: Uint8ClampedArray, width: number, height: number): number {
  if (width < 3 || height < 3) return 0;

  const gray = new Float32Array(width * height);
  for (let i = 0, at = 0; i < data.length; i += 4, at++) {
    gray[at] = luma(data[i], data[i + 1], data[i + 2]);
  }

  let sum = 0;
  let squares = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const at = y * width + x;
      const edge = 4 * gray[at]
        - gray[at - 1] - gray[at + 1] - gray[at - width] - gray[at + width];
      sum += edge;
      squares += edge * edge;
      count++;
    }
  }
  if (!count) return 0;
  const mean = sum / count;
  return Math.max(0, squares / count - mean * mean);
}

/**
 * Podíl přepálených míst v procentech.
 *
 * Počítá se podle **nejsvětlejšího** kanálu: přepálená je i plocha, kde
 * dojela jen červená, i když ostatní mají rezervu — a právě tam vzniká
 * barevný lem, kterého si na fotce všimne každý.
 *
 * Bílé pozadí se do toho nepočítá, protože přepálené bílé pozadí je
 * záměr. Bere se jen to, co je uvnitř ořezu a co je barevné — tedy s
 * rozdílem mezi kanály.
 */
export function clipping(data: Uint8ClampedArray, level = 250): number {
  let hits = 0;
  let count = 0;
  /*
   * Čte se každý čtvrtý bod. Podíl přepalů se na dvaceti megapixelech
   * vzorkem nezmění ani o desetinu procenta, ale projít je všechny znamená
   * sto milionů porovnání a s nimi vteřinu, po kterou okno stojí — zrovna
   * ve chvíli, kdy se člověk dívá, jestli fotka dopadla.
   */
  for (let i = 0; i < data.length; i += 16) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    count++;
    const top = r > g ? (r > b ? r : b) : (g > b ? g : b);
    if (top < level) continue;
    const floor = r < g ? (r < b ? r : b) : (g < b ? g : b);
    /*
     * Neutrálně světlý bod se za přepal **nepočítá**, ani když je na
     * čisté bílé. U produktu na bílém papíru je vybílené pozadí záměr —
     * hlásit ho znamená hlásit u každé fotky, a varování, které svítí
     * pořád, si za týden nikdo nevšimne.
     *
     * Počítá se barevný přepal: jeden kanál dojel a ostatní ne, takže na
     * hraně vznikl barevný lem. Ten je vada, a to i na bílém pozadí.
     * Práh patnácti úrovní je tam, kde je nádech vidět okem.
     */
    if (top - floor >= 15) hits++;
  }
  return count ? (hits / count) * 100 : 0;
}

/**
 * Ořez v pixelech ze zlomkového rámečku.
 *
 * Zaokrouhluje se ven a ořezává na hranice obrazu — jinak u fotky
 * 6000 px na šířku vyjde ze zaokrouhlení rámeček o pixel menší a
 * z „čtverce" je obdélník 2999×3000, který na e-shopu nesedí do řady.
 */
export function cropBox(
  crop: { x: number; y: number; w: number; h: number },
  width: number,
  height: number
): { x: number; y: number; w: number; h: number } {
  const x = Math.max(0, Math.min(width - 1, Math.round(crop.x * width)));
  const y = Math.max(0, Math.min(height - 1, Math.round(crop.y * height)));
  const w = Math.max(1, Math.min(width - x, Math.round(crop.w * width)));
  const h = Math.max(1, Math.min(height - y, Math.round(crop.h * height)));
  return { x, y, w, h };
}

/** Poměry stran, které dávají u produktové fotky smysl. */
export const RATIOS: { id: string; label: string; value: number | null }[] = [
  { id: '1:1', label: 'Čtverec', value: 1 },
  { id: '4:5', label: 'Na výšku 4:5', value: 4 / 5 },
  { id: '3:4', label: 'Na výšku 3:4', value: 3 / 4 },
  { id: '3:2', label: 'Na šířku 3:2', value: 3 / 2 },
  { id: '', label: 'Volně', value: null }
];

export function ratioValue(id: string): number | null {
  return RATIOS.find(one => one.id === id)?.value ?? null;
}

/**
 * Srovná rámeček do zadaného poměru.
 *
 * Řídí se **kratší** stranou, takže se rámeček nikdy nezvětší přes okraj
 * obrazu. Kdyby se řídil delší, vyjel by čtverec tažený u kraje mimo
 * snímek a ořízlo by se i to, co tam není.
 */
export function lockRatio(
  box: { x: number; y: number; w: number; h: number },
  ratio: number | null,
  frame: number
): { x: number; y: number; w: number; h: number } {
  if (!ratio) return box;
  // `frame` je poměr stran obrazu — rámeček je v podílech, takže čtverec
  // na širokém snímku není stejné číslo na šířku a na výšku
  const wantW = Math.min(box.w, (box.h * ratio) / frame);
  const wantH = wantW * frame / ratio;
  return { ...box, w: wantW, h: wantH };
}
