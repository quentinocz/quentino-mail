import { nativeImage } from 'electron';
import { client, recordUsage } from '../ai';
import { getDb, getSetting, setSetting } from '../db';
import { getSettings } from '../settings';
import {
  ZK_DRUHY_FOTEK, ZkCast, ZkDruhFotky, ZkRozpoznani, ZkRozpoznanyKus, ZkVrstvaTyp, rodinaVarianty, sablonaPro
} from '../../shared/zkusebna';
import { Obraz, novyObraz, uloz } from './png';
import * as px from './pixely';
import * as store from './store';
import * as obrazky from './obrazky';
import { ROH_SABLONY, Rozmer, fotkyProduktu, nahraneLatky, rozmerProduktu, stahniFotku } from './produkty';
import { Mereni, latkaZListu, maskaVyrobku, vyrizniOtocene, zmerMeritko } from './meritko';
import { poSkupinach } from './vykresleni';
import { bezSvu, vyrovnejSvetlo } from './latka';

/**
 * Rozpoznání produktu z fotek — co na nich je a kde je rovná látka.
 *
 * ## Proč AI jako oko, ne jako malíř
 *
 * Patrik (23. 11.): „nebude lepší, když ty textury bude nějak generovat
 * AI? … aby se u setu šle + motýlek správně na model vykreslily šle
 * i motýlek". Vystřihování z fotky podle barev selhává přesně tam, kde
 * na tom záleží: na fotce sady leží kšandy přes motýlka, u dárkové sady
 * je vedle kravaty krabička a knoflíčky, kravata je stočená a „největší
 * jednobarevný čtverec" je kus stínu mezi závity.
 *
 * Model s viděním to pozná spolehlivě — co je kšanda a co motýlek, kde
 * na motýlkovi není uzel ani hrana. **Látku ale nevymýšlí**: řekne jen,
 * kde na fotce je, a pixely se vezmou ze skutečné fotky. Zákazník tak na
 * modelu vidí vzor, který si kupuje, ne „něco podobného".
 *
 * Kreslící model přijde na řadu jen tam, kde rovného kusu látky na fotce
 * opravdu není dost (stočená drobná kravata) — a i tehdy dostane výřez
 * jako předlohu a výsledek se v okně ukáže vedle něj.
 *
 * ## Proč se nic neschvaluje samo u sad
 *
 * Sada jde do kabiny až po kontrole člověkem (Patrik: „nedovolit je bez
 * kontroly"). AI kontrolu zkracuje na jeden pohled — u každého kusu je
 * výřez, ze kterého se látka vzala, a věta, co AI viděla.
 */

const SYSTEM = `You look at product photos of a men's accessories e-shop (ties, bow ties,
cravats, braces/suspenders, pocket squares, gift sets) for a virtual fitting room.
The fabric is cut from the photo pixels and put on a model at its TRUE real-world
size — where you point and what you measure decides how big the pattern looks.

First say what each photo shows, then describe EVERY separate item.

Return ONLY JSON:
{"fotky":[{"druh": "detail" | "cely" | "na_modelu" | "sada" | "baleni" | "jine"}],
 "kusy":[{
  "druh": "kravata" | "pletena" | "motylek" | "regata" | "ksandy" | "kapesnicek" | "jine",
  "popis": "short Czech description, colour + pattern + pattern size, e.g. 'vínový motýlek s drobným bílým puntíkem'",
  "foto": index (0-based) of the photo where the item lies flat and straight and can be measured;
          never a photo where it is worn by a person if another photo shows it,
  "ram": [x, y, w, h] whole item in that photo, fractions 0..1 of width/height,
  "latka": [x, y, w, h] a clean flat fabric rectangle COMPLETELY inside the item's fabric:
           no background, knot, outer edge, seam, label, metal part, deep fold or shadow,
  "mira": [x1, y1, x2, y2] a measuring line on the SAME photo, fractions 0..1:
          tie / knitted tie / cravat: straight across the blade at its widest point just above
            the tip, from edge to edge, perpendicular to the blade;
          braces: straight across one strap, edge to edge, perpendicular to it, on a flat part;
          bow tie: from the left wing tip to the right wing tip;
          pocket square: along one whole straight edge if it is shown unfolded, otherwise null,
  "motivu": how many times the main pattern motif repeats along the mira line
            (e.g. 3.5 flowers across the blade), null for plain fabric,
  "latkaCm": real-world size in cm of the latka rectangle's HORIZONTAL side,
  "barva": "#rrggbb" main fabric colour,
  "lem": "#rrggbb" or null — only for a pocket square with a differently coloured hem/border,
  "vzor": "jednobarevny" | "drobny" | "vyrazny",
  "jistota": 0..1
}]}

Photo kinds: "detail" close-up of the fabric, "cely" whole item laid flat or rolled,
"na_modelu" worn by a person, "sada" several items together, "baleni" box or packaging,
"jine" anything else. One entry in "fotky" per photo, in order.
"jine" item = anything not worn on the model (cufflinks, box, tie clip, card).
Use "pletena" for knitted ties, "regata" for wedding cravats/ascots.
Each physical item once; the same item seen in several photos only once.`;

/**
 * Kolik fotek produktu se pošle. Dřív tři; Patrik (25. 11.): další fotky
 * bývají kravata rozložená nebo na modelu — přesně z nich se pozná
 * velikost vzoru. Šest stojí o pár haléřů víc.
 */
