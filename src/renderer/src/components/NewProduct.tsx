import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import Icon from './Icon';
import HtmlField from './HtmlField';
import { uploadToShop, pickForArticle } from '../shopfiles';
import type {
  NewProductState, NewProductDraft, NewProductSpecific, NewProductChange,
  NewProductGap, NewProductTexts, ShopCategoryTree, PtransProduct,
  ParamDictionary, ParamLookup
} from '@shared/types';

/**
 * Nový produkt.
 *
 * Vědomě to **není průvodce po krocích**. Nový produkt se nevyplňuje odshora
 * dolů: člověk vybere předlohu, přepíše barvu, vzpomene si na parametr, vrátí
 * se k názvu. Průvodce by ho nutil chodit dopředu a dozadu a pořád by nebylo
 * vidět, co ještě chybí.
 *
 * Proto je vlevo seznam „co ještě chybí" — je vidět celou dobu a rozlišuje,
 * co export zastaví a co je jen škoda.
 */

/** Jak dlouho se čeká, než se rozepsané pole uloží. */
const SAVE_DELAY = 700;

type Lang = string;

export default function NewProduct({ toast }: { toast: (text: string) => void }) {
  const [state, setState] = useState<NewProductState | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [busy, setBusy] = useState('');

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

  const remove = async (id: string) => {
    setBusy('delete');
    try {
      await api.newProduct.remove(id);
      await load();
    } finally { setBusy(''); }
  };

  if (!state) return <div className="ig-muted np-loading">Načítám…</div>;

  return (
    <div className="np-wrap">
      <div className="np-rail">
        <button className="btn primary np-new" onClick={create}>
          <Icon name="plus" size={14} /> Nový produkt
        </button>
        {state.drafts.length === 0 ? (
          <p className="ig-muted np-empty">
            Zatím tu nic není. Nový produkt se dá vyplnit od nuly, ale rychlejší je
            vybrat si podobný kus jako předlohu — texty se natáhnou a zvýrazní se v nich to,
            co je pro předlohu specifické.
          </p>
        ) : state.drafts.map(one => (
          <button key={one.id} className={`np-item ${one.id === activeId ? 'active' : ''}`}
            onClick={() => setActiveId(one.id)}>
            <span className="np-item-title">{one.langs.cz?.title || one.code || 'Bez názvu'}</span>
            <span className="np-item-sub">
              {one.code || 'bez kódu'}
              {one.state === 'exported' ? ' · v katalogu' : ''}
            </span>
            <Blockers gaps={one.gaps ?? []} />
          </button>
        ))}
      </div>

      {draft ? (
        <DraftEditor key={draft.id} draft={draft} state={state} toast={toast}
          onReload={load} onDelete={() => remove(draft.id)} busy={busy} />
      ) : (
        <div className="np-blank ig-muted">Vyber rozdělaný produkt, nebo založ nový.</div>
      )}
    </div>
  );
}

function Blockers({ gaps }: { gaps: NewProductGap[] }) {
  const blockers = gaps.filter(one => one.level === 'blocker').length;
  if (!blockers) return <span className="np-ok"><Icon name="check" size={12} /> připraveno</span>;
  return <span className="np-todo">{blockers} {blockers === 1 ? 'věc chybí' : 'věci chybí'}</span>;
}

/* ---------- editor jednoho produktu ---------- */

