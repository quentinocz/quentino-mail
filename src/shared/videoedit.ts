/**
 * Střih krátkého videa s titulky — model a výpočet časové osy.
 *
 * ## Proč je to tady a ne v hlavním procesu
 *
 * Tentýž výpočet potřebují **dvě strany**: okno, které kreslí časovou osu
 * a přehrává náhled, a ffmpeg, který z toho staví hotové video. Kdyby si
 * každá strana počítala po svém, náhled by ukazoval titulek v jinou chvíli,
 * než v jaké se vypálí — a to je chyba, kterou člověk najde až v hotovém
 * videu na Instagramu. Proto je čas jeden a spočítaný na jednom místě.
 *
 * ## Jak se skládá výsledek
 *
 * Záběry jdou za sebou. Mezi dvěma záběry je buď **střih** (`zadny`), nebo
 * **přechod** — a přechod se s oběma záběry překrývá, takže výsledek je
 * o jeho délku kratší. Přesně o tohle se časy titulků rozcházejí, když se
 * počítají „od začátku záběru": titulek u pátého záběru by byl posunutý
 * o součet všech přechodů před ním.
 *
 * Záběry spojené střihem se proto sdruží do **skupiny** (ffmpeg je slepí
 * `concat`em, což je přesně tvrdý střih) a přechody jsou vždy jen mezi
 * skupinami (`xfade`). Časy titulků se vztahují k hotovému videu.
 */

/** Přechod mezi dvěma záběry. Názvy odpovídají filtru `xfade` v ffmpegu. */
export type VidPrechod = 'zadny' | 'prolinacka' | 'cerna' | 'bila' | 'posun' | 'setreni' | 'kruh';

/** Co který přechod udělá a jak se jmenuje ve ffmpegu. */
export const PRECHODY: Record<VidPrechod, { nazev: string; popis: string; xfade: string }> = {
  zadny: { nazev: 'Střih', popis: 'Bez přechodu — záběr rovnou vystřídá druhý.', xfade: '' },
  prolinacka: { nazev: 'Prolínačka', popis: 'Jeden záběr se plynule převleče do druhého.', xfade: 'fade' },
  cerna: { nazev: 'Přes černou', popis: 'Ztmavne a zesvětlí. Odděluje části, které spolu nesouvisí.', xfade: 'fadeblack' },
  bila: { nazev: 'Přes bílou', popis: 'Zableskne. Sluší čistým záběrům na světlém pozadí.', xfade: 'fadewhite' },
  posun: { nazev: 'Posun', popis: 'Nový záběr přijede z pravé strany.', xfade: 'slideleft' },
  setreni: { nazev: 'Rozpad', popis: 'Záběr se rozpadne do druhého po zrnech.', xfade: 'dissolve' },
  kruh: { nazev: 'Kruh', popis: 'Nový záběr se otevře kruhem ze středu.', xfade: 'circleopen' }
};

/**
 * Jeden záběr. `od`/`do` jsou sekundy **ve zdrojovém souboru**, ne ve
 * výsledku — prostříhání se dělá tady, ne v přehrávači.
 */
export interface VidKlip {
  id: string;
  soubor: string;
  /** Délka celého zdroje. Jen pro rozhraní, aby šlo táhnout za konec. */
  zdrojDelka: number;
  od: number;
  do: number;
  /** Přechod **před** tímhle záběrem. U prvního se nepoužije. */
  prechod: VidPrechod;
  /** Délka přechodu v sekundách. */
  prechodDelka: number;
  /** Vložená znělka — v rozhraní se označí, ať je poznat od vlastního záběru. */
  znelka?: boolean;
  /**
   * Přiblížení obrazu, 1 = celý záběr. Nad jedničku se ořezává.
   *
   * Natáčí se na šířku, publikuje na výšku — a automatický ořez ze středu
   * trefí půlku kravaty a kus zdi. Tímhle se dá vybrat, co ve svislém
   * formátu zůstane.
   */
  zoom?: number;
  /** Posun výřezu, −1 až 1 (0 = na střed). */
  posunX?: number;
  posunY?: number;
}

/** Hodnoty výřezu i tam, kde je záběr ještě nemá. */
export function vyrez(k: VidKlip): { zoom: number; x: number; y: number } {
  const zoom = Math.max(1, Math.min(3, k.zoom || 1));
  return {
    zoom,
    x: Math.max(-1, Math.min(1, k.posunX ?? 0)),
    y: Math.max(-1, Math.min(1, k.posunY ?? 0))
  };
}

