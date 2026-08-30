import { useEffect, useState } from 'react';
import type { CleanupItem, CleanupProgress } from '@shared/types';
import { api } from '../api';
import { useToast } from '../toast';
import Icon from './Icon';

/**
 * Uvolnění místa ve schránce na serveru.
 *
 * Schránku zaplní pár set starých zpráv s přílohami. Mazat je ručně nikdo
 * nechce a nikdo si netroufne — co když to jednou bude potřeba. Tenhle úklid
 * proto nic nezahazuje: zprávu **nejdřív stáhne celou do počítače** a teprve
 * pak ji smaže ze serveru. V aplikaci zůstane dohledatelná, jen už nezabírá
 * místo v poště.
 *
 * Hledá se přímo na serveru, ne v místní databázi: synchronizuje se jen
 * posledních pár set zpráv na složku, takže staré zprávy — přesně ty, o které
 * tu jde — by v seznamu vůbec nebyly.
 */

function size(bytes: number): string {
  const cz = (n: number, digits: number) =>
    n.toLocaleString('cs-CZ', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  if (bytes >= 1024 ** 3) return `${cz(bytes / 1024 ** 3, 2)} GB`;
  if (bytes >= 1024 ** 2) return `${cz(bytes / 1024 ** 2, 0)} MB`;
  return `${cz(Math.max(1, bytes / 1024), 0)} kB`;
}

const AGES = [
  { days: 180, label: '6 měsíců' },
  { days: 365, label: '1 rok' },
  { days: 730, label: '2 roky' },
  { days: 1095, label: '3 roky' }
];

const SIZES = [
  { kb: 0, label: 'jakkoli velké' },
  { kb: 512, label: 'nad 0,5 MB' },
  { kb: 1024, label: 'nad 1 MB' },
  { kb: 5120, label: 'nad 5 MB' }
];

export default function MailboxCleanup({ accountId, quota, onClose }: {
  accountId: number;
  quota: { used: number; limit: number } | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const [days, setDays] = useState(365);
  const [minKb, setMinKb] = useState(1024);
  const [scanning, setScanning] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<CleanupProgress | null>(null);
  const [found, setFound] = useState<{
    items: CleanupItem[]; count: number; bytes: number; folders: string[];
    trash: { folder: string; count: number } | null;
  } | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  useEffect(() => api.on('cleanup:progress', (p: CleanupProgress) => setProgress(p)), []);

  const key = (item: CleanupItem) => `${item.folder}|${item.uid}`;
  const chosen = found?.items.filter(item => picked.has(key(item))) ?? [];
  const chosenBytes = chosen.reduce((sum, item) => sum + item.size, 0);

  const scan = async () => {
    setScanning(true);
    setFound(null);
    try {
      const result = await api.quota.scan(accountId, days, minKb);
      setFound(result);
      // Ve výchozím stavu je vybrané všechno, co se našlo — kdo chce něco
      // ušetřit, odškrtne; opačně by se musely odklikat stovky řádků
      setPicked(new Set(result.items.map(key)));
      if (result.count === 0) toast('Nic staršího a většího se nenašlo.');
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setScanning(false);
      setProgress(null);
    }
  };

  const run = async () => {
    if (chosen.length === 0) return;
    setRunning(true);
    try {
      const result = await api.quota.clean(accountId, chosen);
      toast(result.failed
        ? `Uvolněno ${size(result.freed)}, ${result.failed} zpráv se nepodařilo — ty na serveru zůstaly.`
        : `Uvolněno ${size(result.freed)} · ${result.done} zpráv je stažených v počítači.`,
        result.failed ? 'error' : 'info');
      if (result.errors.length) console.warn('Úklid schránky:', result.errors);
      setFound(null);
      setPicked(new Set());
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setRunning(false);
      setProgress(null);
    }
  };

  const emptyTrash = async () => {
    if (!found?.trash) return;
    try {
      const n = await api.trash.empty(accountId);
      toast(`Koš je prázdný (${n} zpráv).`);
      setFound({ ...found, trash: null });
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const pct = quota ? Math.min(100, Math.round((quota.used / quota.limit) * 100)) : 0;
  const busy = scanning || running;

  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal cleanup-modal">
        <div className="modal-head">
          <div className="modal-title"><Icon name="archive" size={15} /> Uvolnit místo na serveru</div>
          <span style={{ flex: 1 }} />
          <button className="icon-btn" onClick={onClose} disabled={busy}><Icon name="x" size={16} /></button>
        </div>

        <div className="modal-body">
          {quota && (
            <div className="cl-quota">
              <div className="quota-bar">
                <div className={pct > 90 ? 'crit' : pct > 70 ? 'warn' : ''} style={{ width: `${pct}%` }} />
              </div>
              <div className="ig-muted">
                Obsazeno {pct} % — {size(quota.used)} z {size(quota.limit)}
              </div>
            </div>
          )}

          <p className="cl-lead">
            Staré zprávy se <b>stáhnou do počítače</b> a teprve pak smažou ze serveru.
            V aplikaci zůstanou dohledatelné i čitelné, jen přestanou zabírat místo
            v poště. Zprávy s hvězdičkou se nikdy nemažou.
          </p>

          <div className="cl-filters">
            <label>
              <span>Starší než</span>
              <select value={days} onChange={e => setDays(Number(e.target.value))} disabled={busy}>
                {AGES.map(a => <option key={a.days} value={a.days}>{a.label}</option>)}
              </select>
            </label>
            <label>
              <span>Velikost</span>
              <select value={minKb} onChange={e => setMinKb(Number(e.target.value))} disabled={busy}>
                {SIZES.map(s => <option key={s.kb} value={s.kb}>{s.label}</option>)}
              </select>
            </label>
            <button className="btn" onClick={scan} disabled={busy}>
              {scanning ? 'Hledám…' : 'Najít'}
            </button>
          </div>

          {busy && progress && (
            <div className="cl-progress">
              {progress.phase === 'scan' && <>Prohlížím složku <b>{progress.folder}</b>…</>}
              {progress.phase === 'save' && (
                <>Stahuji {progress.done}/{progress.total} — {progress.subject}</>
              )}
              {progress.phase === 'delete' && <>Mažu ze serveru ve složce <b>{progress.folder}</b>…</>}
            </div>
          )}

          {found && found.count > 0 && (
            <>
              <div className="cl-summary">
                <b>{found.count} zpráv · {size(found.bytes)}</b>
                <span className="ig-muted">
                  {found.items.length < found.count
                    ? `v seznamu je ${found.items.length} největších`
                    : `ve složkách: ${found.folders.join(', ')}`}
                </span>
              </div>

              <div className="cl-list">
                {found.items.map(item => {
                  const id = key(item);
                  return (
                    <label key={id} className="cl-row">
                      <input
                        type="checkbox"
                        checked={picked.has(id)}
                        disabled={busy}
                        onChange={() => setPicked(prev => {
                          const next = new Set(prev);
                          if (next.has(id)) next.delete(id); else next.add(id);
                          return next;
                        })}
                      />
                      <span className="cl-row-main">
                        <span className="cl-subject">
                          {item.attachments && <Icon name="paperclip" size={12} />} {item.subject}
                        </span>
                        <span className="ig-muted cl-meta">
                          {item.from} · {item.date ? new Date(item.date).toLocaleDateString('cs-CZ') : ''} · {item.folder}
                        </span>
                      </span>
                      <span className="cl-size">{size(item.size)}</span>
                    </label>
                  );
                })}
              </div>
            </>
          )}

          {found?.trash && (
            <div className="cl-trash">
              V koši je {found.trash.count} zpráv a místo zabírají taky.
              <button className="btn ghost" onClick={emptyTrash} disabled={busy}>Vysypat koš</button>
            </div>
          )}
        </div>

        <div className="modal-foot">
          <span className="ig-muted">
            {chosen.length > 0
              ? `Vybráno ${chosen.length} · uvolní se ${size(chosenBytes)}`
              : 'Nic není vybráno'}
          </span>
          <span style={{ flex: 1 }} />
          <button className="btn ghost" onClick={onClose} disabled={busy}>Zavřít</button>
          <button className="btn primary" onClick={run} disabled={busy || chosen.length === 0}>
            <Icon name="download" size={13} />
            {running ? 'Uklízím…' : `Stáhnout a uvolnit${chosen.length ? ` (${chosen.length})` : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}