function DraftEditor({ draft, state, toast, onReload, onDelete, busy }: {
  draft: NewProductDraft;
  state: NewProductState;
  toast: (text: string) => void;
  onReload: () => Promise<void>;
  onDelete: () => void;
  busy: string;
}) {
  const [local, setLocal] = useState<NewProductDraft>(draft);
  const [work, setWork] = useState('');
  const [clash, setClash] = useState<{ taken: boolean; title: string } | null>(null);
  const [step, setStep] = useState('');
  const timer = useRef<number | null>(null);

  useEffect(() => { setLocal(draft); }, [draft.id]);

  useEffect(() => {
    const off = api.on('np:step', (s: any) => setStep(s?.step ?? ''));
    return off;
  }, []);

  /**
   * Ukládá se se zpožděním, ale **vždycky výřezem**.
   *
   * Kdyby se posílal celý produkt, dvě rychlé změny za sebou (napsaný název
   * a zaškrtnutá kategorie) by si navzájem přepsaly starší hodnoty.
   */
  const push = useCallback((patch: Partial<NewProductDraft>, now = false) => {
    setLocal(current => ({ ...current, ...patch }));
    if (timer.current) window.clearTimeout(timer.current);
    const send = async () => {
      const saved = await api.newProduct.save(draft.id, patch);
      setLocal(current => ({ ...current, gaps: saved.gaps }));
    };
    if (now) { send().catch(() => { /* okno se zavřelo */ }); return; }
    timer.current = window.setTimeout(() => { send().catch(() => { /* nic */ }); }, SAVE_DELAY);
  }, [draft.id]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setWork(key);
    try { await fn(); }
    catch (e: any) { toast(e?.message ?? String(e)); }
    finally { setWork(''); setStep(''); }
  };

  const langs = state.langs;
  const source = state.sourceLang;
  const texts = local.langs[source] ?? {
    title: '', short: '', long: '', seo_title: '', seo_desc: '', seo_url: '',
    google_title: '', google_desc: ''
  };
  const gaps = local.gaps ?? [];
  const blocked = gaps.filter(one => one.level === 'blocker');

  const setText = (field: keyof typeof texts, value: string, now = false) =>
    push({ langs: { [source]: { ...texts, [field]: value } } as any }, now);

  const checkCode = async (code: string) => {
    if (!code.trim()) { setClash(null); return; }
    setClash(await api.newProduct.checkCode(code));
  };

  return (
    <div className="np-main">
      <div className="np-head">
        <span className="np-head-title">
          {texts.title || local.code || 'Nový produkt'}
        </span>
        {local.state === 'exported'
          ? <span className="np-badge">v katalogu</span>
          : null}
        <span style={{ flex: 1 }} />
        <button className="btn ghost" onClick={onDelete} disabled={busy === 'delete'}>
          <Icon name="trash" size={14} /> Zahodit
        </button>
      </div>

      <div className="np-cols">
        <div className="np-form">
          <Basics draft={local} clash={clash} onCode={code => { push({ code }); checkCode(code); }}
            onPatch={push} state={state} toast={toast} work={work} run={run} onReload={onReload} />

          <Categories draft={local} onPatch={push} toast={toast} />

          <Texts draft={local} texts={texts} lang={source} onText={setText}
            toast={toast} work={work} run={run} onPatch={push} />

          <Params draft={local} onPatch={push} langs={langs} toast={toast} />

          <Images draft={local} onPatch={push} toast={toast} work={work} run={run} />

          {langs.filter(one => one !== source).map(lang => (
            <Translated key={lang} draft={local} lang={lang} />
          ))}
        </div>

        <aside className="np-side">
          <h4>Co ještě chybí</h4>
          {gaps.length === 0 ? (
            <p className="np-side-ok"><Icon name="check" size={13} /> Všechno vyplněné.</p>
          ) : (
            <ul className="np-gaps">
              {gaps.map(one => (
                <li key={one.key} className={one.level}>
                  <Icon name={one.level === 'blocker' ? 'alert' : 'minus'} size={12} />
                  {one.label}
                </li>
              ))}
            </ul>
          )}

          <div className="np-actions">
            <button className="btn primary" disabled={!!work || blocked.length > 0}
              onClick={() => run('save', async () => {
                const out = await api.newProduct.toCatalog(local.id);
                toast(`Produkt ${out.code} je v katalogu. Teď se dopíšou texty a překlady.`);
                await onReload();
              })}>
              {work === 'save' ? <span className="spinner-inline" /> : <Icon name="save" size={14} />}
              {' '}Uložit do katalogu
            </button>
            <p className="desc">
              Zapíše produkt do katalogu překladů. Do e-shopu se tím nedostane —
              na to je až import na konci.
            </p>

            <button className="btn ghost" disabled={!!work || local.state !== 'exported'}
              onClick={() => run('complete', async () => {
                const out = await api.newProduct.complete(local.code);
                toast(out.errors.length
                  ? `Doplněno, ale ${out.errors.length} věcí nevyšlo: ${out.errors[0]}`
                  : 'SEO, texty pro Google i překlady jsou hotové.');
                await onReload();
              })}>
              {work === 'complete' ? <span className="spinner-inline" /> : <Icon name="sparkles" size={14} />}
              {' '}Dopsat texty a přeložit
            </button>
            {work === 'complete' && step ? <p className="np-step">{step}</p> : null}

            <button className="btn ghost" disabled={!!work || local.state !== 'exported'}
              onClick={() => run('xml', async () => {
                const out = await api.ptrans.export({
                  codes: [local.code], mode: 'full', state: 'current', includeSource: true
                });
                toast(out ? `Uloženo do ${out.path}` : 'Uložení se zrušilo.');
              })}>
              {work === 'xml' ? <span className="spinner-inline" /> : <Icon name="download" size={14} />}
              {' '}Stáhnout XML
            </button>

            <button className="btn ghost" disabled={!!work || local.state !== 'exported'}
              onClick={() => run('import', async () => {
                const out = await api.newProduct.openImport(local.code);
                toast(out.note);
              })}>
              {work === 'import' ? <span className="spinner-inline" /> : <Icon name="upload" size={14} />}
              {' '}Vložit do administrace
            </button>
            <p className="desc">
              {/* Založení produktu v e-shopu se vzít zpátky nedá — poslední kliknutí
                  proto zůstává na člověku, stejně jako u nahrávání fotek. */}
              Otevře okno s importem a vloží do něj soubor. <strong>Import nespustím</strong> —
              zkontroluj nastavení a spusť ho sám.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}

/* ---------- základ ---------- */

function Basics({ draft, clash, onCode, onPatch, state, toast, work, run, onReload }: {
  draft: NewProductDraft;
  clash: { taken: boolean; title: string } | null;
  onCode: (code: string) => void;
  onPatch: (patch: Partial<NewProductDraft>, now?: boolean) => void;
  state: NewProductState;
  toast: (text: string) => void;
  work: string;
  run: (key: string, fn: () => Promise<void>) => Promise<void>;
  onReload: () => Promise<void>;
}) {
  const [search, setSearch] = useState('');
  const [hits, setHits] = useState<PtransProduct[]>([]);

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
    <section className="np-box">
      <h4><Icon name="bag" size={14} /> Základ</h4>

      <div className="np-row">
        <label className="np-field">
          <span>Kód produktu</span>
          <input value={draft.code} onChange={e => onCode(e.target.value)}
            placeholder="např. KR00123" />
          {clash?.taken ? (
            /*
             * Import se stejným kódem nezaloží nový produkt, ale potichu
             * přepíše ten stávající — proto se to hlásí hned u pole, ne až
             * na konci při exportu.
             */
            <em className="np-warn">
              <Icon name="alert" size={12} /> Kód už má „{clash.title}". Import by ho přepsal.
            </em>
          ) : draft.code.trim() ? <em className="np-ok-note">Kód je volný.</em> : null}
        </label>

        <label className="np-field">
          <span>EAN <em className="ig-muted">nepovinné</em></span>
          <input value={draft.ean} onChange={e => onPatch({ ean: e.target.value })} />
        </label>

        <label className="np-field">
          <span>Značka</span>
          <input value={draft.manufacturer}
            onChange={e => onPatch({ manufacturer: e.target.value })} />
        </label>
      </div>

      <div className="np-row">
        {priceGroups(state).map(group => (
          <label key={group.currency} className="np-field np-price">
            <span>Cena s DPH — {group.label}</span>
            <input value={draft.prices[group.langs[0]] ?? ''} inputMode="decimal"
              onChange={e => {
                /*
                 * Jedno pole zapisuje cenu všem jazykům se stejnou měnou.
                 * Dvě stejná políčka „€" vedle sebe (slovensky a anglicky)
                 * svádějí k tomu vyplnit jen jedno — a druhá mutace by pak
                 * produkt prodávala za nulu.
                 */
                const prices = { ...draft.prices };
                for (const lang of group.langs) prices[lang] = e.target.value;
                onPatch({ prices });
              }} />
          </label>
        ))}
      </div>
      <p className="desc">
        {/* Sklad v XML schválně není: kdyby ho nesl, každý pozdější opravný import
            textů by po sobě přepsal počet kusů podle staré hodnoty v aplikaci. */}
        Zásoba se sem nepíše — tu vyplníš v administraci. Import ji nikdy nepřepíše.
      </p>

      <div className="np-template">
        <span className="np-template-label"><Icon name="copy" size={13} /> Předloha</span>
        {draft.templateCode ? (
          <span className="np-template-set">
            {draft.templateCode}
            <button className="link" onClick={() => onPatch({ templateCode: '' }, true)}>zrušit</button>
          </span>
        ) : (
          <div className="np-pick">
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Najdi podobný produkt — natáhnou se z něj texty" />
            {hits.length ? (
              <ul className="np-hits">
                {hits.map(one => (
                  <li key={one.code}>
                    <button disabled={!!work} onClick={() => run('template', async () => {
                      const out = await api.newProduct.template(draft.id, one.code);
                      toast(out.note || `Texty z ${one.code} jsou natažené — ${out.specifics.length} míst je specifických pro předlohu.`);
                      setSearch('');
                      await onReload();
                    })}>
                      {one.image ? <img src={one.image} alt="" /> : <span className="np-hit-noimg" />}
                      <span className="np-hit-title">{one.title}</span>
                      <span className="np-hit-code">{one.code}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}

const CURRENCY_LABEL: Record<string, string> = {
  CZK: 'Kč', EUR: '€', USD: '$', GBP: '£', PLN: 'zł'
};

/**
 * Ceny se zadávají po měnách, ne po jazycích.
 *
 * Slovenský a anglický e-shop prodávají obojí v eurech — dvě stejná políčka
 * vedle sebe by jen sváděla vyplnit jedno a druhé nechat prázdné.
 */
function priceGroups(state: NewProductState): { currency: string; label: string; langs: string[] }[] {
  const out: { currency: string; label: string; langs: string[] }[] = [];
  for (const lang of state.langs) {
    // Když feed měnu neuvádí, drží se jazyk sám — radši políčko navíc než
    // cena zapsaná do měny, kterou e-shop nečeká
    const currency = state.currencies[lang] || `?${lang}`;
    const found = out.find(one => one.currency === currency);
    if (found) found.langs.push(lang);
    else out.push({ currency, label: CURRENCY_LABEL[currency] ?? currency.replace(/^\?/, '').toUpperCase(), langs: [lang] });
  }
  return out;
}

/* ---------- kategorie ---------- */

function Categories({ draft, onPatch, toast }: {
  draft: NewProductDraft;
  onPatch: (patch: Partial<NewProductDraft>, now?: boolean) => void;
  toast: (text: string) => void;
}) {
  const [tree, setTree] = useState<ShopCategoryTree | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');

  const load = useCallback(async (refresh = false) => {
    setBusy(true);
    try { setTree(await api.newProduct.categories(refresh)); }
    catch (e: any) { toast(e?.message ?? String(e)); }
    finally { setBusy(false); }
  }, [toast]);

  useEffect(() => { load(false).catch(() => { /* nic */ }); }, [load]);

  // Nabízejí se jen kategorie se zbožím. Do stránek v menu („O nás", články)
  // by se dalo zboží pověsit a v e-shopu by pak nebylo nikde.
  const items = useMemo(() => (tree?.items ?? [])
    .filter(one => one.holdsProducts)
    .filter(one => !filter.trim() || one.path.toLowerCase().includes(filter.trim().toLowerCase())),
  [tree, filter]);

  const toggle = (code: string) => {
    const has = draft.categories.includes(code);
    const categories = has
      ? draft.categories.filter(one => one !== code)
      : [...draft.categories, code];
    onPatch({ categories, mainCategory: has && draft.mainCategory === code ? '' : draft.mainCategory }, true);
  };

  return (
    <section className="np-box">
      <h4>
        <Icon name="folder" size={14} /> Kategorie
        <button className="link np-refresh" disabled={busy} onClick={() => load(true)}>
          {busy ? 'načítám…' : 'načíst znovu'}
        </button>
      </h4>

      {!tree ? (
        <p className="ig-muted">
          Kategorie se berou z exportu kategorií. Adresu vyplň v Nastavení → Produkty.
        </p>
      ) : (
        <>
          <input className="np-filter" value={filter} onChange={e => setFilter(e.target.value)}
            placeholder="Hledat kategorii" />
          <ul className="np-cats">
            {items.map(one => {
              const on = draft.categories.includes(one.code);
              return (
                <li key={one.code} style={{ paddingLeft: 6 + one.depth * 16 }}>
                  <label>
                    <input type="checkbox" checked={on} onChange={() => toggle(one.code)} />
                    <span>{one.names.cz || one.code}</span>
                  </label>
                  {on ? (
                    <button className={`np-main-cat ${draft.mainCategory === one.code ? 'on' : ''}`}
                      onClick={() => onPatch({ mainCategory: one.code }, true)}
                      title="Hlavní kategorie — určuje adresu produktu a drobečkovou navigaci">
                      <Icon name="star" size={12} /> hlavní
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {draft.categories.length && !draft.mainCategory ? (
            <em className="np-warn"><Icon name="alert" size={12} /> Vyber hlavní kategorii.</em>
          ) : null}
        </>
      )}
    </section>
  );
}

/* ---------- texty ---------- */

const FIELD_LABELS: Record<string, string> = {
  title: 'Název', short: 'Krátký popis', long: 'Dlouhý popis'
};

function Texts({ draft, texts, lang, onText, toast, work, run, onPatch }: {
  draft: NewProductDraft;
  texts: NewProductTexts;
  lang: Lang;
  onText: (field: any, value: string, now?: boolean) => void;
  toast: (text: string) => void;
  work: string;
  run: (key: string, fn: () => Promise<void>) => Promise<void>;
  onPatch: (patch: Partial<NewProductDraft>, now?: boolean) => void;
}) {
  const [changes, setChanges] = useState<NewProductChange[] | null>(null);
  const selection = useSelection();

  /*
   * Specifikum se nepovažuje za vyřešené podle toho, že na něj někdo klikl,
   * ale podle toho, jestli je jeho text pořád v poli. Odškrtávání rukou by
   * se dalo odbýt — tohle ne.
   */
  const open = draft.specifics.filter(one => ((texts as any)[one.field] ?? '').includes(one.text));

  const rewrite = (field: string, html: boolean) => run('rewrite', async () => {
    const full = (texts as any)[field] ?? '';
    const picked = selection.current;
    if (!picked) throw new Error('Nejdřív označ kus textu, který se má přepsat.');
    if (!full.includes(picked)) {
      throw new Error('Označený text se v poli nenašel celý — označ raději celou větu v jednom odstavci.');
    }
    const next = await api.newProduct.rewrite({ full, selection: picked, html });
    onText(field, full.replace(picked, next), true);
    toast('Přepsáno. Kdyby to nesedělo, Cmd+Z to vrátí.');
  });

  return (
    <section className="np-box">
      <h4><Icon name="pen" size={14} /> Texty ({lang.toUpperCase()})</h4>

      {draft.specifics.length ? (
        <div className="np-specifics">
          <span className="np-spec-head">
            Z předlohy — {open.length ? `${open.length} ještě beze změny` : 'všechno přepsané'}
          </span>
          {draft.specifics.map((one, index) => {
            const still = ((texts as any)[one.field] ?? '').includes(one.text);
            return (
              <span key={index} className={`np-chip ${still ? '' : 'done'}`}
                title={`${FIELD_LABELS[one.field] ?? one.field} · ${one.why}`}>
                {still ? null : <Icon name="check" size={11} />}
                {one.text.length > 42 ? `${one.text.slice(0, 42)}…` : one.text}
              </span>
            );
          })}
        </div>
      ) : null}

      <label className="np-field">
        <span>Název</span>
        <input value={texts.title} onChange={e => onText('title', e.target.value)} />
      </label>

      {draft.templateCode ? (
        <div className="np-propose">
          <button className="btn ghost" disabled={!!work || !texts.title.trim()}
            onClick={() => run('title', async () => {
              const out = await api.newProduct.titleProposal(draft.id, lang);
              setChanges(out);
              if (out.length === 0) toast('Podle nového názvu není co měnit.');
            })}>
            {work === 'title' ? <span className="spinner-inline" /> : <Icon name="brain" size={14} />}
            {' '}Projít texty podle nového názvu
          </button>
          <span className="desc">
            Vrátí návrhy „tohle → tohle". Nic se nepřepíše samo.
          </span>
        </div>
      ) : null}

      {changes?.length ? (
        <ul className="np-changes">
          {changes.map((one, index) => (
            <li key={index}>
              <span className="np-change-where">{FIELD_LABELS[one.field] ?? one.field}</span>
              <span className="np-change-before">{one.before}</span>
              <Icon name="chevRight" size={12} />
              <span className="np-change-after">{one.after}</span>
              {one.why ? <em className="np-change-why">{one.why}</em> : null}
              <button className="btn ghost np-change-take" onClick={() => {
                const full = (texts as any)[one.field] ?? '';
                if (!full.includes(one.before)) { toast('Text se mezitím změnil — návrh už nesedí.'); return; }
                onText(one.field, full.replace(one.before, one.after), true);
                setChanges(list => (list ?? []).filter((_x, i) => i !== index));
              }}>Použít</button>
              <button className="link" onClick={() =>
                setChanges(list => (list ?? []).filter((_x, i) => i !== index))}>Nechat</button>
            </li>
          ))}
        </ul>
      ) : null}

      {(['short', 'long'] as const).map(field => (
        <div key={field} className="np-html" ref={selection.attach}>
          <div className="np-html-head">
            <span>{FIELD_LABELS[field]}</span>
            <button className="btn ghost" disabled={!!work}
              // Výběr zmizí, jakmile tlačítko dostane zaměření — proto se
              // kliknutí bere už na stisknutí myši a zaměření se nepřebírá
              onMouseDown={e => e.preventDefault()}
              onClick={() => rewrite(field, true)}>
              {work === 'rewrite' ? <span className="spinner-inline" /> : <Icon name="sparkles" size={13} />}
              {' '}Přepsat výběr podle zbytku
            </button>
          </div>
          <HtmlField value={texts[field] ?? ''} rows={field === 'long' ? 14 : 6}
            onChange={value => onText(field, value)} />
        </div>
      ))}

      <div className="np-row">
        <label className="np-field">
          <span>SEO titulek</span>
          <input value={texts.seo_title} onChange={e => onText('seo_title', e.target.value)}
            placeholder="doplní se sám" />
        </label>
        <label className="np-field">
          <span>SEO popis</span>
          <input value={texts.seo_desc} onChange={e => onText('seo_desc', e.target.value)}
            placeholder="doplní se sám" />
        </label>
      </div>
      <p className="desc">
        SEO i texty pro Google se dopíšou z českých popisů po uložení do katalogu —
        vyplňovat je ručně má smysl, jen když chceš něco konkrétního.
      </p>
    </section>
  );
}

/**
 * Poslední označený text uvnitř sledované oblasti.
 *
 * Výběr se musí pamatovat: jakmile se klikne na tlačítko, prohlížeč ho zruší.
 * Sleduje se proto `selectionchange` a drží se poslední neprázdný výběr,
 * který spadá dovnitř pole.
 */
function useSelection() {
  const boxes = useRef<HTMLElement[]>([]);
  const current = useRef('');

  useEffect(() => {
    const onChange = () => {
      const sel = document.getSelection();
      const text = sel?.toString() ?? '';
      if (!text.trim() || !sel?.anchorNode) return;
      const inside = boxes.current.some(box => box.contains(sel.anchorNode));
      if (inside) current.current = text;
    };
    document.addEventListener('selectionchange', onChange);
    return () => document.removeEventListener('selectionchange', onChange);
  }, []);

  return {
    attach: (el: HTMLElement | null) => {
      if (el && !boxes.current.includes(el)) boxes.current.push(el);
    },
    get current() { return current.current; }
  };
}

/* ---------- parametry ---------- */

function Params({ draft, onPatch, langs, toast }: {
  draft: NewProductDraft;
  onPatch: (patch: Partial<NewProductDraft>, now?: boolean) => void;
  langs: string[];
  toast: (text: string) => void;
}) {
  const [dict, setDict] = useState<ParamDictionary | null>(null);
  const [known, setKnown] = useState<Record<number, ParamLookup>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setDict(await api.newProduct.params()); } catch { /* číselník je pomoc, ne podmínka */ }
  }, []);
  useEffect(() => { load(); }, [load]);

  /*
   * U každého řádku se ptáme číselníku, jestli takový parametr v e-shopu
   * vůbec je. Je to jediný způsob, jak před uložením poznat překlep — „Šíře"
   * místo „Šířka" se jinak projeví až tím, že produkt vypadne z filtru.
   */
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

  const set = (index: number, patch: { name?: string; value?: string }) => {
    const params = draft.params.map((one, i) => i === index ? { ...one, ...patch } : one);
    onPatch({ params });
  };
  const add = () => onPatch({ params: [...draft.params, { name: '', value: '' }] }, true);
  const drop = (index: number) =>
    onPatch({ params: draft.params.filter((_one, i) => i !== index) }, true);

  const valuesFor = (name: string) => {
    const key = name.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return (dict?.values ?? []).filter(one => one.nameKey === key);
  };

  return (
    <section className="np-box">
      <h4>
        <Icon name="sliders" size={14} /> Parametry a vlastnosti
        <button className="link np-refresh" disabled={busy} onClick={async () => {
          setBusy(true);
          try {
            const out = await api.newProduct.relearnParams();
            await load();
            toast(`Číselník má ${out.names} parametrů a ${out.values} hodnot.`);
          } catch (e: any) { toast(e?.message ?? String(e)); }
          finally { setBusy(false); }
        }}>{busy ? 'čtu feed…' : 'načíst z feedu'}</button>
      </h4>

      {draft.params.length === 0 ? (
        <p className="ig-muted">Zatím žádné. Z předlohy se natáhnou i s hodnotami.</p>
      ) : (
        <ul className="np-params">
          {draft.params.map((one, index) => {
            const found = known[index];
            const values = valuesFor(one.name);
            return (
              <li key={index} className={one.fromTemplate ? 'from-template' : ''}>
                <input value={one.name} placeholder="Název (Barva)" list={`np-names-${index}`}
                  onChange={e => set(index, { name: e.target.value })} />
                <datalist id={`np-names-${index}`}>
                  {(dict?.names ?? []).map(entry => (
                    <option key={entry.key} value={entry.langs.cz ?? entry.key} />
                  ))}
                </datalist>

                <input value={one.value} placeholder="Hodnota (modrá)" list={`np-values-${index}`}
                  onChange={e => set(index, { value: e.target.value })} />
                <datalist id={`np-values-${index}`}>
                  {values.map(entry => (
                    <option key={entry.key} value={entry.langs.cz ?? entry.key} />
                  ))}
                </datalist>

                <ParamState found={found} langs={langs} />
                <button className="icon-btn" title="Smazat" onClick={() => drop(index)}>
                  <Icon name="trash" size={13} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <button className="btn ghost" onClick={add}><Icon name="plus" size={13} /> Přidat parametr</button>
      <p className="desc">
        {/* „Barva" vedle „barva" jsou pro e-shop dva parametry: rozpadne se
            filtrování v kategorii a v Google Nákupech to vypadá jako dva
            nesouvisející produkty. */}
        Nabídka se skládá z toho, co ve feedu doopravdy je — i s překlady. Co číselník zná,
        se zapíše do XML rovnou slovensky i anglicky; co ne, dopřekládá se s texty.
      </p>
    </section>
  );
}

/** Ukazatel „tenhle parametr e-shop zná / nezná" u jednoho řádku. */
function ParamState({ found, langs }: { found?: ParamLookup; langs: string[] }) {
  if (!found) return <span className="np-param-state" />;
  if (!found.knownName) {
    return (
      <span className="np-param-state new" title="Takový parametr v e-shopu zatím není — zkontroluj překlep">
        <Icon name="plus" size={11} /> nový
      </span>
    );
  }
  const missing = langs.filter(lang => lang !== 'cz' && !(found.value[lang] ?? found.name[lang]));
  if (!found.knownValue) {
    return (
      <span className="np-param-state half" title="Parametr e-shop zná, tuhle hodnotu ještě ne">
        nová hodnota
      </span>
    );
  }
  return (
    <span className={`np-param-state ${missing.length ? 'half' : 'ok'}`}
      title={missing.length ? `Chybí překlad: ${missing.join(', ').toUpperCase()}` : 'Zná ho e-shop i ve všech jazycích'}>
      <Icon name="check" size={11} /> {missing.length ? missing.join(', ').toUpperCase() : 'zná'}
    </span>
  );
}

/* ---------- obrázky ---------- */

function Images({ draft, onPatch, toast, work, run }: {
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
    const images = [...draft.images, ...uploaded.map((one, index) => ({
      url: one.url,
      name: one.name,
      main: draft.images.length === 0 && index === 0
    }))];
    onPatch({ images }, true);
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
    <section className="np-box">
      <h4><Icon name="image" size={14} /> Obrázky</h4>
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
                <Icon name="star" size={12} /> titulní
              </button>
              <button className="icon-btn" onClick={() => move(index, -1)} title="Nahoru">
                <Icon name="chevDown" size={13} />
              </button>
              <button className="icon-btn np-down" onClick={() => move(index, 1)} title="Dolů">
                <Icon name="chevDown" size={13} />
              </button>
              <button className="icon-btn" title="Odebrat"
                onClick={() => onPatch({ images: draft.images.filter((_x, i) => i !== index) }, true)}>
                <Icon name="trash" size={13} />
              </button>
            </li>
          ))}
        </ul>
      ) : <p className="ig-muted">Zatím žádné.</p>}

      <button className="btn ghost" disabled={!!work} onClick={pick}>
        {work === 'images' ? <span className="spinner-inline" /> : <Icon name="upload" size={14} />}
        {' '}Obrázky z počítače
      </button>
      {step ? <p className="np-step">{step}</p> : null}
      <p className="desc">
        Převedou se na WebP, nahrají do souborů na e-shopu a adresa se přečte zpátky —
        skládat ji nejde, Upgates soubory při nahrání přejmenuje.
      </p>
    </section>
  );
}

/* ---------- hotové překlady ---------- */

function Translated({ draft, lang }: { draft: NewProductDraft; lang: Lang }) {
  const texts = draft.langs[lang];
  const filled = texts && (texts.title?.trim() || texts.long?.trim());
  return (
    <section className="np-box np-lang">
      <h4>
        <Icon name="globe" size={14} /> {lang.toUpperCase()}
        {filled ? null : <span className="ig-muted np-lang-note">zatím nepřeloženo</span>}
      </h4>
      {filled ? (
        <>
          <div className="np-lang-title">{texts.title}</div>
          <div className="np-lang-body" dangerouslySetInnerHTML={{ __html: texts.short || '' }} />
        </>
      ) : (
        <p className="ig-muted">
          Doplní se po uložení do katalogu tlačítkem „Dopsat texty a přeložit".
        </p>
      )}
    </section>
  );
}