/**
 * Posun obrazu v náhledu, aby okno ukazovalo týž výřez jako ffmpeg.
 *
 * Náhled kreslí prohlížeč (`object-fit: cover`, tedy totéž co zvětšení
 * na formát a ořez ze středu), pak se přiblíží o `zoom`. Okno widí
 * prostřední část, kterou lze posunout nejvýš o polovinu přesahu —
 * a protože se `translate` v CSS použije **před** zvětšením, dělí se
 * posun ještě `zoom`em. Bez toho by náhled ukazoval jiný výřez než
 * hotové video a ořez by se ladil naslepo.
 */
export function vyrezStyl(k: VidKlip): { transform: string } {
  const { zoom, x, y } = vyrez(k);
  if (zoom === 1 && x === 0 && y === 0) return { transform: 'none' };
  const tx = (-x * (zoom - 1)) / (2 * zoom) * 100;
  const ty = (-y * (zoom - 1)) / (2 * zoom) * 100;
  return { transform: `scale(${zoom}) translate(${tx.toFixed(3)}%, ${ty.toFixed(3)}%)` };
}

/**
 * Rozdělí záběr v daném čase výsledného videa na dva.
 *
 * Z jednoho dlouhého záběru se tím dá udělat několik kratších, mezi
 * kterými jde nastavit přechod — a hlavně vyhodit to, co je uprostřed.
 * Vrací nový seznam; když čas do záběru nespadá, vrátí původní.
 */
export function rozdel(klipy: VidKlip[], index: number, casVeZdroji: number, novéId: () => string): VidKlip[] {
  const k = klipy[index];
  if (!k) return klipy;
  const kde = Math.max(k.od + MIN_KLIP, Math.min(k.do - MIN_KLIP, casVeZdroji));
  if (kde <= k.od || kde >= k.do) return klipy;
  const prvni: VidKlip = { ...k, do: kde };
  // Druhá půlka navazuje střihem — přechod by se tu vzal odkud?
  const druha: VidKlip = { ...k, id: novéId(), od: kde, prechod: 'zadny', prechodDelka: k.prechodDelka };
  return [...klipy.slice(0, index), prvni, druha, ...klipy.slice(index + 1)];
}

/** Vzhled titulku. Kreslí se na plátno, takže se náhled i výsledek shodují. */
export type VidStyl = 'klasik' | 'pruh' | 'vyrazny' | 'cedule' | 'jemny';

export const STYLY: Record<VidStyl, { nazev: string; popis: string }> = {
  klasik: { nazev: 'Klasik', popis: 'Bílé písmo s černým obtahem. Čitelné na čemkoli.' },
  pruh: { nazev: 'Pruh', popis: 'Bílé písmo na tmavém pruhu. Na nesourodém pozadí nejjistější.' },
  vyrazny: { nazev: 'Výrazný', popis: 'Velké tučné verzálky doprostřed. Pro krátká hesla.' },
  cedule: { nazev: 'Cedulka', popis: 'Text v šalvějové ceduli — barva z e-shopu.' },
  jemny: { nazev: 'Jemný', popis: 'Drobné světlé písmo. Nekřičí a nepřebíjí záběr.' }
};

export type VidPozice = 'nahore' | 'stred' | 'dole';

export const POZICE: Record<VidPozice, string> = {
  nahore: 'Nahoře',
  stred: 'Doprostřed',
  dole: 'Dole'
};

/**
 * Jeden titulek. Časy jsou sekundy **ve výsledném videu**.
 *
 * Text je pro každý trh jiný, časy pro všechny stejné — a to je hlavní
 * úspora práce: časová osa se nastaví jednou a pro další trhy se jen
 * přeloží slova.
 */
export interface VidTitulek {
  id: string;
  od: number;
  do: number;
  styl: VidStyl;
  pozice: VidPozice;
  /** Text podle jazyka trhu: `{ CS: 'Ahoj', EN: 'Hello' }`. */
  texty: Record<string, string>;
}

export type VidZvukDruh = 'original' | 'soubor' | 'ticho';

export interface VidZvuk {
  druh: VidZvukDruh;
  /** U `soubor` cesta k hudbě nebo k nahrávce z mikrofonu. */
  soubor?: string;
  /** Výstřižek ze zvuku — sekundy ve zdroji. */
  od?: number;
  do?: number;
  /** Délka zdroje, jen pro rozhraní. */
  zdrojDelka?: number;
  /** 0–1,5. Nad jedničku se zvuk zesiluje. */
  hlasitost?: number;
}

