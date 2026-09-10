import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  WebClash, WebLink, WebPlan, WebSeason, WebText, WebTextsConfig, WebTextsState
} from '@shared/types';
import { api } from '../api';
import { useToast } from '../toast';
import Icon from './Icon';

/**
 * Naplánované náhrady textů na e-shopu.
 *
 * ## Podle čeho je to postavené
 *
 * Vlevo je **plán** — všechno, co se chystá, běží nebo nedávno doběhlo,
 * seřazené v čase. To je ta otázka, která se v tomhle modulu ptá nejčastěji:
 * „co bude na webu příští týden?" Vpravo se edituje jedna změna.
 *
 * Změna je jeden časový úsek, ne jeden text. Na dovolenou se totiž mění
 * všechno najednou — box u produktu, horní lišta i bublina u objednávky —
 * a kdyby to byly tři samostatné záznamy, museli by se hlídat tři konce.
 *
 * ## Co se stane, když se okna překryjí
 *
 * Ptá se na to hned při psaní data, ne až při uložení. Změna, která
 * začíná dřív, se dá jedním kliknutím zkrátit tak, aby skončila minutu
 * před tou novou — to je ten případ „potřebuju to dřív, než skončí, co
 * jsem naplánoval minule".
 *
 * ## Jazyky
 *
 * Vyplňuje se česky; slovenština a angličtina jsou nepovinné a když
 * zůstanou prázdné, ukáže se na nich čeština. Lepší česká věta než prázdné
 * místo tam, kde má být informace o doručení.
 */

type Lang = 'cz' | 'sk' | 'en';

const LANGS: { id: Lang; label: string; hint: string }[] = [
  { id: 'cz', label: 'Česky', hint: 'quentino.cz' },
  { id: 'sk', label: 'Slovensky', hint: 'quentino.sk' },
  { id: 'en', label: 'English', hint: 'wearquentino.com' }
];

const emptyText = (): WebText => ({ cz: '', sk: '', en: '' });
const hasText = (t?: WebText) => !!(t && (t.cz || t.sk || t.en));

const PRODUCT_TEXTS = ['one', 'above', 'header', 'ship', 'delivery', 'pickup', 'below'] as const;

/**
 * Projde všechna textová políčka změny v pevném pořadí.
 *
 * Slouží dvěma věcem naráz — posbírat české texty na překlad a pak do těch
 * samých políček zapsat výsledek. Musí to být jedna funkce, protože **na
 * pořadí záleží**: kdyby se sbíralo jinak, než zapisovalo, doplnil by se
 * překlad expedice do řádku o osobním odběru.
 */
function walkTexts(plan: WebPlan, fn: (t: WebText) => WebText): WebPlan {
  const product: any = { ...plan.product };
  for (const key of PRODUCT_TEXTS) product[key] = fn(product[key]);
  return {
    ...plan,
    product,
    topbar: { ...plan.topbar, text: fn(plan.topbar.text) },
    // Adresy odkazů se nepřekládají — slovenský web má vlastní domény
    links: { ...plan.links, items: plan.links.items.map(one => ({ ...one, text: fn(one.text) })) },
    button: { ...plan.button, text: fn(plan.button.text) }
  };
}

/** Čas na hodinách v podobě, kterou chce `datetime-local`. */
function localNow(offsetMinutes = 0): string {
  const d = new Date(Date.now() + offsetMinutes * 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function blankPlan(): WebPlan {
  return {
    id: '',
    name: '',
    from: localNow(),
    // Den je nejčastější délka; přepsat se dá hned vedle
    to: localNow(24 * 60),
    fromMs: 0,
    toMs: 0,
    off: false,
    product: {
      on: false, one: emptyText(), above: emptyText(), header: emptyText(), hideHeader: false,
      ship: emptyText(), delivery: emptyText(), pickup: emptyText(), shipFrom: '',
      hideShip: false, hideDelivery: false, hidePickup: false, below: emptyText()
    },
    topbar: { on: false, text: emptyText() },
    links: { on: false, mode: 'add', items: [] },
    button: { on: false, text: emptyText() }
  };
}

/** „2026-09-21" jako „21. 9." — do vysvětlující věty, ne do hodnoty */
function dayLabel(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  return m ? `${+m[3]}. ${+m[2]}.` : iso;
}

function whenLabel(plan: WebPlan): string {
  const nice = (s: string) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s);
    return m ? `${+m[3]}. ${+m[2]}. ${m[1].slice(2)} ${m[4]}:${m[5]}` : s;
  };
  return `${nice(plan.from)} – ${nice(plan.to)}`;
}

