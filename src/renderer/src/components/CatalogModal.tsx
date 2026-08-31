import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ProductHit, ProductDetail, StockinSession, StockinItem, StockinPlanRow, LabelLayout,
  CatalogSuggestion, RollLabel, LabelFormat, ZplPlan
} from '@shared/types';
import { labelGeometry } from '@shared/labels';
import { api } from '../api';
import { useToast } from '../toast';
import { useIsPhone } from '../mobile';
import Icon from './Icon';

/**
 * Katalog, naskladnění a štítky.
 *
 * Tři věci, které spolu drží: katalog říká, co máme a kolik toho je,
 * naskladnění do něj přidává a štítky dělají zboží čitelné pro čtečku. Kdyby
 * to byly tři obrazovky, chodilo by se mezi nimi pořád dokola — proto jsou
 * to záložky nad jedním seznamem produktů.
 *
 * Na telefonu je to totéž, jen na výšku: mřížka po dvou, detail přes celou
 * obrazovku a pole pro čtečku nahoře, kde na něj dosáhne palec.
 */

type Tab = 'catalog' | 'stockin' | 'labels';

function stockLabel(stock: number | null): { text: string; tone: string } {
  if (stock === null) return { text: 'neznámo', tone: 'none' };
  if (stock <= 0) return { text: 'vyprodáno', tone: 'out' };
  if (stock <= 3) return { text: `${stock} ks`, tone: 'low' };
  return { text: `${stock} ks`, tone: 'ok' };
}

function ago(iso: string | null): string {
  if (!iso) return 'nikdy';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 90_000) return 'právě teď';
  if (diff < 3_600_000) return `před ${Math.round(diff / 60_000)} min`;
  if (diff < 86_400_000) return `před ${Math.round(diff / 3_600_000)} h`;
  return new Date(iso).toLocaleDateString('cs-CZ');
}

/** České skloňování po číslovce: 1 strana, 2 strany, 5 stran. */
function plural(n: number, one: string, few: string, many: string): string {
  return `${n} ${n === 1 ? one : n >= 2 && n <= 4 ? few : many}`;
}

