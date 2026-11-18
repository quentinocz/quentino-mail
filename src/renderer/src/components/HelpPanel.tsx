import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { HELP_GROUPS, helpTopic, type HelpArea, type HelpTopic, type HelpTopicId } from '../help';
import Icon from './Icon';

/**
 * Nápověda k modulu — tlačítko s otazníkem a panel, který vyjede zprava.
 *
 * ## Proč takhle
 *
 * Panel nepřekrývá celé okno: modul zůstane vidět vlevo, takže se dá číst
 * a zároveň zkoušet. Každý postup je očíslovaný a krok, který se týká
 * konkrétní části obrazovky, ji umí **ukázat** — rozsvítí v okně rámeček
 * kolem tlačítka nebo sloupce, o kterém je řeč. Mapa okna nahoře ukazuje
 * totéž zmenšeně: z čeho se obrazovka skládá a kde co je.
 *
 * Obsah je v `src/renderer/src/help/` jako data. Tahle komponenta ho jen
 * vykreslí — pro všechny moduly stejně.
 */

/** `[Tlačítko]` a `**tučně**` z textu nápovědy. */
export function helpText(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\[([^\]]+)\]|\*\*([^*]+)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(m[1] !== undefined
      ? <span key={n++} className="hp-ui">{m[1]}</span>
      : <b key={n++}>{m[2]}</b>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Je prvek v okně vidět? Jen takový má smysl ukazovat. */
function visible(selector: string | undefined): HTMLElement | null {
  if (!selector) return null;
  let el: HTMLElement | null = null;
  try { el = document.querySelector(selector) as HTMLElement | null; } catch { return null; }
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? el : null;
}

/**
 * Rozsvítí rámeček kolem prvku v okně.
 *
 * Rámeček je samostatná vrstva nad oknem, ne styl na prvku: na prvek se
 * nesahá, takže ukázka nemůže rozbít jeho vzhled ani zůstat viset po zavření.
 */
export function spotlight(selector: string | undefined): boolean {
  const el = visible(selector);
  if (!el) return false;
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  const r = el.getBoundingClientRect();
  const ring = document.createElement('div');
  ring.className = 'hp-spot';
  Object.assign(ring.style, {
    left: `${Math.max(2, r.left - 5)}px`, top: `${Math.max(2, r.top - 5)}px`,
    width: `${Math.min(window.innerWidth - 4, r.width + 10)}px`,
    height: `${Math.min(window.innerHeight - 4, r.height + 10)}px`
  });
  document.body.appendChild(ring);
  /*
   * Panel nápovědy stojí vpravo a tlačítka v hlavičce modulu bývají právě
   * tam — ukázka by orámovala něco, co je schované pod panelem. Panel proto
   * na chvíli odjede stranou a po ukázce se vrátí.
   */
  const panel = document.querySelector('.hp-panel') as HTMLElement | null;
  const p = panel?.getBoundingClientRect();
  const under = !!p && r.right > p.left && r.left < p.right && r.bottom > p.top && r.top < p.bottom;
  if (under) panel!.classList.add('hp-peek');
  window.setTimeout(() => { ring.remove(); if (under) panel?.classList.remove('hp-peek'); }, 2600);
  return true;
}

function AreaMap({ topic, hot, onHot }: { topic: HelpTopic; hot: string; onHot: (id: string) => void }) {
  return (
    <div className="hp-map" aria-hidden="true">
      <div className="hp-map-bar"><i /><i /><i /><span>{topic.title}</span></div>
      <div className="hp-map-grid">
        {topic.areas.map((area, i) => (
          <button key={area.id}
            className={`hp-area${hot === area.id ? ' hot' : ''}`}
            style={{ gridColumn: `${area.x + 1} / span ${area.w}`, gridRow: `${area.y + 1} / span ${area.h}`,
              '--hp-c': topic.color } as any}
            onMouseEnter={() => onHot(area.id)} onMouseLeave={() => onHot('')}
            onClick={() => spotlight(area.target)}
            title={area.target ? 'Ukázat v okně' : undefined}>
            <span className="hp-area-n">{i + 1}</span>
            <span className="hp-area-label">{area.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function HelpPanel({ topic: start, onClose }: { topic: HelpTopicId | string; onClose: () => void }) {
  const [id, setId] = useState(start);
  const topic = helpTopic(id) ?? helpTopic('mail')!;
  const [open, setOpen] = useState(0);
  const [hot, setHot] = useState('');
  useEffect(() => { setOpen(0); }, [id]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);

  const areaIndex = useMemo(() => new Map(topic.areas.map((a, i) => [a.id, i + 1])), [topic]);
  const areaOf = (key?: string): HelpArea | undefined => topic.areas.find(a => a.id === key);

  return createPortal(
    <div className="hp-layer" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="hp-panel" role="dialog" aria-label={`Nápověda: ${topic.title}`}
        style={{ '--hp-c': topic.color } as any}>
        <header className="hp-head">
          <span className="hp-icon"><Icon name={topic.icon} size={18} /></span>
          <div className="hp-head-text">
            <small>Nápověda</small>
            <h2>{topic.title}</h2>
          </div>
          <select className="hp-pick" value={topic.id} onChange={e => setId(e.target.value)}
            aria-label="Jiné téma nápovědy">
            {HELP_GROUPS.map(group => (
              <optgroup key={group.label} label={group.label}>
                {group.topics.map(one => <option key={one.id} value={one.id}>{one.title}</option>)}
              </optgroup>
            ))}
          </select>
          <button className="icon-btn" onClick={onClose} aria-label="Zavřít nápovědu"><Icon name="x" size={16} /></button>
        </header>

        <div className="hp-body">
          <p className="hp-intro">{helpText(topic.intro)}</p>

          <h3 className="hp-h">Jak je okno rozložené</h3>
          <AreaMap topic={topic} hot={hot} onHot={setHot} />

          <h3 className="hp-h">Postupy</h3>
          <div className="hp-guides">
            {topic.guides.map((guide, gi) => (
              <section key={guide.title} className={`hp-guide${open === gi ? ' open' : ''}`}>
                <button className="hp-guide-head" onClick={() => setOpen(open === gi ? -1 : gi)}
                  aria-expanded={open === gi}>
                  <span className="hp-guide-n">{gi + 1}</span>
                  <span className="hp-guide-title">
                    <b>{guide.title}</b>
                    {guide.when && <small>{guide.when}</small>}
                  </span>
                  <Icon name={open === gi ? 'chevUp' : 'chevDown'} size={14} />
                </button>
                {open === gi && (
                  <ol className="hp-steps">
                    {guide.steps.map((step, si) => {
                      const area = areaOf(step.area);
                      const target = step.target ?? area?.target;
                      const canShow = !!visible(target);
                      return (
                        <li key={si} onMouseEnter={() => setHot(step.area ?? '')} onMouseLeave={() => setHot('')}>
                          <span className="hp-step-n">{si + 1}</span>
                          <div className="hp-step-body">
                            <p>{helpText(step.text)}</p>
                            {(area || canShow) && (
                              <div className="hp-step-meta">
                                {area && (
                                  <span className="hp-where">
                                    <span className="hp-area-n">{areaIndex.get(area.id)}</span> {area.label}
                                  </span>
                                )}
                                {canShow && (
                                  <button className="hp-show" onClick={() => spotlight(target)}>
                                    <Icon name="eye" size={12} /> Ukázat
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </section>
            ))}
          </div>

          {topic.warnings?.length ? (
            <div className="hp-warn">
              <Icon name="alert" size={15} />
              <div>{topic.warnings.map((w, i) => <p key={i}>{helpText(w)}</p>)}</div>
            </div>
          ) : null}

          {topic.tips.length > 0 && (
            <>
              <h3 className="hp-h">Dobré vědět</h3>
              <ul className="hp-tips">
                {topic.tips.map((tip, i) => (
                  <li key={i}><Icon name="check" size={13} /><span>{helpText(tip)}</span></li>
                ))}
              </ul>
            </>
          )}
        </div>
      </aside>
    </div>,
    document.body
  );
}

/**
 * Otazník do hlavičky modulu.
 *
 * `topic` může záviset na tom, co je v modulu zrovna otevřené (záložka
 * Nový produkt v překladech má vlastní nápovědu).
 */
/*
 * Vlastní třída, ne `icon-btn`: hlavičky modulů a náhledy s ikonkami
 * počítají („první ikonka obnoví, poslední zavře") — otazník mezi nimi
 * by tiše převzal roli jiného tlačítka.
 */
export default function HelpButton({ topic, className = 'hp-btn', label }: {
  topic: HelpTopicId; className?: string; label?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Fragment>
      <button className={className} onClick={() => setOpen(true)} data-tip="Nápověda — jak s tímhle pracovat"
        aria-label="Nápověda">
        {/* S popiskem je to položka postranního panelu — ta má ikonu ve vlastním obalu */}
        {label
          ? <><span className="icon"><Icon name="help" /></span><span className="label">{label}</span></>
          : <Icon name="help" size={16} />}
      </button>
      {open && <HelpPanel topic={topic} onClose={() => setOpen(false)} />}
    </Fragment>
  );
}
