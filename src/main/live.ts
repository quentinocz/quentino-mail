/**
 * Živé propojení telefonu a počítače přes Supabase Realtime.
 *
 * ## Proč vůbec
 *
 * Naskladnění se počítá u regálu s telefonem v ruce, ale do e-shopu se
 * zapisuje z počítače. Dosud to putovalo sdílenou složkou: telefon zapsal
 * soubor, iCloud ho nahrál, počítač si ho v některém z minutových kol
 * přečetl. V součtu to bylo klidně dvě minuty, a to je u regálu věčnost —
 * člověk mezitím dojde k počítači a kouká na starý seznam.
 *
 * ## Co se tím mění a co ne
 *
 * **Sdílená složka zůstává tím, co platí.** Je trvalá: přežije vypnutý
 * počítač, zavřenou aplikaci i výpadek sítě, a slučování po řádcích v ní
 * je vyzkoušené. Tenhle modul je jen **rychlý posel** — pošle tutéž věc
 * hned a druhá strana ji sloučí týmž kódem (`mergeStockin`), který by
 * jinak spustila složka. Když posel nedoručí, nic se neztratí; dojde to
 * složkou jako dřív, jen později.
 *
 * ## Proč broadcast a ne tabulky
 *
 * Supabase je v aplikaci kvůli chatu už napojený, takže se nic nového
 * nezavádí. Posílá se ale **broadcast**, ne změny v tabulkách:
 *
 *  - do databáze se nic neukládá, takže není co zabezpečovat pravidly
 *    přístupu ani co uklízet — a anon klíč je veřejný (je i ve widgetu na
 *    e-shopu), takže dát mu do rukou skladová data by nebylo v pořádku,
 *  - není potřeba spouštět žádné SQL ani zakládat tabulky,
 *  - zpráva se doručí jen tomu, kdo zrovna poslouchá, což přesně odpovídá
 *    tomu, k čemu to je: „koukni se, něco se změnilo, tady to máš".
 *
 * Jméno kanálu je zároveň heslo — kdo ho nezná, na kanál nedosáhne. Proto
 * se generuje dlouhé a náhodné, stejně jako téma pro upozornění.
 *
 * ## Protokol
 *
 * Realtime mluví protokolem Phoenixu: JSON rámce `{topic, event, payload,
 * ref}` přes WebSocket. Knihovna na to není potřeba, jsou to čtyři druhy
 * rámců — připojení ke kanálu, tep, odeslání a příjem.
 */
import crypto from 'crypto';
import { BrowserWindow } from 'electron';
import { getSetting, setSetting } from './db';
import { getSecrets } from './chat/config';
import { deviceId, deviceLabel } from './device';

/** Jak dlouho čekat mezi tepy — server bez nich spojení po chvíli zavře. */
const HEARTBEAT_MS = 25_000;
/** Po neúspěchu se čeká čím dál dýl, ale nejvýš minutu. */
const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 60_000;

/**
 * Druhy zpráv.
 *
 * `hello` je pozdrav při připojení: kdo se právě přidal, neví, co se mezitím
 * dělo, a broadcast se nikam neukládá. Ostatní na pozdrav odpoví tím, co
 * mají rozdělané — jinak by aplikace zapnutá uprostřed naskladnění o něm
 * nevěděla až do prvního dalšího pípnutí.
 *
 * `vouchers` je deník poukazů. U nich na rychlosti záleží nejvíc ze všeho:
 * dvě zařízení, která o sobě nevědí, můžou vydat týž kód dvakrát — a pozná
 * se to až u zákazníka, který ho nemůže uplatnit.
 */
export type LiveKind = 'stockin' | 'packing' | 'vouchers' | 'hello';

export interface LiveMessage {
  kind: LiveKind;
  /** Odkud to přišlo — vlastní zprávy se zahazují */
  from: string;
  /** Jméno zařízení do hlášky („z telefonu Patrik") */
  fromName: string;
  data: any;
}

export interface LiveStatus {
  /** Je propojení zapnuté v nastavení? */
  enabled: boolean;
  channel: string;
  /** Drží spojení právě teď? */
  connected: boolean;
  /** Poslední potíž, když se připojit nedaří */
  error: string | null;
}

/* ---------- nastavení ---------- */

export function getChannel(): string {
  return getSetting('liveChannel', '')!;
}

export function isEnabled(): boolean {
  return getSetting('liveEnabled', '0') === '1' && !!getChannel() && !!getSecrets().url;
}

/**
 * Nové jméno kanálu.
 *
 * Je to zároveň heslo, takže se nevymýšlí — 20 znaků z náhodných bajtů je
 * na uhodnutí příliš. Písmena a číslice proto, že jméno kanálu jde do
 * adresy a diakritika ani pomlčky by se tam pletly.
 */
export function newChannel(): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(20);
  let out = 'q-';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

export function saveConfig(patch: { channel?: string; enabled?: boolean }): LiveStatus {
  if (patch.channel !== undefined) setSetting('liveChannel', patch.channel.trim());
  if (patch.enabled !== undefined) setSetting('liveEnabled', patch.enabled ? '1' : '0');
  // Změna se má projevit hned, ne až po restartu
  stop();
  if (isEnabled()) start();
  return status();
}

export function status(): LiveStatus {
  return {
    enabled: getSetting('liveEnabled', '0') === '1',
    channel: getChannel(),
    connected: joined,
    error: lastError
  };
}

/* ---------- spojení ---------- */

