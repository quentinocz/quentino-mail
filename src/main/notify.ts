/**
 * Upozornění na telefon přes ntfy.
 *
 * Proč zrovna takhle: opravdový push do vlastní aplikace (APNs) se bez
 * placeného účtu u Applu zapnout nedá — oprávnění „Push Notifications" volný
 * profil neunese a aplikace se navíc podepisuje přes SideStore. Notifikace
 * proto doručuje ntfy: na telefonu je jeho aplikace ze App Storu, ta má push
 * od Applu vyřízený za nás a poslat do ní zprávu znamená jediný POST na
 * adresu s tajným názvem tématu. Nic se neplatí a nikde se nezakládá účet.
 *
 * Název tématu je zároveň heslo. Kdo ho zná, čte i posílá — proto se
 * generuje dost dlouhý a v nastavení se s ním zachází jako s tajemstvím.
 *
 * Do zprávy jde **odesílatel a předmět, ne text**. Přes cizí server tečou
 * e-maily zákazníků, takže se ven pouští jen tolik, aby šlo poznat, jestli
 * to spěchá.
 */
import { getSettings } from './settings';
import type { NotifyKind } from '../shared/types';

/** Veřejný server ntfy. Kdo si ho hostuje sám, přepíše adresu v nastavení. */
export const DEFAULT_NTFY_SERVER = 'https://ntfy.sh';

/**
 * Tvar zprávy tak, jak ji ntfy čeká.
 *
 * Posílá se JSONem na kořen serveru, ne hlavičkami na `/téma`: hlavičky musí
 * být ASCII, takže „Nová objednávka" by se cestou rozsypalo.
 */
interface NtfyMessage {
  topic: string;
  title: string;
  message: string;
  /** Emotikony před titulkem — v seznamu notifikací se pozná typ na první pohled */
  tags?: string[];
  /** 1 = nejtišší, 5 = protlačí se i přes soustředění */
  priority?: number;
  /** Co otevřít po klepnutí */
  click?: string;
}

/** Náhodný název tématu. Je to zároveň heslo, tak ať se nedá uhodnout. */
export function makeTopic(): string {
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = 'quentino-';
  for (let i = 0; i < 24; i++) out += abc[Math.floor(Math.random() * abc.length)];
  return out;
}

/** Adresa tématu — do ní se posílá a v aplikaci ntfy se na ni člověk přihlásí. */
export function topicUrl(server: string, topic: string): string {
  const base = (server || DEFAULT_NTFY_SERVER).trim().replace(/\/+$/, '');
  return `${base}/${topic}`;
}

/** Má se tenhle druh události posílat na telefon? */
export function wantsNotify(kind: NotifyKind): boolean {
  const s = getSettings();
  if (!s.notifyPhone || !s.notifyTopic) return false;
  return kind === 'mail' ? s.notifyPhoneMail : s.notifyPhoneChat;
}

/**
 * Pošle upozornění na telefon.
 *
 * Nikdy nevyhodí výjimku a nikdy nečeká dlouho: tohle visí na příchodu nové
 * pošty a výpadek ntfy nesmí zdržet ani shodit synchronizaci. Když se
 * nepovede, vrátí se důvod — hodí se do zkoušky v nastavení.
 */
export async function notifyPhone(
  kind: NotifyKind,
  title: string,
  message: string,
  extra: { click?: string; priority?: number } = {}
): Promise<{ ok: boolean; error?: string }> {
  const s = getSettings();
  if (!s.notifyTopic) return { ok: false, error: 'Není nastavené téma' };
  return send(s.notifyServer || DEFAULT_NTFY_SERVER, {
    topic: s.notifyTopic,
    title,
    message,
    tags: [kind === 'mail' ? 'envelope' : 'speech_balloon'],
    priority: extra.priority ?? 3,
    click: extra.click
  });
}

/** Zkušební notifikace z nastavení — posílá se i s vypnutými přepínači. */
export async function notifyTest(server: string, topic: string): Promise<{ ok: boolean; error?: string }> {
  if (!topic.trim()) return { ok: false, error: 'Vyplň název tématu' };
  return send(server, {
    topic: topic.trim(),
    title: 'Quentino',
    message: 'Zkušební upozornění. Když tohle vidíš na telefonu, je hotovo.',
    tags: ['white_check_mark'],
    priority: 3
  });
}

