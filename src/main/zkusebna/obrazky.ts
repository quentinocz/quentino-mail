import { getSetting, setSetting } from '../db';
import { decrypt } from '../secure';
import { dilKvality } from '../../shared/zkusebna';
import { Obraz, nacti, uloz } from './png';
import * as px from './pixely';

/**
 * Kreslení obrázků — OpenAI.
 *
 * ## Proč zvlášť a ne přes `ai.ts`
 *
 * Zbytek aplikace mluví s Anthropicem a ten obrázky nekreslí. Tohle je
 * druhý dodavatel na jedinou úlohu: vykreslit postavu a dooblékat ji.
 * Klíč má proto vlastní a evidenci spotřeby taky vlastní — aby bylo
 * poznat, kolik stojí vizuály a kolik texty.
 *
 * ## Proč se nepoužívá knihovna
 *
 * Potřebují se dvě adresy a jedna z nich posílá soubory. `fetch`
 * a `FormData` jsou v Node vestavěné, takže knihovna by přibyla do
 * závislostí kvůli dvaceti řádkům — a každá další závislost je něco, co
 * se musí hlídat při každém vydání aplikace.
 *
 * ## Proč se model dá vybrat
 *
 * Rodiny obrázkových modelů se mění rychleji než zbytek aplikace a liší
 * se v jedné podstatné věci: jak věrně drží vstupní obrázek. A právě na
 * tom celé oblékání stojí — když model postavu mezi kroky překreslí,
 * vrstva nesedne. Model je proto v nastavení a ne v kódu.
 */

/** Adresa rozhraní. V nastavení kvůli zkouškám, ne kvůli jinému dodavateli. */
const ZAKLAD = () => getSetting('openaiBase', 'https://api.openai.com/v1')!;

export interface ObrazkovyModel {
  id: string;
  nazev: string;
  popis: string;
  /** Umí držet vstupní obrázek na bod, nebo se musí doprošovat zadáním. */
  verny: 'vzdy' | 'navolbu' | 'ne';
  /** Orientační cena jednoho obrázku v dolarech, při vysoké kvalitě na výšku. */
  cena: number;
  /**
   * Přijme libovolný rozměr, nebo jen tři předepsané?
   *
   * Rozhoduje o tom, jak velký výřez se dá modelu poslat — a tím
   * i o ceně, protože obrázek se platí podle plochy. Novější řada bere
   * cokoli (násobky šestnácti, poměr do 1:3, nejmíň 0,65 megabodu),
   * starší jen 1024×1024, 1024×1536 a 1536×1024.
   */
  volneRozmery: boolean;
}

/**
 * Modely, které umí kreslit a upravovat obrázky.
 *
 * Seznam je tady proto, aby šlo v okně vybírat ze jmen a aby u každého
 * stálo, co od něj čekat. Kdyby přibyl další, přidá se řádek — zadat se
 * dá i jméno, které tu není.
 *
 * Starší řady zůstávají dole: kdo si je jednou vybral, nemá se dozvědět
 * „neznámý model" jen proto, že se seznam posunul. Když u OpenAI
 * doslouží, pozná se to z hlášky a rada k ní ukáže sem.
 */
export const MODELY: ObrazkovyModel[] = [
  {
    id: 'gpt-image-2.5-sunburst', nazev: 'gpt-image-2.5 Sunburst',
    popis: 'Nejpřesnější v úpravách hotového obrázku — a na tom oblékání po vrstvách stojí.',
    verny: 'vzdy', cena: 0.05, volneRozmery: true
  },
  {
    id: 'gpt-image-2.5-flare', nazev: 'gpt-image-2.5 Flare',
    popis: 'Rychlejší, na běžné kreslení od nuly. Vstupní obrázek drží volněji než Sunburst.',
    verny: 'vzdy', cena: 0.05, volneRozmery: true
  },
  /*
   * Řada 2.6 přibyla v rozhraní na podzim 2026 (u úprav je dokonce
   * výchozí). Cenu OpenAI v dokumentaci zatím neuvádí jednotně, odhad je
   * proto jako u 2.5 — evidence se dorovná podle toho, co přijde na účet.
   */
  {
    id: 'gpt-image-2.6-sunburst', nazev: 'gpt-image-2.6 Sunburst (nejnovější)',
    popis: 'Nejnovější řada. Když 2.5 nesedí nebo hlásí chybu, zkus tenhle.',
    verny: 'vzdy', cena: 0.05, volneRozmery: true
  },
  {
    id: 'gpt-image-2.6-flare', nazev: 'gpt-image-2.6 Flare (nejnovější)',
    popis: 'Nejnovější řada, rychlejší varianta.',
    verny: 'vzdy', cena: 0.05, volneRozmery: true
  },
  {
    id: 'gpt-image-2', nazev: 'gpt-image-2 (starší)',
    popis: 'Předchozí řada, dražší. Jen tři pevné rozměry; průhledné pozadí má jen zkušebně.',
    verny: 'vzdy', cena: 0.22, volneRozmery: false
  }
];