const FOTEK = 6;
/** Verze rozpoznání — starší se při „Připravit" udělají znovu. */
export const VERZE = 2;

type Zeptej = (fotky: { b64: string; mime: string }[], text: string) => Promise<{ text: string; model: string }>;

let zeptej: Zeptej = async (fotky, text) => {
  const model = getSetting('zkVisionModel', '') || getSettings().draftModel;
  const res = await client().messages.create({
    model,
    max_tokens: 2500,
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: [
        ...fotky.map(one => ({
          type: 'image' as const,
          source: { type: 'base64' as const, media_type: one.mime as 'image/png' | 'image/jpeg', data: one.b64 }
        })),
        { type: 'text' as const, text }
      ]
    }]
  });
  recordUsage(model, res.usage as any);
  return { text: res.content.filter(b => b.type === 'text').map(b => (b as any).text).join('').trim(), model };
};

/** Pro zkoušky: místo modelu podvrh, který vrátí připravenou odpověď. */
export function nastavZeptani(fn: Zeptej | null): void {
  if (fn) zeptej = fn;
}

/* ------------------------------------------------------------- odpověď */

interface SurovyKus {
  druh: string; popis: string; foto: number;
  ram: number[]; latka: number[]; latkaCm: number;
  mira: number[] | null; motivu: number | null;
  barva: string; lem: string | null; vzor: string; jistota: number;
}

function cara(v: unknown): number[] | null {
  if (!Array.isArray(v) || v.length !== 4) return null;
  const c = v.map(Number);
  if (c.some(n => !Number.isFinite(n) || n < -0.05 || n > 1.05)) return null;
  return c.map(n => Math.max(0, Math.min(1, n)));
}

const DRUHY: Record<string, { typ: ZkVrstvaTyp; rodina: string } | null> = {
  kravata: { typ: 'kravata', rodina: 'kravata' },
  pletena: { typ: 'kravata', rodina: 'kravata' },
  motylek: { typ: 'kravata', rodina: 'motylek' },
  regata: { typ: 'kravata', rodina: 'regata' },
  ksandy: { typ: 'ksandy', rodina: 'ksandy' },
  kapesnicek: { typ: 'kapesnicek', rodina: 'kapesnicek' },
  jine: null
};

const NAZVY: Record<string, string> = {
  kravata: 'kravata', pletena: 'pletená kravata', motylek: 'motýlek', regata: 'regata',
  ksandy: 'kšandy', kapesnicek: 'kapesníček', jine: 'jiná věc'
};

function obdelnik(v: unknown): [number, number, number, number] | null {
  if (!Array.isArray(v) || v.length !== 4) return null;
  const c = v.map(Number);
  if (c.some(n => !Number.isFinite(n))) return null;
  /* Model občas vrátí body místo zlomků — to se pozná podle čísel přes 1 */
  if (c.some(n => n > 1.5)) return null;
  const [x, y, w, h] = c;
  if (w <= 0 || h <= 0) return null;
  return [Math.max(0, x), Math.max(0, y), Math.min(1 - Math.max(0, x), w), Math.min(1 - Math.max(0, y), h)];
}

/** Co je na které fotce — podle odpovědi, chybějící jako „jiné". */
export function druhyFotek(text: string, fotek: number): ZkDruhFotky[] {
  try {
    const cisty = text.replace(/```json/gi, '').replace(/```/g, '');
    const json = JSON.parse(cisty.slice(cisty.indexOf('{'), cisty.lastIndexOf('}') + 1));
    const pole = Array.isArray(json?.fotky) ? json.fotky : [];
    return Array.from({ length: fotek }, (_, i) => {
      const d = String(pole[i]?.druh ?? '');
      return (d in ZK_DRUHY_FOTEK ? d : 'jine') as ZkDruhFotky;
    });
  } catch {
    return Array.from({ length: fotek }, () => 'jine' as ZkDruhFotky);
  }
}

export function rozeberOdpoved(text: string, fotek: number): SurovyKus[] {
  const cisty = text.replace(/```json/gi, '').replace(/```/g, '');
  const od = cisty.indexOf('{');
  const doK = cisty.lastIndexOf('}');
  if (od < 0 || doK <= od) throw new Error('AI nevrátila čitelnou odpověď — zkus rozpoznání znovu.');
  const json = JSON.parse(cisty.slice(od, doK + 1));
  const out: SurovyKus[] = [];
  for (const k of Array.isArray(json?.kusy) ? json.kusy : []) {
    const druh = String(k?.druh ?? '').toLowerCase();
    if (!(druh in DRUHY)) continue;
    const ram = obdelnik(k.ram);
    const latka = obdelnik(k.latka);
    const foto = Math.round(Number(k.foto) || 0);
    if (!ram || foto < 0 || foto >= fotek) continue;
    out.push({
      druh, popis: String(k.popis ?? '').slice(0, 120), foto,
      ram, latka: latka ?? ram,
      latkaCm: Math.max(0.5, Math.min(30, Number(k.latkaCm) || 0)),
      mira: cara(k.mira),
      motivu: Number(k.motivu) > 0 && Number(k.motivu) < 60 ? Math.round(Number(k.motivu) * 10) / 10 : null,
      barva: /^#[0-9a-f]{6}$/i.test(String(k.barva)) ? String(k.barva).toLowerCase() : '',
      lem: /^#[0-9a-f]{6}$/i.test(String(k.lem)) ? String(k.lem).toLowerCase() : null,
      vzor: ['jednobarevny', 'drobny', 'vyrazny'].includes(k.vzor) ? k.vzor : 'drobny',
      jistota: Math.max(0, Math.min(1, Number(k.jistota) || 0.5))
    });
  }
  return out;
}

