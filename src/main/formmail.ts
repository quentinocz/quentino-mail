/**
 * Zprávy z formulářů na webu.
 *
 * E-shop posílá „Rychlý kontakt", „Dotaz na produkt" a podobné zprávy sám za
 * sebe — v hlavičce `From` je `system@upgates.com` a odpověď na ni skončí
 * u poskytovatele e-shopu, ne u zákazníka. Zákazníkova adresa přitom ve
 * zprávě je, jen o řádek níž v textu:
 *
 *     Eshop: www.quentino.cz
 *     Email: tuckovaterez@gmail.com
 *     Čas: 22.08.2026 10:36:28
 *
 * Tenhle modul takový mail pozná a vytáhne z něj, komu vlastně odpovědět.
 * Zároveň hledá telefon — formuláře o něj rovnou žádají („Pro rychlejší
 * komunikaci můžete napsat i své telefonní číslo: 733573771") a je to
 * nejrychlejší cesta, jak takový dotaz vyřídit.
 *
 * Nic se nehádá: když se v textu popiska s adresou nenajde, modul mlčí a
 * aplikace se chová jako dosud.
 */

export interface FormContact {
  /** Adresa zákazníka vytažená z těla zprávy */
  email: string;
  /** Telefon v mezinárodním tvaru, pokud ho zákazník uvedl */
  phone: string;
  /** Jméno, když ho formulář posílá */
  name: string;
  /** Který formulář to byl — do popisku v rozhraní */
  form: string;
  /** Stránka, ze které se psalo (u dotazu na produkt je to ten produkt) */
  page: string;
}

/**
 * Odesílatelé, kteří píšou za někoho jiného.
 *
 * Rozhoduje doména, ne celá adresa — Upgates střídá `system@`, `noreply@`
 * i adresu s číslem instance a vyjmenovat je všechny by znamenalo, že první
 * nová varianta zase spadne pod stůl.
 */
const RELAY_DOMAINS = ['upgates.com', 'upgates.cz', 'shoptet.cz', 'shopify.com'];

/** Odesílatel, na kterého odpovídat nemá smysl. */
const NOREPLY = /^(no-?reply|nereply|nedopovidejte|donotreply|system|mailer|robot|info@upgates)/i;

export function isRelaySender(fromAddr: string): boolean {
  const address = (fromAddr ?? '').toLowerCase();
  const domain = address.split('@')[1] ?? '';
  if (RELAY_DOMAINS.some(known => domain === known || domain.endsWith(`.${known}`))) return true;
  return NOREPLY.test(address.split('@')[0] ?? '');
}

/*
 * Popisky polí ve třech jazycích e-shopu.
 *
 * Hledá se popiska, ne první adresa v textu. Ve zprávě bývá i adresa
 * e-shopu, odkaz na produkt a patička — vzít „první e-mail, na který
 * narazím" by odpověď poslalo někam úplně jinam.
 */
const EMAIL_LABELS = ['e-?mail', 'email', 'e-?mailová adresa', 'kontaktní e-?mail', 'from', 'odesílatel'];
const PHONE_LABELS = ['telefon', 'telefonní číslo', 'tel', 'mobil', 'phone', 'číslo'];
const NAME_LABELS = ['jméno', 'meno', 'jméno a příjmení', 'name', 'celé jméno'];
const FORM_LABELS = ['formulář', 'formular', 'form'];
const PAGE_LABELS = ['stránka', 'stranka', 'page', 'url'];

/** Hodnota za popiskou. Popiska může být i tučně v HTML, proto se čte z textu. */
function labelled(text: string, labels: string[]): string {
  for (const label of labels) {
    const found = text.match(new RegExp(`^[\\s>*_-]*${label}\\s*[:：]\\s*(.+)$`, 'im'));
    if (found?.[1]) {
      const value = found[1].trim();
      if (value) return value;
    }
  }
  return '';
}

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.]{2,}/;

/**
 * HTML na text, jen pro čtení popisek.
 *
 * Schválně vlastní, ne ta ze `customer.ts`: ta umí navíc odřezávat citace a
 * tenhle modul z ní potřebuje jen zlomek. Import by navíc vyrobil kruh —
 * `customer.ts` si sáhne sem pro rozpoznání přeposílajícího odesílatele.
 *
 * Bloky se lámou na řádky, protože popiska a hodnota jsou v HTML mailu
 * často každá ve své buňce tabulky a bez zlomu by se slily do jedné věty.
 */