/** Nejmenší obrázek, který rozhraní u volných rozměrů přijme. */
export const NEJMENE_BODU = 655_360;

/**
 * Modely, které už nenabízíme — u OpenAI dosloužily, nebo se na vrstvy
 * nehodí (nedrží vstupní obrázek).
 *
 * Kdo si je vybral, nemá kvůli tomu zůstat s nefunkčním nastavením —
 * jednou se mu tiše přepne na ten současný. Vlastnoručně zadaného jména
 * se to netýká: to si člověk napsal schválně a přepisovat mu ho by bylo
 * drzé.
 */
const DOSLOUZILY = [
  'gpt-image-1.5', 'gpt-image-1-mini',
  /* OpenAI ho vypnul 23. 10. 2026 — kdo ho měl vybraný, dostával jen chybu */
  'gpt-image-1'
];

export function model(): ObrazkovyModel {
  let id = getSetting('obrazkovyModel', MODELY[0].id)!;
  if (DOSLOUZILY.includes(id)) {
    id = MODELY[0].id;
    setSetting('obrazkovyModel', id);
  }
  const znamy = MODELY.find(one => one.id === id) ?? { ...MODELY[0], id, nazev: id };
  /* Co model odmítl, si aplikace pamatuje — viz `posli` */
  return pevneRozmery(id) ? { ...znamy, volneRozmery: false } : znamy;
}

/* ------------------------------------------------- co který model neumí */

/**
 * Parametry, které daný model odmítl.
 *
 * Rodiny modelů se liší v drobnostech, které dokumentace popisuje
 * nejednotně: průhledné pozadí „podle modelu", `input_fidelity` jen
 * u některých, volné rozměry jen u novějších. Místo hádání se to pozná
 * z první odpovědi — chyba 400 se nezaplatí — a zapamatuje se, ať se
 * na totéž neptá u každé vrstvy znovu.
 */
export function odmitnute(modelId = model().id): string[] {
  try {
    const ulozene = JSON.parse(getSetting(`obrazkyBez:${modelId}`, '[]')!);
    return Array.isArray(ulozene) ? ulozene.map(String) : [];
  } catch { return []; }
}

function zapamatujOdmitnuti(modelId: string, parametr: string): void {
  const ted = odmitnute(modelId);
  if (!ted.includes(parametr)) setSetting(`obrazkyBez:${modelId}`, JSON.stringify([...ted, parametr]));
}

export function pevneRozmery(modelId: string): boolean {
  return getSetting(`obrazkyPevne:${modelId}`, '') === '1';
}

/** Umí model vrátit průhledné pozadí? Když ne, vyřízne se samo. */
export function umiPruhlednost(modelId = model().id): boolean {
  return !odmitnute(modelId).includes('background');
}

/** Zapomene, co model odmítl — po výměně modelu nebo na přání v okně. */
export function zapomenOdmitnuti(modelId = model().id): void {
  setSetting(`obrazkyBez:${modelId}`, '');
  setSetting(`obrazkyPevne:${modelId}`, '');
}

export function klic(): string {
  const stored = getSetting('openaiApiKey', '')!;
  if (!stored) return '';
  return decrypt(stored) || '';
}

export function maKlic(): boolean {
  return !!klic();
}

/* ---------------------------------------------------------------- účetnictví */

/**
 * Evidence spotřeby. Vlastní, protože OpenAI zůstatek kreditu přes
 * rozhraní neříká — a kdo generuje vrstvy pro dvanáct postav, má vědět,
 * kolik to zatím stálo, ještě než mu to přijde na účet.
 */