/* -------------------------------------------------------- přiřazení */

interface Misto { cast: number; typ: ZkVrstvaTyp; rodina: string; varianta: string }

/**
 * Který rozpoznaný kus patří na které místo produktu.
 *
 * Nejdřív přesná shoda (motýlek na motýlka), pak aspoň stejné místo na
 * modelu (název říká motýlek, AI vidí regatu — to je pro člověka). Co
 * na fotce je navíc a na model patří, přidá se jako další kus sady;
 * co na model nepatří (knoflíčky, krabička), jen se zmíní.
 */
export function prirad(
  mista: Misto[],
  kusy: SurovyKus[],
  detsky: boolean
): { prirazeni: Map<number, SurovyKus>; nove: { kus: SurovyKus; typ: ZkVrstvaTyp; varianta: string }[]; poznamky: string[] } {
  const prirazeni = new Map<number, SurovyKus>();
  const poznamky: string[] = [];
  const volne = kusy.filter(one => DRUHY[one.druh] && one.jistota >= 0.35)
    .sort((a, b) => b.jistota - a.jistota);
  const vezmi = (shoda: (k: SurovyKus) => boolean) => {
    const i = volne.findIndex(shoda);
    return i < 0 ? null : volne.splice(i, 1)[0];
  };
  for (const m of mista) {
    const presny = vezmi(k => DRUHY[k.druh]!.typ === m.typ && DRUHY[k.druh]!.rodina === m.rodina);
    if (presny) { prirazeni.set(m.cast, presny); continue; }
    const podobny = vezmi(k => DRUHY[k.druh]!.typ === m.typ);
    if (podobny) {
      prirazeni.set(m.cast, podobny);
      poznamky.push(`Podle názvu je to ${NAZVY[m.rodina] ?? m.rodina}, na fotce vidím ${NAZVY[podobny.druh]} — zkontroluj variantu.`);
      continue;
    }
    poznamky.push(`Na fotce jsem nenašla: ${NAZVY[m.rodina] ?? m.typ}. Nahraj fotku toho kusu, nebo nech barvu.`);
  }
  const nove: { kus: SurovyKus; typ: ZkVrstvaTyp; varianta: string }[] = [];
  const obsazene = new Set(mista.map(one => one.typ));
  for (const k of volne) {
    const d = DRUHY[k.druh]!;
    if (obsazene.has(d.typ)) {
      poznamky.push(`Na fotce je i ${k.popis || NAZVY[k.druh]}, ale na model se k tomu dát nedá (stejné místo).`);
      continue;
    }
    obsazene.add(d.typ);
    const varianta = d.rodina === 'motylek' ? (detsky ? 'motylek-detsky' : 'motylek')
      : d.rodina === 'regata' ? 'regata'
        : k.druh === 'pletena' ? 'pletena'
          : d.typ === 'kravata' ? (detsky ? 'kravata-6' : 'kravata')
            : d.typ === 'ksandy' ? (detsky ? 'uzke' : 'siroke')
              : 'spicka';
    nove.push({ kus: k, typ: d.typ, varianta });
    poznamky.push(`Na fotce je navíc ${k.popis || NAZVY[k.druh]} — přidala jsem ho jako další kus sady.`);
  }
  const jine = kusy.filter(one => one.druh === 'jine').map(one => one.popis || 'jiná věc');
  if (jine.length) poznamky.push(`Na model nepatří: ${jine.join(', ')}.`);
  return { prirazeni, nove, poznamky };
}

/* ------------------------------------------------------------ látka */

const hexNa = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));

function prumer(o: Obraz): [number, number, number] {
  let r = 0; let g = 0; let b = 0; let n = 0;
  for (let i = 0; i < o.body.length; i += 4) {
    if (o.body[i + 3] < 128) continue;
    r += o.body[i]; g += o.body[i + 1]; b += o.body[i + 2]; n += 1;
  }
  return n ? [r / n, g / n, b / n] : [0, 0, 0];
}

function naHex(rgb: number[]): string {
  return '#' + rgb.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
}

/**
 * Obdélník látky v bodech fotky, ověřený: nesmí v něm být pozadí.
 *
 * AI se o pár procent splete — a pak je v „látce" proužek bílého
 * pozadí, který se na modelu vydláždí do pruhů. Obdélník se proto
 * zmenšuje ke středu, dokud v něm pozadí není.
 */