export default function CatalogModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const phone = useIsPhone();
  const [tab, setTab] = useState<Tab>('catalog');

  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [inStock, setInStock] = useState(false);
  const [items, setItems] = useState<ProductHit[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [cats, setCats] = useState<{ name: string; count: number }[]>([]);
  const [active, setActive] = useState<ProductDetail | null>(null);
  const [stockAt, setStockAt] = useState<string | null>(null);
  /*
   * Katalog stažený starší verzí varianty nezná — tabulka vznikla prázdná
   * a produkty v ní zůstaly bez délek. Plánovač si o nové stažení řekne sám,
   * ale kdo přijde do katalogu dřív, nemá čekat a koukat na neúplný seznam.
   */
  const [needsFeed, setNeedsFeed] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const page = await api.products.list({
        query, category: category || undefined, inStockOnly: inStock, limit: 60, offset
      });
      setItems(page.items);
      setTotal(page.total);
    } catch (e: any) {
      toast(e.message, 'error');
    }
  }, [query, category, inStock, offset, toast]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setOffset(0); }, [query, category, inStock]);
  useEffect(() => {
    api.products.facets().then(f => setCats(f.categories.slice(0, 24))).catch(() => {});
    api.catalog.stockAt().then(setStockAt).catch(() => {});
    api.products.status()
      .then(st => setNeedsFeed(st.count > 0 && (st.variants ?? 0) === 0))
      .catch(() => {});
  }, []);
  useEffect(() => api.on('products:changed', () => {
    load();
    api.catalog.stockAt().then(setStockAt).catch(() => {});
  }), [load]);

  const openProduct = async (code: string) => {
    try {
      setActive(await api.catalog.detail(code));
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const refreshStock = async () => {
    setBusy(true);
    try {
      const out = await api.catalog.refreshStock();
      setStockAt(out.at);
      toast(`Zásoby aktuální — ${out.products} produktů, ${out.variants} variant.`);
      load();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  /**
   * Vybrat všechno, co odpovídá filtru — ne jen to, co je vidět.
   *
   * Kódy se dotahují z databáze, protože stránka jich drží šedesát. Načtený
   * výběr se s tím dosavadním sloučí: kdo si napřed naklikal pár kusů a pak
   * přidá celou kategorii, o ty první nepřijde.
   */
  const pickAll = async () => {
    setBusy(true);
    try {
      const codes = await api.catalog.codes({
        query, category: category || undefined, inStockOnly: inStock, sort: 'title'
      });
      setPicked(prev => new Set([...prev, ...codes]));
      toast(`Vybráno ${codes.length} produktů.`);
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const toggle = (code: string) => setPicked(prev => {
    const next = new Set(prev);
    if (next.has(code)) next.delete(code); else next.add(code);
    return next;
  });

  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal kat-modal">
        <div className="modal-head">
          <div className="modal-title"><Icon name="bag" size={15} /> Katalog</div>
          <div className="kat-tabs">
            <button className={tab === 'catalog' ? 'on' : ''} onClick={() => setTab('catalog')}>Produkty</button>
            <button className={tab === 'stockin' ? 'on' : ''} onClick={() => setTab('stockin')}>Naskladnění</button>
            {/* Štítky se tisknou do PDF, a to umí jen počítač — na telefonu
                by záložka slibovala něco, co se tam nedá dokončit */}
            {!phone && (
              <button className={tab === 'labels' ? 'on' : ''} onClick={() => setTab('labels')}>
                Štítky{picked.size ? ` (${picked.size})` : ''}
              </button>
            )}
          </div>
          <span style={{ flex: 1 }} />
          <button className="icon-btn" onClick={onClose} aria-label="Zavřít"><Icon name="x" size={16} /></button>
        </div>

        {tab === 'catalog' && (
          <>
            <div className="kat-filters">
              <div className="ig-search">
                <Icon name="search" size={14} />
                <input value={query} onChange={e => setQuery(e.target.value)}
                  placeholder="Název, kód nebo EAN" />
              </div>
              <select value={category} onChange={e => setCategory(e.target.value)}>
                <option value="">všechny kategorie</option>
                {cats.map(c => <option key={c.name} value={c.name}>{c.name} ({c.count})</option>)}
              </select>
              <label className="kat-check">
                <input type="checkbox" checked={inStock} onChange={e => setInStock(e.target.checked)} />
                jen skladem
              </label>
              <span style={{ flex: 1 }} />
              {/* Kdy naposledy dorazila zásoba — u katalogu je to ta nejdůležitější
                  informace na obrazovce, protože podle ní se slibuje zákazníkovi */}
              <button className="btn ghost" onClick={refreshStock} disabled={busy}
                data-tip="Stáhne rychlý feed jen se zásobami a cenami">
                <Icon name="refresh" size={13} /> Zásoby: {ago(stockAt)}
              </button>
            </div>

            <div className="modal-body kat-body">
              {needsFeed && (
                <div className="kat-note">
                  <div>
                    <b>Katalog nezná varianty.</b>
                    <div className="ig-muted">
                      Stáhl se starší verzí aplikace, která délky a velikosti neukládala.
                      Jedno stažení to spraví — jinak si o něj aplikace řekne sama do dvaceti hodin.
                    </div>
                  </div>
                  <button className="btn primary" disabled={busy} onClick={async () => {
                    setBusy(true);
                    try {
                      const st = await api.products.refresh();
                      setNeedsFeed((st.variants ?? 0) === 0);
                      toast(`Katalog stažen — ${st.count} produktů, ${st.variants ?? 0} variant.`);
                      load();
                    } catch (e: any) {
                      toast(e.message, 'error');
                    } finally { setBusy(false); }
                  }}>
                    <Icon name="refresh" size={13} /> {busy ? 'Stahuji…' : 'Stáhnout katalog'}
                  </button>
                </div>
              )}
              <div className="kat-grid">
                {items.map(p => {
                  const s = stockLabel(p.stock ?? null);
                  return (
                    <div key={p.code} className={`kat-card ${picked.has(p.code) ? 'picked' : ''}`}>
                      <button className="kat-open" onClick={() => openProduct(p.code)}>
                        <div className="kat-img">
                          {p.image ? <img src={p.image} alt="" loading="lazy" />
                            : <span className="kat-ph"><Icon name="image" size={20} /></span>}
                          <span className={`kat-stock ${s.tone}`}>{s.text}</span>
                        </div>
                        <div className="kat-name">{p.title.cz || p.title.en || p.code}</div>
                        <div className="kat-meta">
                          <span className="kat-code">{p.code}</span>
                          <span>{p.price.cz}</span>
                        </div>
                      </button>
                      {!phone && (
                        <label className="kat-pick">
                          <input type="checkbox" checked={picked.has(p.code)} onChange={() => toggle(p.code)} />
                          na štítky
                        </label>
                      )}
                    </div>
                  );
                })}
                {items.length === 0 && (
                  <div className="empty-state"><div className="big">📦</div><p>Nic neodpovídá hledání.</p></div>
                )}
              </div>
            </div>

            <div className="modal-foot">
              <span className="ig-muted">
                {total} produktů{picked.size > 0 ? ` · vybráno ${picked.size}` : ''}
              </span>
              <span style={{ flex: 1 }} />
              {/*
                * Štítky se tisknou po kategoriích, ne po jednom. Stránka jich
                * ukazuje šedesát, filtr jich může mít stovky — obojí musí jít
                * vybrat jedním klepnutím.
                */}
              {!phone && (
                <>
                  <button className="btn ghost" onClick={() =>
                    setPicked(prev => new Set([...prev, ...items.map(one => one.code)]))}>
                    Vybrat stránku
                  </button>
                  <button className="btn ghost" disabled={busy || total === 0} onClick={pickAll}>
                    Vybrat vše ({total})
                  </button>
                  {picked.size > 0 && (
                    <button className="btn ghost" onClick={() => setPicked(new Set())}>Zrušit výběr</button>
                  )}
                </>
              )}
              <button className="btn ghost" disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - 60))}>Předchozí</button>
              <button className="btn ghost" disabled={offset + 60 >= total}
                onClick={() => setOffset(offset + 60)}>Další</button>
            </div>
          </>
        )}

        {tab === 'stockin' && <Stockin phone={phone} />}
        {tab === 'labels' && !phone && <Labels codes={[...picked]} onClear={() => setPicked(new Set())} />}

        {active && (
          <ProductSheet
            detail={active}
            picked={picked.has(active.code)}
            onPick={phone ? null : () => toggle(active.code)}
            onClose={() => setActive(null)}
          />
        )}
      </div>
    </div>
  );
}

/* ---------- detail produktu s variantami ---------- */

function ProductSheet({ detail, picked, onPick, onClose }: {
  detail: ProductDetail;
  picked: boolean;
  /** Na telefonu se štítky netisknou, takže tam výběr nedává smysl */
  onPick: (() => void) | null;
  onClose: () => void;
}) {
  return (
    <div className="kat-sheet" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="kat-sheet-in">
        <div className="kat-sheet-head">
          <b>{detail.title.cz || detail.code}</b>
          <button className="icon-btn" onClick={onClose}><Icon name="x" size={16} /></button>
        </div>
        <div className="kat-sheet-body">
          <div className="kat-sheet-top">
            {detail.image
              ? <img src={detail.image} alt="" />
              : <span className="kat-ph big"><Icon name="image" size={28} /></span>}
            <div>
              <div className="kat-kv"><span>Kód</span><b>{detail.code}</b></div>
              {detail.ean && <div className="kat-kv"><span>EAN</span><b>{detail.ean}</b></div>}
              <div className="kat-kv"><span>Cena</span><b>{detail.price.cz}</b></div>
              <div className="kat-kv"><span>Dostupnost</span><b>{detail.availability || '—'}</b></div>
              <div className="kat-kv"><span>Sklad</span><b>{detail.stock ?? '—'} ks</b></div>
              <div className="kat-kv"><span>Kategorie</span><b>{detail.category || '—'}</b></div>
              <div className="ig-muted kat-when">Zásoba z feedu {ago(detail.stockAt)}</div>
            </div>
          </div>

          {detail.variants.length > 0 && (
            <>
              <h4>Varianty</h4>
              <div className="kat-vars">
                {detail.variants.map(v => {
                  const s = stockLabel(v.stock);
                  return (
                    <div key={v.code} className="kat-var">
                      <div className="kat-var-main">
                        <b>{v.label || v.code}</b>
                        <span className="kat-code">{v.code}</span>
                      </div>
                      <span>{v.price}</span>
                      <span className={`kat-stock ${s.tone}`}>{s.text}</span>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          <div className="kat-links">
            {/* Štítky se vybírají i odsud — kdo si produkt otevřel, aby se
                podíval na varianty, ho nemá zavírat jen kvůli zaškrtnutí */}
            {onPick && (
              <button className={`btn ${picked ? 'primary' : 'ghost'}`} onClick={onPick}>
                <Icon name={picked ? 'check' : 'printer'} size={13} />
                {picked ? 'Vybráno na štítky' : 'Na štítky'}
              </button>
            )}
            {detail.url.cz && (
              <button className="btn ghost" onClick={() => api.shell.openUrl(detail.url.cz)}>
                <Icon name="globe" size={13} /> Otevřít v e-shopu
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- naskladnění ---------- */

function Stockin({ phone }: { phone: boolean }) {
  const toast = useToast();
  const [sessions, setSessions] = useState<StockinSession[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [items, setItems] = useState<StockinItem[]>([]);
  const [scan, setScan] = useState('');
  const [qty, setQty] = useState(1);
  /*
   * Napovídání podle názvu. Štítek občas chybí nebo je nečitelný a psát kód
   * po paměti je sázka do loterie — „kšandy modré" člověk napíše bez váhání.
   */
  const [hits, setHits] = useState<CatalogSuggestion[]>([]);
  const [openVariants, setOpenVariants] = useState('');
  /** Běží čtení kódů fotoaparátem (jen v aplikaci na telefonu) */
  const [camera, setCamera] = useState(false);
  const [hasCamera, setHasCamera] = useState(false);
  /** Počet pro další načtení; hledáček ho mění mimo React, proto odkaz */
  const qtyRef = useRef(1);
  const [plan, setPlan] = useState<StockinPlanRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  /*
   * Po vložení do administrace se čeká na člověka: ukládá tam on. Dokud
   * nepotvrdí, zůstává naskladnění rozpracované — jinak by se stav aplikace
   * rozešel se stavem e-shopu při první zavřené záložce.
   */
  const [awaiting, setAwaiting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const loadList = useCallback(() => {
    api.stockin.list().then(setSessions).catch(() => {});
  }, []);
  const loadItems = useCallback((id: string) => {
    api.stockin.open(id).then(r => setItems(r.items)).catch(() => {});
  }, []);

  useEffect(() => { loadList(); }, [loadList]);
  useEffect(() => { if (openId) loadItems(openId); }, [openId, loadItems]);
  useEffect(() => api.on('stockin:changed', () => {
    loadList();
    if (openId) loadItems(openId);
  }), [loadList, loadItems, openId]);
  useEffect(() => api.on('stockin:progress', (p: any) => setProgress(p)), []);

  const session = sessions.find(s => s.id === openId) ?? null;

  const create = async () => {
    try {
      const s = await api.stockin.create();
      /*
       * Nové naskladnění se přidá do seznamu rovnou tady, ne až se seznam
       * natáhne z databáze. Bez toho `openId` ukazovalo na řádek, o kterém
       * rozhraní ještě nevědělo, a místo prázdného naskladnění se ukázal
       * zase seznam — vypadalo to, že se tlačítko neudělalo nic.
       */
      setSessions(prev => [s, ...prev]);
      setOpenId(s.id);
      setTimeout(() => input.current?.focus(), 50);
    } catch (e: any) { toast(e.message, 'error'); }
  };

  /*
   * Načtení kódu. Čtečka se chová jako klávesnice: napíše kód a stiskne
   * Enter — proto stačí obyčejné pole a odeslání na Enter. Po každém načtení
   * se pole vyprázdní a nechá si zaměření, aby šlo pípat jeden kus za druhým.
   */
  const submitScan = async (raw: string, count = qty): Promise<boolean> => {
    const id = openId;
    if (!id || !raw.trim()) return false;
    try {
      const out = await api.stockin.scan(id, raw.trim(), count);
      if (out.added) {
        setScan('');
        setHits([]);
        setOpenVariants('');
        loadItems(id);
        input.current?.focus();
        return true;
      }
      /*
       * Neznámý kód se nezahazuje hláškou. Ve chvíli, kdy štítek nesedí,
       * je nejbližší užitečná věc nabídnout, co se tomu podobá — proto se
       * z nenalezeného kódu rovnou stane hledání podle názvu.
       */
      const found = await api.catalog.suggest(raw.trim());
      setHits(found);
      if (found.length === 0) toast(`„${out.unknown}" v katalogu není.`, 'error');
      return false;
    } catch (e: any) {
      toast(e.message, 'error');
      return false;
    }
  };

  /* ---------- napovídání podle názvu ---------- */

  useEffect(() => {
    const text = scan.trim();
    if (text.length < 2) { setHits([]); return; }
    // Chvilka klidu, ať se nehledá po každém písmenu
    const timer = setTimeout(() => {
      api.catalog.suggest(text).then(setHits).catch(() => {});
    }, 220);
    return () => clearTimeout(timer);
  }, [scan]);

  /* ---------- čtečka fotoaparátem ---------- */

  useEffect(() => { api.scan.available().then(setHasCamera).catch(() => setHasCamera(false)); }, []);

  /*
   * Hledáček zůstane otevřený a kódy chodí po jednom. Na každý se odpoví
   * větou, která se ukáže rovnou v hledáčku — kdo drží telefon nad krabicí,
   * se nedívá na obrazovku pod ním.
   *
   * Počítadlo „− 6 +" v hledáčku říká, **kolik kusů přidá další načtení**.
   * V krabici je šest kusů, ale pípne se jednou; nastavit to předem je
   * rychlejší než po každém pípnutí opravovat řádek v seznamu pod tím.
   */
  useEffect(() => {
    if (!camera || !openId) return;

    const off = api.on('scan:code', async (payload: any) => {
      const text = String(payload?.text ?? '').trim();
      if (!text) return;
      const found = await api.catalog.scan(text).catch(() => null);
      if (!found) {
        api.scan.feedback(`Kód ${text} v katalogu není`, false);
        return;
      }
      const out = await api.stockin.scan(openId, text, qtyRef.current).catch(() => null);
      if (!out?.added) {
        api.scan.feedback('Nepodařilo se přidat', false);
        return;
      }
      api.scan.feedback(
        `${found.title}${found.label ? ` · ${found.label}` : ''}`
        + ` — +${qtyRef.current}, celkem ${out.item?.qty ?? qtyRef.current} ks`, true
      );
      loadItems(openId);
    });

    /*
     * Držení tlačítka posílá zprávy osmkrát za vteřinu. Počítá se proto
     * z odkazu, ne ze stavu Reactu — dvě zprávy těsně za sebou by jinak
     * vyšly ze stejného čísla a jeden krok by se ztratil.
     */
    const offQty = api.on('scan:qty', (payload: any) => {
      const next = Math.max(1, qtyRef.current + (Number(payload?.delta) || 0));
      if (next === qtyRef.current) return;
      qtyRef.current = next;
      setQty(next);
      api.scan.count(next);
    });

    const offClosed = api.on('scan:closed', () => setCamera(false));
    return () => { off(); offQty(); offClosed(); };
  }, [camera, openId, loadItems]);

  const toggleCamera = async () => {
    if (camera) { await api.scan.stop().catch(() => {}); setCamera(false); return; }
    try {
      await api.scan.start();
      // Počítadlo v hledáčku musí od začátku ukazovat, kolik se přidá
      qtyRef.current = qty;
      api.scan.count(qty);
      setCamera(true);
    } catch (e: any) { toast(e.message, 'error'); }
  };

  const send = async () => {
    if (!openId) return;
    setBusy(true);
    try {
      const out = await api.stockin.sendWindow(openId);
      if (out.needsLogin) {
        toast('Přihlas se v okně administrace a spusť odeslání znovu.', 'error');
      } else {
        toast(out.skipped.length
          ? `Vloženo ${out.added} položek, ${out.skipped.length} se nepodařilo — dodej je v okně ručně.`
          : `Vloženo ${out.added} položek. Zkontroluj je v okně a ulož.`,
          out.skipped.length ? 'error' : 'info');
        if (out.added > 0) setAwaiting(true);
      }
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  if (!openId || !session) {
    return (
      <div className="modal-body kat-body">
        <button className="btn primary" style={{ alignSelf: 'flex-start' }} onClick={create}>
          <Icon name="plus" size={13} /> Nové naskladnění
        </button>

        <div className="kat-sessions">
          {sessions.map(s => (
            <div key={s.id} className="kat-session">
              <button className="kat-session-open" onClick={() => setOpenId(s.id)}>
                <b>{s.title}</b>
                <div className="ig-muted">
                  {plural(s.lines, 'položka', 'položky', 'položek')} · {s.pieces} ks
                  {' · '}{s.device} · {ago(s.updatedAt)}
                </div>
              </button>
              {s.state === 'sent'
                ? <span className="kat-badge done">zapsáno</span>
                : <span className="kat-badge">rozpracované</span>}
            </div>
          ))}
          {sessions.length === 0 && (
            <div className="ig-muted" style={{ fontSize: 12 }}>Zatím žádné naskladnění.</div>
          )}
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="kat-title">
        <button className="icon-btn" onClick={() => { setOpenId(null); setPlan(null); setAwaiting(false); }}
          aria-label="Zpět na seznam naskladnění">
          <Icon name="chevLeft" size={16} />
        </button>
        {/* Název se přepisuje rovnou — „Naskladnění 30. 8." je dobrý začátek,
            ale u třetí krabice ten den už neřekne nic */}
        <input
          className="kat-title-in"
          defaultValue={session.title}
          key={session.id}
          onBlur={e => {
            const value = e.target.value.trim();
            if (value && value !== session.title) api.stockin.rename(openId, value);
          }}
        />
        {session.state === 'sent' && <span className="kat-badge done">zapsáno</span>}
        <button className={`btn ${confirmDelete ? 'danger' : 'ghost'}`}
          onClick={async () => {
            if (!confirmDelete) { setConfirmDelete(true); return; }
            await api.stockin.remove(openId);
            setOpenId(null);
            setConfirmDelete(false);
          }}>
          {confirmDelete ? 'Opravdu smazat?' : 'Smazat'}
        </button>
      </div>

      <div className="kat-scanbar">
        <input
          ref={input}
          className="kat-scan"
          value={scan}
          autoFocus
          placeholder="Načti kód čtečkou nebo piš kód, EAN i název"
          onChange={e => setScan(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') submitScan(scan); }}
        />
        <label className="kat-qty">
          ks
          {/* `inputMode` vytáhne na telefonu číselnou klávesnici — jinak se
              počet ťuká na písmenkové, nebo se mačká plus dvacetkrát */}
          <input type="number" inputMode="numeric" min={1} value={qty}
            onFocus={e => e.target.select()}
            onChange={e => {
              const next = Math.max(1, Number(e.target.value) || 1);
              qtyRef.current = next;
              setQty(next);
              if (camera) api.scan.count(next);
            }} />
        </label>
        {hasCamera && (
          <button className={`btn ${camera ? 'primary' : 'ghost'}`} onClick={toggleCamera}
            data-tip="Čte QR i čárové kódy fotoaparátem, jeden kus za druhým">
            <Icon name="search" size={14} /> {camera ? 'Skenuji…' : 'Skenovat'}
          </button>
        )}
        <button className="btn ghost" onClick={() => submitScan(scan)}>Přidat</button>
      </div>

      {/*
        * Nabídka podle názvu. U produktu s variantami se nepřidává produkt —
        * naskladňuje se konkrétní délka, tak se rozbalí varianty a vybere se.
        */}
      {hits.length > 0 && (
        <div className="kat-hits">
          {hits.map(hit => (
            <div key={hit.code} className="kat-hit">
              <button className="kat-hit-main" onClick={() => {
                if (hit.variants.length === 0) submitScan(hit.code);
                else setOpenVariants(openVariants === hit.code ? '' : hit.code);
              }}>
                {hit.image
                  ? <img src={hit.image} alt="" loading="lazy" />
                  : <span className="kat-ph"><Icon name="image" size={16} /></span>}
                <span className="kat-hit-text">
                  <b>{hit.title}</b>
                  <small>
                    {hit.code}
                    {hit.variants.length > 0
                      ? ` · ${plural(hit.variants.length, 'varianta', 'varianty', 'variant')}`
                      : hit.stock !== null ? ` · skladem ${hit.stock}` : ''}
                  </small>
                </span>
                {hit.variants.length > 0 && <Icon name="chevDown" size={13} />}
              </button>
              {openVariants === hit.code && (
                <div className="kat-hit-vars">
                  {hit.variants.map(v => (
                    <button key={v.code} onClick={() => submitScan(v.code)}>
                      <b>{v.label || v.code}</b>
                      <span className="kat-code">{v.code}</span>
                      <span className={`kat-stock ${stockLabel(v.stock).tone}`}>
                        {stockLabel(v.stock).text}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="modal-body kat-body">
        {/*
          * Poslední krok dělá člověk v administraci. Aplikace se ho proto
          * musí zeptat, jak to dopadlo — sama to neví a tvářit se, že ano,
          * by znamenalo mít naskladnění za zapsané i po zavření okna bez uložení.
          */}
        {awaiting && session.state === 'open' && (
          <div className="kat-confirm">
            <div>
              <b>Položky jsou v naskladňování v Upgates.</b>
              <div className="ig-muted">
                Zkontroluj je tam a ulož. Teprve pak se naskladnění označí za zapsané —
                aby se stejné zboží nenaskladnilo podruhé.
              </div>
            </div>
            <button className="btn primary" onClick={async () => {
              await api.stockin.confirm(openId);
              setAwaiting(false);
              toast('Naskladnění je zapsané.');
            }}>
              <Icon name="check" size={13} /> Uložil jsem to
            </button>
            <button className="btn ghost" onClick={() => setAwaiting(false)}>Ještě ne</button>
          </div>
        )}
        {items.length === 0 && (
          <div className="empty-state"><div className="big">📥</div><p>Zatím prázdná — načti první kód.</p></div>
        )}
        {items.map(item => (
          <div key={item.code} className="kat-line">
            <div className="kat-line-main">
              <b>{item.title}</b>
              <div className="ig-muted">
                {item.code}{item.label ? ` · ${item.label}` : ''}
                {item.stockBefore !== null ? ` · skladem bylo ${item.stockBefore}` : ''}
              </div>
            </div>
            {/*
              * Počet se dá přepsat, ne jen naklikat: u dvaceti kusů je mačkání
              * plus dvacetkrát trest, ne ovládání.
              *
              * Pole je záměrně neřízené (`defaultValue` a klíč podle počtu):
              * každá změna naskladnění překreslí seznam a řízené pole by při
              * psaní přepisovalo samo sebe zpátky na uloženou hodnotu.
              */}
            <div className="kat-line-qty">
              <button onClick={() => api.stockin.qty(openId, item.code, item.qty - 1)}
                aria-label="O kus méně">−</button>
              <input
                key={`${item.code}:${item.qty}`}
                type="number"
                inputMode="numeric"
                min={0}
                defaultValue={item.qty}
                onFocus={e => e.target.select()}
                onBlur={e => {
                  const value = Math.max(0, Math.round(Number(e.target.value) || 0));
                  if (value !== item.qty) api.stockin.qty(openId, item.code, value);
                }}
                onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              />
              <button onClick={() => api.stockin.qty(openId, item.code, item.qty + 1)}
                aria-label="O kus víc">+</button>
            </div>
          </div>
        ))}

        {plan && (
          <div className="kat-plan">
            <h4>Co se zapíše</h4>
            {plan.map(row => (
              <div key={row.code} className={`kat-plan-row ${row.moved ? 'moved' : ''}`}>
                <span>{row.title}{row.label ? ` · ${row.label}` : ''}</span>
                <span className="kat-code">{row.code}</span>
                {/* Bez vnitřního čísla z feedu se řádek zapsat nedá — slibovat
                    u něj novou zásobu by bylo zavádějící */}
                {row.productId ? (
                  <span>
                    {row.stockNow ?? '—'} → <b>{(row.stockNow ?? 0) + row.qty}</b>
                    {row.moved && <small> (zásoba se mezitím změnila)</small>}
                  </span>
                ) : (
                  <span className="ig-muted">{row.qty} ks · ručně</span>
                )}
                {!row.productId && <span className="kat-badge warn">chybí ve feedu</span>}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="modal-foot">
        <span className="ig-muted">
          {plural(items.length, 'položka', 'položky', 'položek')}
          {' · '}{items.reduce((sum, i) => sum + i.qty, 0)} ks
          {progress ? ` · vkládám ${progress.done}/${progress.total}` : ''}
        </span>
        <span style={{ flex: 1 }} />
        <button className="btn ghost" onClick={() => api.stockin.plan(openId).then(setPlan)}>
          Zkontrolovat
        </button>
        {!phone && (
          <button className="btn primary" onClick={send} disabled={busy || items.length === 0}>
            <Icon name="upload" size={13} /> {busy ? 'Vkládám…' : 'Vložit do Upgates'}
          </button>
        )}

      </div>
    </>
  );
}

/* ---------- štítky ---------- */

const LAYOUT_KEY = 'quentino-labels';

const BASE_LAYOUT: LabelLayout = {
  cols: 4, rows: 8, marginTop: 10, marginSide: 8, gap: 3,
  qr: 18, fontSize: 9, withTitle: true, cutLines: false
};

/**
 * Rozvržení se pamatuje.
 *
 * Kdo tiskne štítky, tiskne je na jeden druh archů pořád dokola — a přenastavovat
 * sedm čísel při každém tisku by bylo trestání za to, že papír zůstal stejný.
 */
function savedLayout(): LabelLayout {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    return raw ? { ...BASE_LAYOUT, ...JSON.parse(raw) } : BASE_LAYOUT;
  } catch {
    return BASE_LAYOUT;
  }
}

const ROLL_KEY = 'quentino-labels-roll';

const BASE_ROLL: RollLabel = {
  widthMm: 50, heightMm: 30, dpi: 203, qrMm: 18, textMm: 3.5, withTitle: false
};

function savedRoll(): RollLabel {
  try {
    const raw = localStorage.getItem(ROLL_KEY);
    return raw ? { ...BASE_ROLL, ...JSON.parse(raw) } : BASE_ROLL;
  } catch {
    return BASE_ROLL;
  }
}

function Labels({ codes, onClear }: { codes: string[]; onClear: () => void }) {
  const toast = useToast();
  const [layout, setLayout] = useState<LabelLayout>(savedLayout);
  /*
   * Do čeho se tiskne.
   *
   * A4 je archy do obyčejné tiskárny. Zebra rozumí ZPL a dostane hotový
   * soubor. Brother univerzální textový jazyk nemá — každá řada se ovládá
   * jiným binárním protokolem — takže se pro něj vyváží CSV, které si
   * P-touch Editor naslučuje do vlastní šablony. Stejně to bere
   * i ZebraDesigner.
   */
  const [format, setFormat] = useState<LabelFormat>('pdf');
  const [roll, setRoll] = useState<RollLabel>(savedRoll);
  const [plan, setPlan] = useState<ZplPlan | null>(null);
  const [perItem, setPerItem] = useState(1);
  const [items, setItems] = useState<{ code: string; title: string; label: string; count: number }[]>([]);
  const [html, setHtml] = useState('');

  useEffect(() => {
    if (codes.length === 0) { setItems([]); return; }
    api.catalog.labelItems(codes, perItem).then(setItems).catch(() => {});
  }, [codes, perItem]);

  useEffect(() => {
    if (items.length === 0) { setHtml(''); return; }
    api.catalog.labelPreview(items, layout).then(setHtml).catch(() => {});
  }, [items, layout]);

  useEffect(() => {
    if (format !== 'zpl') return;
    api.catalog.rollPlan(roll).then(setPlan).catch(() => setPlan(null));
  }, [format, roll]);

  const geom = labelGeometry(layout);

  const setRollValue = (patch: Partial<RollLabel>) => setRoll(prev => {
    const next = { ...prev, ...patch };
    try { localStorage.setItem(ROLL_KEY, JSON.stringify(next)); } catch { /* nevadí */ }
    return next;
  });

  const set = (patch: Partial<LabelLayout>) => setLayout(prev => {
    const next = { ...prev, ...patch };
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(next)); } catch { /* nevadí */ }
    return next;
  });
  const perPage = Math.max(1, geom.perPage);
  const totalLabels = items.reduce((sum, one) => sum + one.count, 0);

  const print = async () => {
    try {
      if (format === 'pdf') {
        const out = await api.catalog.labelPdf(items, layout);
        if (out) {
          toast(`Uloženo: ${plural(out.labels, 'štítek', 'štítky', 'štítků')} na `
            + plural(out.pages, 'straně', 'stranách', 'stranách') + '.');
        }
        return;
      }
      const out = await api.catalog.exportLabels(format, items, roll);
      if (out) toast(`Uloženo: ${plural(out.labels, 'štítek', 'štítky', 'štítků')}.`);
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const num = (label: string, key: keyof LabelLayout, min: number, max: number, unit = '') => (
    <label className="kat-num">
      <span>{label}</span>
      <input type="number" min={min} max={max} value={layout[key] as number}
        onChange={e => set({ [key]: Math.min(max, Math.max(min, Number(e.target.value) || min)) } as any)} />
      {unit && <small>{unit}</small>}
    </label>
  );

  return (
    <>
      <div className="modal-body kat-body kat-labels">
        {codes.length === 0 ? (
          <div className="empty-state">
            <div className="big">🏷️</div>
            <p>Vyber produkty v záložce Produkty — zaškrtnutím „na štítky".</p>
            <p className="ig-muted">
              U produktů s variantami se vytiskne štítek pro každou variantu zvlášť;
              naskladňuje se konkrétní velikost, ne „kšandy".
            </p>
          </div>
        ) : (
          <>
            <div className="kat-formats">
              <button className={format === 'pdf' ? 'on' : ''} onClick={() => setFormat('pdf')}>
                <b>Archy A4</b><small>obyčejná tiskárna, PDF</small>
              </button>
              <button className={format === 'zpl' ? 'on' : ''} onClick={() => setFormat('zpl')}>
                <b>Zebra (ZPL)</b><small>soubor rovnou na tiskárnu</small>
              </button>
              <button className={format === 'csv' ? 'on' : ''} onClick={() => setFormat('csv')}>
                <b>CSV do šablony</b><small>Brother P-touch, ZebraDesigner</small>
              </button>
            </div>

            {format === 'pdf' && (
              <>
                <div className="kat-label-form">
                  {num('Sloupců', 'cols', 1, 8)}
                  {num('Řádků', 'rows', 1, 14)}
                  {num('QR', 'qr', 8, 60, 'mm')}
                  {num('Mezera', 'gap', 0, 20, 'mm')}
                  {num('Okraj shora', 'marginTop', 0, 30, 'mm')}
                  {num('Okraj po stranách', 'marginSide', 0, 30, 'mm')}
                  {num('Písmo', 'fontSize', 5, 16, 'pt')}
                  <label className="kat-num">
                    <span>Kusů na produkt</span>
                    <input type="number" min={1} max={50} value={perItem}
                      onChange={e => setPerItem(Math.max(1, Number(e.target.value) || 1))} />
                  </label>
                  <label className="kat-check">
                    <input type="checkbox" checked={layout.withTitle}
                      onChange={e => set({ withTitle: e.target.checked })} />
                    psát i název
                  </label>
                  <label className="kat-check">
                    <input type="checkbox" checked={layout.cutLines}
                      onChange={e => set({ cutLines: e.target.checked })} />
                    linky na střih
                  </label>
                </div>

                {/*
                  * Rozměr štítku se počítá dopředu a říká se nahlas. Do políčka
                  * 46 × 25 mm se QR o 22 mm i s kódem a názvem nevejde — dřív se
                  * to prostě ořízlo a přišlo se na to až po vytištění archu.
                  */}
                <div className={`kat-fit ${geom.tooSmall ? 'bad' : geom.shrunk ? 'warn' : ''}`}>
                  <b>Štítek {geom.cellW} × {geom.cellH} mm</b>
                  <span>· {perPage} na stránku</span>
                  {geom.tooSmall && (
                    <span>· QR vyšlo na {geom.qr} mm — na to čtečka nestačí.
                      Uber řádky nebo sloupce, případně vypni název.</span>
                  )}
                  {!geom.tooSmall && geom.shrunk && (
                    <span>· QR se zmenšilo na {geom.qr} mm, aby se vešlo i s textem.</span>
                  )}
                </div>
              </>
            )}

            {format === 'zpl' && (
              <>
                <div className="kat-label-form">
                  <label className="kat-num">
                    <span>Šířka štítku</span>
                    <input type="number" min={15} max={150} value={roll.widthMm}
                      onChange={e => setRollValue({ widthMm: Math.max(15, Number(e.target.value) || 15) })} />
                    <small>mm</small>
                  </label>
                  <label className="kat-num">
                    <span>Výška štítku</span>
                    <input type="number" min={10} max={150} value={roll.heightMm}
                      onChange={e => setRollValue({ heightMm: Math.max(10, Number(e.target.value) || 10) })} />
                    <small>mm</small>
                  </label>
                  <label className="kat-num">
                    <span>Rozlišení</span>
                    <select value={roll.dpi}
                      onChange={e => setRollValue({ dpi: Number(e.target.value) === 300 ? 300 : 203 })}>
                      <option value={203}>203 dpi</option>
                      <option value={300}>300 dpi</option>
                    </select>
                  </label>
                  <label className="kat-num">
                    <span>QR</span>
                    <input type="number" min={8} max={60} value={roll.qrMm}
                      onChange={e => setRollValue({ qrMm: Math.max(8, Number(e.target.value) || 8) })} />
                    <small>mm</small>
                  </label>
                  <label className="kat-num">
                    <span>Písmo</span>
                    <input type="number" min={2} max={10} step={0.5} value={roll.textMm}
                      onChange={e => setRollValue({ textMm: Math.max(2, Number(e.target.value) || 2) })} />
                    <small>mm</small>
                  </label>
                  <label className="kat-num">
                    <span>Kusů na produkt</span>
                    <input type="number" min={1} max={50} value={perItem}
                      onChange={e => setPerItem(Math.max(1, Number(e.target.value) || 1))} />
                  </label>
                  <label className="kat-check">
                    <input type="checkbox" checked={roll.withTitle}
                      onChange={e => setRollValue({ withTitle: e.target.checked })} />
                    psát i název
                  </label>
                </div>

                {plan && (
                  <div className={`kat-fit ${plan.tooSmall ? 'bad' : plan.shrunk ? 'warn' : ''}`}>
                    <b>QR {plan.qrMm} mm</b>
                    <span>· {plan.widthDots} × {plan.heightDots} bodů při {roll.dpi} dpi</span>
                    {plan.tooSmall && (
                      <span>· na to čtečka nestačí. Vezmi větší štítek, zmenši písmo
                        nebo vypni název.</span>
                    )}
                    {!plan.tooSmall && plan.shrunk && (
                      <span>· zmenšeno, aby zbylo místo na text. ZPL neškáluje po
                        milimetrech, ale po celých bodech mřížky.</span>
                    )}
                  </div>
                )}

                <div className="kat-note">
                  <div>
                    <b>Soubor jde na tiskárnu, jak je.</b>
                    <div className="ig-muted">
                      Uložený <code>.zpl</code> se pošle na Zebru přímo — přes její webové rozhraní,
                      sdílenou tiskárnu, nebo z terminálu <code>lpr -o raw</code>. Nic se
                      nepřevádí, takže co je v souboru, to se vytiskne.
                    </div>
                  </div>
                </div>
              </>
            )}

            {format === 'csv' && (
              <>
                <div className="kat-label-form">
                  <label className="kat-num">
                    <span>Kusů na produkt</span>
                    <input type="number" min={1} max={50} value={perItem}
                      onChange={e => setPerItem(Math.max(1, Number(e.target.value) || 1))} />
                  </label>
                </div>
                <div className="kat-note">
                  <div>
                    <b>Pro Brother a pro vlastní šablony.</b>
                    <div className="ig-muted">
                      Brother nemá jazyk, který by šel poslat na tiskárnu jako text —
                      P-touch i QL se ovládají binárně a u každé řady jinak. Obvyklá
                      cesta je proto nakreslit si štítek jednou v P-touch Editoru
                      a data do něj naslučovat z tabulky. Tohle CSV je přesně na to:
                      sloupce <code>kod</code>, <code>nazev</code>, <code>varianta</code>,
                      <code> pocet</code>. Stejně ho vezme i ZebraDesigner.
                    </div>
                  </div>
                </div>
              </>
            )}

            {/* Náhled je tentýž dokument, jaký půjde do PDF — ne přiblížení
                ani schéma. Co je vidět, to se vytiskne. Rolové formáty náhled
                nemají: štítek vysází tiskárna, ne my, a nakreslený obrázek by
                sliboval přesnost, kterou nemáme jak zaručit. */}
            {format === 'pdf' && (
              <div className="kat-preview">
                <iframe title="Náhled štítků" srcDoc={html} />
              </div>
            )}
          </>
        )}
      </div>

      <div className="modal-foot">
        <span className="ig-muted">
          {codes.length === 0 ? 'Nic není vybráno'
            : format === 'pdf'
              ? `${plural(totalLabels, 'štítek', 'štítky', 'štítků')} · ${perPage} na stránku · `
                + plural(Math.ceil(totalLabels / perPage), 'strana', 'strany', 'stran')
              : `${plural(totalLabels, 'štítek', 'štítky', 'štítků')} `
                + `z ${plural(codes.length, 'produktu', 'produktů', 'produktů')}`}
        </span>
        <span style={{ flex: 1 }} />
        {codes.length > 0 && <button className="btn ghost" onClick={onClear}>Zrušit výběr</button>}
        <button className="btn primary" onClick={print} disabled={items.length === 0}>
          <Icon name="download" size={13} />
          {format === 'pdf' ? 'Uložit PDF' : format === 'zpl' ? 'Uložit ZPL' : 'Uložit CSV'}
        </button>
      </div>
    </>
  );
}