export function zapisUtratu(pocet = 1, kvalita?: string): void {
  const mesic = new Date().toISOString().slice(0, 7);
  const klicZapisu = `obrazkyUtrata:${mesic}`;
  const ted = cislo(klicZapisu, 0);
  setSetting(klicZapisu, String(ted + pocet * cenaObrazku(kvalita)));
  const kusy = `obrazkyKusy:${mesic}`;
  setSetting(kusy, String(cislo(kusy, 0) + pocet));
}

/**
 * Číslo z nastavení. Nula je hodnota, ne „nevyplněno".
 *
 * Strop nastavený na nulu znamená „teď nekresli nic" — a přesně to
 * dřív nefungovalo: `Number(…) || 40` udělalo z nuly čtyřicet dolarů,
 * takže jediná pojistka proti nechtěnému generování tiše nefungovala.
 */
function cislo(klic: string, vychozi: number): number {
  const ulozene = Number(getSetting(klic, String(vychozi)));
  return Number.isFinite(ulozene) ? ulozene : vychozi;
}

export function utrata(): { mesic: string; usd: number; kusu: number; strop: number } {
  const mesic = new Date().toISOString().slice(0, 7);
  return {
    mesic,
    usd: cislo(`obrazkyUtrata:${mesic}`, 0),
    kusu: cislo(`obrazkyKusy:${mesic}`, 0),
    strop: cislo('obrazkyStrop', 40)
  };
}

/**
 * Strop na měsíc.
 *
 * Generování vrstev je smyčka přes postavy a kusy oblečení; jeden
 * překlep v počtu a je to sto obrázků místo deseti. Strop je proto
 * **tvrdý**: překročit se nedá zrychlením ani opakováním, jen tím, že
 * si ho člověk v okně zvedne.
 */
export function zbyvaDoStropu(): number {
  const u = utrata();
  return Math.max(0, u.strop - u.usd);
}

/* ------------------------------------------------------------------ volání */

function hlavicky(): Record<string, string> {
  const k = klic();
  if (!k) throw new Error('Není nastaven klíč k OpenAI (Nastavení → Vizuály na modelu).');
  return { authorization: `Bearer ${k}` };
}

/** Co se dá zkusit znovu a co se opakováním nespraví nikdy. */
function znovu(stav: number, text: string): boolean {
  if (stav === 429 || stav === 408 || stav === 409) return true;
  if (stav >= 500) return true;
  return /overloaded|timeout|fetch failed|ECONNRESET|socket hang up/i.test(text);
}

/**
 * Parametry, bez kterých se obrázek nakreslí taky.
 *
 * Když je model odmítne, vynechají se a požadavek se pošle znovu —
 * chyba 400 se neplatí. Model, prompt a obrázek mezi nimi nejsou: bez
 * nich by to už byl jiný požadavek.
 */
const VYNECHATELNE = new Set(['background', 'input_fidelity', 'moderation', 'output_format', 'n', 'quality']);

/**
 * Model nevzal rozměr výřezu.
 *
 * Volné rozměry umí jen novější řady a dokumentace to u každé říká
 * jinak. Když rozměr neprojde, zapamatuje se to u modelu a vrstva si
 * výřez spočítá znovu v rozměru, který vezme každý.
 */
export class ChybaRozmeru extends Error {
  constructor(zprava: string) {
    super(zprava);
    this.name = 'ChybaRozmeru';
  }
}

/** Jak dlouho se čeká na jeden obrázek. Vysoká kvalita trvá i dvě minuty. */
const CEKAT_MS = 6 * 60_000;

interface Pozadavek {
  pole: Record<string, string | number>;
  /** Soubory jdou jen s úpravou obrázku — pak se posílá formulář. */
  soubory?: Record<string, { data: Buffer; jmeno: string }>;
}

/** Text chyby od OpenAI rozebraný na zprávu, parametr a kód. */
export function rozeberChybu(text: string): { zprava: string; parametr: string; kod: string } {
  try {
    const e = JSON.parse(text)?.error ?? {};
    return { zprava: String(e.message ?? text), parametr: String(e.param ?? ''), kod: String(e.code ?? '') };
  } catch {
    return { zprava: text, parametr: '', kod: '' };
  }
}

/**
 * Který parametr chyba odmítá — prázdno, když to chyba parametru není.
 *
 * Odmítnutí bezpečnostní kontrolou, chybějící kredit nebo neznámý model
 * se tu nepoznají schválně: ty se vynecháním parametru nespraví.
 */