function overenyObdelnik(fotka: Obraz, pozadi: Uint8Array, r: number[]): px.Obdelnik | null {
  let x = r[0] * fotka.sirka; let y = r[1] * fotka.vyska;
  let w = r[2] * fotka.sirka; let h = r[3] * fotka.vyska;
  for (let pokus = 0; pokus < 4; pokus++) {
    const kde = {
      x: Math.round(Math.max(0, x)), y: Math.round(Math.max(0, y)),
      w: Math.round(Math.min(fotka.sirka - Math.max(0, x), w)), h: Math.round(Math.min(fotka.vyska - Math.max(0, y), h))
    };
    if (kde.w < 10 || kde.h < 10) return null;
    let naPozadi = 0;
    for (let yy = kde.y; yy < kde.y + kde.h; yy++) {
      for (let xx = kde.x; xx < kde.x + kde.w; xx++) if (pozadi[yy * fotka.sirka + xx]) naPozadi += 1;
    }
    if (naPozadi / (kde.w * kde.h) <= 0.04) return kde;
    x += w * 0.125; y += h * 0.125; w *= 0.75; h *= 0.75;
  }
  return null;
}

/** Malý náhled výřezu pro okno — ať se dá posoudit, odkud látka je. */
function nahled(o: Obraz, strana = 96): string {
  const k = Math.min(1, strana / Math.max(o.sirka, o.vyska));
  const m = k < 1 ? px.prevzorkuj(o, Math.max(1, Math.round(o.sirka * k)), Math.max(1, Math.round(o.vyska * k))) : o;
  return `data:image/png;base64,${uloz(m).toString('base64')}`;
}

/** Dlaždice z výřezu: zmenší se na rozumnou velikost a zrcadlí, aby navazovala. */
function dlazdice(vyrez: Obraz, cm: number): { obraz: Obraz; cm: number } {
  /* Stejně jako u výřezu bez AI: vyrovnat světlo z fotky a prolnout bez švů (latka.ts) */
  const rovny = vyrovnejSvetlo(vyrez);
  const k = Math.min(1, 200 / Math.max(rovny.sirka, rovny.vyska));
  const mensi = k < 1
    ? px.prevzorkuj(rovny, Math.max(4, Math.round(rovny.sirka * k)), Math.max(4, Math.round(rovny.vyska * k)))
    : rovny;
  return { obraz: bezSvu(mensi), cm: Math.round(cm * 100) / 100 };
}

/**
 * Špička kapesníčku s lemem, nakreslená z látky a barvy lemu.
 *
 * Z fotky sady se špička vystřihnout nedá (kapesníček je složený pod
 * kravatou), ale AI řekne, jakou má látku a lem. Tvar odpovídá
 * šabloně — špička kousek vpravo, lem po obou horních hranách.
 */
export function rohSLemem(latka: Obraz, latkaCm: number, lem: string): Obraz {
  const W = 160; const H = 84;
  const out = novyObraz(W, H);
  const A = { x: ROH_SABLONY.apex[0] * W, y: ROH_SABLONY.apex[1] * H };
  const L = { x: ROH_SABLONY.levy[0] * W, y: ROH_SABLONY.levy[1] * H };
  const R = { x: ROH_SABLONY.pravy[0] * W, y: ROH_SABLONY.pravy[1] * H };
  /* Šablona ukazuje kolem 7 cm na šířku; lem bývá kolem 0,6 cm */
  const naCm = W / 7;
  const sirkaLemu = 0.6 * naCm;
  const dlazdiceSirka = Math.max(4, latkaCm * naCm);
  const k = latka.sirka / dlazdiceSirka;
  const [lr, lg, lb] = hexNa(lem);
  const vzdalenost = (p: { x: number; y: number }, a: typeof A, b: typeof A) =>
    Math.abs((b.y - a.y) * p.x - (b.x - a.x) * p.y + b.x * a.y - b.y * a.x) / Math.hypot(b.y - a.y, b.x - a.x);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const p = { x: x + 0.5, y: y + 0.5 };
      const d = Math.min(vzdalenost(p, A, L), vzdalenost(p, A, R));
      /* Vně trojúhelníku je to jedno (vrstva to ořízne) — dá se tam lem, ať hrana neprosvítá */
      const vne = (p.x - A.x) * (L.y - A.y) - (p.y - A.y) * (L.x - A.x) < 0
        || (p.x - A.x) * (R.y - A.y) - (p.y - A.y) * (R.x - A.x) > 0;
      if (vne || d < sirkaLemu) {
        /* Vnitřní hrana lemu je o kousek tmavší — šev */
        const sev = !vne && d > sirkaLemu - 1.2 ? 0.86 : 1;
        out.body[i] = lr * sev; out.body[i + 1] = lg * sev; out.body[i + 2] = lb * sev; out.body[i + 3] = 255;
        continue;
      }
      const zx = Math.floor(((x * k) % latka.sirka + latka.sirka) % latka.sirka);
      const zy = Math.floor(((y * k) % latka.vyska + latka.vyska) % latka.vyska);
      const z = (zy * latka.sirka + zx) * 4;
      out.body[i] = latka.body[z]; out.body[i + 1] = latka.body[z + 1]; out.body[i + 2] = latka.body[z + 2];
      out.body[i + 3] = 255;
    }
  }
  return out;
}

interface Latka {
  hex: string; vzorek: string; vzorekCm: number; zdroj: 'fotka' | 'ai' | 'barva'; vyrez: string;
  mira?: ZkRozpoznanyKus['mira']; kontrolaMeritka?: string;
}

/** Přes co se měří a jak je to doopravdy velké. */
export interface ZnamyRozmer { cm: number; druh: 'list' | 'pruh' | 'rozpeti'; co: string }

