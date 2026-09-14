import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import Icon from './Icon';
import HtmlField, { HtmlFieldHandle } from './HtmlField';
import { uploadToShop, pickForArticle } from '../shopfiles';
import type {
  NewProductState, NewProductDraft, NewProductChange, NewProductGap, NewProductTexts,
  NewProductParamProposal, ShopCategoryTree, ShopCategoryItem, PtransProduct,
  ParamDictionary, ParamLookup, EurRate
} from '@shared/types';

/**
 * Nový produkt.
 *
 * Aby se vyplatilo zakládat produkt tady a ne v administraci, musí být na
 * jedné obrazovce vidět tři věci naráz: co je vyplněné, co chybí a co ještě
 * zbývá přepsat po předloze. Proto ne průvodce po krocích — ten by pokaždé
 * ukazoval jen jednu z nich.
 *
 * Jazyky jsou v záložkách, ne pod sebou: slovenština a angličtina vznikají
 * překladem a dívá se do nich až na konci, kdežto čeština se píše celou dobu.
 */

/** Jak dlouho se čeká, než se rozepsané pole uloží. */
const SAVE_DELAY = 700;

/** Kam se z „co ještě chybí" skáče. */
const GAP_SECTION: Record<string, string> = {
  code: 'zaklad', price: 'zaklad', 'price-eur': 'zaklad',
  category: 'kategorie',
  title: 'texty', short: 'texty', long: 'texty', seo: 'texty', google: 'texty',
  params: 'parametry',
  images: 'obrazky', 'main-image': 'obrazky', upload: 'obrazky'
};

const EMPTY: NewProductTexts = {
  title: '', short: '', long: '', seo_title: '', seo_desc: '', seo_url: '',
  google_title: '', google_desc: ''
};

export default function NewProduct({ toast }: { toast: (text: string) => void }) {
  const [state, setState] = useState<NewProductState | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const next = await api.newProduct.state();
    setState(next);
    setActiveId(current => current && next.drafts.some(one => one.id === current)
      ? current
      : (next.drafts[0]?.id ?? null));
  }, []);

  useEffect(() => { load().catch(() => { /* okno se zavřelo */ }); }, [load]);

  const draft = state?.drafts.find(one => one.id === activeId) ?? null;

  const create = async () => {
    const fresh = await api.newProduct.create();
    await load();
    setActiveId(fresh.id);
  };

  if (!state) return <div className="ig-muted np-loading">Načítám…</div>;

  return (
    <div className="np-wrap">
      <div className="np-rail">
        <button className="btn primary np-new" onClick={create}>
          <Icon name="plus" size={16} /> Nový produkt
        </button>
        {state.drafts.length === 0 ? (
          <p className="ig-muted np-empty">
            Nejrychlejší je vybrat podobný kus jako předlohu — texty, parametry
            i kategorie se natáhnou a zvýrazní se, co je potřeba přepsat.
          </p>
        ) : state.drafts.map(one => (
          <button key={one.id} className={`np-item ${one.id === activeId ? 'active' : ''}`}
            onClick={() => setActiveId(one.id)}>
            {one.images.find(img => img.main)?.url
              ? <img src={one.images.find(img => img.main)!.url} alt="" />
              : <span className="np-item-noimg"><Icon name="image" size={14} /></span>}
            <span className="np-item-text">
              <b>{one.langs.cz?.title || 'Bez názvu'}</b>
              <small>{one.code || 'bez kódu'}</small>
            </span>
            <Stav draft={one} />
          </button>
        ))}
      </div>

      {draft ? (
        <DraftEditor key={draft.id} draft={draft} state={state} toast={toast} onReload={load} />
      ) : (
        <div className="np-blank ig-muted">Vyber rozdělaný produkt, nebo založ nový.</div>
      )}
    </div>
  );
}

function Stav({ draft }: { draft: NewProductDraft }) {
  const blockers = (draft.gaps ?? []).filter(one => one.level === 'blocker').length;
  if (draft.state === 'exported') {
    return <span className="np-state done"><Icon name="check" size={12} /> v katalogu</span>;
  }
  if (blockers) return <span className="np-state todo">{blockers}×</span>;
  return <span className="np-state ready">připraveno</span>;
}

/* ---------- editor jednoho produktu ---------- */