export function odmitnutyParametr(stav: number, text: string): string {
  if (stav !== 400) return '';
  const { zprava, parametr, kod } = rozeberChybu(text);
  if (/safety|moderation_blocked|billing|quota/i.test(`${zprava} ${kod}`)) return '';
  const jmeno = (parametr || (zprava.match(/parameter:?\s*'([a-z_[\]]+)'/i)?.[1] ?? '')).replace(/\[\]$/, '');
  if ((kod === 'unknown_parameter' || /unknown parameter/i.test(zprava)) && jmeno) return jmeno;
  if (jmeno === 'background' || /transparen/i.test(zprava)) return 'background';
  if (jmeno === 'input_fidelity' || /input_fidelity/.test(zprava)) return 'input_fidelity';
  if (jmeno === 'size' || (/\bsize\b/i.test(zprava) && /invalid|supported|must be|multiple/i.test(zprava))) return 'size';
  if (jmeno && /invalid|not supported|unsupported/i.test(zprava)) return jmeno;
  return '';
}

/**
 * Zadání pro model, který průhledné pozadí nevrátí.
 *
 * Místo průhlednosti se chce **čistě bílé** pozadí: od šedého trička i
 * od kreslicích barev se dá spolehlivě oddělit. Bez téhle náhrady model
 * „průhledné pozadí" kreslí jako šachovnici, a ta se odděluje hůř.
 */
export function bezPruhlednosti(zadani: string): string {
  return zadani
    .replace(/on a fully transparent background/gi, 'on a plain, uniform, pure white (#FFFFFF) background')
    .replace(/no checkerboard pattern\.?/gi, 'no gradient, no texture.')
    .replace(/The background must stay fully transparent\./gi, 'Keep the background exactly as it is, plain and uniform.');
}

/**
 * Obrázek z odpovědi. Vlastní čtečka PNG umí jen osm bitů na složku a
 * neprokládané soubory; kdyby model poslal něco jiného, přečte to okno
 * aplikace (Chromium), a teprve když neumí ani to, je to chyba.
 */
function nactiOdpoved(data: Buffer): Obraz {
  try {
    return nacti(data);
  } catch (vlastni) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { nativeImage } = require('electron');
      const img = nativeImage?.createFromBuffer(data);
      if (!img || img.isEmpty()) throw vlastni;
      const { width, height } = img.getSize();
      const bgra: Buffer = img.toBitmap();
      const obraz: Obraz = { sirka: width, vyska: height, body: new Uint8Array(width * height * 4) };
      for (let i = 0; i < width * height; i++) {
        const a = bgra[i * 4 + 3];
        /* Bitmapa z Chromia má barvy přednásobené průhledností */
        const k = a ? 255 / a : 0;
        obraz.body[i * 4] = Math.min(255, Math.round(bgra[i * 4 + 2] * k));
        obraz.body[i * 4 + 1] = Math.min(255, Math.round(bgra[i * 4 + 1] * k));
        obraz.body[i * 4 + 2] = Math.min(255, Math.round(bgra[i * 4] * k));
        obraz.body[i * 4 + 3] = a;
      }
      return obraz;
    } catch {
      throw vlastni;
    }
  }
}

/**
 * Pošle požadavek a vrátí obrázek.
 *
 * ## Proč dva tvary těla
 *
 * Kreslení od nuly (`/images/generations`) bere **jen JSON**; posílat mu
 * formulář končí na „Unsupported content type: 'multipart/form-data'" a
 * žádný obrázek nevznikne. Dokreslování (`/images/edits`) je naopak
 * formulář, protože s sebou nese soubory — vstupní obrázek a masku.
 *
 * ## Proč se opravuje sám
 *
 * Patrik (23. 11.): „stále tam nefunguje generování obrazových podkladů".
 * Modely se mezi sebou liší v drobnostech (průhledné pozadí, věrnost
 * vstupu, volné rozměry) a dokumentace je popisuje nejednotně — jeden
 * nepodporovaný parametr a nevznikne nic. Odmítnutý parametr se proto
 * vynechá, zapamatuje u modelu a požadavek jde znovu; zaplatí se až
 * obrázek, který opravdu přišel.
 */