/**
 * Skutečný rozměr kusu, přes který AI ukáže čáru: šířka kravaty a kšand
 * z katalogu (jinak ze šablony), rozpětí motýlka, strana kapesníčku.
 * Rozměr z katalogu jen u hlavního kusu — u sady patří jen jemu.
 */
export function znamyRozmer(typ: ZkVrstvaTyp, varianta: string, rozmer: Rozmer = {}): ZnamyRozmer {
  const s = sablonaPro(typ, varianta);
  const r = rozmer.sirkaCm ?? 0;
  if (typ === 'kapesnicek') return { cm: r >= 15 && r <= 50 ? r : 30, druh: 'rozpeti', co: 'strana kapesníčku' };
  if (typ === 'ksandy') return { cm: r >= 1.5 && r <= 6 ? r : (s?.sirkaCm ?? 3.5), druh: 'pruh', co: 'šířka pásku' };
  if (varianta.startsWith('motylek')) return { cm: r >= 6 && r <= 16 ? r : (s?.sirkaCm ?? 12), druh: 'rozpeti', co: 'rozpětí motýlka' };
  return { cm: r >= 3 && r <= 14 ? r : (s?.sirkaCm ?? 7), druh: 'list', co: varianta === 'regata' ? 'šířka regaty' : 'šířka kravaty' };
}

/**
 * Kontrola měřítka pro okno: vlevo kus fotky kolem měření, vpravo
 * vzorek tak, jak ho vydláždí kabina — **ve stejném měřítku**. Když
 * jsou květy vpravo stejně velké jako vlevo, sedí to i na modelu.
 */
function kontrolaMeritka(fotka: Obraz, m: Mereni, dlazdice: Obraz, cm: number, strana = 150): string {
  const okno = m.bodu * 1.7;
  const vlevo = vyrizniOtocene(fotka, m.stred, m.uhel, okno, okno);
  /* Dlaždice: tolik bodů na centimetr jako výřez z fotky */
  const naCmDlazdice = dlazdice.sirka / Math.max(0.1, cm);
  const k = m.bodyNaCm / naCmDlazdice;
  const vpravo = novyObraz(Math.round(okno), Math.round(okno));
  for (let y = 0; y < vpravo.vyska; y++) {
    for (let x = 0; x < vpravo.sirka; x++) {
      const sx = Math.floor(x / k) % dlazdice.sirka; const sy = Math.floor(y / k) % dlazdice.vyska;
      const i = (y * vpravo.sirka + x) * 4; const j = (sy * dlazdice.sirka + sx) * 4;
      vpravo.body[i] = dlazdice.body[j]; vpravo.body[i + 1] = dlazdice.body[j + 1]; vpravo.body[i + 2] = dlazdice.body[j + 2];
      vpravo.body[i + 3] = 255;
    }
  }
  const a = px.prevzorkuj(vlevo, strana, strana); const b = px.prevzorkuj(vpravo, strana, strana);
  const out = novyObraz(strana * 2 + 6, strana);
  out.body.fill(255);
  for (const [o, dx] of [[a, 0], [b, strana + 6]] as const) {
    for (let y = 0; y < strana; y++) {
      for (let x = 0; x < strana; x++) {
        const i = (y * strana + x) * 4; const j = (y * out.sirka + x + dx) * 4;
        const al = o.body[i + 3] / 255;
        for (let c = 0; c < 3; c++) out.body[j + c] = Math.round(o.body[i + c] * al + 245 * (1 - al));
        out.body[j + 3] = 255;
      }
    }
  }
  /* Na fotce: značky šířky, přes kterou se měřilo (svislé čárky v poměru 1 : 1,7) */
  const kraj = Math.round((strana * (1 - 1 / 1.7)) / 2);
  for (const x of [kraj, strana - 1 - kraj]) {
    for (let y = 0; y < 10; y++) {
      for (const yy of [y, strana - 1 - y]) {
        const j = (yy * out.sirka + x) * 4;
        out.body[j] = 230; out.body[j + 1] = 40; out.body[j + 2] = 60;
      }
    }
  }
  return `data:image/png;base64,${uloz(out).toString('base64')}`;
}

/**
 * Látka jednoho kusu: výřez z fotky, ověřený a převedený na dlaždici.
 *
 * Velikost vzoru se **měří** (meritko.ts): AI ukáže čáru přes kus známé
 * šířky a body se spočítají z fotky. Kravata a kšandy se pak vyříznou
 * podél listu (otočené svisle, jako na modelu) a co nejdelší — méně
 * viditelného opakování. Když měřit nejde, zůstane odhad od AI.
 */
