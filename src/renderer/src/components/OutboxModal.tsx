import { useCallback, useEffect, useState } from 'react';
import type { OutboxItem } from '@shared/types';
import { api } from '../api';
import { useToast } from '../toast';
import Icon from './Icon';

const STATUS_LABELS: Record<string, string> = {
  scheduled: 'Naplánováno',
  sending: 'Odesílá se',
  sent: 'Odesláno',
  failed: 'Selhalo'
};

export default function OutboxModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [items, setItems] = useState<OutboxItem[]>([]);

  const load = useCallback(() => { api.outbox.list().then(setItems).catch(() => {}); }, []);

  useEffect(() => {
    load();
    const un = api.on('outbox:changed', load);
    return un;
  }, [load]);

  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <div className="modal-head">
          <span>K odeslání</span>
          <button className="icon-btn" data-tip="Zavřít" onClick={onClose}><Icon name="x" size={15} /></button>
        </div>
        <div className="modal-body">
          {items.length === 0 && <div className="empty-state"><div className="big"><Icon name="clock" size={32} /></div>Žádné naplánované zprávy</div>}
          {items.map(it => (
            <div key={it.id} className="outbox-item">
              <span className={`status-pill status-${it.status}`}>{STATUS_LABELS[it.status] ?? it.status}</span>
              <div className="grow" style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {it.subject || '(bez předmětu)'}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
                  → {it.toAddr} · {new Date(it.sendAt).toLocaleString('cs-CZ')}
                  {it.error ? ` · chyba: ${it.error}` : ''}
                </div>
              </div>
              {(it.status === 'scheduled' || it.status === 'failed') && (
                <button className="btn danger" onClick={() => api.outbox.cancel(it.id).then(load)}>Zrušit</button>
              )}
            </div>
          ))}
          {items.some(i => i.status === 'scheduled') && (
            <button className="btn ghost" style={{ alignSelf: 'flex-start' }}
              onClick={() => api.outbox.processNow().then(() => { load(); toast('Kontrola fronty spuštěna.'); })}>
              Odeslat splatné hned
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