/** Co má daný trh jinak než zdroj. Prázdné = všechno se bere ze zdroje. */
export interface VidTrh {
  /** Vlastní záběry místo společných. Titulky zůstávají stejné. */
  klipy?: VidKlip[];
  zvuk?: VidZvuk;
}

export type VidPomer = '9:16' | '4:5' | '1:1' | '16:9';

export const POMERY: Record<VidPomer, { nazev: string; sirka: number; vyska: number; popis: string }> = {
  '9:16': { nazev: '9:16', sirka: 1080, vyska: 1920, popis: 'Reel a stories — na celý telefon.' },
  '4:5': { nazev: '4:5', sirka: 1080, vyska: 1350, popis: 'Příspěvek do mřížky, nejvyšší povolený.' },
  '1:1': { nazev: '1:1', sirka: 1080, vyska: 1080, popis: 'Čtverec, klasika do mřížky.' },
  '16:9': { nazev: '16:9', sirka: 1920, vyska: 1080, popis: 'Na šířku, spíš na web než na Instagram.' }
};

export interface VidHotovo {
  soubor: string;
  kdy: string;
  /** Délka výsledku — kvůli kontrole, že se vykreslilo, co se čekalo. */
  delka: number;
}

export interface VidProjekt {
  postId: number;
  pomer: VidPomer;
  /** Jazyk, ze kterého se překládá. Bere se zdrojový účet, dá se přepsat. */
  zdroj: string;
  klipy: VidKlip[];
  titulky: VidTitulek[];
  trhy: Record<string, VidTrh>;
  /** Vykreslená videa podle trhu. */
  hotovo: Record<string, VidHotovo>;
  /** Reel se má objevit i v mřížce profilu. */
  doMrizky: boolean;
  zmeneno?: string;
}

/** Uložená znělka — video na začátek nebo na konec, nahrané jen jednou. */
export interface VidZnelka {
  id: string;
  nazev: string;
  soubor: string;
  delka: number;
  /** Kam se obvykle hodí. Jen nápověda v rozhraní, použít jde kamkoli. */
  kam: 'zacatek' | 'konec' | 'kamkoli';
}

export function prazdnyProjekt(postId: number, zdroj = 'CS'): VidProjekt {
  return {
    postId,
    pomer: '9:16',
    zdroj,
    klipy: [],
    titulky: [],
    trhy: {},
    hotovo: {},
    doMrizky: true
  };
}

/** Nejkratší záběr, který má smysl — pod tím ffmpeg nemá co kódovat. */
export const MIN_KLIP = 0.2;

export function delkaKlipu(k: VidKlip): number {
  return Math.max(MIN_KLIP, (k.do || 0) - (k.od || 0));
}

/**
 * Skupiny záběrů spojených tvrdým střihem.
 *
 * Vrací seznamy indexů: `[[0,1],[2],[3,4]]` znamená, že 0 a 1 se slepí
 * natvrdo, pak je přechod na skupinu s 2, pak přechod na 3 a 4.
 */
export function skupiny(klipy: VidKlip[]): number[][] {
  const out: number[][] = [];
  klipy.forEach((k, i) => {
    if (i === 0 || k.prechod !== 'zadny') out.push([i]);
    else out[out.length - 1].push(i);
  });
  return out;
}

export interface VidMisto {
  /** Kde záběr začíná ve výsledném videu. */
  start: number;
  delka: number;
  /** Skutečně použitá délka přechodu před tímto záběrem (0 = střih). */
  prechod: number;
  /** Index skupiny, do které záběr patří. */
  skupina: number;
}

/**
 * Rozmístí záběry na časovou osu výsledku.
 *
 * Přechod se **překrývá**: skupina nezačíná tam, kde předchozí skončila,
 * ale o délku přechodu dřív. Bez toho by se titulky u pozdějších záběrů
 * posunuly o součet všech přechodů před nimi.
 *
 * Délka přechodu se krátí, aby se vešla: `xfade` odmítne přechod delší,
 * než je kterákoli ze spojovaných částí, a padá hláškou, ze které to není
 * poznat. Půlka kratší části je bezpečná hranice.
 */