async function latkaKusu(
  kus: SurovyKus,
  typ: ZkVrstvaTyp,
  znamy: ZnamyRozmer,
  fotky: Obraz[],
  pozadi: Uint8Array[],
  dokreslit: boolean
): Promise<Latka> {
  const fotka = fotky[kus.foto];
  const hex = kus.barva || '';
  const maska = maskaVyrobku(fotka, pozadi[kus.foto]);
  const m = kus.mira ? zmerMeritko(fotka, maska, kus.mira, znamy.cm, znamy.druh) : null;
  let vyrez: Obraz | null = null;
  let cm = 0;
  if (m && znamy.druh !== 'rozpeti') {
    vyrez = latkaZListu(fotka, maska, m);
    if (vyrez) cm = vyrez.sirka / m.bodyNaCm;
  }
  if (!vyrez) {
    const r = overenyObdelnik(fotka, pozadi[kus.foto], kus.latka);
    vyrez = r ? px.vyrizniObdelnik(fotka, r) : null;
    cm = r ? (m ? r.w / m.bodyNaCm : kus.latkaCm * (r.w / Math.max(1, kus.latka[2] * fotka.sirka))) : 0;
  }
  if (vyrez && hex) {
    /* Výřez úplně jiné barvy, než AI tvrdí = souřadnice ujely; jednobarevný kus to pozná nejlíp */
    const [a, b, c] = prumer(vyrez);
    const [x, y, z] = hexNa(hex);
    const rozdil = Math.abs(a - x) + Math.abs(b - y) + Math.abs(c - z);
    if (kus.vzor === 'jednobarevny' && rozdil > 150) vyrez = null;
  }
  if (!vyrez) {
    /* Z celého kusu postaru: největší čtverec, kde je jen látka */
    const ram = overenyObdelnik(fotka, new Uint8Array(pozadi[kus.foto].length), kus.ram);
    if (ram) {
      const celyKus = px.vyrizniObdelnik(fotka, ram);
      for (const strana of [96, 72, 52, 36]) {
        const kousek = px.vzorekLatky(celyKus, strana, 0.03, 'prumer');
        if (kousek) {
          vyrez = kousek;
          const naCm = m ? m.bodyNaCm : (kus.latka[2] * fotka.sirka) / Math.max(0.5, kus.latkaCm);
          cm = naCm > 0 ? kousek.sirka / naCm : 2.8;
          break;
        }
      }
    }
  }
  if (!vyrez) return { hex, vzorek: '', vzorekCm: 0, zdroj: 'barva', vyrez: '' };
  const nahledVyrezu = nahled(vyrez);
  const prumerna = naHex(prumer(vyrez));
  const mira: ZkRozpoznanyKus['mira'] = m
    ? { cm: znamy.cm, bodu: Math.round(m.bodu), zMereni: m.zMereni, motivu: kus.motivu, co: znamy.co }
    : undefined;

  /* Kapesníček s lemem: špička nakreslená z látky a lemu, přes celý tvar */
  if (typ === 'kapesnicek' && kus.lem) {
    const roh = rohSLemem(dlazdice(vyrez, cm).obraz, cm, kus.lem);
    return { hex: hex || prumerna, vzorek: `data:image/png;base64,${uloz(roh).toString('base64')}`, vzorekCm: -1, zdroj: 'fotka', vyrez: nahledVyrezu, mira };
  }

  /*
   * Málo látky na fotce a vzor: dokreslit podle výřezu. Jednobarevná
   * látka nic nepotřebuje — z malého výřezu se vydláždí stejně dobře.
   */
  const malo = Math.min(vyrez.sirka, vyrez.vyska) < 56;
  if (dokreslit && malo && kus.vzor !== 'jednobarevny' && obrazky.maKlic()
    && obrazky.zbyvaDoStropu() > obrazky.cenaObrazku('medium')) {
    try {
      const nove = await obrazky.dokresliLatku(vyrez, kus.popis);
      /* Kraje dokresleného čtverce bývají slabší — bere se střed */
      const stred = px.vyrizniObdelnik(nove, {
        x: Math.round(nove.sirka * 0.15), y: Math.round(nove.vyska * 0.15),
        w: Math.round(nove.sirka * 0.7), h: Math.round(nove.vyska * 0.7)
      });
      const d = dlazdice(stred, cm * 0.7);
      return {
        hex: hex || prumerna, vzorek: `data:image/png;base64,${uloz(d.obraz).toString('base64')}`, vzorekCm: d.cm, zdroj: 'ai',
        vyrez: nahledVyrezu, mira, kontrolaMeritka: m ? kontrolaMeritka(fotka, m, d.obraz, d.cm) : undefined
      };
    } catch { /* nedokreslilo se — zůstane výřez z fotky */ }
  }
  const d = dlazdice(vyrez, cm || 2.8);
  return {
    hex: hex || prumerna, vzorek: `data:image/png;base64,${uloz(d.obraz).toString('base64')}`, vzorekCm: d.cm, zdroj: 'fotka',
    vyrez: nahledVyrezu, mira, kontrolaMeritka: m ? kontrolaMeritka(fotka, m, d.obraz, d.cm) : undefined
  };
}

/* ---------------------------------------------------------- celé */

/** Fotka pro AI: nejvýš tisíc bodů, JPEG když jde (menší), jinak PNG. */
function proAi(o: Obraz): { b64: string; mime: string } {
  const k = Math.min(1, 1000 / Math.max(o.sirka, o.vyska));
  const m = k < 1 ? px.prevzorkuj(o, Math.round(o.sirka * k), Math.round(o.vyska * k)) : o;
  const png = uloz(m);
  try {
    const jpeg = nativeImage.createFromBuffer(png).toJPEG(86);
    if (jpeg && jpeg.length > 0) return { b64: jpeg.toString('base64'), mime: 'image/jpeg' };
  } catch { /* bez Electronu (zkoušky) se posílá PNG */ }
  return { b64: png.toString('base64'), mime: 'image/png' };
}

