import { useEffect, useState } from 'react';
import type { ChatMessage as Msg, ChatProduct } from '@shared/types';
import { api } from '../../api';

/** Karty se drží v paměti okna — feed se mění zřídka a překreslení je časté. */
const cardCache = new Map<string, ChatProduct[]>();

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

/**
 * Jedna bublina. Odkazy na produkty se vykreslují jako karty — stejně jako
 * je uvidí zákazník ve widgetu, takže je při psaní jasné, co dorazí.
 */
export default function ChatMessage({ m, onOpenImage }: { m: Msg; onOpenImage: (src: string) => void }) {
  const [cards, setCards] = useState<ChatProduct[]>(() => cardCache.get(m.id) ?? []);
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

  if (image) {
    return (
      <div className={`ch-row ${mine ? 'mine' : ''}`}>
        <img className="ch-image" src={m.content} alt="" onClick={() => onOpenImage(m.content)} />
      </div>
    );
  }

  return (
    <div className={`ch-row ${mine ? 'mine' : ''} ${system ? 'system' : ''}`}>
      <div className="ch-bubble-wrap">
        {text && <div className={`ch-bubble ${mine ? 'mine' : ''} ${system ? 'system' : ''}`}>{text}</div>}
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
        {!system && <div className="ch-time">{messageTime(m.createdAt)}</div>}
      </div>
    </div>
  );
}
