import { BrowserWindow } from 'electron';
import { getDb, getSetting } from './db';
import { deviceId, deviceName } from './device';
import { findByCode } from './products';
import { StockinSession, StockinItem, StockinPlanRow } from '../shared/types';

/**
 * Naskladnění — naskladnění zboží.
 *
 * Zboží dorazí v krabici, někdo ho projde kus po kuse a v e-shopu musí
 * přibýt na skladě. Dělá se to u regálu, ne u počítače, takže se to začíná
 * na telefonu a dokončuje na Macu — a mezi tím se nesmí nic ztratit.
 *
 * Naskladnění je proto **seznam řádků, ne jeden dokument**: každý řádek je kód
 * a počet. Řádky se mezi zařízeními slučují po jednom (stejně jako deníky
 * poukazů), takže když se na telefonu přidá pět položek a na Macu tři,
 * výsledek má osm — bez ohledu na to, které zařízení bylo první.
 *
 * Co se **nedělá**: nikde se nezapisuje zásoba naslepo. U každého řádku se
 * pamatuje, kolik toho bylo skladem v okamžiku načtení, takže při odeslání
 * je vidět „bylo 4, přidáváme 10" — a když se mezitím prodalo, je to poznat.
 */

function now(): string {
  return new Date().toISOString();
}

function touch(id: string): void {
  getDb().prepare('UPDATE stockin SET updated_at = ? WHERE id = ?').run(now(), id);
}

export function listSessions(): StockinSession[] {
  const rows = getDb().prepare(
    `SELECT s.*, (SELECT COUNT(*) FROM stockin_items i WHERE i.session_id = s.id) AS lines,
            (SELECT COALESCE(SUM(qty), 0) FROM stockin_items i WHERE i.session_id = s.id) AS pieces
     FROM stockin s ORDER BY (s.state = 'open') DESC, s.updated_at DESC LIMIT 60`
  ).all() as any[];
  return rows.map(mapSession);
}

function mapSession(r: any): StockinSession {
  return {
    id: r.id,
    title: r.title ?? '',
    note: r.note ?? '',
    device: r.device ?? '',
    state: r.state === 'sent' ? 'sent' : 'open',
    createdAt: r.created_at ?? '',
    updatedAt: r.updated_at ?? '',
    sentAt: r.sent_at || null,
    lines: r.lines ?? 0,
    pieces: r.pieces ?? 0
  };
}

export function createSession(title = ''): StockinSession {
  const id = `${deviceId().slice(0, 6)}-${Date.now().toString(36)}`;
  const at = now();
  getDb().prepare(
    `INSERT INTO stockin (id, title, device, state, created_at, updated_at)
     VALUES (?,?,?,'open',?,?)`
  ).run(id, title || `Naskladnění ${new Date().toLocaleDateString('cs-CZ')}`, deviceName(), at, at);
  return sessionOf(id)!;
}

export function sessionOf(id: string): StockinSession | null {
  const row = getDb().prepare(
    `SELECT s.*, (SELECT COUNT(*) FROM stockin_items i WHERE i.session_id = s.id) AS lines,
            (SELECT COALESCE(SUM(qty), 0) FROM stockin_items i WHERE i.session_id = s.id) AS pieces
     FROM stockin s WHERE s.id = ?`
  ).get(id) as any;
  return row ? mapSession(row) : null;
}

export function itemsOf(id: string): StockinItem[] {
  const rows = getDb().prepare(
    'SELECT * FROM stockin_items WHERE session_id = ? ORDER BY added_at DESC'
  ).all(id) as any[];
  return rows.map(r => ({
    code: r.code,
    productCode: r.product_code ?? '',
    title: r.title ?? '',
    label: r.label ?? '',
    qty: r.qty ?? 0,
    stockBefore: r.stock_before ?? null,
    addedAt: r.added_at ?? ''
  }));
}