export interface VysledekRozpoznani {
  kod: string;
  kusu: number;
  poznamky: string[];
  kontrola: string;
}

/**
 * Rozpozná produkt z fotek a doplní látku každému kusu.
 *
 * `fotky` jde podvrhnout (zkoušky); jinak se stáhnou z katalogu (všechny
 * naráz, z mezipaměti na disku, když už tam jsou).
 */
export async function rozpoznej(
  kod: string,
  moznosti: { fotky?: Obraz[]; nazev?: string; dokreslit?: boolean; rozmer?: Rozmer } = {}
): Promise<VysledekRozpoznani> {
  const row = store.produktyRows().find(one => one.kod === kod);
  if (!row || !row.typ) throw new Error('Produkt není v kabině zařazený — nejdřív mu vyber, kam na model patří.');
  let nazev = moznosti.nazev ?? '';
  if (!nazev) {
    try {
      nazev = (getDb().prepare('SELECT title_cz FROM products WHERE code = ?').get(kod) as { title_cz?: string } | undefined)?.title_cz ?? '';
    } catch { /* bez katalogu (zkoušky) stačí kód */ }
  }
  nazev = nazev || kod;

  let fotky: Obraz[] = [];
  let adresy: string[] = [];
  if (moznosti.fotky) {
    fotky = moznosti.fotky;
    adresy = fotky.map(() => '');
  } else {
    const urls = fotkyProduktu(kod, FOTEK);
    const stazene = await Promise.all(urls.map(url => stahniFotku(url)));
    stazene.forEach((o, i) => { if (o) { fotky.push(o); adresy.push(urls[i]); } });
  }
  const platne = fotky.map(one => one.sirka > 20 && one.vyska > 20);
  fotky = fotky.filter((_, i) => platne[i]);
  adresy = adresy.filter((_, i) => platne[i]);
  if (!fotky.length) throw new Error('Produkt nemá fotku, ze které by šlo číst.');

  const mista: Misto[] = [
    { cast: -1, typ: row.typ as ZkVrstvaTyp, rodina: rodinaVarianty(row.typ, row.varianta), varianta: row.varianta },
    ...(row.casti ?? []).map((c, i) => ({ cast: i, typ: c.typ, rodina: rodinaVarianty(c.typ, c.varianta), varianta: c.varianta }))
  ];
  const rozmer = moznosti.rozmer ?? (moznosti.fotky ? {} : rozmerProduktu(kod));
  const ocekavane = mista.map(m => NAZVY[m.rodina] ?? m.typ).join(' + ');
  const hlavniRozmer = znamyRozmer(row.typ as ZkVrstvaTyp, row.varianta, rozmer);
  const odpoved = await zeptej(fotky.map(proAi),
    `Product name: "${nazev}". By the name it should contain: ${ocekavane}. `
    + `Real size of the main item: ${hlavniRozmer.cm} cm (${hlavniRozmer.druh === 'rozpeti' ? 'wing tip to wing tip / edge length' : 'width'}). `
    + `There are ${fotky.length} photo(s), in this order. Report what you actually see.`);
  const kusy = rozeberOdpoved(odpoved.text, fotky.length);
  const druhy = druhyFotek(odpoved.text, fotky.length);

  const detsky = /detsk|mini|uzke|kravata-6/.test(`${row.varianta} ${(row.casti ?? []).map(c => c.varianta).join(' ')}`)
    || /d[eě]tsk|kojen|mini/i.test(nazev);
  const { prirazeni, nove, poznamky } = prirad(mista, kusy, detsky);

  const pozadi = fotky.map(one => px.pozadiOdKraje(one));
  const nahrane = nahraneLatky();
  const dokreslit = moznosti.dokreslit !== false;
  const shrnuti: ZkRozpoznanyKus[] = [];
  const souhrn = (k: SurovyKus, typ: ZkVrstvaTyp | '', cast: number | null, l: Latka | null): ZkRozpoznanyKus => ({
    druh: k.druh, popis: k.popis, typ, cast, jistota: k.jistota, zdroj: l?.zdroj ?? 'barva', vyrez: l?.vyrez ?? '',
    foto: k.foto, ...(l?.mira ? { mira: l.mira } : {}), ...(l?.kontrolaMeritka ? { kontrolaMeritka: l.kontrolaMeritka } : {})
  });

  let hlavni = { hex: row.hex, vzorek: row.vzorek, vzorekCm: row.vzorekCm ?? 0 };
  const hlavniKus = prirazeni.get(-1);
  if (hlavniKus && !nahrane.has(kod)) {
    const l = await latkaKusu(hlavniKus, row.typ as ZkVrstvaTyp, hlavniRozmer, fotky, pozadi, dokreslit);
    hlavni = {
      hex: row.rucne ? row.hex : (l.hex || row.hex),
      vzorek: l.vzorek || row.vzorek,
      vzorekCm: l.vzorek ? l.vzorekCm : (row.vzorekCm ?? 0)
    };
    shrnuti.push(souhrn(hlavniKus, row.typ as ZkVrstvaTyp, -1, l));
  }

  const casti: ZkCast[] = [];
  for (let i = 0; i < (row.casti ?? []).length; i++) {
    const c = row.casti![i];
    const kus = prirazeni.get(i);
    if (!kus || nahrane.has(`${kod}~${i}`)) { casti.push(c); continue; }
    const l = await latkaKusu(kus, c.typ, znamyRozmer(c.typ, c.varianta), fotky, pozadi, dokreslit);
    casti.push({ ...c, hex: l.hex || c.hex, vzorek: l.vzorek, vzorekCm: l.vzorekCm });
    shrnuti.push(souhrn(kus, c.typ, i, l));
  }
  for (const n of nove) {
    const l = await latkaKusu(n.kus, n.typ, znamyRozmer(n.typ, n.varianta), fotky, pozadi, dokreslit);
    casti.push({ typ: n.typ, varianta: n.varianta, hex: l.hex, vzorek: l.vzorek, vzorekCm: l.vzorekCm });
    shrnuti.push(souhrn(n.kus, n.typ, casti.length - 1, l));
  }
  for (const k of kusy) {
    if (k.druh === 'jine') shrnuti.push(souhrn(k, '', null, null));
  }

  /*
   * Kontrola: sada vždycky (Patrik: nedovolit bez kontroly), samotný kus
   * jen tehdy, když AI viděla něco jiného, než říká název, nebo si
   * nebyla jistá. Schválený samotný kus zůstane schválený — dostal jen
   * lepší látku.
   */
  const sada = casti.length > 0;
  const nejista = shrnuti.some(one => one.typ && one.jistota < 0.6);
  const popisSady = shrnuti.filter(one => one.typ).map(one => one.popis || NAZVY[one.druh]).join(' + ');
  const kontrola = sada || poznamky.length || nejista
    ? `AI na fotce: ${popisSady || 'nic, co patří na model'}. Zkontroluj látky a potvrď.`
    : '';
  const zmenaStavby = casti.length !== (row.casti ?? []).length;
  const schvaleno = row.schvaleno && !sada && !zmenaStavby && !kontrola;

  const ai: ZkRozpoznani = {
    kdy: new Date().toISOString(), model: odpoved.model, verze: VERZE, kusy: shrnuti, poznamky,
    fotky: adresy.map((url, i) => ({ url, druh: druhy[i] }))
  };
  store.zapisProdukt({
    ...row, ...hlavni, casti, kontrola, schvaleno, ai,
    /* Nová látka = nové měřítko; ruční doladění vzoru patřilo k té staré */
    meritko: hlavniKus && !nahrane.has(kod) ? 1 : row.meritko
  });
  return { kod, kusu: shrnuti.filter(one => one.typ).length, poznamky, kontrola };
}

