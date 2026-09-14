import { getSetting, setSetting } from '../../db';

/**
 * Kurz koruny k euru z ČNB.
 *
 * U nového produktu se cena zadává v korunách i v eurech a druhé políčko
 * zůstávalo prázdné — přepočítávat to v hlavě u každého produktu je zbytečná
 * práce a přepsat se přitom dá čárka. Aplikace proto nabídne přibližnou cenu;
 * přesnou (s koncovkou .90 a podobně) si člověk nastaví sám.
 *
 * Kurz **nevymýšlí model**. Bere se z denního kurzovního lístku ČNB, což je
 * jediné číslo, které se dá ověřit — a je jasné, ke kterému dni platí.
 */

const KEY = 'ptrans.rateEur';
const SOURCE = 'https://www.cnb.cz/cs/financni-trhy/devizovy-trh/kurzy-devizoveho-trhu/'
  + 'kurzy-devizoveho-trhu/denni_kurz.txt';

export interface EurRate {
  /** Kolik korun stojí jedno euro */
  rate: number;
  /** Den, ke kterému kurz platí (jak ho uvádí ČNB) */
  day: string;
  /** Kdy se stahoval */
  at: string;
}

/**
 * Přečte kurz z kurzovního lístku.
 *
 * Řádky jsou `země|měna|množství|kód|kurz` a množství není vždy jedna
 * (u forintu je to sto) — dělí se jím, jinak by cena vyšla stokrát vedle.
 */
export function parseRate(text: string, code = 'EUR'): { rate: number; day: string } | null {
  const day = (text.split('\n')[0] ?? '').split('#')[0].trim();
  for (const line of text.split('\n')) {
    const parts = line.split('|');
    if (parts.length < 5 || parts[3].trim().toUpperCase() !== code) continue;
    const amount = Number(parts[2].replace(',', '.')) || 1;
    const value = Number(parts[4].replace(/\s/g, '').replace(',', '.'));
    if (!Number.isFinite(value) || value <= 0) return null;
    return { rate: value / amount, day };
  }
  return null;
}

function stored(): EurRate | null {
  try {
    const raw = getSetting(KEY, '');
    if (!raw) return null;
    const saved = JSON.parse(raw) as EurRate;
    return Number.isFinite(saved?.rate) && saved.rate > 0 ? saved : null;
  } catch {
    return null;
  }
}

/** Kurz je z dneška? Lístek vychází jednou denně, častěji se ptát nemá smysl. */
function fresh(saved: EurRate | null): boolean {
  if (!saved?.at) return false;
  return Date.now() - Date.parse(saved.at) < 12 * 3600_000;
}

export async function eurRate(force = false): Promise<EurRate | null> {
  const saved = stored();
  if (!force && fresh(saved)) return saved;
  try {
    const res = await fetch(SOURCE, { redirect: 'follow' });
    if (!res.ok) return saved;
    const parsed = parseRate(await res.text());
    if (!parsed) return saved;
    const next: EurRate = { rate: parsed.rate, day: parsed.day, at: new Date().toISOString() };
    setSetting(KEY, JSON.stringify(next));
    return next;
  } catch {
    /*
     * Bez sítě se vrátí poslední známý kurz. Přibližná cena z včerejšího
     * kurzu je pořád lepší než prázdné políčko — a je u ní vidět, ke
     * kterému dni platí.
     */
    return saved;
  }
}

export const __test = { parseRate };