let socket: WebSocket | null = null;
let joined = false;
let lastError: string | null = null;
let heartbeat: NodeJS.Timeout | null = null;
let retry: NodeJS.Timeout | null = null;
let retryIn = RETRY_MIN_MS;
let ref = 0;
let stopped = true;

const listeners = new Set<(message: LiveMessage) => void>();

export function onLive(cb: (message: LiveMessage) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Předá přijatou zprávu posluchačům.
 *
 * Odděleno od obsluhy WebSocketu schválně: doručení je to jediné, na čem
 * u příjmu záleží, a takhle se dá vyzkoušet bez skutečného spojení —
 * zkouška podstrčí zprávu rovnou sem. Kdyby to šlo jen přes síť, nedalo by
 * se ověřit vůbec nic z toho, co se s přijatou prací stane.
 */
export function deliver(body: any): void {
  if (!body || typeof body !== 'object') return;
  if (body.from === deviceId()) return;   // vlastní zpráva, ta se sem vrátit neměla
  for (const cb of listeners) {
    try { cb(body as LiveMessage); } catch { /* jeden posluchač nesmí shodit ostatní */ }
  }
}

function emitState() {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('live:state', status());
}

function topic(): string {
  return `realtime:${getChannel()}`;
}

function send(event: string, payload: unknown, onTopic = topic()) {
  if (!socket || socket.readyState !== 1) return;
  socket.send(JSON.stringify({ topic: onTopic, event, payload, ref: String(++ref) }));
}

/**
 * Adresa WebSocketu Realtime.
 *
 * Ze `https://xyz.supabase.co` se stane `wss://xyz.supabase.co/realtime/v1/…`.
 * Klíč jde do adresy, protože hlavičky se u WebSocketu v prohlížečovém
 * rozhraní nastavit nedají.
 */
function socketUrl(): string | null {
  const { url, anonKey } = getSecrets();
  if (!url || !anonKey) return null;
  const ws = url.replace(/^http/, 'ws').replace(/\/+$/, '');
  return `${ws}/realtime/v1/websocket?apikey=${encodeURIComponent(anonKey)}&vsn=1.0.0`;
}

export function start(): void {
  stopped = false;
  if (!isEnabled() || socket) return;

  const address = socketUrl();
  if (!address) {
    lastError = 'Chybí adresa Supabase nebo anon klíč (Chat → Nastavení).';
    return;
  }
  /*
   * WebSocket je v Node vestavěný teprve od dvaadvacítky. Kdyby aplikace
   * běžela na starší, ať to řekne rovnou místo pádu — složka funguje dál.
   */
  if (typeof WebSocket === 'undefined') {
    lastError = 'Tahle verze aplikace neumí živé propojení — zbývá sdílená složka.';
    return;
  }

  try {
    socket = new WebSocket(address);
  } catch (e: any) {
    lastError = e?.message ?? 'nepodařilo se otevřít spojení';
    scheduleRetry();
    return;
  }

  socket.onopen = () => {
    lastError = null;
    /*
     * Přihlášení ke kanálu. `self: false` znamená, že se vlastní zprávy
     * nevrací zpátky — jinak by si počítač slučoval sám se sebou.
     */
    send('phx_join', {
      config: { broadcast: { self: false, ack: false }, presence: { key: '' } }
    });
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = setInterval(() => send('heartbeat', {}, 'phoenix'), HEARTBEAT_MS);
  };

  socket.onmessage = (event: MessageEvent) => {
    let frame: any = null;
    try { frame = JSON.parse(String(event.data)); } catch { return; }

    if (frame.event === 'phx_reply' && frame.topic === topic()) {
      const ok = frame.payload?.status === 'ok';
      joined = ok;
      if (!ok) {
        lastError = frame.payload?.response?.reason
          ?? 'kanál nešel otevřít — zkontroluj adresu a klíč';
      } else {
        retryIn = RETRY_MIN_MS;
        // Připojení uprostřed práce: zeptat se, co je rozdělané
        publish('hello', {});
      }
      emitState();
      return;
    }

    if (frame.event !== 'broadcast') return;
    deliver(frame.payload?.payload);
  };

  socket.onerror = () => {
    lastError = 'spojení se nepodařilo navázat';
  };

  socket.onclose = () => {
    joined = false;
    socket = null;
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    emitState();
    scheduleRetry();
  };
}

function scheduleRetry(): void {
  if (stopped || !isEnabled() || retry) return;
  retry = setTimeout(() => {
    retry = null;
    start();
  }, retryIn);
  // Čekání se zdvojnásobuje, ať se při delším výpadku neťuká pořád dokola
  retryIn = Math.min(RETRY_MAX_MS, retryIn * 2);
}

export function stop(): void {
  stopped = true;
  if (retry) { clearTimeout(retry); retry = null; }
  if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
  retryIn = RETRY_MIN_MS;
  joined = false;
  const open = socket;
  socket = null;
  try { open?.close(); } catch { /* už je zavřený */ }
  emitState();
}

/**
 * Pošle změnu druhé straně.
 *
 * Tiše se vzdá, když spojení není — složka to donese. Návratová hodnota
 * říká, jestli se to povedlo, aby tlačítko „odeslat do počítače" mohlo
 * říct pravdu.
 */
export function publish(kind: LiveKind, data: unknown): boolean {
  if (!joined || !socket || socket.readyState !== 1) return false;
  const message: LiveMessage = {
    kind, from: deviceId(), fromName: deviceLabel(), data
  };
  send('broadcast', { type: 'broadcast', event: kind, payload: message });
  return true;
}