export function osa(klipy: VidKlip[]): { místa: VidMisto[]; delka: number } {
  const grp = skupiny(klipy);
  const delkaSkupiny = (g: number[]) => g.reduce((s, i) => s + delkaKlipu(klipy[i]), 0);

  const místa: VidMisto[] = klipy.map(() => ({ start: 0, delka: 0, prechod: 0, skupina: 0 }));
  let startSkupiny = 0;

  grp.forEach((g, gi) => {
    const prvni = g[0];
    let prechod = 0;
    if (gi > 0) {
      const chce = klipy[prvni].prechod === 'zadny' ? 0 : Math.max(0, klipy[prvni].prechodDelka || 0);
      const strop = Math.min(delkaSkupiny(grp[gi - 1]), delkaSkupiny(g)) / 2;
      prechod = Math.min(chce, strop);
      // Pod desetinu sekundy přechod nikdo nepozná a ffmpeg se s ním dusí
      if (prechod < 0.1) prechod = 0;
      startSkupiny = startSkupiny - prechod;
    }

    let běh = startSkupiny;
    g.forEach((i, vi) => {
      const d = delkaKlipu(klipy[i]);
      místa[i] = { start: běh, delka: d, prechod: vi === 0 ? prechod : 0, skupina: gi };
      běh += d;
    });
    startSkupiny = běh;
  });

  return { místa, delka: Math.max(0, startSkupiny) };
}

/** Délka hotového videa. */
export function delkaVidea(klipy: VidKlip[]): number {
  return osa(klipy).delka;
}

/** Záběry pro daný trh — vlastní, jinak společné. */
export function klipyTrhu(p: VidProjekt, lang: string): VidKlip[] {
  const vlastni = p.trhy?.[lang]?.klipy;
  return vlastni && vlastni.length > 0 ? vlastni : p.klipy;
}

export function zvukTrhu(p: VidProjekt, lang: string): VidZvuk {
  return p.trhy?.[lang]?.zvuk ?? { druh: 'original' };
}

/**
 * Text titulku pro trh. Když pro trh chybí, vrátí se zdrojový — lepší
 * nepřeložený titulek než prázdné místo v obraze.
 */
export function textTitulku(t: VidTitulek, lang: string, zdroj: string): string {
  const vlastni = (t.texty?.[lang] ?? '').trim();
  if (vlastni) return vlastni;
  return (t.texty?.[zdroj] ?? '').trim();
}

/** `0:07,3` — čitelnější než 7.34 a vejde se i na úzkou osu. */
export function cas(s: number): string {
  const celk = Math.max(0, s);
  const m = Math.floor(celk / 60);
  const sek = Math.floor(celk % 60);
  const des = Math.floor((celk * 10) % 10);
  return `${m}:${String(sek).padStart(2, '0')},${des}`;
}

/**
 * Co brání vykreslení. Prázdný seznam = dá se pustit.
 *
 * Kontroluje se i to, co ffmpeg sice přežije, ale výsledek by byl
 * k ničemu: titulek za koncem videa nikdo neuvidí a překryté titulky
 * se v obraze slijí do nečitelné kaše.
 */
export function potize(p: VidProjekt, langs: string[]): string[] {
  const out: string[] = [];
  if (p.klipy.length === 0) return ['Zatím tu není žádný záběr.'];

  for (const lang of langs) {
    const klipy = klipyTrhu(p, lang);
    if (klipy.length === 0) out.push(`Trh ${lang} nemá žádný záběr.`);
  }

  const celkem = delkaVidea(p.klipy);
  for (const t of p.titulky) {
    if (t.do <= t.od) out.push(`Titulek „${zkratka(t, p.zdroj)}" nemá kladnou délku.`);
    if (t.od > celkem) out.push(`Titulek „${zkratka(t, p.zdroj)}" začíná až za koncem videa.`);
    if (!textTitulku(t, p.zdroj, p.zdroj)) out.push('Jeden titulek je bez textu.');
  }

  const podleVrstvy = new Map<string, VidTitulek[]>();
  for (const t of p.titulky) {
    const key = t.pozice;
    if (!podleVrstvy.has(key)) podleVrstvy.set(key, []);
    podleVrstvy.get(key)!.push(t);
  }
  for (const [pozice, list] of podleVrstvy) {
    const řada = [...list].sort((a, b) => a.od - b.od);
    for (let i = 1; i < řada.length; i++) {
      if (řada[i].od < řada[i - 1].do - 0.01) {
        out.push(`Dva titulky ${POZICE[pozice as VidPozice].toLowerCase()} se překrývají — v obraze by byly přes sebe.`);
        break;
      }
    }
  }
  return out;
}

function zkratka(t: VidTitulek, zdroj: string): string {
  const text = textTitulku(t, zdroj, zdroj);
  return text.length > 24 ? `${text.slice(0, 24)}…` : text || 'bez textu';
}