type Phase = 'off' | 'live' | 'soon' | 'done';

function phaseOf(plan: WebPlan): Phase {
  if (plan.off) return 'off';
  const now = Date.now();
  if (now < plan.fromMs) return 'soon';
  if (now > plan.toMs) return 'done';
  return 'live';
}

const PHASES: Record<Phase, string> = {
  live: 'běží', soon: 'naplánováno', done: 'skončilo', off: 'vypnuto'
};

/** Které oblasti změna nastavuje — do řádku v seznamu. */
function areasOf(plan: WebPlan): string[] {
  const out: string[] = [];
  if (plan.product.on) out.push('produkt');
  if (plan.topbar.on) out.push('horní lišta');
  if (plan.links.on) out.push(plan.links.mode === 'off' ? 'odkazy skryté' : 'odkazy');
  if (plan.button.on) out.push('bublina');
  return out;
}

/* ---------- políčko na jeden text ---------- */

function TextField({ label, hint, value, lang, onChange, rows = 1 }: {
  label: string;
  hint?: string;
  value: WebText;
  lang: Lang;
  onChange: (next: WebText) => void;
  rows?: number;
}) {
  /*
   * Čeština je základ, ostatní jazyky na ni padají zpátky. Když je česky
   * něco napsané a slovensky ne, ukáže se to jako našeptaná hodnota —
   * jinak by se dalo lehko přehlédnout, že Slováci uvidí češtinu.
   */
  const fallback = lang !== 'cz' && !value[lang] && value.cz ? value.cz : '';
  return (
    <div className="field wt-field">
      <label>{label}</label>
      {rows > 1 ? (
        <textarea
          rows={rows}
          value={value[lang]}
          placeholder={fallback || hint || ''}
          onChange={e => onChange({ ...value, [lang]: e.target.value })}
        />
      ) : (
        <input
          value={value[lang]}
          placeholder={fallback || hint || ''}
          onChange={e => onChange({ ...value, [lang]: e.target.value })}
        />
      )}
      {fallback && <span className="desc">Prázdné — ukáže se český text.</span>}
    </div>
  );
}

/* ---------- jedna oblast ---------- */