async function posli(cesta: string, poz: Pozadavek, pokusu = 3): Promise<Obraz> {
  const modelId = String(poz.pole.model ?? '');
  let naposled = '';
  let oprav = 0;
  for (let pokus = 0; pokus < pokusu; pokus++) {
    if (zbyvaDoStropu() <= 0) {
      throw new Error(`Měsíční strop ${utrata().strop} $ za obrázky je vyčerpaný. Zvedni ho v okně, nebo počkej do dalšího měsíce.`);
    }
    let odpoved: Response;
    try {
      let body: string | FormData;
      if (poz.soubory) {
        const formular = new FormData();
        for (const [k, v] of Object.entries(poz.pole)) formular.append(k, String(v));
        for (const [k, f] of Object.entries(poz.soubory)) {
          formular.append(k, new Blob([new Uint8Array(f.data)], { type: 'image/png' }), f.jmeno);
        }
        body = formular;
      } else {
        body = JSON.stringify(poz.pole);
      }
      odpoved = await fetch(`${ZAKLAD()}${cesta}`, {
        method: 'POST',
        /* U formuláře si hranici doplní fetch sám — vlastní hlavička by ji přebila */
        headers: poz.soubory ? hlavicky() : { ...hlavicky(), 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(CEKAT_MS)
      });
    } catch (e: any) {
      const kod = String(e?.cause?.code ?? e?.name ?? '');
      /*
       * Vypršený čas se **neopakuje**: OpenAI mohl obrázek mezitím
       * nakreslit a naúčtovat, jen odpověď nedorazila. Opakovat znamená
       * platit dvakrát za tutéž kravatu.
       */
      if (/TIMEOUT|TimeoutError|AbortError/i.test(kod)) {
        naposled = 'OpenAI neodpověděl včas.';
        break;
      }
      naposled = String(e?.message ?? e) + (e?.cause?.message ? ` (${e.cause.message})` : '');
      if (/Není nastaven klíč/.test(naposled)) throw e;
      if (!znovu(0, naposled) || pokus === pokusu - 1) break;
      await pauza(pokus);
      continue;
    }
    const text = await odpoved.text();
    if (!odpoved.ok) {
      const parametr = odmitnutyParametr(odpoved.status, text);
      if (parametr === 'size' && cesta === '/images/edits') {
        setSetting(`obrazkyPevne:${modelId}`, '1');
        throw new ChybaRozmeru(rozeberChybu(text).zprava);
      }
      if (parametr && VYNECHATELNE.has(parametr) && parametr in poz.pole && oprav < 4) {
        delete poz.pole[parametr];
        zapamatujOdmitnuti(modelId, parametr);
        if (parametr === 'background' && typeof poz.pole.prompt === 'string') {
          poz.pole.prompt = bezPruhlednosti(poz.pole.prompt);
        }
        oprav += 1;
        pokus -= 1;
        continue;
      }
      naposled = `${odpoved.status} ${rozeberChybu(text).zprava.slice(0, 300)}`;
      if (!znovu(odpoved.status, text) || pokus === pokusu - 1) break;
      await pauza(pokus);
      continue;
    }
    let b64 = '';
    try { b64 = JSON.parse(text)?.data?.[0]?.b64_json ?? ''; } catch { b64 = ''; }
    if (!b64) {
      naposled = 'Odpověď neobsahuje obrázek.';
      break;
    }
    zapisUtratu(1, typeof poz.pole.quality === 'string' ? poz.pole.quality : undefined);
    return nactiOdpoved(Buffer.from(b64, 'base64'));
  }
  throw new Error(`Obrázek se nepodařilo nakreslit: ${naposled}${radaKChybe(naposled)}`);
}

/**
 * Věta navíc tam, kde z hlášky od OpenAI není poznat, co s tím.
 *
 * Rodiny obrázkových modelů se mění rychleji než aplikace a „model not
 * found" je hláška, nad kterou člověk neví, jestli je rozbitá aplikace,
 * klíč, nebo účet. Přitom stačí vybrat jiný model.
 */
function radaKChybe(text: string): string {
  /*
   * Obrázkové modely chtějí **ověřenou organizaci** — bez ní vrací 403
   * „must be verified" a z aplikace se to spravit nedá. Ověření je na
   * platform.openai.com a po něm trvá pár minut, než začne platit.
   */
  if (/verif/i.test(text)) {
    return ' — OpenAI chce u obrázkových modelů ověřenou organizaci. Ověř ji na platform.openai.com'
      + ' → Settings → Organization → General → Verify Organization (po ověření to začne fungovat do pár minut).';
  }
  if (/^401\b|invalid_api_key|incorrect api key/i.test(text)) {
    return ' — klíč k OpenAI neplatí. Vlož nový v Nastavení → Klíč k OpenAI.';
  }
  if (/model/i.test(text) && /not found|does not exist|unknown|neexistuje|do not have access|not have access/i.test(text)) {
    return ` — model „${model().id}" není k dispozici (nebo k němu účet nemá přístup). Vyber jiný v Nastavení → Model.`;
  }
  /*
   * Odmítnutí bezpečnostní kontrolou není porucha, ale zadání. Hláška od
   * OpenAI je anglická a končí číslem požadavku, takže z ní nikdo
   * nepozná, že stačí přepsat jednu větu — a kde.
   */
  if (/safety|moderation/i.test(text)) {
    return ' — zadání neprošlo bezpečnostní kontrolou modelu. Uprav ho u té vrstvy'
      + ' (Vizuály → vrstva → Zadání); postava musí být popsaná jako oblečená.';
  }
  if (/insufficient_quota|billing|credit|quota/i.test(text)) {
    return ' — účet u OpenAI nemá kredit (platform.openai.com → Billing).';
  }
  if (/^429\b|rate limit/i.test(text)) {
    return ' — OpenAI teď brzdí počet požadavků. Zkus to za pár minut.';
  }
  if (/neodpověděl včas/.test(text)) {
    return ' Zkus nižší kvalitu v Nastavení, nebo to zopakuj — obrázek mohl být přesto naúčtovaný.';
  }
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN/i.test(text)) {
    return ' — nepodařilo se spojit s OpenAI. Je počítač na internetu?';
  }
  return '';
}