function stripHtml(html: string): string {
  return (html ?? '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|td|th|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Telefon v textu.
 *
 * Bere se devět a víc číslic, případně s předvolbou a s mezerami nebo
 * pomlčkami mezi trojicemi. Datum ani částka takhle nevypadají, takže se
 * plete málokdy — a co proklouzne, uživatel na tlačítku vidí dřív, než
 * zavolá.
 */
const PHONE_RE = /(?:\+|00)?\s?(?:\d{3}\s?)?\d{3}[\s.-]?\d{3}[\s.-]?\d{3}/;

export function normalizeFormPhone(raw: string): string {
  const clean = (raw ?? '').replace(/[^\d+]/g, '');
  if (clean.length < 9) return '';
  if (clean.startsWith('+')) return clean;
  if (clean.startsWith('00')) return `+${clean.slice(2)}`;
  if (clean.length === 9) return `+420${clean}`;
  // Dvanáct číslic začínajících předvolbou bez plus („420733573771")
  if (clean.length === 12 && /^4(20|21)/.test(clean)) return `+${clean}`;
  return clean;
}

/**
 * Kdo vlastně píše.
 *
 * Vrací `null`, když zpráva na formulář nevypadá — volající se pak chová
 * jako dřív. Přísně: adresa se musí najít u popisky, samotný výskyt
 * e-mailu v textu nestačí.
 */
export function formContact(message: {
  fromAddr?: string | null;
  replyTo?: string | null;
  subject?: string | null;
  bodyText?: string | null;
  bodyHtml?: string | null;
}): FormContact | null {
  // Když odesílatel poslal Reply-To, je rozhodnuto a nemá cenu hádat z textu
  if ((message.replyTo ?? '').trim()) return null;
  if (!isRelaySender(message.fromAddr ?? '')) return null;

  const text = (message.bodyText ?? '').trim() || stripHtml(message.bodyHtml ?? '');
  if (!text) return null;

  const emailValue = labelled(text, EMAIL_LABELS);
  const email = (emailValue.match(EMAIL_RE)?.[0] ?? '').toLowerCase();
  if (!email) return null;
  // Adresa e-shopu není zákazník
  if (isRelaySender(email)) return null;

  const phoneValue = labelled(text, PHONE_LABELS);
  // Formulář se na číslo ptá větou, ne popiskou („…můžete napsat i své
  // telefonní číslo: 733573771"), takže když popiska nesedí, zkusí se
  // najít číslo za slovem „telefon" kdekoli ve větě
  const loose = text.match(/telefon(?:ní)?\s*(?:číslo|cislo)?\s*[:：]?\s*([\d\s+().-]{9,20})/i);
  const phone = normalizeFormPhone(phoneValue || loose?.[1] || '');

  return {
    email,
    phone,
    name: labelled(text, NAME_LABELS),
    form: labelled(text, FORM_LABELS) || (message.subject ?? '').trim(),
    page: labelled(text, PAGE_LABELS)
  };
}

/**
 * Komu odpovědět.
 *
 * Pořadí je dané tím, jak spolehlivý který zdroj je: `Reply-To` si přeje
 * sám odesílatel, adresa z formuláře je vytažená z těla zprávy, a teprve
 * když není ani jedno, zbývá `From`.
 */
export function replyAddress(message: {
  fromAddr?: string | null;
  fromName?: string | null;
  replyTo?: string | null;
  subject?: string | null;
  bodyText?: string | null;
  bodyHtml?: string | null;
}): { address: string; name: string; source: 'reply-to' | 'formulář' | 'odesílatel' } {
  const replyTo = (message.replyTo ?? '').split(',')[0]?.trim();
  if (replyTo) return { address: replyTo, name: '', source: 'reply-to' };

  const form = formContact(message);
  if (form) return { address: form.email, name: form.name, source: 'formulář' };

  return {
    address: message.fromAddr ?? '',
    name: message.fromName ?? '',
    source: 'odesílatel'
  };
}
