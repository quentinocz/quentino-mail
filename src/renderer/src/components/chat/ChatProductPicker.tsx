import { useEffect, useState } from 'react';
import type { ChatProduct } from '@shared/types';
import { api } from '../../api';
import { useToast } from '../../toast';
import Icon from '../Icon';

const DOMAINS: { id: 'cz' | 'sk' | 'en'; label: string }[] = [
  { id: 'cz', label: 'CZ' },
  { id: 'sk', label: 'SK' },
  { id: 'en', label: 'EN' }
];

/**
 * Hledání produktu a vložení odkazu do odpovědi. Jazyk e-shopu se předvyplní
 * podle jazyka konverzace — Slovákovi nemá smysl posílat český odkaz.
 */
export default function ChatProductPicker({ locale, onInsert, onClose }: {
  locale: 'cz' | 'sk' | 'en';
  onInsert: (url: string) => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [domain, setDomain] = useState<'cz' | 'sk' | 'en'>(locale);
  const [results, setResults] = useState<ChatProduct[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (q.trim().length < 2) { setResults([]); return; }
    setLoading(true);
    const timer = setTimeout(() => {
      api.chat.searchProducts(q)
        .then(setResults)
        .catch(e => toast(e.message, 'error'))
        .finally(() => setLoading(false));
    }, 320);
    return () => clearTimeout(timer);
  }, [q, toast]);

  // Zavření klávesou — na počítači zvyk, na telefonu to dělá tlačítko systému
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const insert = async (p: ChatProduct) => {
    if (domain === 'cz') { onInsert(p.url); onClose(); return; }
    try {
      const other = await api.chat.productInDomain(p.id, domain);
      if (other?.url) onInsert(other.url);
      else {
        toast(`Produkt není v ${domain.toUpperCase()} feedu — vkládám českou adresu.`, 'error');
        onInsert(p.url);
      }
    } catch {
      onInsert(p.url);
    }
    onClose();
  };

  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ width: 'min(560px, 94vw)', maxHeight: '80vh' }}>
        <div className="modal-head">
          <span>Vložit produkt</span>
          <button className="icon-btn" onClick={onClose}><Icon name="x" size={15} /></button>
        </div>
        <div className="modal-body">
          <input
            autoFocus
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Název nebo kód produktu"
          />
          <div className="ig-seg">
            {DOMAINS.map(d => (
              <button key={d.id} className={domain === d.id ? 'active' : ''} onClick={() => setDomain(d.id)}>
                {d.label}
              </button>
            ))}
          </div>

          {loading && <div className="ig-muted">Hledám…</div>}
          {!loading && q.trim().length >= 2 && results.length === 0 && (
            <div className="ig-muted">Nic nenalezeno.</div>
          )}
          {results.map((p, i) => (
            <button key={i} className="ch-hit" onClick={() => insert(p)}>
              {p.imgUrl ? <img src={p.imgUrl} alt="" /> : <span className="ch-card-ph">🛍️</span>}
              <span className="ch-hit-body">
                <span className="ch-card-name">{p.name}</span>
                <span className="ch-card-price">{p.price}</span>
              </span>
              <span className="btn ghost">Vložit</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