/** Kolik produktů čeká na rozpoznání v daném rozsahu. */
export function kRozpoznani(rozsah: 'nove' | 'sady' | 'vse', kody?: string[]): string[] {
  return store.produktyRows().filter(one => one.typ && (!kody || kody.includes(one.kod))
    && (rozsah === 'vse'
      || (rozsah === 'nove' && (!one.ai || (one.ai.verze ?? 1) < VERZE))
      || (rozsah === 'sady' && (one.kontrola || (one.casti?.length ?? 0) > 0) && !one.ai)))
    .map(one => one.kod);
}

/** Kolik naráz: model s viděním odpoví za 10–20 s, čtyři souběžně zkrátí katalog na čtvrtinu. */
const NARAZ = 4;

/**
 * Rozpozná víc produktů — po čtyřech naráz.
 *
 * Jedno rozpoznání stojí kolem koruny až dvou (šest fotek do modelu
 * s viděním). `nove` = co ještě nemá rozpoznání s měřením vzoru.
 * Po každém hotovém produktu přijde hlášení s jeho kódem, takže okno
 * může ukazovat hotové ke schválení, zatímco se zbytek ještě zpracovává.
 */
export async function rozpoznejVse(
  rozsah: 'nove' | 'sady' | 'vse',
  hlas?: (p: { hotovo: number; celkem: number; co: string; kod?: string }) => void,
  kody?: string[]
): Promise<{ hotovo: number; chyb: number; posledniChyba: string }> {
  const fronta = kRozpoznani(rozsah, kody);
  let hotovo = 0; let chyb = 0; let posledniChyba = ''; let dokonceno = 0;
  try {
    await poSkupinach(fronta, NARAZ, async kod => {
      try {
        await rozpoznej(kod);
        hotovo += 1;
        dokonceno += 1;
        hlas?.({ hotovo: dokonceno, celkem: fronta.length, co: `Připravuji produkty (${dokonceno} z ${fronta.length})`, kod });
      } catch (e: any) {
        chyb += 1;
        dokonceno += 1;
        posledniChyba = String(e?.message ?? e);
        hlas?.({ hotovo: dokonceno, celkem: fronta.length, co: `Připravuji produkty (${dokonceno} z ${fronta.length})` });
        /* Chybějící klíč nebo kredit se dalším produktem nespraví — skončí se hned */
        if (/klíč|API key|credit|kredit|401|403/i.test(posledniChyba)) throw e;
      }
    });
  } catch { /* chyba je v posledniChyba */ }
  setSetting('zkRozpoznanoKdy', new Date().toISOString());
  return { hotovo, chyb, posledniChyba };
}

export const __test = { rozeberOdpoved, druhyFotek, prirad, overenyObdelnik, rohSLemem, znamyRozmer };
