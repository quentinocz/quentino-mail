import { useEffect, useState } from 'react';
import type { ChatMessage as Msg, ChatProduct } from '@shared/types';
import { api } from '../../api';
import Icon from '../Icon';

/** Karty se drží v paměti okna — feed se mění zřídka a překreslení je časté. */
const cardCache = new Map<string, ChatProduct[]>();
/** Hotové překlady taky — přepnutí vlákna sem a zpátky nemá stát další volání. */
const czCache = new Map<string, string>();

const PRODUCT_URL_RE =
  /https?:\/\/(?:www\.)?(?:quentino\.cz|quentino\.sk|wearquentino\.com)\/[^\s<>"']*/gi;

function stripUrls(text: string): string {
  return text.replace(PRODUCT_URL_RE, '').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function isImage(m: Msg): boolean {
  return m.contentType === 'image' || /\.(jpg|jpeg|png|webp|heif|heic|gif)(\?|$)/i.test(m.content);
}

export function messageTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
}

/*
 * Slova, po kterých se pozná domácí zákazník.
 *
 * Nabídka překladu se má ukázat jen tam, kde k něčemu je. Zákazníci píšou
 * často bez diakritiky („dobry den, objednala jsem…"), takže hlídat háčky
 * nestačí — rozhoduje slovník. Krátká a mezinárodně sdílená slova („a",
 * „den", „to") se schválně počítají až od druhé shody: samotné „den" je
 * i německy.
 */
const HOME_WORDS = new Set([
  'jsem', 'jste', 'jsme', 'bych', 'byste', 'prosim', 'prosime', 'dekuji', 'dekujeme',
  'dakujem', 'dakujeme', 'dobry', 'den', 'zdravim', 'ahoj', 'mate', 'mam', 'muzete',
  'mozete', 'chtela', 'chtel', 'chcela', 'chcel', 'jestli', 'ci', 'uz', 'ale', 'nebo',
  'alebo', 'take', 'tiez', 'jeste', 'este', 'velmi', 'vam', 'vas', 'nam', 'ktery',
  'ktera', 'ktere', 'ktory', 'ktora', 'objednavka', 'objednavku', 'objednavky',
  'objednavke', 'zbozi', 'tovar', 'kdy', 'kde', 'proc', 'preco', 'tak', 'jak',
  'posta', 'postu', 'balik', 'balicek', 'vraceni', 'reklamace', 'velikost', 'velkost'
]);

function bare(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/** Vypadá zpráva na češtinu nebo slovenštinu? Pak nabízet překlad nemá smysl. */
export function looksHome(text: string): boolean {
  const words = bare(text).split(/[^a-z]+/).filter(Boolean);
  let hits = 0;
  for (const word of words) if (HOME_WORDS.has(word)) hits++;
  return hits >= 2;
}

interface Props {
  m: Msg;
  onOpenImage: (src: string) => void;
  /** Poslední zpráva ve shluku od stejného odesílatele — jen u ní se píše čas */
  tail?: boolean;
  /** Přeložit hned po zobrazení (hromadné „přeložit příchozí") */
  autoTranslate?: boolean;
}

/**
 * Jedna bublina. Odkazy na produkty se vykreslují jako karty — stejně jako
 * je uvidí zákazník ve widgetu, takže je při psaní jasné, co dorazí.
 *
 * U zpráv od zákazníka, které nevypadají česky, je pod bublinou nabídka
 * překladu. Nepřekládá se předem: většina konverzací je česká a volání
 * modelu u každé zprávy by se platilo zbytečně.
 */
export default function ChatMessage({ m, onOpenImage, tail = true, autoTranslate = false }: Props) {
  const [cards, setCards] = useState<ChatProduct[]>(() => cardCache.get(m.id) ?? []);
  const [cz, setCz] = useState<string>(() => czCache.get(m.id) ?? '');
  const [busy, setBusy] = useState(false);
  const [original, setOriginal] = useState(false);
  const image = isImage(m);
  // Pozor: regulární výraz s příznakem `g` si u `.test()` pamatuje pozici
  // a střídavě by vracel false — proto se hledá přes `.match()`.
  const hasUrls = !image && (m.content.match(PRODUCT_URL_RE) ?? []).length > 0;
  const text = hasUrls ? stripUrls(m.content) : m.content;

  useEffect(() => {
    if (image || !hasUrls || cardCache.has(m.id)) return;
    let alive = true;
    api.chat.cards(m.content).then(list => {
      cardCache.set(m.id, list);
      if (alive) setCards(list);
    }).catch(() => {});
    return () => { alive = false; };
  }, [m.id, m.content, image, hasUrls]);

  const mine = m.sender === 'operator';
  const system = m.sender === 'system';
  const canTranslate = !mine && !system && !image && text.trim().length >= 12;
  const offer = canTranslate && !looksHome(text);

  const translate = async () => {
    if (busy || cz) return;
    setBusy(true);
    try {
      const out = await api.ai.translateText(text, 'cs');
      const value = out.trim();
      if (value) { czCache.set(m.id, value); setCz(value); }
    } catch {
      /* Překlad je pohodlí, ne podmínka — chyba se nemá vnutit doprostřed chatu */
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (autoTranslate && canTranslate && !cz && !busy) translate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoTranslate, canTranslate, cz]);

  if (image) {
    return (
      <div className={`ch-row ${mine ? 'mine' : ''} ${tail ? '' : 'grouped'}`}>
        <img className="ch-image" src={m.content} alt="" onClick={() => onOpenImage(m.content)} />
      </div>
    );
  }

  const shown = cz && !original ? cz : text;

  return (
    <div className={`ch-row ${mine ? 'mine' : ''} ${system ? 'system' : ''} ${tail ? '' : 'grouped'}`}>
      <div className="ch-bubble-wrap">
        {text && (
          <div className={`ch-bubble ${mine ? 'mine' : ''} ${system ? 'system' : ''}`}>
            {shown}
            {cz && !original && <span className="ch-cz-mark">přeloženo</span>}
          </div>
        )}
        {cards.map((p, i) => (
          <button key={i} className="ch-card" onClick={() => api.shell.openUrl(p.url)}>
            {p.imgUrl
              ? <img src={p.imgUrl} alt="" />
              : <span className="ch-card-ph">🛍️</span>}
            <span className="ch-card-body">
              <span className="ch-card-name">{p.name}</span>
              <span className="ch-card-price">{p.price}</span>
              <span className="ch-card-domain">{p.domain}</span>
            </span>
          </button>
        ))}
        {(offer || cz) && (
          <div className="ch-translate">
            {cz ? (
              <button onClick={() => setOriginal(v => !v)}>
                {original ? 'Zobrazit překlad' : 'Zobrazit originál'}
              </button>
            ) : (
              <button onClick={translate} disabled={busy}>
                <Icon name="globe" size={12} /> {busy ? 'Překládám…' : 'Přeložit do češtiny'}
              </button>
            )}
          </div>
        )}
        {!system && tail && <div className="ch-time">{messageTime(m.createdAt)}</div>}
      </div>
    </div>
  );
}