function pauza(pokus: number): Promise<void> {
  /* Rozptyl schválně: bez něj se souběžná volání probudí naráz */
  const zaklad = Math.min(1500 * 2 ** pokus, 20_000);
  return new Promise(r => setTimeout(r, zaklad + Math.random() * zaklad * 0.3));
}

export interface Rozmer { sirka: number; vyska: number }

/** Vynechá z požadavku, co model už jednou odmítl. */
function bezOdmitnutych(pole: Record<string, string | number>, modelId: string): Record<string, string | number> {
  for (const p of odmitnute(modelId)) if (VYNECHATELNE.has(p)) delete pole[p];
  return pole;
}

/**
 * Nakreslí obrázek od nuly — tak vzniká postava.
 *
 * Vrátí vždy obrázek v žádaném rozměru, a když se chtěla průhlednost,
 * tak i průhledný: buď ho tak poslal model, nebo se pozadí vyřízne
 * tady. Bez průhlednosti by postava neprošla kontrolou — silueta by
 * byla celé plátno.
 */
export async function nakresli(
  zadani: string,
  rozmer: Rozmer,
  prusvitne = true,
  kvalita?: string
): Promise<Obraz> {
  const m = model();
  const pruhledne = prusvitne && umiPruhlednost(m.id);
  const pole: Record<string, string | number> = bezOdmitnutych({
    model: m.id,
    prompt: prusvitne && !pruhledne ? bezPruhlednosti(zadani) : zadani,
    size: `${rozmer.sirka}x${rozmer.vyska}`,
    quality: kvalita ?? getSetting('obrazkyKvalita', 'high')!,
    output_format: 'png',
    n: 1,
    /* Průhledné pozadí jde jen k png nebo webp — u jpeg by to rozhraní odmítlo */
    ...(pruhledne ? { background: 'transparent' } : {})
  }, m.id);
  let obraz = px.prevzorkuj(await posli('/images/generations', { pole }), rozmer.sirka, rozmer.vyska);
  if (prusvitne && !px.jePruhledny(obraz)) {
    const bezPozadi = px.odstranPozadi(obraz);
    if (!bezPozadi) {
      throw new Error('Model vrátil obrázek s pozadím, které se od postavy nedá spolehlivě oddělit'
        + ' (není jednolité). Zkus to znovu, nebo vyber jiný model v Nastavení → Model.');
    }
    obraz = bezPozadi;
  }
  return obraz;
}

