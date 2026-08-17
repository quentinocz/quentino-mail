import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MailLang, ProductHit, ProductCardStyle, ProductFacets } from '@shared/types';
import { api } from '../api';
import { useToast } from '../toast';
import Icon from './Icon';
import { productCardHtml, CARD_STYLE_LABEL } from '../productcard';

const PAGE = 40;

const SORTS: { value: 'title' | 'price' | 'stock'; label: string }[] = [
  { value: 'title', label: 'Podle názvu' },
  { value: 'price', label: 'Podle ceny' },
  { value: 'stock', label: 'Nejvíc skladem' }
];

const STYLES: ProductCardStyle[] = ['card', 'compact', 'image'];

function titleOf(p: ProductHit, lang: MailLang): string {
  return p.title[lang] || p.title.cz || p.title.en || p.title.sk || p.code;
}

function priceOf(p: ProductHit, lang: MailLang): string {
  return p.price[lang] || p.price.cz || '';
}

interface Props {
  lang: MailLang;
  accent: string;
  /** Produkty, které už jsou v košíku z minulého otevření */
  initialSelected?: ProductHit[];
  /** Výchozí styl vložení (drží se mezi otevřeními) */
  initialStyle?: ProductCardStyle;
  onClose: () => void;
  /** Vloží produkty do těla zprávy na pozici kurzoru */
  onInsert: (products: ProductHit[], style: ProductCardStyle) => void;
  /** Uloží stav košíku, aby po zavření nezmizel */
  onSelectionChange?: (products: ProductHit[], style: ProductCardStyle) => void;
}

/**
 * Prohlížeč produktů: vlevo kategorie, uprostřed mřížka celého katalogu s hledáním,
 * vpravo košík vybraných produktů. Produkty se vkládají do textu na pozici kurzoru,
 * takže mezi ně jde psát komentáře.
 */
