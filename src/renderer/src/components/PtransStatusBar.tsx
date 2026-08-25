import { useEffect, useState } from 'react';
import type { PtransProgress, ArticleProgress } from '@shared/types';
import { api } from '../api';
import Icon from './Icon';

/**
 * Stavový pruh práce, která běží na pozadí.
 *
 * Překlad produktů i psaní článků běží v hlavním procesu — zavřené okno je
 * nezastaví. Pruh je jediné místo, kde je pak vidět, že se něco děje. Drží se
 * dole nad obsahem a nabízí to jediné, co se během běhu chce: otevřít nebo
 * zastavit. Když je příslušné okno otevřené, pruh se schová — tam je průběh
 * vidět líp.
 *
 * Obě úlohy sdílí jeden pruh záměrně. Zároveň běžet nemají (obojí mluví se
 * stejným API a šlo by se snadno dostat na limit), a dva pruhy nad sebou by
 * jen zabíraly místo.
 */

/** Nástroje, které umí běžet na pozadí; „instagram" je vlastní prostor */
type Kind = 'ptrans' | 'articles';

interface Line {
  kind: Kind;
  label: string;
  detail: string;
  percent: number;
}

function humanEta(seconds: number | null): string {
  if (seconds == null) return '';
  if (seconds > 90) return `zbývá ~${Math.round(seconds / 60)} min`;
  return `zbývá ~${Math.max(1, Math.round(seconds))} s`;
}

export default function PtransStatusBar({ hidden, onOpen }: {
  /** Který nástroj je otevřený — pro ten se pruh neukazuje */
  hidden?: string | boolean;
  onOpen: (kind: Kind) => void;
}) {
  const [ptrans, setPtrans] = useState<PtransProgress | null>(null);
  const [articles, setArticles] = useState<ArticleProgress | null>(null);
  const [stopping, setStopping] = useState(false);

  // Po startu aplikace může běžet práce z minula — stav se zjistí dotazem
  useEffect(() => {
    api.ptrans.progress().then(setPtrans).catch(() => {});
    api.articles.progress().then(setArticles).catch(() => {});
    // `p` může přijít i prázdné (běh se zrušil dřív, než vůbec začal) —
    // sáhnout do něj naslepo by shodilo celé rozhraní kvůli pruhu na okraji
    const offPtrans = api.on('ptrans:progress', (p: PtransProgress | null) => {
      setPtrans(p);
      if (!p?.running) setStopping(false);
    });
    const offArticles = api.on('articles:progress', (p: ArticleProgress | null) => {
      setArticles(p);
      if (!p?.running) setStopping(false);
    });
    return () => { offPtrans(); offArticles(); };
  }, []);

  let line: Line | null = null;
  if (ptrans?.running) {
    line = {
      kind: 'ptrans',
      label: `Překládám ${ptrans.done}/${ptrans.total}`,
      detail: [ptrans.label || 'připravuji', humanEta(ptrans.etaSeconds),
        ptrans.failed > 0 ? `${ptrans.failed} chyb` : ''].filter(Boolean).join(' · '),
      percent: ptrans.total > 0 ? Math.round((ptrans.done / ptrans.total) * 100) : 0
    };
  } else if (articles?.running) {
    line = {
      kind: 'articles',
      label: articles.total > 1
        ? `Píšu článek ${articles.done + 1}/${articles.total}`
        : 'Píšu článek',
      // U článku není co odpočítávat — délka odpovědi se dopředu neví.
      // Počet napsaných slov je poctivější ukazatel než odhad času.
      detail: [articles.label || 'připravuji',
        articles.chars > 0 ? `zatím ${Math.round(articles.chars / 6)} slov` : '',
        articles.failed > 0 ? `${articles.failed} chyb` : ''].filter(Boolean).join(' · '),
      percent: articles.total > 0 ? Math.round((articles.done / articles.total) * 100) : 0
    };
  }

  if (!line) return null;
  if (hidden === true || hidden === line.kind) return null;

  const stop = () => {
    setStopping(true);
    const call = line!.kind === 'ptrans' ? api.ptrans.stop() : api.articles.stop();
    call.catch(() => setStopping(false));
  };

  return (
    <div className="pt-statusbar">
      <span className="pt-status-ico">
        <Icon name={line.kind === 'ptrans' ? 'globe' : 'fileText'} size={14} />
      </span>
      <div className="pt-status-text">
        <b>{line.label}</b>
        <small>{line.detail}</small>
      </div>
      <div className="pt-status-track"><span style={{ width: `${line.percent}%` }} /></div>
      <span className="pt-status-pct">{line.percent} %</span>
      <button className="btn ghost" onClick={() => onOpen(line!.kind)}>
        <Icon name="expand" size={13} /> Otevřít
      </button>
      <button className="btn ghost danger" disabled={stopping} onClick={stop}>
        <Icon name="stop" size={12} /> {stopping ? 'Zastavuji…' : 'Zastavit'}
      </button>
    </div>
  );
}