async function send(server: string, body: NtfyMessage): Promise<{ ok: boolean; error?: string }> {
  const base = (server || DEFAULT_NTFY_SERVER).trim().replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `ntfy: ${res.status} ${text.slice(0, 160)}`.trim() };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.name === 'AbortError' ? 'ntfy neodpovídá' : String(e?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- Text notifikace ---------- */

interface MailLine {
  fromName?: string | null;
  fromAddr?: string | null;
  subject?: string | null;
}

/**
 * Titulek a text pro novou poštu.
 *
 * Vytažené zvlášť, aby se dalo zkoušet bez sítě — a hlavně aby bylo na jednom
 * místě vidět, co všechno se pouští ven. Text zprávy se sem záměrně nedostane.
 */
export function mailNotification(rows: MailLine[]): { title: string; message: string } {
  const name = (r: MailLine) => (r.fromName || r.fromAddr || 'Neznámý odesílatel').trim();
  const subject = (r: MailLine) => (r.subject || '(bez předmětu)').trim();

  if (rows.length === 1) {
    return { title: name(rows[0]), message: subject(rows[0]) };
  }
  return {
    title: `${rows.length} ${rows.length < 5 ? 'nové zprávy' : 'nových zpráv'}`,
    message: rows.map(r => `${name(r)}: ${subject(r)}`).join('\n').slice(0, 400)
  };
}

/**
 * SQL, kterým se v Supabase založí odesílání notifikací z chatu.
 *
 * Chat nemá kdo hlídat: počítač bývá vypnutý a telefon se na pozadí probouzí,
 * kdy se systému zachce. Supabase ale umí zavolat adresu sám, jakmile přibude
 * řádek — tím je notifikace okamžitá a nezávislá na tom, jestli něco běží.
 *
 * Vrací se jako text k vložení do SQL editoru: zakládat cizí databázi za zády
 * uživatele by bylo přes čáru, a navíc to je jednorázová věc.
 */
export function chatWebhookSql(server: string, topic: string): string {
  // Posílá se na kořen serveru, ne na adresu tématu: JSON se jménem tématu
  // uvnitř bere ntfy jen tam. Na `/téma` by celé tělo považoval za text zprávy.
  const url = (server || DEFAULT_NTFY_SERVER).trim().replace(/\/+$/, '');
  return `-- Upozornění na nové zprávy v chatu, rovnou ze Supabase.
--
-- Vlož celé do SQL editoru projektu (Database → SQL Editor) a spusť.
-- Stačí jednou; opakované spuštění nic nerozbije.
--
-- BEZPEČNOST: nesahá se na žádnou tabulku, řádek ani sloupec — nic se nemaže
-- ani nepřepisuje. Editor přesto ohlásí „destruktivní operaci", protože v kódu
-- je slovo DROP; týká se jediného řádku níž a ten jen uklízí po předchozím
-- spuštění téhož skriptu. Co se opravdu stane: nainstaluje se rozšíření pro
-- HTTP dotazy, založí se jedna nová funkce a jeden nový trigger.
--
-- Dotaz na ntfy je asynchronní (pg_net ho jen zařadí do fronty a vrátí se),
-- takže vložení zprávy do chatu na nic nečeká a neselže ani tehdy, když je
-- ntfy nedostupné.
--
-- Vzít zpět jde dvěma řádky:
--   drop trigger if exists chat_message_notify on public.messages;
--   drop function if exists public.notify_new_chat_message();

-- Umí poslat HTTP dotaz z databáze. Zakládá si vlastní schéma \`net\`,
-- proto se neurčuje, kam se má nainstalovat.
create extension if not exists pg_net;

create or replace function public.notify_new_chat_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  who text;
begin
  -- Upozorňuje se jen na to, co napsal zákazník. Vlastní odpovědi by
  -- znamenaly notifikaci na každou větu, kterou člověk sám odešle.
  if new.sender is distinct from 'customer' then
    return new;
  end if;

  select coalesce(nullif(c.customer_name, ''), c.customer_email, 'Zákazník')
    into who
    from public.conversations c
   where c.id = new.conversation_id;

  perform net.http_post(
    url := '${url}',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := jsonb_build_object(
      'topic', '${topic}',
      'title', coalesce(who, 'Zákazník'),
      'message', left(coalesce(new.content, 'Nová zpráva v chatu'), 200),
      'tags', jsonb_build_array('speech_balloon'),
      'priority', 4
    )
  );
  return new;
end;
$$;

-- Jediný DROP v celém skriptu. Maže výhradně trigger tohohle jména, aby šlo
-- skript spustit znovu; při prvním spuštění nemá co dělat.
drop trigger if exists chat_message_notify on public.messages;

create trigger chat_message_notify
  after insert on public.messages
  for each row execute function public.notify_new_chat_message();
`;
}
