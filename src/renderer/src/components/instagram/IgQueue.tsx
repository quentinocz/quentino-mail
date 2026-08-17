import { useCallback, useEffect, useState } from 'react';
import type { IgJob, IgOverview } from '@shared/types';
import { api } from '../../api';
import { useToast } from '../../toast';
import Icon from '../Icon';
import { fmtDate } from './IgShared';

const STATE_LABEL: Record<string, string> = {
  scheduled: 'čeká',
  publishing: 'odesílá se',
  done: 'publikováno',
  failed: 'chyba'
};

/** Fronta publikací: co čeká, co se právě odesílá a co spadlo — a proč. */
export default function IgQueue({ overview, onOpenPost }: { overview: IgOverview; onOpenPost: (id: number) => void }) {
  const toast = useToast();
  const [jobs, setJobs] = useState<IgJob[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setJobs(await api.ig.jobs());
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => api.on('ig:changed', () => load()), [load]);
  // Během odesílání se stav mění i bez událostí (čekání na zpracování médií)
  useEffect(() => {
    if (!jobs.some(j => j.state === 'publishing')) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [jobs, load]);

  const act = async (fn: () => Promise<void>, msg: string) => {
    try { await fn(); toast(msg); load(); } catch (e: any) { toast(e.message, 'error'); }
  };

  const waiting = jobs.filter(j => j.state === 'scheduled' || j.state === 'publishing');
  const finished = jobs.filter(j => j.state === 'done' || j.state === 'failed');

  return (
    <div className="ig-page">
      <div className="ig-head">
        <h2>Fronta a plán</h2>
        <div className="ig-head-tools">
          <button className="btn ghost" onClick={() => act(() => api.ig.runQueue(), 'Frontu jsem projel.')}>
            <Icon name="refresh" size={13} /> Odbavit hned
          </button>
        </div>
      </div>

      {loading ? <div className="ig-muted ig-pad">Načítám…</div> : (
        <>
          <div className="ig-section-title">Čeká ({waiting.length})</div>
          {waiting.length === 0 ? (
            <p className="ig-muted ig-pad">Nic nečeká. Publikace se objeví tady hned po odeslání z příspěvku.</p>
          ) : waiting.map(j => (
            <Row key={j.id} job={j} onOpenPost={onOpenPost}>
              <button className="btn ghost" onClick={() => act(async () => api.ig.cancelJob(j.id), 'Zrušeno.')}
                disabled={j.state === 'publishing'}>Zrušit</button>
            </Row>
          ))}

          <div className="ig-section-title">Hotové a chyby</div>
          {finished.length === 0 ? (
            <p className="ig-muted ig-pad">Zatím nic.</p>
          ) : finished.map(j => (
            <Row key={j.id} job={j} onOpenPost={onOpenPost}>
              {j.state === 'failed' && (
                <button className="btn ghost" onClick={() => act(async () => api.ig.retryJob(j.id), 'Zkusím to znovu.')}>
                  Zkusit znovu
                </button>
              )}
              {j.permalink && (
                <button className="btn ghost" onClick={() => api.shell.openUrl(j.permalink!)}>
                  <Icon name="globe" size={13} /> Na Instagramu
                </button>
              )}
            </Row>
          ))}
        </>
      )}

      {overview.accounts.length === 0 && (
        <p className="ig-muted ig-pad">Bez připojených účtů se nedá publikovat.</p>
      )}
    </div>
  );
}

function Row({ job, onOpenPost, children }: { job: IgJob; onOpenPost: (id: number) => void; children?: React.ReactNode }) {
  return (
    <div className={`ig-job ig-job-${job.state}`}>
      <span className="ig-lang ig-lang-done" style={{ background: job.color, borderColor: job.color }}>{job.lang}</span>
      <div className="ig-job-body">
        <button className="ig-job-preview" onClick={() => onOpenPost(job.postId)}>
          {job.preview || <span className="ig-muted">bez textu</span>}
        </button>
        <div className="ig-muted">
          @{job.username} · {STATE_LABEL[job.state] ?? job.state}
          {job.state === 'scheduled' && ` · ${fmtDate(job.scheduledAt)}`}
          {job.finishedAt && ` · ${fmtDate(job.finishedAt)}`}
        </div>
        {job.error && <div className="ig-job-error">{job.error}</div>}
      </div>
      <div className="ig-job-actions">
        {job.state === 'publishing' && <span className="spinner-inline" />}
        {children}
      </div>
    </div>
  );
}
