import { useEffect, useState } from 'react';
import type { IgMarket } from '@shared/types';
import { api } from '../../api';

/** Náhledy se stahují jednou za spuštění; podruhé už jsou v paměti. */
const thumbCache = new Map<number, string | null>();
const pending = new Map<number, Promise<string | null>>();

export function useThumb(sourcePostId: number | null): string | null {
  const [url, setUrl] = useState<string | null>(() =>
    sourcePostId != null ? thumbCache.get(sourcePostId) ?? null : null);

  useEffect(() => {
    if (sourcePostId == null) return;
    if (thumbCache.has(sourcePostId)) { setUrl(thumbCache.get(sourcePostId)!); return; }
    let alive = true;
    let p = pending.get(sourcePostId);
    if (!p) {
      p = api.ig.thumb(sourcePostId).catch(() => null);
      pending.set(sourcePostId, p);
    }
    p.then(u => {
      thumbCache.set(sourcePostId, u);
      pending.delete(sourcePostId);
      if (alive) setUrl(u);
    });
    return () => { alive = false; };
  }, [sourcePostId]);

  return url;
}

/** Náhled souboru vybraného z disku (u videa se náhled nedělá). */
export function useFilePreview(file: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file) { setUrl(null); return; }
    let alive = true;
    api.ig.preview(file).then(u => { if (alive) setUrl(u); }).catch(() => {});
    return () => { alive = false; };
  }, [file]);
  return url;
}

export function marketColor(markets: IgMarket[], lang: string): string {
  return markets.find(m => m.lang === lang)?.color ?? '#7c5cff';
}

export function LangDot({ lang, color, state, title }: {
  lang: string; color: string; state: 'done' | 'pending' | 'none'; title?: string;
}) {
  return (
    <span
      className={`ig-lang ig-lang-${state}`}
      style={state === 'none' ? { color } : { background: color, borderColor: color }}
      data-tip={title}
    >
      {lang}
    </span>
  );
}

export function fmtDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? `dnes ${d.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' })}`
    : d.toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric', year: '2-digit' })
      + ' ' + d.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
}

/** Popisek pro odesílatele: délka a počet hashtagů proti limitům Instagramu. */
export function captionStats(text: string): { chars: number; tags: number; over: boolean } {
  const chars = text.length;
  const tags = (text.match(/#/g) ?? []).length;
  return { chars, tags, over: chars > 2200 || tags > 30 };
}

/** Vstup pro naplánování — datum a čas v místním pásmu, výstup ISO. */
export function LocalDateTime({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <input
      type="datetime-local"
      value={value}
      min={new Date(Date.now() - 60_000).toISOString().slice(0, 16)}
      onChange={e => onChange(e.target.value)}
    />
  );
}

export function toIso(local: string): string | null {
  if (!local) return null;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
