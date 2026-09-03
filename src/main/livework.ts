/**
 * Co se stane, když od druhého zařízení něco přijde.
 *
 * Modul je schválně oddělený od `live.ts`: ten umí jen poslat a přijmout
 * zprávu a neví nic o naskladnění ani o balení. Tady se to teprve spojuje
 * dohromady — a díky tomu nevzniká kruh, ve kterém by naskladnění
 * potřebovalo posla a posel naskladnění.
 *
 * ## Nic se nevnucuje
 *
 * Přijatá práce se **uloží hned, ale okno se neotevře**. Na počítači může
 * být rozepsaná odpověď zákazníkovi nebo rozdělaný překlad a vyskočit
 * přes to celým oknem jen proto, že někdo u regálu pípnul čtečkou, by bylo
 * horší než nic. Místo toho se dole ukáže úzký proužek — stejně jako
 * u překladu běžícího na pozadí — a okno se otevře, teprve když na něj
 * někdo klepne.
 *
 * Proužek zmizí sám, když je práce hotová (naskladnění odeslané, krabice
 * zavřená), nebo když ho někdo odklidí.
 */
import { BrowserWindow } from 'electron';
import * as live from './live';
import { mergeStockin, sessionOf, itemsOf, sessionSlice } from './stockin';
import { applyPacking, packingSlice } from './packing';
import { applyVoucherJournal } from './appsync';
import { getDb } from './db';
import type { LiveOffer } from '../shared/types';

function emit(channel: string, payload: unknown) {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload);
}

/**
 * Co se právě nabízí.
 *
 * Drží se to v paměti, ne v databázi: je to nabídka pro tenhle běh
 * aplikace, ne fakt o zboží. Po zavření aplikace nemá co obnovovat —
 * data samotná už v databázi jsou.
 */
const offers = new Map<string, LiveOffer>();

/**
 * Na co se právě někdo dívá.
 *
 * Jakmile je okno balení otevřené, proužek u balení nemá co nabízet — kdo
 * ho má před sebou, ten se rozhodl u toho být. Přechod na jinou objednávku
 * v telefonu se pak přepne rovnou v okně, místo aby se pod ním hromadily
 * nabídky, které se po zavření musí jedna po druhé odklikat.
 */
const watching = new Set<string>();

export function watchLive(kind: string, on: boolean): void {
  if (on) {
    watching.add(kind);
    // Co se nabízelo, než se okno otevřelo, už nabízet nemá smysl
    let dropped = false;
    for (const [key, one] of offers) {
      if (one.kind === kind) { offers.delete(key); dropped = true; }
    }
    if (dropped) emit('live:offers', liveOffers());
  } else {
    watching.delete(kind);
  }
}

export function liveOffers(): LiveOffer[] {
  return [...offers.values()].sort((a, b) => (a.at < b.at ? 1 : -1));
}

export function dismissOffer(key: string): LiveOffer[] {
  offers.delete(key);
  emit('live:offers', liveOffers());
  return liveOffers();
}

/**
 * Nabídne rozdělanou práci — nejvýš jednu od každého druhu.
 *
 * Když se v telefonu proklikají čtyři objednávky za sebou, nabídky se dřív
 * hromadily a po zavření okna se musely odklikat jedna po druhé. Zajímavá je
 * přitom vždycky ta poslední: u té se právě stojí.
 */
function offer(one: LiveOffer): void {
  // Kdo má okno otevřené, ten se rozhodl u toho být — tomu se nic nenabízí
  if (watching.has(one.kind)) return;
  for (const [key, old] of offers) {
    if (old.kind === one.kind && key !== one.key) offers.delete(key);
  }
  offers.set(one.key, one);
  emit('live:offers', liveOffers());
}

/** Práce je hotová — proužek nemá co nabízet. */
function closeOffer(key: string): void {
  if (offers.delete(key)) emit('live:offers', liveOffers());
}

/* ---------- příjem ---------- */

export function startLiveWork(): void {
  live.onLive(message => {
    if (message.kind === 'hello') { answerHello(); return; }
    if (message.kind === 'stockin') { takeStockin(message.fromName, message.data); return; }
    if (message.kind === 'packing') { takePacking(message.fromName, message.data); return; }
    /*
     * Poukazy se jen sloučí, nic se nenabízí. Není to rozdělaná práce, na
     * kterou by se dalo „přejít" — je to fakt o tom, který kód je vydaný,
     * a ten platí všude stejně.
     */
    if (message.kind === 'vouchers') { applyVoucherJournal(message.data); return; }
  });
}

/**
 * Někdo se právě připojil a ptá se, co je rozdělané.
 *
 * Odpovídá se jen otevřeným naskladněním — hotová druhou stranu nezajímají
 * a poslat všechno by znamenalo velkou zprávu při každém zapnutí telefonu.
 */
function answerHello(): void {
  const open = getDb().prepare(
    "SELECT id FROM stockin WHERE state = 'open' ORDER BY updated_at DESC LIMIT 3"
  ).all() as any[];
  for (const row of open) {
    const slice = sessionSlice(String(row.id));
    if (slice) live.publish('stockin', slice);
  }
}

function takeStockin(from: string, data: any): void {
  const id = String(data?.sessions?.[0]?.id ?? '');
  if (!id) return;

  mergeStockin(data);
  emit('stockin:changed', {});

  const session = sessionOf(id);
  // Odeslaná nebo smazaná už není práce, kterou by mělo smysl nabízet
  if (!session || session.state !== 'open') { closeOffer(`stockin:${id}`); return; }

  const items = itemsOf(id);
  const pieces = items.reduce((sum, one) => sum + one.qty, 0);
  // Otevřené okno se přepne rovnou na tuhle věc, ať se nemusí hledat
  emit('live:work', { kind: 'stockin', id, from });
  offer({
    key: `stockin:${id}`,
    kind: 'stockin',
    id,
    from,
    title: session.title || 'Naskladnění',
    detail: `${items.length} položek · ${pieces} ks`,
    at: new Date().toISOString()
  });
}

function takePacking(from: string, data: any): void {
  const applied = applyPacking(data);
  if (!applied) return;
  /*
   * Se stavem, ne jen jako „něco se změnilo". Otevřené okno si ho rovnou
   * promítne do zaškrtávátek; kdyby dostalo jen zprávu, muselo by celý
   * seznam načíst znovu — a než by to udělalo, koukal by na něj člověk
   * s odškrtnutou položkou v telefonu a neodškrtnutou na obrazovce.
   */
  emit('packing:changed', applied);

  // Otevřené okno se přepne rovnou na tuhle objednávku
  emit('live:work', { kind: 'packing', id: applied.code, from });

  if (applied.done) { closeOffer(`packing:${applied.code}`); return; }

  let counted = 0;
  try { counted = Object.values(JSON.parse(String(data.counts ?? '{}'))).length; } catch { /* prázdno */ }
  offer({
    key: `packing:${applied.code}`,
    kind: 'packing',
    id: applied.code,
    from,
    title: `Objednávka ${applied.code}`,
    detail: counted > 0 ? `${counted} položek odškrtnuto` : 'balí se',
    at: new Date().toISOString()
  });
}

/** Nabídka po klepnutí zmizí — okno otevře rozhraní samo. */
export { packingSlice };