/**
 * Dokreslí do hotového obrázku — tak se postava dooblékává.
 *
 * `input_fidelity: high` je tady to podstatné u modelů, které ho berou:
 * bez něj si model obrázek překreslí po svém. Modely, které vstup drží
 * vždycky, tu volbu neberou a poslat jim ji je chyba — proto se posílá
 * jen tam, kam patří.
 */
export async function dokresli(zadani: string, vstup: Obraz, maska?: Obraz): Promise<Obraz> {
  const m = model();
  const pruhledne = umiPruhlednost(m.id);
  const pole: Record<string, string | number> = bezOdmitnutych({
    model: m.id,
    prompt: pruhledne ? zadani : bezPruhlednosti(zadani),
    size: `${vstup.sirka}x${vstup.vyska}`,
    quality: getSetting('obrazkyKvalita', 'high')!,
    output_format: 'png',
    n: 1,
    ...(pruhledne ? { background: 'transparent' } : {}),
    ...(m.verny === 'navolbu' ? { input_fidelity: 'high' } : {})
  }, m.id);
  const soubory: Pozadavek['soubory'] = { image: { data: uloz(vstup), jmeno: 'postava.png' } };
  if (maska) soubory.mask = { data: uloz(maska), jmeno: 'maska.png' };
  const vracene = px.prevzorkuj(await posli('/images/edits', { pole, soubory }), vstup.sirka, vstup.vyska);
  return px.obnovPruhlednost(vracene, vstup);
}

/* ----------------------------------------------------------- zkouška */

export interface ZkouskaModelu {
  ok: boolean;
  model: string;
  /** Vrátil model průhledné pozadí sám? Když ne, vyřezává se v aplikaci. */
  pruhledne: boolean;
  /** Parametry, které model odmítl a aplikace je přestala posílat. */
  bez: string[];
  sekund: number;
  chyba: string;
}

/**
 * Jeden levný obrázek na ověření, že kreslení funguje.
 *
 * Patrik (23. 11.): generování „stále nefunguje" — a z hlášky na pár
 * vteřin se nedá poznat, jestli je to klíč, ověření organizace, kredit,
 * nebo model. Tohle stojí kolem centu (nízká kvalita, čtverec) a řekne
 * to najisto, ještě než se pustí běh za dolary.
 */
export async function vyzkousej(): Promise<ZkouskaModelu> {
  const m = model();
  const start = Date.now();
  const zadani = 'A single red apple, studio product photo, isolated on a fully transparent background,'
    + ' no shadow, no checkerboard pattern.';
  try {
    const pole: Record<string, string | number> = bezOdmitnutych({
      model: m.id,
      prompt: umiPruhlednost(m.id) ? zadani : bezPruhlednosti(zadani),
      size: '1024x1024',
      quality: 'low',
      output_format: 'png',
      n: 1,
      ...(umiPruhlednost(m.id) ? { background: 'transparent' } : {})
    }, m.id);
    const obraz = await posli('/images/generations', { pole }, 1);
    return {
      ok: true, model: m.id, pruhledne: px.jePruhledny(obraz), bez: odmitnute(m.id),
      sekund: Math.round((Date.now() - start) / 1000), chyba: ''
    };
  } catch (e: any) {
    return {
      ok: false, model: m.id, pruhledne: false, bez: odmitnute(m.id),
      sekund: Math.round((Date.now() - start) / 1000), chyba: String(e?.message ?? e)
    };
  }
}

/**
 * Cena jednoho obrázku při dnešním nastavení.
 *
 * Cena u modelu platí pro vysokou kvalitu; nižší kvalita je násobkem
 * levnější. Bez toho by evidence utrácení tvrdila, že zkušební běh
 * v nízké kvalitě stál totéž co ten načisto — a strop by se vyčerpal
 * čtyřikrát rychleji, než se opravdu utratilo.
 */
export function cenaObrazku(kvalita?: string): number {
  return Math.round(model().cena * dilKvality(kvalita ?? getSetting('obrazkyKvalita', 'high')!) * 1000) / 1000;
}

/** Kolik by stálo vygenerovat daný počet obrázků. */
export function odhadCeny(kusu: number): number {
  return Math.round(kusu * cenaObrazku() * 100) / 100;
}

export const __test = { znovu, posli, odmitnutyParametr, bezPruhlednosti, radaKChybe };