/**
 * Přidá načtený kód. Když už na naskladnění je, jen se přičte počet.
 *
 * Vrací i to, co se našlo — u regálu je potřeba na první pohled vidět, že
 * pípnutí sedlo na správné zboží. Když se nenajde nic, **nic se nepřidá**:
 * naskladnění s řádkem „neznámý kód" by se nedala odeslat a při zápisu do
 * e-shopu by se stejně musela řešit ručně.
 */
export function addScan(id: string, raw: string, qty = 1):
  { added: boolean; item?: StockinItem; unknown?: string } {
  const hit = findByCode(raw);
  if (!hit) return { added: false, unknown: (raw ?? '').trim() };

  const d = getDb();
  const exists = d.prepare('SELECT qty FROM stockin_items WHERE session_id = ? AND code = ?')
    .get(id, hit.code) as { qty: number } | undefined;

  if (exists) {
    d.prepare('UPDATE stockin_items SET qty = qty + ? WHERE session_id = ? AND code = ?')
      .run(Math.max(1, qty), id, hit.code);
  } else {
    d.prepare(
      `INSERT INTO stockin_items (session_id, code, product_code, title, label, qty, stock_before, added_at)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(id, hit.code, hit.productCode, hit.title, hit.label, Math.max(1, qty), hit.stock, now());
  }
  touch(id);
  const item = itemsOf(id).find(one => one.code === hit.code)!;
  return { added: true, item };
}

export function setQty(id: string, code: string, qty: number): void {
  const d = getDb();
  if (qty <= 0) d.prepare('DELETE FROM stockin_items WHERE session_id = ? AND code = ?').run(id, code);
  else d.prepare('UPDATE stockin_items SET qty = ? WHERE session_id = ? AND code = ?').run(Math.round(qty), id, code);
  touch(id);
}

export function renameSession(id: string, title: string, note = ''): void {
  getDb().prepare('UPDATE stockin SET title = ?, note = ?, updated_at = ? WHERE id = ?')
    .run(title, note, now(), id);
}

export function deleteSession(id: string): void {
  const d = getDb();
  d.prepare('DELETE FROM stockin_items WHERE session_id = ?').run(id);
  d.prepare('DELETE FROM stockin WHERE id = ?').run(id);
}

/** Označí naskladnění za odeslanou — už se do ní nepřidává a nesynchronizuje se zpět. */
export function markSent(id: string): void {
  getDb().prepare("UPDATE stockin SET state = 'sent', sent_at = ?, updated_at = ? WHERE id = ?")
    .run(now(), now(), id);
}

/**
 * Podklad pro zápis do e-shopu.
 *
 * K řádkům se dohledají vnitřní čísla z feedu (`product_id`, `variant_id`) —
 * bez nich se do Upgates zapsat nedá, formulář ani API kód produktu nepoužívá.
 * Co se dohledat nepodaří, se nezamlčí: vrátí se s prázdným `productId`
 * a rozhraní to ukáže jako řádek k ručnímu dořešení.
 */
export function planOf(id: string): StockinPlanRow[] {
  const d = getDb();
  const items = itemsOf(id);
  const out: StockinPlanRow[] = [];

  for (const item of items) {
    const variant = d.prepare('SELECT * FROM product_variants WHERE code = ?').get(item.code) as any;
    const product = d.prepare('SELECT * FROM products WHERE code = ?')
      .get(variant ? variant.product_code : item.code) as any;
    const stockNow = variant ? variant.stock : product?.stock ?? null;

    out.push({
      code: item.code,
      title: item.title || product?.title_cz || item.code,
      label: item.label,
      qty: item.qty,
      productId: product?.product_id ?? '',
      variantId: variant?.variant_id ?? '',
      stockNow: stockNow ?? null,
      stockBefore: item.stockBefore,
      /*
       * Zásoba se od načtení změnila — mezitím se prodalo nebo někdo
       * naskladnil ručně. Není to chyba, ale je to jediná informace, kvůli
       * které se má člověk před odesláním podívat.
       */
      moved: item.stockBefore !== null && stockNow !== null && item.stockBefore !== stockNow
    });
  }
  return out;
}

/* ---------- synchronizace mezi zařízeními ---------- */

/**
 * Sloučení naskladnění ze sdílené složky.
 *
 * Slučuje se po řádcích a **počet se bere jako vyšší z obou stran**, ne jako
 * součet: kdyby se sčítalo, každá další synchronizace by počet nafoukla.
 * Odeslané naskladnění se nikdy nevrací do stavu „rozpracované" — jednou
 * zapsané zboží se nemá naskladnit podruhé.
 */
export function mergeStockin(remote: any): void {
  if (!remote || !Array.isArray(remote.sessions)) return;
  const d = getDb();

  const upsertSession = d.prepare(
    `INSERT INTO stockin (id, title, note, device, state, created_at, updated_at, sent_at)
     VALUES (@id, @title, @note, @device, @state, @created_at, @updated_at, @sent_at)
     ON CONFLICT(id) DO UPDATE SET
       title = CASE WHEN excluded.updated_at > stockin.updated_at THEN excluded.title ELSE stockin.title END,
       note = CASE WHEN excluded.updated_at > stockin.updated_at THEN excluded.note ELSE stockin.note END,
       state = CASE WHEN excluded.state = 'sent' THEN 'sent' ELSE stockin.state END,
       sent_at = CASE WHEN stockin.sent_at = '' THEN excluded.sent_at ELSE stockin.sent_at END,
       updated_at = MAX(stockin.updated_at, excluded.updated_at)`
  );
  const upsertItem = d.prepare(
    `INSERT INTO stockin_items (session_id, code, product_code, title, label, qty, stock_before, added_at)
     VALUES (@session_id, @code, @product_code, @title, @label, @qty, @stock_before, @added_at)
     ON CONFLICT(session_id, code) DO UPDATE SET
       qty = MAX(stockin_items.qty, excluded.qty),
       title = CASE WHEN stockin_items.title = '' THEN excluded.title ELSE stockin_items.title END,
       label = CASE WHEN stockin_items.label = '' THEN excluded.label ELSE stockin_items.label END,
       stock_before = COALESCE(stockin_items.stock_before, excluded.stock_before)`
  );

  const run = d.transaction(() => {
    for (const s of remote.sessions) {
      if (!s?.id) continue;
      upsertSession.run({
        id: String(s.id),
        title: s.title ?? '',
        note: s.note ?? '',
        device: s.device ?? '',
        state: s.state === 'sent' ? 'sent' : 'open',
        created_at: s.created_at ?? now(),
        updated_at: s.updated_at ?? now(),
        sent_at: s.sent_at ?? ''
      });
    }
    for (const i of remote.items ?? []) {
      if (!i?.session_id || !i?.code) continue;
      upsertItem.run({
        session_id: String(i.session_id),
        code: String(i.code),
        product_code: i.product_code ?? '',
        title: i.title ?? '',
        label: i.label ?? '',
        qty: Number(i.qty) || 0,
        stock_before: i.stock_before ?? null,
        added_at: i.added_at ?? now()
      });
    }
  });
  run();
}

/** Co se má poslat do sdílené složky — jen rozpracované a nedávno odeslané. */
export function stockinExport(): { sessions: any[]; items: any[] } {
  const d = getDb();
  const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const sessions = d.prepare(
    'SELECT * FROM stockin WHERE state = ? OR updated_at > ? ORDER BY updated_at DESC LIMIT 60'
  ).all('open', cutoff) as any[];
  const ids = sessions.map(s => s.id);
  const items = ids.length
    ? d.prepare(
      `SELECT * FROM stockin_items WHERE session_id IN (${ids.map(() => '?').join(',')})`
    ).all(...ids) as any[]
    : [];
  return { sessions, items };
}

export function emitChanged(): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('stockin:changed', {});
}

export { getSetting };