function DraftEditor({ draft, state, toast, onReload }: {
  draft: NewProductDraft;
  state: NewProductState;
  toast: (text: string) => void;
  onReload: () => Promise<void>;
}) {
  const source = state.sourceLang;
  const [local, setLocal] = useState<NewProductDraft>(draft);
  const [work, setWork] = useState('');
  const [step, setStep] = useState('');
  /*
   * Jazyk se drží tady a přepíná se v pravém sloupci. V kartě textů to
   * znamenalo odscrollovat od pole, které se zrovna upravuje, nahoru
   * a zase zpátky.
   */
  const [lang, setLang] = useState(source);
  const timer = useRef<number | null>(null);
  const pending = useRef<Partial<NewProductDraft> | null>(null);

  useEffect(() => {
    const off = api.on('np:step', (s: any) => setStep(s?.step ?? ''));
    return off;
  }, []);

  const flush = useCallback(async () => {
    if (timer.current) { window.clearTimeout(timer.current); timer.current = null; }
    const patch = pending.current;
    if (!patch) return;
    pending.current = null;
    try {
      const saved = await api.newProduct.save(draft.id, patch);
      setLocal(current => ({ ...current, gaps: saved.gaps }));
    } catch (e: any) { toast(e?.message ?? String(e)); }
  }, [draft.id, toast]);

  useEffect(() => () => { void flush(); }, [flush]);

  /**
   * Ukládá se výřezem a se zpožděním.
   *
   * Celý produkt by se navzájem přepisoval: dvě rychlé změny za sebou
   * (napsaný název a zaškrtnutá kategorie) by si vrátily starší hodnoty.
   */
  const push = useCallback((patch: Partial<NewProductDraft>, now = false) => {
    setLocal(current => ({ ...current, ...patch }));
    pending.current = { ...(pending.current ?? {}), ...patch };
    if (timer.current) window.clearTimeout(timer.current);
    if (now) { void flush(); return; }
    timer.current = window.setTimeout(() => { void flush(); }, SAVE_DELAY);
  }, [flush]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setWork(key);
    try { await fn(); }
    catch (e: any) { toast(e?.message ?? String(e)); }
    finally { setWork(''); setStep(''); }
  };

  const gaps = local.gaps ?? [];
  const blockers = gaps.filter(one => one.level === 'blocker');
  const saved = local.state === 'exported';

  const jump = (key: string) => {
    const id = GAP_SECTION[key.split(':')[0]] ?? 'texty';
    document.getElementById(`np-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="np-main">
      <div className="np-head">
        <span className="np-head-title">{local.langs[source]?.title || 'Nový produkt'}</span>
        {local.code ? <code className="np-head-code">{local.code}</code> : null}
        <span style={{ flex: 1 }} />
        <button className="btn ghost" onClick={() => run('delete', async () => {
          if (!window.confirm('Zahodit rozdělaný produkt?')) return;
          await api.newProduct.remove(local.id);
          await onReload();
        })}>
          <Icon name="trash" size={14} /> Zahodit
        </button>
      </div>

      <div className="np-cols">
        <div className="np-form">
          <Basics draft={local} state={state} onPatch={push} toast={toast} work={work}
            run={run} onLoaded={setLocal} />

          <TextsCard draft={local} state={state} lang={lang} onPatch={push} toast={toast}
            work={work} run={run} />

          <ParamsCard draft={local} state={state} onPatch={push} toast={toast}
            work={work} run={run} />

          <ImagesCard draft={local} onPatch={push} toast={toast} work={work} run={run} />
        </div>

        <aside className="np-side">
          <div className="np-side-lang">
            <span className="np-label">Jazyk</span>
            <div className="ig-seg np-langs">
              {state.langs.map(one => {
                const filled = !!(local.langs[one]?.title || '').trim();
                return (
                  <button key={one} className={one === lang ? 'active' : ''}
                    onClick={() => setLang(one)}>
                    {one.toUpperCase()}
                    {one !== source && !filled ? <i className="np-dot" /> : null}
                  </button>
                );
              })}
            </div>
          </div>

          <h4>Co ještě chybí</h4>
          {gaps.length === 0 ? (
            <p className="np-side-ok"><Icon name="check" size={13} /> Všechno vyplněné.</p>
          ) : (
            <ul className="np-gaps">
              {gaps.map(one => (
                <li key={one.key}>
                  <button className={one.level} onClick={() => jump(one.key)}>
                    <Icon name={one.level === 'blocker' ? 'alert' : 'minus'} size={12} />
                    {one.label}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <ol className="np-steps">
            <li className={saved ? 'done' : 'now'}>
              {/* Hotový krok nesmí vypadat jako tlačítko, které jde zmáčknout */}
              <button className={`btn ${saved ? 'ghost' : 'primary'}`}
                disabled={!!work || blockers.length > 0 || saved}
                onClick={() => run('save', async () => {
                  const out = await api.newProduct.toCatalog(local.id);
                  setLocal(out.draft);
                  await onReload();
                  toast(`${out.code} je v katalogu.`);
                })}>
                {work === 'save' ? <span className="spinner-inline" /> : <Icon name="save" size={14} />}
                {' '}Uložit do katalogu
              </button>
            </li>

            <li className={saved ? 'now' : ''}>
              <button className="btn ghost" disabled={!!work || !saved}
                onClick={() => run('complete', async () => {
                  const out = await api.newProduct.complete(local.code);
                  if (out.draft) setLocal(out.draft);
                  await onReload();
                  toast(out.errors.length
                    ? `Hotovo, ale ${out.errors.length}× to nevyšlo: ${out.errors[0]}`
                    : 'SEO, texty pro Google i překlady jsou dopsané.');
                })}>
                {work === 'complete' ? <span className="spinner-inline" /> : <Icon name="sparkles" size={14} />}
                {' '}Dopsat SEO, Google a překlady
              </button>
              {work === 'complete' && step ? <p className="np-step">{step}</p> : null}
            </li>

            <li className={saved ? 'now' : ''}>
              <div className="np-two">
                <button className="btn ghost" disabled={!!work || !saved}
                  onClick={() => run('xml', async () => {
                    const out = await api.ptrans.export({
                      codes: [local.code], mode: 'full', state: 'current', includeSource: true
                    });
                    toast(out ? `Uloženo do ${out.path}` : 'Uložení se zrušilo.');
                  })}>
                  <Icon name="download" size={14} /> XML
                </button>
                <button className="btn ghost" disabled={!!work || !saved}
                  onClick={() => run('import', async () => {
                    const out = await api.newProduct.openImport(local.code);
                    toast(out.note);
                  })}>
                  {work === 'import' ? <span className="spinner-inline" /> : <Icon name="upload" size={14} />}
                  {' '}Do administrace
                </button>
              </div>
              {work === 'import' && step ? <p className="np-step">{step}</p> : null}
              <p className="desc">Import nespustím — poslední kliknutí je na tobě.</p>
            </li>
          </ol>

          <CategoryPicker draft={local} onPatch={push} toast={toast} />
        </aside>
      </div>
    </div>
  );
}

/* ---------- 1. základ ---------- */

const CURRENCY_LABEL: Record<string, string> = {
  CZK: 'Kč', EUR: '€', USD: '$', GBP: '£', PLN: 'zł'
};

/**
 * Ceny se zadávají po měnách, ne po jazycích: slovenský i anglický e-shop
 * prodávají v eurech a dvě stejná políčka „€" svádějí vyplnit jen jedno.
 */
function priceGroups(state: NewProductState): { currency: string; label: string; langs: string[] }[] {
  const out: { currency: string; label: string; langs: string[] }[] = [];
  for (const lang of state.langs) {
    const currency = state.currencies[lang] || `?${lang}`;
    const found = out.find(one => one.currency === currency);
    if (found) found.langs.push(lang);
    else out.push({
      currency,
      label: CURRENCY_LABEL[currency] ?? currency.replace(/^\?/, '').toUpperCase(),
      langs: [lang]
    });
  }
  return out;
}

function Basics({ draft, state, onPatch, toast, work, run, onLoaded }: {
  draft: NewProductDraft;
  state: NewProductState;
  onPatch: (patch: Partial<NewProductDraft>, now?: boolean) => void;
  toast: (text: string) => void;
  work: string;
  run: (key: string, fn: () => Promise<void>) => Promise<void>;
  onLoaded: (draft: NewProductDraft) => void;
}) {
  const [clash, setClash] = useState<{ taken: boolean; title: string } | null>(null);
  const [search, setSearch] = useState('');
  const [hits, setHits] = useState<PtransProduct[]>([]);
  const [rate, setRate] = useState<EurRate | null>(null);

  useEffect(() => { api.newProduct.rate().then(setRate).catch(() => { /* bez kurzu se obejde */ }); }, []);

  useEffect(() => {
    if (!draft.code.trim()) { setClash(null); return; }
    let alive = true;
    const id = window.setTimeout(async () => {
      const out = await api.newProduct.checkCode(draft.code, draft.id);
      if (alive) setClash(out);
    }, 300);
    return () => { alive = false; window.clearTimeout(id); };
  }, [draft.code, draft.id, draft.state]);

  useEffect(() => {
    if (!search.trim()) { setHits([]); return; }
    let alive = true;
    const id = window.setTimeout(async () => {
      const page = await api.ptrans.list({ search: search.trim(), limit: 8, onlyActive: true });
      if (alive) setHits(page.rows);
    }, 250);
    return () => { alive = false; window.clearTimeout(id); };
  }, [search]);

  return (
    <section className="np-box" id="np-zaklad">
      <h4><Icon name="bag" size={14} /> Základ</h4>

      <div className="np-basics">
        <label className="np-field np-code">
          <span>Kód produktu</span>
          <input value={draft.code} placeholder="KR00123"
            className={clash?.taken ? 'bad' : ''}
            onChange={e => onPatch({ code: e.target.value })} />
          {clash?.taken
            ? <em className="np-warn"><Icon name="alert" size={12} /> Má ho „{clash.title}"</em>
            : draft.code.trim() ? <em className="np-good">volný</em> : <em className="np-hint">povinné</em>}
        </label>

        {priceGroups(state).map(group => {
          const value = draft.prices[group.langs[0]] ?? '';
          const set = (next: string) => {
            const prices = { ...draft.prices };
            for (const lang of group.langs) prices[lang] = next;
            onPatch({ prices });
          };
          /*
           * Přibližná cena v eurech z kurzu ČNB. Přesnou (s koncovkou .90)
           * si člověk nastaví sám — přepočítávat v hlavě u každého produktu
           * je zbytečná práce a přepsat se přitom dá čárka.
           */
          const czk = Number((draft.prices[state.sourceLang] ?? '').replace(',', '.'));
          const suggest = group.currency === 'EUR' && rate && czk > 0
            ? (Math.round((czk / rate.rate) * 10) / 10).toFixed(1).replace('.', ',')
            : '';
          return (
            <label key={group.currency} className="np-field np-price">
              <span>Cena ({group.label})</span>
              <input value={value} inputMode="decimal" onChange={e => set(e.target.value)} />
              {suggest && !value.trim() ? (
                <button type="button" className="link np-rate"
                  title={`Kurz ČNB ${rate!.rate.toFixed(3).replace('.', ',')} Kč/€ ze dne ${rate!.day}`}
                  onClick={() => set(suggest)}>
                  ≈ {suggest} € — použít
                </button>
              ) : <em className="np-hint">s DPH</em>}
            </label>
          );
        })}

        <label className="np-field">
          <span>Značka</span>
          <input value={draft.manufacturer} onChange={e => onPatch({ manufacturer: e.target.value })} />
        </label>

        <label className="np-field">
          <span>EAN</span>
          <input value={draft.ean} onChange={e => onPatch({ ean: e.target.value })} />
          <em className="np-hint">nepovinné</em>
        </label>
      </div>

      <div className="np-template">
        <span className="np-label"><Icon name="copy" size={13} /> Předloha</span>
        {draft.templateCode ? (
          <span className="np-template-set">
            <code>{draft.templateCode}</code>
            <button className="link" onClick={() => onPatch({ templateCode: '' }, true)}>odpojit</button>
          </span>
        ) : (
          <div className="np-pick">
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Najdi podobný produkt — natáhnou se texty, parametry i kategorie" />
            {work === 'template' ? <span className="spinner-inline np-pick-spin" /> : null}
            {hits.length ? (
              <ul className="np-hits">
                {hits.map(one => (
                  <li key={one.code}>
                    <button disabled={!!work} onClick={() => run('template', async () => {
                      const out = await api.newProduct.template(draft.id, one.code);
                      onLoaded(out.draft);
                      setSearch('');
                      setHits([]);
                      toast(out.note
                        || `Z ${one.code} natažené texty · ${out.specifics.length}× je v nich něco specifického pro předlohu.`);
                    })}>
                      {one.image ? <img src={one.image} alt="" /> : <span className="np-hit-noimg" />}
                      <span className="np-hit-title">{one.title}</span>
                      <code>{one.code}</code>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        )}
      </div>

      <p className="desc">Zásoba se sem nepíše — vyplníš ji v administraci a import ji nepřepíše.</p>
    </section>
  );
}

/* ---------- 2. kategorie ---------- */

interface CatNode extends ShopCategoryItem {
  children: CatNode[];
}

function buildTree(items: ShopCategoryItem[]): CatNode[] {
  const byId = new Map<string, CatNode>();
  for (const one of items) byId.set(one.id, { ...one, children: [] });
  const roots: CatNode[] = [];
  for (const one of byId.values()) {
    const parent = one.parentId ? byId.get(one.parentId) : undefined;
    if (parent) parent.children.push(one); else roots.push(one);
  }
  return roots;
}

function CategoryPicker({ draft, onPatch, toast }: {
  draft: NewProductDraft;
  onPatch: (patch: Partial<NewProductDraft>, now?: boolean) => void;
  toast: (text: string) => void;
}) {
  const [tree, setTree] = useState<ShopCategoryTree | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const load = useCallback(async (refresh = false) => {
    setBusy(true);
    try { setTree(await api.newProduct.categories(refresh)); }
    catch (e: any) { toast(e?.message ?? String(e)); }
    finally { setBusy(false); }
  }, [toast]);

  useEffect(() => { load(false).catch(() => { /* nic */ }); }, [load]);

  // Nabízejí se jen kategorie se zbožím — do stránek v menu by se dalo pověsit
  // zboží a v e-shopu by pak nebylo nikde
  const roots = useMemo(
    () => buildTree((tree?.items ?? []).filter(one => one.holdsProducts)),
    [tree]
  );

  const q = filter.trim().toLowerCase();
  const chosen = new Set(draft.categories);

  const toggle = (code: string) => {
    const has = chosen.has(code);
    const categories = has
      ? draft.categories.filter(one => one !== code)
      : [...draft.categories, code];
    const main = has && draft.mainCategory === code ? (categories[0] ?? '') : draft.mainCategory;
    onPatch({ categories, mainCategory: main || categories[0] || '' }, true);
  };

  const nameOf = (one: CatNode) => one.names.cz || one.code;

  /** Kolik vybraných je pod uzlem (i v něm samotném). */
  const countIn = (node: CatNode): number =>
    (chosen.has(node.code) ? 1 : 0) + node.children.reduce((sum, kid) => sum + countIn(kid), 0);

  const matches = (node: CatNode): boolean =>
    !q || node.path.toLowerCase().includes(q) || node.children.some(matches);

  const render = (node: CatNode, depth: number): JSX.Element | null => {
    if (!matches(node)) return null;
    const on = chosen.has(node.code);
    const inside = countIn(node);
    // Rozbalí se samo tam, kde něco je: vybraná podkategorie schovaná
    // v zabalené větvi by vypadala, že vybraná není
    const shown = open[node.code] ?? (!!q || inside > 0);
    return (
      <li key={node.code}>
        <div className="np-cat" style={{ paddingLeft: depth * 18 }}>
          {node.children.length ? (
            <button className={`np-cat-toggle ${shown ? 'open' : ''}`}
              onClick={() => setOpen(o => ({ ...o, [node.code]: !shown }))}>
              <Icon name="chevDown" size={12} />
            </button>
          ) : <span className="np-cat-toggle empty" />}

          <label>
            <input type="checkbox" checked={on} onChange={() => toggle(node.code)} />
            <span>{nameOf(node)}</span>
          </label>

          {on ? (
            <button className={`np-main-cat ${draft.mainCategory === node.code ? 'on' : ''}`}
              onClick={() => onPatch({ mainCategory: node.code }, true)}
              title="Hlavní kategorie určuje adresu produktu a drobečkovou navigaci">
              <Icon name="star" size={11} /> hlavní
            </button>
          ) : inside && !shown ? <span className="np-cat-count">{inside}</span> : null}
        </div>
        {shown && node.children.length ? (
          <ul>{node.children.map(kid => render(kid, depth + 1))}</ul>
        ) : null}
      </li>
    );
  };

  const picked = (tree?.items ?? []).filter(one => chosen.has(one.code));

  return (
    <section className="np-box" id="np-kategorie">
      <h4>
        <Icon name="folder" size={14} /> Kategorie
        <span className="np-count">{picked.length}</span>
        <button className="link np-right" disabled={busy} onClick={() => load(true)}>
          {busy ? 'načítám…' : 'načíst z e-shopu'}
        </button>
      </h4>

      {!tree ? (
        <p className="ig-muted">Adresu exportu kategorií vyplň v Nastavení → AI.</p>
      ) : (
        <>
          {picked.length ? (
            <div className="np-chosen">
              {picked.map(one => (
                <span key={one.code} title={one.path}
                  className={`np-chip-cat ${draft.mainCategory === one.code ? 'main' : ''}`}>
                  {draft.mainCategory === one.code ? <Icon name="star" size={11} /> : null}
                  <span>{one.names.cz || one.code}</span>
                  <button onClick={() => toggle(one.code)}><Icon name="x" size={11} /></button>
                </span>
              ))}
            </div>
          ) : null}

          <input className="np-filter" value={filter} onChange={e => setFilter(e.target.value)}
            placeholder="Hledat kategorii" />
          <ul className="np-cats">{roots.map(one => render(one, 0))}</ul>
        </>
      )}
    </section>
  );
}

/* ---------- 3. texty ---------- */

const FIELD_LABELS: Record<string, string> = {
  title: 'Název', short: 'Krátký popis', long: 'Dlouhý popis'
};

/** Kratší podoba do štítků — „Modrá" se stejným zněním bývá ve dvou polích. */
const FIELD_SHORT: Record<string, string> = {
  title: 'název', short: 'krátký', long: 'dlouhý'
};

function TextsCard({ draft, state, lang, onPatch, toast, work, run }: {
  draft: NewProductDraft;
  state: NewProductState;
  lang: string;
  onPatch: (patch: Partial<NewProductDraft>, now?: boolean) => void;
  toast: (text: string) => void;
  work: string;
  run: (key: string, fn: () => Promise<void>) => Promise<void>;
}) {
  const source = state.sourceLang;
  const [changes, setChanges] = useState<NewProductChange[] | null>(null);
  const [picked, setPicked] = useState<{ field: 'short' | 'long'; text: string } | null>(null);
  const [hint, setHint] = useState('');
  const fields = useRef<Record<string, HtmlFieldHandle | null>>({});

  const texts = draft.langs[lang] ?? EMPTY;
  const setText = (field: keyof NewProductTexts, value: string, now = false) =>
    onPatch({ langs: { ...draft.langs, [lang]: { ...texts, [field]: value } } }, now);

  /*
   * Specifika se hlídají jen ve zdrojovém jazyce — v překladech se stejně
   * přepisují spolu s ním. Za vyřešené se bere to, co v poli doopravdy není;
   * odškrtnout rukou nejde, aby se to nedalo odbýt.
   */
  const specifics = lang === source ? draft.specifics : [];
  const left = specifics.filter(one => ((texts as any)[one.field] ?? '').includes(one.text));

  const rewrite = () => run('rewrite', async () => {
    if (!picked) return;
    const handle = fields.current[picked.field];
    if (!handle) return;
    const around = handle.context();
    if (!around.selection.trim()) throw new Error('Výběr už neplatí — označ text znovu.');
    const next = await api.newProduct.rewrite({
      before: around.before, selection: around.selection, after: around.after,
      instruction: hint.trim() || undefined
    });
    if (!handle.replaceSelection(next)) {
      throw new Error('Výběr už neplatí — označ text znovu.');
    }
    setPicked(null);
    setHint('');
  });

  return (
    <section className="np-box" id="np-texty">
      <h4>
        <Icon name="pen" size={14} /> Texty
        <span className="np-count">{lang.toUpperCase()}</span>
      </h4>

      {lang !== source && !texts.title.trim() ? (
        <p className="ig-muted np-lang-note">Doplní se překladem po uložení do katalogu.</p>
      ) : null}

      {specifics.length ? (
        <div className="np-specifics">
          <span className="np-label">
            {left.length ? `Z předlohy zbývá přepsat ${left.length}` : 'Z předlohy je vše přepsané'}
          </span>
          {specifics.map((one, index) => {
            const still = ((texts as any)[one.field] ?? '').includes(one.text);
            return (
              <span key={index} className={`np-chip ${still ? '' : 'done'}`}
                title={`${FIELD_LABELS[one.field] ?? one.field} · ${one.why}`}>
                {still ? null : <Icon name="check" size={11} />}
                <i>{FIELD_SHORT[one.field] ?? one.field}</i>
                {one.text.length > 38 ? `${one.text.slice(0, 38)}…` : one.text}
              </span>
            );
          })}
        </div>
      ) : null}

      <label className="np-field">
        <span>Název</span>
        <div className="np-title-row">
          <input value={texts.title} onChange={e => setText('title', e.target.value)} />
          {draft.templateCode && lang === source ? (
            <button className="btn ghost" disabled={!!work || !texts.title.trim()}
              onClick={() => run('title', async () => {
                const out = await api.newProduct.titleProposal(draft.id, lang);
                setChanges(out);
                if (out.length === 0) toast('Podle nového názvu není v textech co měnit.');
              })}>
              {work === 'title' ? <span className="spinner-inline" /> : <Icon name="brain" size={14} />}
              {' '}Sladit texty s názvem
            </button>
          ) : null}
        </div>
      </label>

      {changes?.length ? (
        <ul className="np-changes">
          {changes.map((one, index) => (
            <li key={index}>
              <span className="np-change-where">{FIELD_LABELS[one.field] ?? one.field}</span>
              <span className="np-change-before">{one.before}</span>
              <Icon name="chevRight" size={12} />
              <span className="np-change-after">{one.after}</span>
              {one.why ? <em>{one.why}</em> : null}
              <button className="btn ghost" onClick={() => {
                const full = (texts as any)[one.field] ?? '';
                if (!full.includes(one.before)) { toast('Text se mezitím změnil — návrh už nesedí.'); return; }
                setText(one.field as keyof NewProductTexts, full.replace(one.before, one.after), true);
                setChanges(list => (list ?? []).filter((_x, i) => i !== index));
              }}>Použít</button>
              <button className="link" onClick={() =>
                setChanges(list => (list ?? []).filter((_x, i) => i !== index))}>Nechat</button>
            </li>
          ))}
        </ul>
      ) : null}

      {(['short', 'long'] as const).map(field => (
        <div key={field} className="np-field">
          <span>{FIELD_LABELS[field]}</span>
          <HtmlField
            ref={el => { fields.current[field] = el; }}
            value={texts[field] ?? ''}
            rows={field === 'long' ? 14 : 6}
            onChange={value => setText(field, value)}
            onSelect={text => setPicked(text.trim() ? { field, text } : null)}
          />
          {/*
            * Nabídka na přepis se ukazuje jen tam, kde je zrovna označeno.
            * Tlačítko, které je vidět pořád a skoro vždy nejde zmáčknout,
            * vypadá jako rozbité.
            */}
          {picked?.field === field ? (
            <div className="np-rewrite">
              <Icon name="sparkles" size={13} />
              <span className="np-rewrite-text">
                „{picked.text.length > 60 ? `${picked.text.slice(0, 60)}…` : picked.text}"
              </span>
              <input value={hint} placeholder="volitelně: jak to přepsat"
                onChange={e => setHint(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); rewrite(); } }} />
              <button className="btn primary" disabled={!!work}
                onMouseDown={e => e.preventDefault()} onClick={rewrite}>
                {work === 'rewrite' ? <span className="spinner-inline" /> : null} Přepsat
              </button>
            </div>
          ) : null}
        </div>
      ))}

      {/*
        * SEO a Google vedle sebe, titulek nad popisem. Popis je dlouhá věta
        * a na jednom řádku z něj bylo vidět pár slov — porovnat, jestli obě
        * verze říkají totéž, se takhle nedalo.
        */}
      <div className="np-meta">
        <div className="np-meta-col">
          <span className="np-label">SEO</span>
          <input value={texts.seo_title} placeholder="titulek — dopíše se"
            onChange={e => setText('seo_title', e.target.value)} />
          <textarea rows={3} value={texts.seo_desc} placeholder="popis — dopíše se"
            onChange={e => setText('seo_desc', e.target.value)} />
        </div>
        <div className="np-meta-col">
          <span className="np-label">Google Nákupy</span>
          <input value={texts.google_title} placeholder="titulek — dopíše se"
            onChange={e => setText('google_title', e.target.value)} />
          <textarea rows={3} value={texts.google_desc} placeholder="popis — dopíše se"
            onChange={e => setText('google_desc', e.target.value)} />
        </div>
      </div>
    </section>
  );
}

/* ---------- 4. parametry ---------- */

function keyOf(text: string): string {
  return text.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * Políčko s nabídkou.
 *
 * Ne `<input list>`: prohlížeč v něm nabízí jen to, co odpovídá napsanému
 * textu, takže u vyplněného políčka není vidět nic. Tady se tlačítkem
 * otevře **celá** nabídka a psaním se teprve filtruje.
 */
function Suggest({ value, onChange, options, placeholder }: {
  value: string;
  onChange: (value: string) => void;
  options: string[];
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [typing, setTyping] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const shown = typing && value.trim()
    ? options.filter(one => keyOf(one).includes(keyOf(value)))
    : options;

  return (
    <div className="np-suggest" ref={box}>
      <input value={value} placeholder={placeholder}
        onChange={e => { setTyping(true); setOpen(true); onChange(e.target.value); }}
        onFocus={() => { setTyping(false); setOpen(true); }} />
      <button className="np-suggest-open" tabIndex={-1}
        onMouseDown={e => e.preventDefault()}
        onClick={() => { setTyping(false); setOpen(o => !o); }}>
        <Icon name="chevDown" size={12} />
      </button>
      {open && shown.length ? (
        <ul className="np-suggest-list">
          {shown.slice(0, 60).map(one => (
            <li key={one}>
              <button onMouseDown={e => e.preventDefault()}
                onClick={() => { onChange(one); setOpen(false); setTyping(false); }}>
                {one}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ParamsCard({ draft, state, onPatch, toast, work, run }: {
  draft: NewProductDraft;
  state: NewProductState;
  onPatch: (patch: Partial<NewProductDraft>, now?: boolean) => void;
  toast: (text: string) => void;
  work: string;
  run: (key: string, fn: () => Promise<void>) => Promise<void>;
}) {
  const [dict, setDict] = useState<ParamDictionary | null>(null);
  const [known, setKnown] = useState<Record<number, ParamLookup>>({});
  const [ideas, setIdeas] = useState<NewProductParamProposal[] | null>(null);

  const load = useCallback(async () => {
    try { setDict(await api.newProduct.params()); } catch { /* číselník je pomoc, ne podmínka */ }
  }, []);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    let alive = true;
    const id = window.setTimeout(async () => {
      const out: Record<number, ParamLookup> = {};
      for (let i = 0; i < draft.params.length; i++) {
        const one = draft.params[i];
        if (!one.name.trim()) continue;
        try { out[i] = await api.newProduct.checkParam(one.name, one.value); } catch { /* nic */ }
      }
      if (alive) setKnown(out);
    }, 400);
    return () => { alive = false; window.clearTimeout(id); };
  }, [draft.params]);

  const names = (dict?.names ?? []).map(one => one.langs.cz ?? one.key);
  const valuesFor = (name: string) => (dict?.values ?? [])
    .filter(one => one.nameKey === keyOf(name))
    .map(one => one.langs.cz ?? one.key);

  const set = (index: number, patch: { name?: string; value?: string }) =>
    onPatch({ params: draft.params.map((one, i) => i === index ? { ...one, ...patch } : one) });

  const add = (name = '', value = '') =>
    onPatch({ params: [...draft.params, { name, value }] }, true);

  return (
    <section className="np-box" id="np-parametry">
      <h4>
        <Icon name="sliders" size={14} /> Parametry
        <span className="np-count">{draft.params.length}</span>
        <button className="btn ghost np-right" disabled={!!work}
          onClick={() => run('params', async () => {
            const out = await api.newProduct.proposeParams(draft.id);
            setIdeas(out);
            if (out.length === 0) toast('Z popisu se nedá vyčíst žádný další parametr.');
          })}>
          {work === 'params' ? <span className="spinner-inline" /> : <Icon name="brain" size={14} />}
          {' '}Vyčíst z popisu
        </button>
      </h4>

      {ideas?.length ? (
        <ul className="np-ideas">
          {ideas.map((one, index) => (
            <li key={`${one.name}-${index}`}>
              <b>{one.name}</b>
              <span>{one.value}</span>
              {one.known ? null : <em className="np-warn">nový parametr</em>}
              {one.why ? <em>{one.why}</em> : null}
              <button className="btn ghost" onClick={() => {
                add(one.name, one.value);
                setIdeas(list => (list ?? []).filter((_x, i) => i !== index));
              }}>Přidat</button>
              <button className="link" onClick={() =>
                setIdeas(list => (list ?? []).filter((_x, i) => i !== index))}>Ne</button>
            </li>
          ))}
        </ul>
      ) : null}

      {draft.params.length === 0 ? (
        <p className="ig-muted">Zatím žádné. Z předlohy se natáhnou i s hodnotami.</p>
      ) : (
        <ul className="np-params">
          {draft.params.map((one, index) => (
            <li key={index} className={one.fromTemplate ? 'from-template' : ''}>
              <Suggest value={one.name} options={names} placeholder="Barva"
                onChange={name => set(index, { name })} />
              <Suggest value={one.value} options={valuesFor(one.name)} placeholder="zelená"
                onChange={value => set(index, { value })} />
              <ParamState found={known[index]} langs={state.langs} />
              <button className="icon-btn" title="Smazat"
                onClick={() => onPatch({ params: draft.params.filter((_x, i) => i !== index) }, true)}>
                <Icon name="trash" size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="np-row">
        <button className="btn ghost" onClick={() => add()}>
          <Icon name="plus" size={13} /> Přidat ručně
        </button>
        <button className="link" onClick={async () => {
          const out = await api.newProduct.relearnParams();
          await load();
          toast(`Číselník má ${out.names} parametrů a ${out.values} hodnot.`);
        }}>obnovit číselník z feedu</button>
      </div>
    </section>
  );
}

/** Stav parametru proti číselníku z feedu — „nový" je varování před překlepem. */
function ParamState({ found, langs }: { found?: ParamLookup; langs: string[] }) {
  if (!found) return <span className="np-param-state" />;
  if (!found.knownName) {
    return (
      <span className="np-param-state new" title="Takový parametr v e-shopu není — zkontroluj překlep">
        <Icon name="plus" size={11} /> nový
      </span>
    );
  }
  if (!found.knownValue) {
    return <span className="np-param-state half" title="Parametr e-shop zná, tuhle hodnotu ještě ne">nová hodnota</span>;
  }
  const missing = langs.filter(lang => lang !== 'cz' && !(found.value[lang] ?? found.name[lang]));
  return (
    <span className={`np-param-state ${missing.length ? 'half' : 'ok'}`}
      title={missing.length ? `Chybí překlad: ${missing.join(', ').toUpperCase()}` : 'Zná ho e-shop i ve všech jazycích'}>
      <Icon name="check" size={11} /> {missing.length ? missing.join(', ').toUpperCase() : 'zná'}
    </span>
  );
}

/* ---------- 5. obrázky ---------- */

function ImagesCard({ draft, onPatch, toast, work, run }: {
  draft: NewProductDraft;
  onPatch: (patch: Partial<NewProductDraft>, now?: boolean) => void;
  toast: (text: string) => void;
  work: string;
  run: (key: string, fn: () => Promise<void>) => Promise<void>;
}) {
  const [step, setStep] = useState('');

  const pick = () => run('images', async () => {
    const files = await pickForArticle();
    if (files.length === 0) return;
    const uploaded = await uploadToShop(files, setStep);
    onPatch({
      images: [...draft.images, ...uploaded.map((one, index) => ({
        url: one.url, name: one.name, main: draft.images.length === 0 && index === 0
      }))]
    }, true);
    setStep('');
    toast(`Nahráno ${uploaded.length} ${uploaded.length === 1 ? 'obrázek' : 'obrázků'}.`);
  });

  const move = (index: number, dir: -1 | 1) => {
    const next = [...draft.images];
    const to = index + dir;
    if (to < 0 || to >= next.length) return;
    [next[index], next[to]] = [next[to], next[index]];
    onPatch({ images: next }, true);
  };

  return (
    <section className="np-box" id="np-obrazky">
      <h4>
        <Icon name="image" size={14} /> Obrázky
        <span className="np-count">{draft.images.length}</span>
        <button className="btn ghost np-right" disabled={!!work} onClick={pick}>
          {work === 'images' ? <span className="spinner-inline" /> : <Icon name="upload" size={14} />}
          {' '}Z počítače
        </button>
      </h4>

      {step ? <p className="np-step">{step}</p> : null}

      {draft.images.length ? (
        <ul className="np-images">
          {draft.images.map((one, index) => (
            <li key={`${one.url ?? one.path}-${index}`} className={one.main ? 'main' : ''}>
              {one.url ? <img src={one.url} alt={one.name} /> : <span className="np-img-wait" />}
              <span className="np-img-name">{one.name}</span>
              <button className={`np-img-main ${one.main ? 'on' : ''}`}
                onClick={() => onPatch({
                  images: draft.images.map((x, i) => ({ ...x, main: i === index }))
                }, true)}>
                <Icon name="star" size={11} /> titulní
              </button>
              <button className="icon-btn np-up" onClick={() => move(index, -1)} title="Nahoru">
                <Icon name="chevDown" size={13} />
              </button>
              <button className="icon-btn" onClick={() => move(index, 1)} title="Dolů">
                <Icon name="chevDown" size={13} />
              </button>
              <button className="icon-btn" title="Odebrat"
                onClick={() => onPatch({ images: draft.images.filter((_x, i) => i !== index) }, true)}>
                <Icon name="trash" size={13} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="ig-muted">
          Převedou se na WebP, nahrají na e-shop a adresa se přečte zpátky.
        </p>
      )}
    </section>
  );
}
