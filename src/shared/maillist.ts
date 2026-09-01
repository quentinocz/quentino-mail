/**
 * Jak se zprávy popisují v seznamu.
 *
 * Stojí to zvlášť od rozhraní, aby se to dalo zkoušet bez prohlížeče — obojí
 * je drobnost, kterou okem zkontroluje jen ten, kdo zrovna ví, na co se dívat.
 */

/**
 * Čas u čerstvé pošty, datum u starší.
 *
 * Rozhoduje posledních čtyřiadvacet hodin, ne kalendářní den: zpráva z včerejška
 * v jedenáct večer je pořád „ta, co přišla v noci", a datum u ní říká míň než
 * hodina. Po půlnoci by se přitom podle kalendáře už přepnula na datum.
 *
 * Zprávy s časem v budoucnosti (rozhozené hodiny odesílatele) se berou jako
 * čerstvé — ukázat u nich datum vpřed by mátlo víc.
 */
export function fmtDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 24 * 3_600_000) return d.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString('cs-CZ', sameYear ? { day: 'numeric', month: 'numeric' } : { day: 'numeric', month: 'numeric', year: '2-digit' });
}

/**
 * Komu zpráva šla — pro odeslanou poštu a koncepty.
 *
 * Adresy se ukládají jako seznam oddělený čárkou a bez jmen; u víc příjemců
 * se ukáže první a počet zbylých, aby řádek nepřetekl.
 */
export function recipients(toAddr: string): string {
  const list = (toAddr ?? '').split(',').map(a => a.trim()).filter(Boolean);
  if (list.length === 0) return '(bez příjemce)';
  return list.length === 1 ? list[0] : `${list[0]} +${list.length - 1}`;
}

