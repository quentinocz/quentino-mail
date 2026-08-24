import { useCallback, useEffect, useState } from 'react';
import type { SupabaseStatus } from '@shared/types';
import { api } from '../api';
import { useToast } from '../toast';
import Icon from './Icon';

/**
 * Jak dlouho je ticho od projektů Supabase.
 *
 * Bezplatný tarif projekt po několika dnech bez jediného dotazu uspí. Probrat
 * ho jde jen ručně v administraci a do té doby nefunguje to, co na něm visí —
 * u chatu zákazník píše do prázdna, u Instagramu spadne publikace, protože
 * není kam nahrát fotku.
 *
 * Aplikace projekt oťukává sama, ale jen když běží. Právě proto tenhle
 * přehled existuje: po týdnu, kdy se aplikace nespustí, se projekt uspí
 * a je potřeba, aby to bylo vidět dřív, než na to přijde zákazník.
 *
 * Chat i Instagram můžou běžet na jednom projektu — pak je tu jeden řádek
 * a je u něj napsané, k čemu obojímu slouží.
 */
export default function SupabaseHealth({ only }: {
  /** Ukázat jen projekt, který slouží k tomuhle (`chat`, `média pro Instagram`) */
  only?: string;
}) {
  const toast = useToast();
  const [rows, setRows] = useState<SupabaseStatus[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.supabase.status().then(setRows).catch(() => setRows([]));
  }, []);
  useEffect(load, [load]);

  const ping = async () => {
    setBusy(true);
    try {
      const result = await api.supabase.ping();
      setRows(result.status);
      const failed = result.result.filter(item => !item.ok);
      toast(failed.length
        ? `${failed[0].host}: ${failed[0].error}`
        : 'Projekty se ozvaly.', failed.length ? 'error' : undefined);
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const visible = (rows ?? []).filter(row => !only || row.uses.includes(only));
  if (visible.length === 0) return null;

  return (
    <div className="sb-health">
      {visible.map(row => (
        <div key={row.host} className={`sb-row ${row.warn ? 'warn' : ''}`}>
          <Icon name={row.warn ? 'zap' : 'check'} size={13} />
          <div className="sb-text">
            <b>{idleLabel(row)}</b>
            <small>
              {row.host} · {row.uses.join(' a ')}
            </small>
          </div>
        </div>
      ))}
      <p className="ig-muted sb-note">
        Bezplatný tarif Supabase uspí projekt po několika dnech bez jediného dotazu.
        Dokud aplikace běží, ozývá se za tebe sama — když ji ale týden nespustíš,
        projekt usne a probudit ho jde jen v administraci Supabase.
      </p>
      <button className="btn ghost" onClick={ping} disabled={busy}>
        {busy ? <span className="spinner-inline" /> : <Icon name="refresh" size={13} />}
        Ozvat se projektům teď
      </button>
    </div>
  );
}

/** Věta o tom, jak dlouho je ticho — ve správném tvaru, ne „1 dnů". */
function idleLabel(row: SupabaseStatus): string {
  if (row.idleDays < 0) return 'Projekt se zatím neozval';
  if (row.idleDays === 0) return 'Projekt se ozval dnes';
  if (row.idleDays === 1) return 'Projekt se neozval den';
  if (row.idleDays < 5) return `Projekt se neozval ${row.idleDays} dny`;
  return `Projekt se neozval ${row.idleDays} dnů`;
}
