import { getSetting, setSetting } from './db';
import { decrypt } from './secure';

/**
 * Aby projekty Supabase neusnuly.
 *
 * Bezplatný tarif projekt po několika dnech bez jediného dotazu uspí. Probrat
 * ho jde jen ručně v administraci a do té doby nefunguje to, co na něm visí:
 * u chatu zákazník píše do prázdna, u Instagramu se nemá kam nahrát fotka
 * k příspěvku a publikace spadne.
 *
 * Aplikace používá **dva** projekty, a každý jinak často:
 *
 *  - **chat** — čte se z něj každých pár vteřin, dokud aplikace běží, takže
 *    se prakticky sám udržuje vzhůru,
 *  - **úložiště médií pro Instagram** — sáhne se na něj jen když se
 *    publikuje příspěvek. Mezi dvěma příspěvky klidně uplyne týden, takže je
 *    na uspání náchylnější než chat.
 *
 * Můžou to být i dva různé projekty, jeden společný, nebo jen jeden z nich
 * nastavený. Proto se nepočítá „chat" a „Instagram", ale **hostitel** —
 * když obojí ukazuje na tentýž projekt, oťuká se jednou a hlásí se jednou.
 *
 * Hranice toho, co tohle umí: aplikace udrží projekt vzhůru jen tehdy, když
 * sama běží. Když se celý týden nespustí, projekt se uspí tak jako tak —
 * proto se pamatuje čas posledního ozvání a je vidět v nastavení.
 */

/** Po kolika dnech ticha má smysl sáhnout na projekt sám od sebe. */
const QUIET_DAYS = 1;

/** Kdy začít varovat. Supabase uspává kolem týdne, tohle nechává rezervu. */
export const WARN_DAYS = 4;

export interface Project {
  /** Hostitel projektu — podle něj se pozná, že jsou dva použití jedno a totéž */
  host: string;
  url: string;
  /** K čemu všemu se projekt v aplikaci používá */
  uses: string[];
  key: string;
  /** Cesta, která projekt jen oťukne a nic nezmění */
  probe: string;
}

/**
 * Klíč z databáze.
 *
 * Čte se přímo z nastavení, ne přes `chat/config` a `instagram/store` —
 * ty si naopak sáhnou sem pro stav, a kdyby to bylo oboustranně, vznikl by
 * kruh v načítání modulů. Tenhle modul je tím nižším z obou.
 */
function secret(key: string): string {
  const raw = getSetting(key, '')!;
  if (!raw) return '';
  try {
    return decrypt(raw);
  } catch {
    // Zamčená klíčenka po přejmenování aplikace — projekt se prostě nehlásí
    return '';
  }
}

function host(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

/**
 * Projekty, které aplikace používá.
 *
 * Slučují se podle hostitele: kdyby chat i úložiště běžely na stejném
 * projektu, je to jeden záznam se dvěma použitími.
 */
export function projects(): Project[] {
  const found = new Map<string, Project>();

  const add = (url: string, key: string, use: string, probe: string) => {
    if (!url || !key) return;
    const id = host(url);
    const existing = found.get(id);
    if (existing) {
      if (!existing.uses.includes(use)) existing.uses.push(use);
      return;
    }
    found.set(id, { host: id, url: url.replace(/\/+$/, ''), uses: [use], key, probe });
  };

  // Dotaz na jeden řádek je to nejlacinější, co projekt probudí
  add(getSetting('chatSupabaseUrl', '')!, secret('chatAnonKey'),
    'chat', '/rest/v1/conversations?select=id&limit=1');

  // Úložiště nemá REST tabulky — výpis kbelíků je jeho obdoba
  add(getSetting('igStorageUrl', '')!, secret('igStorageKey'),
    'média pro Instagram', '/storage/v1/bucket');

  return [...found.values()];
}

/* ---------- kdy se který ozval ---------- */

function seenKey(id: string): string {
  return `supabaseSeen:${id}`;
}

export function markSeen(url: string): void {
  if (!url) return;
  setSetting(seenKey(host(url)), new Date().toISOString());
}

/** Kolik dní je projekt bez ozvání; `-1` = neozval se nikdy. */
export function idleDays(url: string): number {
  if (!url) return -1;
  const at = getSetting(seenKey(host(url)), '')!;
  if (!at) return -1;
  const ms = Date.now() - new Date(at).getTime();
  return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 86_400_000)) : -1;
}

export function lastSeen(url: string): string {
  return url ? getSetting(seenKey(host(url)), '')! : '';
}

/* ---------- oťukání ---------- */

async function ping(project: Project): Promise<void> {
  const res = await fetch(`${project.url}${project.probe}`, {
    headers: { apikey: project.key, Authorization: `Bearer ${project.key}` }
  });
  // I zamítnutí je odpověď — projekt běží a o to tady jde. Vadí až to, když
  // se neozve vůbec (uspaný projekt spojení nepřijme).
  if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
}

/**
 * Oťuká projekty, které se delší dobu neozvaly.
 *
 * Pouští to plánovač jednou za pár hodin. U chatu se to obvykle nikdy
 * neprovede — drží ho vzhůru samotné načítání nepřečtených. U úložiště
 * médií je to naopak jediné, co ho mezi dvěma příspěvky udrží.
 */
export async function keepAwake(force = false): Promise<{ host: string; uses: string[]; ok: boolean; error?: string }[]> {
  const out: { host: string; uses: string[]; ok: boolean; error?: string }[] = [];
  for (const project of projects()) {
    const idle = idleDays(project.url);
    if (!force && idle >= 0 && idle < QUIET_DAYS) continue;
    try {
      await ping(project);
      markSeen(project.url);
      out.push({ host: project.host, uses: project.uses, ok: true });
    } catch (e: any) {
      out.push({ host: project.host, uses: project.uses, ok: false, error: e?.message ?? String(e) });
    }
  }
  return out;
}

/** Přehled pro nastavení: co je nastavené a jak dlouho je od každého ticho. */
export function status(): { host: string; uses: string[]; lastSeen: string; idleDays: number; warn: boolean }[] {
  return projects().map(project => {
    const idle = idleDays(project.url);
    return {
      host: project.host,
      uses: project.uses,
      lastSeen: lastSeen(project.url),
      idleDays: idle,
      warn: idle >= WARN_DAYS
    };
  });
}
