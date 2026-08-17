import { getDb } from './db';
import { shopMatchesSender } from './ordercard';

/**
 * Propojení příchozí pošty s objednávkami.
 *
 * Když zákazník odpoví na potvrzení objednávky nebo se na ni jen zeptá, měla
 * by taková zpráva vyčnívat — jinak snadno zapadne mezi ostatní poštu. Vazba
 * se hledá jen z hlaviček zpráv, které jsou v databázi tak jako tak: číslo
 * objednávky je v předmětu potvrzení a e-mail zákazníka v jeho adrese. Odpadá
 * tím stahování těl zpráv i jakýkoli dotaz na e-shop.
 */

const ORDER_SUBJECT = /(objedn[áa]v|order\b|bestellung)/i;
const SUBJECT_NUMBER = /(?:č\.|c\.|no\.|nr\.|#)\s*(\d{3,})/i;
/** Číslo objednávky kdekoli v textu — pro odpovědi, kde bývá i bez „č." */
const ANY_NUMBER = /\b(\d{5,7})\b/g;

function normEmail(s: string): string {
  const m = (s ?? '').match(/[\w.+-]+@[\w-]+\.[\w.]{2,}/);
  return m ? m[0].toLowerCase() : '';
}

/**
 * Projde potvrzení objednávek a zapíše dvojice „číslo objednávky → zákazník".
 * Čte se výhradně z hlaviček, takže je to levné i pro tisíce zpráv.
 */
export function reindexOrders(days = 400): number {
  const d = getDb();
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows = d.prepare(
    'SELECT id, subject, from_addr, to_addr, date FROM messages WHERE date >= ? ORDER BY date ASC'
  ).all(since) as any[];

  const ins = d.prepare(
    `INSERT INTO order_index (order_number, customer_email, message_pk, date)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(order_number) DO UPDATE SET
       customer_email = excluded.customer_email, message_pk = excluded.message_pk, date = excluded.date`
  );

  let n = 0;
  const tx = d.transaction(() => {
    for (const r of rows) {
      if (!ORDER_SUBJECT.test(r.subject ?? '')) continue;
      if (!shopMatchesSender(r.from_addr ?? '')) continue;
      const num = (r.subject.match(SUBJECT_NUMBER) ?? [])[1];
      const email = normEmail(r.to_addr ?? '');
      if (!num || !email) continue;
      ins.run(num, email, r.id, r.date ?? '');
      n++;
    }
  });
  tx();
  return n;
}

/**
 * Přiřadí příchozí zprávy k objednávkám — i staré, aby šlo dohledat zpětně.
 * Nejdřív podle čísla objednávky
 * v předmětu, jinak podle adresy odesílatele — u té se bere jeho nejnovější
 * objednávka, protože zákazník se ptá typicky na tu poslední.
 */
export function linkMessages(days = 400): number {
  const d = getDb();
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const msgs = d.prepare(
    `SELECT m.id, m.subject, m.from_addr, m.date FROM messages m
     LEFT JOIN order_link ol ON ol.message_pk = m.id
     WHERE m.date >= ? AND ol.message_pk IS NULL AND m.folder NOT IN ('Sent', 'Drafts')`
  ).all(since) as any[];

  // Zákazník číslo často opíše bez úvodní nuly („23702" místo „023702"),
  // proto se porovnává číselně, ne jako text
  const byNumber = d.prepare(
    'SELECT order_number, message_pk FROM order_index WHERE CAST(order_number AS INTEGER) = CAST(? AS INTEGER)'
  );
  const byEmail = d.prepare(
    'SELECT order_number, message_pk FROM order_index WHERE customer_email = ? ORDER BY date DESC LIMIT 1'
  );
  const ins = d.prepare(
    `INSERT INTO order_link (message_pk, order_number, order_msg_pk, resolved)
     VALUES (?, ?, ?, 0) ON CONFLICT(message_pk) DO NOTHING`
  );

  let n = 0;
  const tx = d.transaction(() => {
    for (const m of msgs) {
      // Potvrzení objednávky samo o sobě není dotaz zákazníka
      if (shopMatchesSender(m.from_addr ?? '')) continue;

      let hit: any = null;
      for (const num of String(m.subject ?? '').matchAll(ANY_NUMBER)) {
        hit = byNumber.get(num[1]);
        if (hit) break;
      }
      if (!hit) {
        const email = normEmail(m.from_addr ?? '');
        if (email) hit = byEmail.get(email);
      }
      if (!hit) continue;

      ins.run(m.id, hit.order_number, hit.message_pk);
      n++;
    }
  });
  tx();
  return n;
}

/** Přeindexuje objednávky i vazby — volá se po synchronizaci a při otevření složky. */
export function refreshOrderLinks(): { orders: number; links: number } {
  const orders = reindexOrders();
  const links = linkMessages();
  return { orders, links };
}

/** Kolik zpráv k objednávkám čeká na odpověď. */
export function pendingCount(accountId: number | null): number {
  const row = (accountId
    ? getDb().prepare(
      `SELECT COUNT(*) AS n FROM order_link ol JOIN messages m ON m.id = ol.message_pk
         WHERE ol.resolved = 0 AND m.answered = 0 AND m.account_id = ?`
    ).get(accountId)
    : getDb().prepare(
      `SELECT COUNT(*) AS n FROM order_link ol JOIN messages m ON m.id = ol.message_pk
         WHERE ol.resolved = 0 AND m.answered = 0`
    ).get()) as any;
  return row?.n ?? 0;
}

/** Ruční označení zprávy jako vyřízené (nebo návrat mezi čekající). */
export function setOrderReplyResolved(messageId: number, value: boolean): void {
  getDb().prepare(
    `UPDATE order_link SET resolved = ?, resolved_at = ? WHERE message_pk = ?`
  ).run(value ? 1 : 0, value ? new Date().toISOString() : null, messageId);
}