function Area({ title, hint, on, onToggle, children }: {
  title: string;
  hint: string;
  on: boolean;
  onToggle: (on: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <section className={`wt-area ${on ? 'on' : ''}`}>
      <label className="wt-area-head">
        <input type="checkbox" checked={on} onChange={e => onToggle(e.target.checked)} />
        <span>
          <b>{title}</b>
          <small>{hint}</small>
        </span>
      </label>
      {on && <div className="wt-area-body">{children}</div>}
    </section>
  );
}

export default function WebTextsModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [state, setState] = useState<WebTextsState | null>(null);
  const [draft, setDraft] = useState<WebPlan | null>(null);
  const [lang, setLang] = useState<Lang>('cz');
  const [clashes, setClashes] = useState<WebClash[]>([]);
  const [busy, setBusy] = useState('');
  const [tab, setTab] = useState<'plan' | 'xmas' | 'setup'>('plan');
  const [key, setKey] = useState('');
  const [config, setConfig] = useState<WebTextsConfig | null>(null);
  const [xmas, setXmas] = useState<WebSeason | null>(null);
  const timer = useRef<number | null>(null);

  const load = useCallback(async () => {
    setBusy('načítám');
    try {
      const next = await api.webtexts.load();
      setState(next);
      setConfig(next.config);
      setXmas(next.season);
      if (!next.config.ready) setTab('setup');
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  /*
   * Překryv se hlídá při psaní, ne až u tlačítka Uložit. Zjistit až po
   * uložení, že to koliduje, znamená vracet se a přepisovat datum, které
   * člověk zrovna vymyslel.
   */
  useEffect(() => {
    if (!draft) { setClashes([]); return; }
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      try {
        setClashes(await api.webtexts.clashes(draft));
      } catch {
        setClashes([]);
      }
    }, 250);
    return () => { if (timer.current) window.clearTimeout(timer.current); };
  }, [draft?.from, draft?.to, draft?.id]);

  const plans = state?.plans ?? [];
  const shortenable = useMemo(() => clashes.filter(c => c.shortenTo), [clashes]);

  const apply = (next: WebTextsState, message?: string) => {
    setState(next);
    setConfig(next.config);
    setXmas(next.season);
    if (next.error) toast(next.error, 'error');
    else if (message) toast(message);
  };

  const save = async () => {
    if (!draft) return;
    setBusy('ukládám');
    try {
      const next = await api.webtexts.save(draft);
      apply(next, next.error ? undefined : 'Změna je uložená a vystavená na web.');
      setDraft(null);
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const remove = async (id: string) => {
    setBusy('mažu');
    try {
      apply(await api.webtexts.remove(id), 'Změna je pryč.');
      setDraft(null);
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const toggle = async (plan: WebPlan) => {
    setBusy('ukládám');
    try {
      apply(await api.webtexts.toggle(plan.id, !plan.off));
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
    }
  };

  /** Zkrátit ty, které začínají dřív, aby té nové uvolnily místo. */
  const shorten = async () => {
    if (!draft) return;
    setBusy('ukládám');
    try {
      // Zkrátit jde jen to, co je uložené — proto se nová změna nejdřív uloží
      const saved = await api.webtexts.save(draft);
      const mine = saved.plans.find(p => p.from === draft.from && p.to === draft.to && p.name === draft.name);
      const target = draft.id || mine?.id;
      if (!target) throw new Error('Změna se neuložila, není co zkracovat.');
      apply(await api.webtexts.shorten(target, shortenable.map(c => c.id)),
        'Předchozí změny končí těsně před touhle.');
      setDraft(null);
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const publish = async () => {
    setBusy('vystavuji');
    try {
      const next = await api.webtexts.publish();
      apply(next, next.error ? undefined : 'Plán je na webu.');
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const saveConfig = async () => {
    if (!config) return;
    setBusy('ukládám');
    try {
      const next = await api.webtexts.config({ ...config, ...(key ? { key } : {}) });
      setConfig(next);
      setKey('');
      const full = await api.webtexts.state();
      setState(full);
      toast('Nastavení uložené.');
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
    }
  };

  /*
   * Překlad doplňuje **jen prázdná** políčka. Přepsat to, co je ručně
   * doladěné, by znamenalo, že se po každém stisknutí musí kontrolovat
   * všechny tři jazyky znovu — a jednou by se na to zapomnělo.
   */
  const translatePlan = async () => {
    if (!draft) return;
    setBusy('překládám');
    try {
      const source: string[] = [];
      walkTexts(draft, t => { source.push(t.cz); return t; });
      const done = await api.webtexts.translate(source);
      let i = 0;
      let filled = 0;
      const next = walkTexts(draft, t => {
        const one = done[i++];
        if (!t.cz || !one) return t;
        const sk = t.sk || one.sk;
        const en = t.en || one.en;
        if (sk !== t.sk || en !== t.en) filled++;
        return { ...t, sk, en };
      });
      setDraft(next);
      toast(filled
        ? `Doplněno ${filled} textů ve slovenštině a angličtině. Ulož a vystav, ať to platí.`
        : 'Není co doplnit — všechno je přeložené. Smaž překlad, který chceš přepsat.');
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const translateSeason = async () => {
    if (!xmas?.text.cz) { toast('Nejdřív napiš české znění.', 'error'); return; }
    setBusy('překládám');
    try {
      const [one] = await api.webtexts.translate([xmas.text.cz]);
      setXmas(x => (x ? { ...x, text: { ...x.text, sk: x.text.sk || one.sk, en: x.text.en || one.en } } : x));
      toast('Slovenština a angličtina doplněné. Ulož a vystav, ať to platí.');
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const saveSeason = async () => {
    if (!xmas) return;
    setBusy('ukládám');
    try {
      const next = await api.webtexts.season(xmas);
      apply(next, next.error ? undefined : 'Garance je uložená a vystavená na web.');
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const copyScript = async () => {
    if (!state?.script) return;
    try {
      await navigator.clipboard.writeText(state.script);
      toast('Skript je ve schránce — vlož ho na konec <head> e-shopu.');
    } catch {
      toast('Zkopírovat se to nepovedlo, označ text a zkopíruj ručně.', 'error');
    }
  };

  const set = (patch: Partial<WebPlan>) => setDraft(d => (d ? { ...d, ...patch } : d));

  const product = draft?.product;
  const oneMode = !!(product && hasText(product.one));
  /* Sáhla změna na expedici nebo doručení? Podle toho se chová i horní lišta. */
  const shipChanged = !!(product?.on
    && (hasText(product.ship) || product.shipFrom || product.hideShip || hasText(product.delivery)));

  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal wt-modal">
        <div className="modal-head">
          <span className="modal-title"><Icon name="globe" size={15} /> Texty na webu</span>
          <div className="wt-head-right">
            <button className={`tab ${tab === 'plan' ? 'active' : ''}`} onClick={() => setTab('plan')}>Plán</button>
            <button className={`tab ${tab === 'xmas' ? 'active' : ''}`} onClick={() => setTab('xmas')}>Vánoce</button>
            <button className={`tab ${tab === 'setup' ? 'active' : ''}`} onClick={() => setTab('setup')}>Napojení</button>
            <button className="icon-btn" onClick={onClose} disabled={!!busy}><Icon name="x" size={16} /></button>
          </div>
        </div>

        <div className="wt-status">
          {state?.error ? (
            <span className="wt-bad"><Icon name="alert" size={13} /> {state.error}</span>
          ) : state?.dirty ? (
            <span className="wt-bad"><Icon name="alert" size={13} /> Změna zatím není na webu.</span>
          ) : state?.publishedAt ? (
            <span className="wt-ok">
              <Icon name="check" size={13} /> Vystaveno {new Date(state.publishedAt).toLocaleString('cs-CZ')}
            </span>
          ) : (
            <span className="desc">Zatím nic nevystaveno — web jede na dynamických textech.</span>
          )}
          <span className="wt-spacer" />
          {busy && <span className="desc">{busy}…</span>}
          <button className="btn ghost" onClick={publish} disabled={!!busy || !state?.config.ready}>
            <Icon name="upload" size={14} /> Vystavit znovu
          </button>
        </div>

        {tab === 'plan' ? (
          <div className="wt-body">
            <aside className="wt-list">
              <button className="btn" onClick={() => { setDraft(blankPlan()); setLang('cz'); }} disabled={!!busy}>
                <Icon name="plus" size={14} /> Nová změna
              </button>
              {plans.length === 0 && (
                <p className="desc" style={{ padding: '10px 2px' }}>
                  Nic naplánovaného. Texty na webu se počítají samy podle dne a hodiny.
                </p>
              )}
              {plans.map(plan => {
                const phase = phaseOf(plan);
                return (
                  <button
                    key={plan.id}
                    className={`wt-row ${phase} ${draft?.id === plan.id ? 'sel' : ''}`}
                    onClick={() => { setDraft(plan); setLang('cz'); }}
                  >
                    <span className="wt-row-top">
                      <b>{plan.name || 'Beze jména'}</b>
                      <em className={`wt-badge ${phase}`}>{PHASES[phase]}</em>
                    </span>
                    <span className="desc">{whenLabel(plan)}</span>
                    <span className="wt-chips">
                      {areasOf(plan).map(a => <em key={a}>{a}</em>)}
                    </span>
                  </button>
                );
              })}
            </aside>

            <div className="wt-edit">
              {!draft ? (
                <div className="empty-state" style={{ padding: '40px 10px' }}>
                  <div className="big">🗓️</div>
                  <p>Vyber změnu vlevo, nebo založ novou.</p>
                  <p className="desc">
                    Co změna nenastaví, počítá web dál sám — podle dne v týdnu, hodiny a svátků.
                  </p>
                </div>
              ) : (
                <>
                  <div className="wt-when">
                    <div className="field">
                      <label>Název</label>
                      <input
                        value={draft.name}
                        placeholder="Dovolená, výpadek dopravce, akce…"
                        onChange={e => set({ name: e.target.value })}
                      />
                    </div>
                    <div className="field">
                      <label>Platí od</label>
                      <input type="datetime-local" value={draft.from}
                        onChange={e => set({ from: e.target.value })} />
                    </div>
                    <div className="field">
                      <label>Platí do</label>
                      <input type="datetime-local" value={draft.to}
                        onChange={e => set({ to: e.target.value })} />
                    </div>
                  </div>
                  <p className="desc">Časy jsou pražské a platí na minutu přesně; konec je včetně své minuty.</p>

                  {clashes.length > 0 && (
                    <div className="wt-clash">
                      <b><Icon name="alert" size={13} /> Překrývá se s jinou změnou</b>
                      <ul>
                        {clashes.map(c => (
                          <li key={c.id}>
                            {c.name} — {whenLabel({ ...blankPlan(), from: c.from, to: c.to })}
                            {c.shortenTo ? '' : ' (začíná později, zkrátit ji nejde)'}
                          </li>
                        ))}
                      </ul>
                      {shortenable.length > 0 && (
                        <button className="btn ghost" onClick={shorten} disabled={!!busy}>
                          <Icon name="clock" size={14} /> Uložit a zkrátit předchozí na {shortenable[0].shortenTo.replace('T', ' ')}
                        </button>
                      )}
                    </div>
                  )}

                  <div className="tabs wt-langs">
                    {LANGS.map(l => (
                      <button key={l.id} className={`tab ${lang === l.id ? 'active' : ''}`} onClick={() => setLang(l.id)}>
                        {l.label} <small>{l.hint}</small>
                      </button>
                    ))}
                    <span className="wt-spacer" />
                    <button className="btn ghost" onClick={translatePlan} disabled={!!busy}>
                      <Icon name="globe" size={14} /> Přeložit do SK a EN
                    </button>
                  </div>
                  <p className="desc">
                    Emoji piš rovnou. Slovo mezi dvěma hvězdičkami — <code>**takhle**</code> — bude na webu tučné.
                    Překlad doplní jen prázdná políčka a nechává adresy odkazů být.
                  </p>

                  <Area
                    title="Box u produktu"
                    hint="Expedice, předpokládané doručení a osobní odběr"
                    on={!!product?.on}
                    onToggle={on => set({ product: { ...draft.product, on } })}
                  >
                    <div className="wt-two">
                      <TextField label="Nadpis boxu" lang={lang} value={draft.product.header}
                        hint="PŘEDPOKLÁDANÝ STAV DORUČENÍ:"
                        onChange={header => set({ product: { ...draft.product, header } })} />
                      <label className="wt-check">
                        <input type="checkbox" checked={draft.product.hideHeader}
                          onChange={e => set({ product: { ...draft.product, hideHeader: e.target.checked } })} />
                        Nadpis neukazovat
                      </label>
                    </div>

                    <TextField label="Řádek pod nadpisem" lang={lang} value={draft.product.above}
                      hint="nepovinné — vloží se nad tři řádky"
                      onChange={above => set({ product: { ...draft.product, above } })} />

                    <TextField
                      label="Místo tří řádků jeden náhradní text" rows={2} lang={lang}
                      value={draft.product.one}
                      hint="Vyplněním se tři řádky níž nahradí tímhle jedním"
                      onChange={one => set({ product: { ...draft.product, one } })}
                    />

                    <fieldset className={`wt-lines ${oneMode ? 'muted' : ''}`}>
                      <legend>
                        {oneMode ? 'Tři řádky (teď je nahrazuje text výš)' : 'Tři řádky boxu'}
                        {' '}— mění se jen hodnota za dvojtečkou, popisek zůstává
                      </legend>
                      <div className="field">
                        <label>Expedujeme od (nepovinné)</label>
                        <input type="date" value={draft.product.shipFrom}
                          onChange={e => set({ product: { ...draft.product, shipFrom: e.target.value } })} />
                        <span className="desc">
                          Datum řídí obojí: doplní se do řádku o expedici a <b>počítá se z něj i odhad
                          doručení</b> (první pracovní den po něm). Bez data se odhad počítá z dneška,
                          takže by box mohl hlásit expedici za deset dní a doručení zítra.
                        </span>
                      </div>

                      <div className="wt-two">
                        <TextField label="Expedice" lang={lang} value={draft.product.ship}
                          hint="prázdné = počítá se podle času a svátků"
                          onChange={ship => set({ product: { ...draft.product, ship } })} />
                        <label className="wt-check">
                          <input type="checkbox" checked={draft.product.hideShip}
                            onChange={e => set({ product: { ...draft.product, hideShip: e.target.checked } })} />
                          Neukazovat
                        </label>
                      </div>
                      <div className="wt-two">
                        <TextField label="Předpokládané doručení" lang={lang} value={draft.product.delivery}
                          hint="prázdné = počítá se podle času a svátků"
                          onChange={delivery => set({ product: { ...draft.product, delivery } })} />
                        <label className="wt-check">
                          <input type="checkbox" checked={draft.product.hideDelivery}
                            onChange={e => set({ product: { ...draft.product, hideDelivery: e.target.checked } })} />
                          Neukazovat
                        </label>
                      </div>
                      <div className="wt-two">
                        <TextField label="Osobní odběr" lang={lang} value={draft.product.pickup}
                          hint="prázdné = původní text, jen když je skladem"
                          onChange={pickup => set({ product: { ...draft.product, pickup } })} />
                        <label className="wt-check">
                          <input type="checkbox" checked={draft.product.hidePickup}
                            onChange={e => set({ product: { ...draft.product, hidePickup: e.target.checked } })} />
                          Neukazovat
                        </label>
                      </div>
                    </fieldset>

                    <TextField label="Řádek pod boxem" lang={lang} value={draft.product.below}
                      hint="nepovinné" onChange={below => set({ product: { ...draft.product, below } })} />

                    {/*
                      * Lišta nad boxem slibuje doručení podle téhož kalendáře.
                      * Kdyby o změněné expedici nevěděla, tvrdila by nad boxem
                      * „Zítra u Vás“ zrovna ve chvíli, kdy box hlásí odeslání
                      * za deset dní — a zákazník vidí obojí naráz.
                      */}
                    {shipChanged && !draft.topbar.on && (
                      <p className="wt-note">
                        <Icon name="alert" size={13} />
                        {draft.product.shipFrom
                          ? ` Horní lišta se přizpůsobí sama: bude hlásit „Odesíláme `
                            + `${dayLabel(draft.product.shipFrom)}“, dokud jí nedáš vlastní text.`
                          : ' Horní lišta přestane slibovat konkrétní den — dokud jí nedáš vlastní text, '
                            + 'napíše „Objednávku připravíme co nejdříve“.'}
                      </p>
                    )}
                  </Area>

                  <Area
                    title="Horní lišta s doručením"
                    hint="Jeden text přes celou šířku hlavičky"
                    on={draft.topbar.on}
                    onToggle={on => set({ topbar: { ...draft.topbar, on } })}
                  >
                    <TextField label="Náhradní text" rows={2} lang={lang} value={draft.topbar.text}
                      hint="✨ Do 6. 1. máme dovolenou • Objednávky odesíláme hned poté"
                      onChange={text => set({ topbar: { ...draft.topbar, text } })} />
                  </Area>

                  <Area
                    title="Lišta s odkazy"
                    hint="Střídající se odkazy pod hlavičkou"
                    on={draft.links.on}
                    onToggle={on => set({ links: { ...draft.links, on } })}
                  >
                    <div className="field">
                      <label>Co s původními odkazy</label>
                      <select
                        value={draft.links.mode}
                        onChange={e => set({ links: { ...draft.links, mode: e.target.value as any } })}
                      >
                        <option value="add">Nechat a přidat k nim nové</option>
                        <option value="replace">Nahradit je novými</option>
                        <option value="off">Lištu vůbec neukazovat</option>
                      </select>
                    </div>

                    {draft.links.mode !== 'off' && (
                      <>
                        {draft.links.items.map((item, i) => (
                          <div className="wt-link" key={i}>
                            <TextField label={`Text ${i + 1}`} lang={lang} value={item.text}
                              onChange={text => set({
                                links: {
                                  ...draft.links,
                                  items: draft.links.items.map((x, j) => (j === i ? { ...x, text } : x))
                                }
                              })} />
                            <TextField label="Odkaz" lang={lang} value={item.href}
                              hint="https://www.quentino.cz/…"
                              onChange={href => set({
                                links: {
                                  ...draft.links,
                                  items: draft.links.items.map((x, j) => (j === i ? { ...x, href } : x))
                                }
                              })} />
                            <label className="wt-check">
                              <input type="checkbox" checked={item.blank}
                                onChange={e => set({
                                  links: {
                                    ...draft.links,
                                    items: draft.links.items.map((x, j) =>
                                      (j === i ? { ...x, blank: e.target.checked } : x))
                                  }
                                })} />
                              Nová záložka
                            </label>
                            <button className="icon-btn" title="Odebrat odkaz"
                              onClick={() => set({
                                links: { ...draft.links, items: draft.links.items.filter((_, j) => j !== i) }
                              })}>
                              <Icon name="trash" size={15} />
                            </button>
                          </div>
                        ))}
                        <button
                          className="btn ghost"
                          disabled={draft.links.items.length >= 8}
                          onClick={() => set({
                            links: {
                              ...draft.links,
                              items: [...draft.links.items,
                                { text: emptyText(), href: emptyText(), blank: false } as WebLink]
                            }
                          })}
                        >
                          <Icon name="plus" size={14} /> Přidat odkaz
                        </button>
                      </>
                    )}
                  </Area>

                  <Area
                    title="Bublina u tlačítka objednávky"
                    hint="Ukáže se při najetí myší; na dotyku se napíše pod tlačítko"
                    on={draft.button.on}
                    onToggle={on => set({ button: { ...draft.button, on } })}
                  >
                    <TextField label="Text bubliny" rows={2} lang={lang} value={draft.button.text}
                      hint="Odesíláme do 24 hodin, doprava zdarma nad 1 500 Kč"
                      onChange={text => set({ button: { ...draft.button, text } })} />
                  </Area>

                  <div className="wt-foot">
                    {draft.id && (
                      <>
                        <button className="btn ghost danger" onClick={() => remove(draft.id)} disabled={!!busy}>
                          <Icon name="trash" size={14} /> Smazat
                        </button>
                        <button className="btn ghost" onClick={() => toggle(draft)} disabled={!!busy}>
                          <Icon name={draft.off ? 'check' : 'ban'} size={14} />
                          {draft.off ? ' Zapnout' : ' Vypnout'}
                        </button>
                      </>
                    )}
                    <span className="wt-spacer" />
                    <button className="btn ghost" onClick={() => setDraft(null)} disabled={!!busy}>Zavřít</button>
                    <button className="btn primary" onClick={save} disabled={!!busy}>
                      <Icon name="save" size={14} /> Uložit a vystavit
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        ) : tab === 'xmas' ? (
          <div className="modal-body wt-setup">
            {/*
              * Garance není naplánovaná změna: platí každý rok ve stejném
              * období a mění se u ní nanejvýš datum a znění. Kdyby se dělala
              * jako změna v plánu, muselo by se na ni každý listopad myslet
              * znovu — a rok, kdy se zapomene, by e-shop mlčel zrovna
              * v prosinci.
              */}
            <p className="desc">
              Věta, která se v období před Vánoci ukazuje nad boxem u produktu i v horní liště.
              Platí každý rok ve stejném období, takže se nemusí pokaždé zakládat znovu — mění se
              u ní nanejvýš datum a znění.
            </p>

            <label className="wt-check">
              <input type="checkbox" checked={!!xmas?.on}
                onChange={e => setXmas(x => (x ? { ...x, on: e.target.checked } : x))} />
              Garanci ukazovat
            </label>

            {xmas?.on && (
              <>
                <div className="wt-season">
                  <div className="field">
                    <label>Od (den a měsíc)</label>
                    <div className="wt-daymonth">
                      <input type="number" min={1} max={31} value={xmas.fromDay}
                        onChange={e => setXmas(x => (x ? { ...x, fromDay: Number(e.target.value) } : x))} />
                      <span>.</span>
                      <input type="number" min={1} max={12} value={xmas.fromMonth}
                        onChange={e => setXmas(x => (x ? { ...x, fromMonth: Number(e.target.value) } : x))} />
                      <span>.</span>
                    </div>
                  </div>
                  <div className="field">
                    <label>Do (den a měsíc)</label>
                    <div className="wt-daymonth">
                      <input type="number" min={1} max={31} value={xmas.toDay}
                        onChange={e => setXmas(x => (x ? { ...x, toDay: Number(e.target.value) } : x))} />
                      <span>.</span>
                      <input type="number" min={1} max={12} value={xmas.toMonth}
                        onChange={e => setXmas(x => (x ? { ...x, toMonth: Number(e.target.value) } : x))} />
                      <span>.</span>
                    </div>
                  </div>
                </div>

                <div className="tabs wt-langs">
                  {LANGS.map(l => (
                    <button key={l.id} className={`tab ${lang === l.id ? 'active' : ''}`}
                      onClick={() => setLang(l.id)}>
                      {l.label} <small>{l.hint}</small>
                    </button>
                  ))}
                  <span className="wt-spacer" />
                  <button className="btn ghost" onClick={translateSeason} disabled={!!busy}>
                    <Icon name="globe" size={14} /> Přeložit do SK a EN
                  </button>
                </div>

                <TextField
                  label="Znění garance" rows={2} lang={lang} value={xmas.text}
                  hint="🎄 Garance doručení do Vánoc při objednání do 18.12."
                  onChange={text => setXmas(x => (x ? { ...x, text } : x))}
                />
                <span className="desc">
                  Prázdné = vestavěné znění. Pozor na datum uvnitř věty — když se posune období,
                  je potřeba přepsat i text, ten se sám nepočítá. Emoji a <code>**tučně**</code> fungují.
                </span>
              </>
            )}

            <div className="wt-foot">
              <span className="wt-spacer" />
              <button className="btn primary" onClick={saveSeason} disabled={!!busy || !xmas}>
                <Icon name="save" size={14} /> Uložit a vystavit
              </button>
            </div>
          </div>
        ) : (
          <div className="modal-body wt-setup">
            <p className="desc">
              Plán se vystavuje jako jeden veřejný soubor do úložiště Supabase. Web z něj čte přes CDN,
              takže se tím nebudí databáze a stránka se nezdrží — skript nejdřív vykreslí dynamický text
              a plán dotáhne až potom. Kbelík si aplikace v případě potřeby založí sama.
            </p>

            <div className="field">
              <label>Adresa projektu Supabase</label>
              <input
                value={config?.url ?? ''}
                placeholder="https://xxxx.supabase.co (prázdné = projekt chatu)"
                onChange={e => setConfig(c => (c ? { ...c, url: e.target.value } : c))}
              />
            </div>
            <div className="field">
              <label>Servisní klíč (service_role)</label>
              <input
                type="password"
                value={key}
                placeholder={config?.hasKey ? 'uložený — nech prázdné, pokud se nemění' : 'z Supabase → Project settings → API'}
                onChange={e => setKey(e.target.value)}
              />
              <span className="desc">
                Zapisuje se jím do úložiště. Zůstává zašifrovaný v tomhle počítači, na web se neposílá
                — tam jde jen hotový soubor s plánem.
              </span>
            </div>
            <div className="field-grid">
              <div className="field">
                <label>Kbelík</label>
                <input value={config?.bucket ?? ''}
                  onChange={e => setConfig(c => (c ? { ...c, bucket: e.target.value } : c))} />
              </div>
              <div className="field">
                <label>Soubor</label>
                <input value={config?.path ?? ''}
                  onChange={e => setConfig(c => (c ? { ...c, path: e.target.value } : c))} />
              </div>
            </div>
            <div className="field">
              <label>Jak dlouho prohlížeči stačí uložená kopie (sekundy)</label>
              <input type="number" min={5} max={3600} value={config?.ttl ?? 300}
                onChange={e => setConfig(c => (c ? { ...c, ttl: Number(e.target.value) } : c))} />
              <span className="desc">
                Netýká se začátku a konce změn — ty si prohlížeč spočítá i z hodinu staré kopie.
                Určuje jen, za jak dlouho se na webu projeví nově naplánovaná změna.
                Na zkoušení jde dát i 5 vteřin; pro provoz patří 300 a víc, jinak si prohlížeč
                sahá pro plán po každé druhé stránce.
              </span>
            </div>
            <div className="field">
              <label>Odkud to čte web</label>
              <input value={config?.publicUrl ?? ''} readOnly />
            </div>

            <div className="field">
              <label>Skript na konec &lt;head&gt; e-shopu</label>
              <textarea className="wt-script" rows={8} readOnly value={state?.script ?? ''} />
              <span className="desc">
                Nahrazuje všechny čtyři dosavadní skripty najednou. Adresa plánu je v něm už doplněná,
                takže po změně úložiště je potřeba ho zkopírovat znovu.
              </span>
            </div>

            <div className="wt-foot">
              <button className="btn ghost" onClick={copyScript} disabled={!state?.script}>
                <Icon name="copy" size={14} /> Zkopírovat skript
              </button>
              <span className="wt-spacer" />
              <button className="btn primary" onClick={saveConfig} disabled={!!busy}>
                <Icon name="save" size={14} /> Uložit napojení
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