export default function ProductBrowser(p: Props) {
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [category, setCategory] = useState('');
  const [sort, setSort] = useState<'title' | 'price' | 'stock'>('title');
  const [inStockOnly, setInStockOnly] = useState(false);

  const [items, setItems] = useState<ProductHit[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [facets, setFacets] = useState<ProductFacets | null>(null);
  const [catFilter, setCatFilter] = useState('');

  const [selected, setSelected] = useState<ProductHit[]>(p.initialSelected ?? []);
  const [style, setStyle] = useState<ProductCardStyle>(p.initialStyle ?? 'card');
  const [previewOpen, setPreviewOpen] = useState(false);

  const gridRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  /** Roste s každou změnou filtru — odpovědi ze zastaralých dotazů se zahodí */
  const reqId = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 220);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    api.products.facets().then(setFacets).catch(() => setFacets(null));
  }, []);

  const load = useCallback(async (offset: number, id: number) => {
    setLoading(true);
    try {
      const page = await api.products.list({
        query: debounced || undefined,
        category: category || undefined,
        inStockOnly: inStockOnly || undefined,
        sort,
        offset,
        limit: PAGE,
        lang: p.lang
      });
      if (id !== reqId.current) return;
      setTotal(page.total);
      setItems(prev => (offset === 0 ? page.items : [...prev, ...page.items]));
    } catch (e: any) {
      if (id === reqId.current) toast(e.message, 'error');
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [debounced, category, inStockOnly, sort, p.lang, toast]);

  // Změna filtru → načíst od začátku a odscrollovat nahoru
  useEffect(() => {
    const id = ++reqId.current;
    setItems([]);
    if (gridRef.current) gridRef.current.scrollTop = 0;
    void load(0, id);
  }, [load]);

  // Nekonečné načítání
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(entries => {
      if (!entries[0].isIntersecting || loading) return;
      if (items.length === 0 || items.length >= total) return;
      void load(items.length, reqId.current);
    }, { root: gridRef.current, rootMargin: '300px' });
    io.observe(el);
    return () => io.disconnect();
  }, [load, loading, total, items.length]);

  useEffect(() => { p.onSelectionChange?.(selected, style); }, [selected, style]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedCodes = useMemo(() => new Set(selected.map(s => s.code)), [selected]);

  const toggle = (prod: ProductHit) => {
    setSelected(prev => prev.some(x => x.code === prod.code)
      ? prev.filter(x => x.code !== prod.code)
      : [...prev, prod]);
  };

  const move = (index: number, dir: -1 | 1) => {
    setSelected(prev => {
      const next = [...prev];
      const to = index + dir;
      if (to < 0 || to >= next.length) return prev;
      [next[index], next[to]] = [next[to], next[index]];
      return next;
    });
  };

  const refreshFeed = async () => {
    setRefreshing(true);
    try {
      const st = await api.products.refresh();
      toast(`Katalog aktualizován — ${st.count} produktů.`);
      setFacets(await api.products.facets());
      const id = ++reqId.current;
      setItems([]);
      await load(0, id);
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setRefreshing(false);
    }
  };

  const insert = (list: ProductHit[]) => {
    if (list.length === 0) return;
    p.onInsert(list, style);
  };

  const categories = useMemo(() => {
    const list = facets?.categories ?? [];
    const f = catFilter.trim().toLowerCase();
    return f ? list.filter(c => c.name.toLowerCase().includes(f)) : list;
  }, [facets, catFilter]);

  const previewHtml = useMemo(() => {
    const sample = selected[0] ?? items[0];
    return sample ? productCardHtml(sample, p.lang, p.accent, style) : '';
  }, [selected, items, style, p.lang, p.accent]);

  return (
    <div className="overlay pb-overlay" onMouseDown={e => { if (e.target === e.currentTarget) p.onClose(); }}>
      <div className="product-browser">
        <div className="pb-top">
          <div className="pb-title"><Icon name="bag" size={16} /> Produkty</div>
          <div className="pb-search">
            <Icon name="search" size={14} />
            <input
              autoFocus
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Hledej podle názvu, kódu nebo kategorie…"
            />
            {query && (
              <button className="icon-btn" data-tip="Vymazat hledání" onClick={() => setQuery('')}>
                <Icon name="x" size={12} />
              </button>
            )}
          </div>
          <select value={sort} onChange={e => setSort(e.target.value as any)} className="pb-sort">
            {SORTS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
          <label className="pb-check">
            <input type="checkbox" checked={inStockOnly} onChange={e => setInStockOnly(e.target.checked)} />
            Jen skladem
          </label>
          <button className="icon-btn" data-tip="Znovu stáhnout produktový feed" disabled={refreshing} onClick={refreshFeed}>
            {refreshing ? <span className="spinner-inline" /> : <Icon name="refresh" size={14} />}
          </button>
          <button className="icon-btn" data-tip="Zavřít" onClick={p.onClose}><Icon name="x" size={15} /></button>
        </div>

        <div className="pb-body">
          <aside className="pb-cats">
            <input
              className="pb-cat-filter"
              value={catFilter}
              onChange={e => setCatFilter(e.target.value)}
              placeholder="Filtr kategorií…"
            />
            <button className={`pb-cat ${category === '' ? 'active' : ''}`} onClick={() => setCategory('')}>
              <span>Všechny produkty</span>
              <b>{facets?.total ?? ''}</b>
            </button>
            {categories.map(c => (
              <button key={c.name} className={`pb-cat ${category === c.name ? 'active' : ''}`}
                onClick={() => setCategory(category === c.name ? '' : c.name)}>
                <span>{c.name}</span>
                <b>{c.count}</b>
              </button>
            ))}
            {facets && facets.categories.length === 0 && (
              <div className="pb-hint">Feed neposílá kategorie — po aktualizaci katalogu (ikona ↻) se doplní.</div>
            )}
          </aside>

          <div className="pb-grid-wrap" ref={gridRef}>
            <div className="pb-count">
              {total > 0
                ? <>Nalezeno <b>{total}</b> produktů{category ? <> v kategorii <b>{category}</b></> : null}</>
                : loading ? 'Načítám…' : 'Nic nenalezeno'}
            </div>
            <div className="pb-grid">
              {items.map(prod => {
                const on = selectedCodes.has(prod.code);
                const soldOut = typeof prod.stock === 'number' && prod.stock <= 0;
                return (
                  <div key={prod.code}
                    className={`pb-item ${on ? 'on' : ''}`}
                    onClick={() => toggle(prod)}
                    onDoubleClick={() => insert([prod])}
                    title="Klik = vybrat, dvojklik = rovnou vložit do textu">
                    <div className="pb-thumb">
                      {prod.image
                        ? <img src={prod.image} alt="" loading="lazy" />
                        : <div className="pb-noimg"><Icon name="bag" size={20} /></div>}
                      <span className="pb-mark">{on ? <Icon name="check" size={12} /> : <Icon name="plus" size={12} />}</span>
                    </div>
                    <div className="pb-name">{titleOf(prod, p.lang)}</div>
                    <div className="pb-meta">
                      <span className="pb-price">{priceOf(prod, p.lang)}</span>
                      {soldOut && <span className="pb-tagout">vyprodáno</span>}
                    </div>
                    <div className="pb-code">{prod.code}{prod.category ? ` · ${prod.category}` : ''}</div>
                  </div>
                );
              })}
            </div>
            <div ref={sentinelRef} className="pb-sentinel">
              {loading && <span className="spinner-inline" />}
              {!loading && items.length > 0 && items.length >= total && <span>To je vše ({total})</span>}
            </div>
          </div>

          <aside className="pb-basket">
            <div className="pb-basket-head">
              <span><Icon name="layers" size={13} /> K vložení <b>({selected.length})</b></span>
              {selected.length > 0 && (
                <button className="linkish" onClick={() => setSelected([])}>Vyprázdnit</button>
              )}
            </div>
            <div className="pb-basket-list">
              {selected.length === 0 && (
                <div className="pb-hint">
                  Klikni na produkt vlevo a přidá se sem. Pořadí v tomhle seznamu určuje pořadí ve zprávě.
                </div>
              )}
              {selected.map((prod, i) => (
                <div key={prod.code} className="pb-basket-item">
                  {prod.image ? <img src={prod.image} alt="" /> : <div className="pb-noimg sm"><Icon name="bag" size={13} /></div>}
                  <div className="pc-info">
                    <div className="pc-title">{titleOf(prod, p.lang)}</div>
                    <div className="pc-price">{priceOf(prod, p.lang)}</div>
                  </div>
                  <div className="pb-basket-actions">
                    <button className="icon-btn" data-tip="Nahoru" disabled={i === 0} onClick={() => move(i, -1)}>
                      <Icon name="chevDown" size={12} style={{ transform: 'rotate(180deg)' }} />
                    </button>
                    <button className="icon-btn" data-tip="Dolů" disabled={i === selected.length - 1} onClick={() => move(i, 1)}>
                      <Icon name="chevDown" size={12} />
                    </button>
                    <button className="icon-btn" data-tip="Vložit jen tenhle do textu" onClick={() => insert([prod])}>
                      <Icon name="plus" size={12} />
                    </button>
                    <button className="icon-btn" data-tip="Odebrat z výběru" onClick={() => toggle(prod)}>
                      <Icon name="x" size={12} />
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div className="pb-style">
              <label>Vzhled v e-mailu</label>
              <div className="pb-style-row">
                {STYLES.map(s => (
                  <button key={s} className={`pb-style-btn ${style === s ? 'active' : ''}`} onClick={() => setStyle(s)}>
                    {CARD_STYLE_LABEL[s]}
                  </button>
                ))}
              </div>
              <button className="linkish" onClick={() => setPreviewOpen(v => !v)}>
                {previewOpen ? 'Skrýt náhled' : 'Zobrazit náhled'}
              </button>
              {previewOpen && previewHtml && (
                <div className="pb-preview" dangerouslySetInnerHTML={{ __html: previewHtml }} />
              )}
            </div>
          </aside>
        </div>

        <div className="pb-foot">
          <span className="pb-foot-hint">
            Produkty se vloží do textu tam, kde jsi naposledy psal — mezi ně pak můžeš normálně psát.
          </span>
          <span className="toolbar-spacer" />
          <button className="btn ghost" onClick={p.onClose}>Zavřít</button>
          <button className="btn primary" disabled={selected.length === 0} onClick={() => insert(selected)}>
            Vložit do zprávy{selected.length > 0 ? ` (${selected.length})` : ''}
          </button>
        </div>
      </div>
    </div>
  );
}
