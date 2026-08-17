import { useEffect, useState } from 'react';
import { api } from '../api';
import Icon from './Icon';

/** Denní AI přehled doručené pošty za posledních 24 hodin. */
export default function DigestModal({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.ai.digest().then(setText).catch(e => setError(e.message));
  }, []);

  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ width: 'min(640px, 94vw)' }}>
        <div className="modal-head">
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="sunrise" size={18} /> Přehled dne
          </span>
          <button className="icon-btn" data-tip="Zavřít" onClick={onClose}><Icon name="x" size={15} /></button>
        </div>
        <div className="modal-body">
          {!text && !error && (
            <div className="empty-state" style={{ padding: '40px 20px' }}>
              <span className="spinner-inline" /> AI sestavuje přehled posledních 24 hodin…
            </div>
          )}
          {error && <div className="pp-empty">Přehled se nepodařilo sestavit: {error}</div>}
          {text && <div className="digest-text">{text}</div>}
        </div>
      </div>
    </div>
  );
}
