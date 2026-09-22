import { useCallback, useEffect, useState } from 'react';
import type { Banner, BannerClash, BannerSet, BannersState, WebText } from '@shared/types';
import { api } from '../api';
import { toWebp } from '../media';
import { useToast } from '../toast';
import { inToolWindow } from '../toolwindows';
import Icon from './Icon';
import BannerPreview, { type PreviewDevice } from './BannerPreview';

/**
 * Bannery na úvodní stránce e-shopu.
 *
 * ## Podle čeho je to postavené
 *
 * Vlevo **sady** seřazené v čase, uprostřed jedna sada a jeden banner
 * v ní, vpravo **živý náhled**. Náhled není ozdoba: bannery jsou jediná
 * věc na webu, u které se rozhoduje okem, a bez něj by se každá změna
 * musela vystavit, aby se zjistilo, jak vypadá.
 *
 * ## Proč se plánují celé sady
 *
 * Čtyři dlaždice na úvodní stránce jsou vždycky jedna kampaň. Kdyby měl
 * každý banner vlastní platnost, musely by se hlídat čtyři časy a první
 * den akce by na stránce byly dva nové bannery a dva staré.
 *
 * ## Co se hlídá za člověka
 *
 * - **Čitelnost.** Fotka s textem dostane ztmavení, i kdyby se posuvník
 *   stáhl na nulu. Bílý nadpis na světlé látce na telefonu ve slunci
 *   nepřečte nikdo.
 * - **Odkazy do ostatních trhů.** Vyplňuje se česká adresa; slovenskou
 *   a anglickou dopočítá mapa adres, ne model — uhodnutý slovenský slug
 *   vede na stránku 404.
 * - **Poskakování.** Dlaždice mají pevný poměr stran a rotace prolíná
 *   místo posouvání, takže se stránka pod bannerem nehne.
 */

type Lang = 'cz' | 'sk' | 'en';

const LANGS: { id: Lang; label: string; hint: string }[] = [
  { id: 'cz', label: 'Česky', hint: 'quentino.cz' },
  { id: 'sk', label: 'Slovensky', hint: 'quentino.sk' },
  { id: 'en', label: 'English', hint: 'wearquentino.com' }
];

const emptyText = (): WebText => ({ cz: '', sk: '', en: '' });
const hasText = (t?: WebText) => !!(t && (t.cz || t.sk || t.en));

/** Emoji, která se u bannerů používají nejčastěji — ať se nehledá v systému. */
const EMOJI = ['🎁', '❄️', '🎄', '⏳', '🔥', '✨', '💙', '🚚', '🏷️', '👔', '🎀', '⭐'];

const EFFECTS: { id: Banner['smart']['effect']; label: string; hint: string }[] = [
  { id: 'none', label: 'Bez pohybu', hint: 'Klidná dlaždice' },
  { id: 'snow', label: 'Padající emoji', hint: 'Sype se uvnitř dlaždice' },
  { id: 'shine', label: 'Přejezd lesku', hint: 'Světlo přejede jednou za pár vteřin' },
  { id: 'pulse', label: 'Tep emoji', hint: 'Emoji v rohu se nadechne' },
  { id: 'float', label: 'Plavání emoji', hint: 'Emoji se zlehka houpe' }
];

const KINDS: { id: Banner['smart']['kind']; label: string; hint: string }[] = [
  { id: 'none', label: 'Obyčejný', hint: 'Fotka, nadpis, tlačítko' },
  { id: 'countdown', label: 'Odpočet', hint: 'Do konce akce, tiká i v noci' },
  { id: 'code', label: 'Slevový kód', hint: 'Klepnutím se zkopíruje' },
  { id: 'delivery', label: 'Doručení do Vánoc', hint: 'Datum poslední objednávky a kolik zbývá' }
];

/** Čas na hodinách v podobě, kterou chce `datetime-local`. */
function localNow(offsetMinutes = 0): string {
  const d = new Date(Date.now() + offsetMinutes * 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function blankBanner(): Banner {
  return {
    id: '',
    name: '',
    off: false,
    copy: { title: emptyText(), text: emptyText(), button: emptyText(), href: emptyText() },
    look: {
      image: '', bg: '#1c1c22', fg: '#ffffff', overlay: 40,
      align: 'left', pos: 'bottom', focus: '50% 50%'
    },
    smart: { kind: 'none', until: '', untilMs: 0, code: '', emoji: '', effect: 'none' }
  };
}

/**
 * Předlohy.
 *
 * Nejsou to ozdoby: rozdíl mezi „prázdný banner" a „banner s odpočtem"
 * je pět políček na čtyřech různých místech a kdo si na ně nevzpomene,
 * udělá obyčejnou dlaždici. Předloha je nastaví a zbyde napsat text.
 */
const PRESETS: { id: string; label: string; emoji: string; make: () => Banner }[] = [
  {
    id: 'foto', label: 'Fotka s nadpisem', emoji: '🖼️',
    make: () => blankBanner()
  },
  {
    id: 'odpocet', label: 'Akce s odpočtem', emoji: '⏳',
    make: () => {
      const one = blankBanner();
      one.name = 'Akce s odpočtem';
      one.smart = {
        kind: 'countdown', until: localNow(3 * 24 * 60), untilMs: 0,
        code: '', emoji: '⏳', effect: 'pulse'
      };
      one.look = { ...one.look, bg: '#7a1d1d', overlay: 45, pos: 'bottom' };
      return one;
    }
  },
  {
    id: 'kod', label: 'Sleva s kódem', emoji: '🏷️',
    make: () => {
      const one = blankBanner();
      one.name = 'Sleva s kódem';
      one.smart = { kind: 'code', until: '', untilMs: 0, code: 'SLEVA10', emoji: '🏷️', effect: 'shine' };
      one.look = { ...one.look, bg: '#1d3a7a', overlay: 45 };
      return one;
    }
  },
  {
    id: 'vanoce', label: 'Doručení do Vánoc', emoji: '🎄',
    make: () => {
      const one = blankBanner();
      one.name = 'Doručení do Vánoc';
      const year = new Date().getFullYear();
      one.copy.title.cz = 'Stihneme to pod stromeček';
      one.smart = {
        kind: 'delivery', until: `${year}-12-18T12:00`, untilMs: 0,
        code: '', emoji: '❄️', effect: 'snow'
      };
      one.look = { ...one.look, bg: '#123a52', overlay: 42, align: 'center', pos: 'middle' };
      return one;
    }
  }
];

/**
 * Nový identifikátor.
 *
 * Sada i banner ho dostanou **už v okně**, ne až při uložení. Bez toho by
 * se po uložení musela hledat podle jména, a dvě sady se stejným jménem by
 * se v tu chvíli zaměnily — člověk by pak upravoval jinou, než kterou měl
 * před sebou.
 */
const newId = () => (globalThis.crypto?.randomUUID?.()
  ?? `nova-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`);

function blankSet(): BannerSet {
  return {
    id: newId(), name: '', from: '', to: '', fromMs: 0, toMs: 0, off: false,
    layout: 'quad', phone: 'grid', rotate: 0,
    banners: [{ ...blankBanner(), id: newId() }]
  };
}

function whenLabel(set: BannerSet): string {
  if (!set.from && !set.to) return 'Platí pořád';
  const nice = (s: string) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s);
    return m ? `${+m[3]}. ${+m[2]}. ${m[4]}:${m[5]}` : s;
  };
  if (!set.to) return `od ${nice(set.from)}`;
  if (!set.from) return `do ${nice(set.to)}`;
  return `${nice(set.from)} – ${nice(set.to)}`;
}

type Phase = 'off' | 'live' | 'soon' | 'done';

const PHASES: Record<Phase, string> = {
  off: 'vypnuto', live: 'na webu', soon: 'chystá se', done: 'doběhlo'
};

function phaseOf(set: BannerSet): Phase {
  if (set.off) return 'off';
  const now = Date.now();
  if (set.from && now < set.fromMs) return 'soon';
  if (set.to && now > set.toMs) return 'done';
  return 'live';
}

export default function BannersModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const okno = inToolWindow();
  const [state, setState] = useState<BannersState | null>(null);
  const [draft, setDraft] = useState<BannerSet | null>(null);
  const [pick, setPick] = useState(0);
  const [lang, setLang] = useState<Lang>('cz');
  const [device, setDevice] = useState<PreviewDevice>('pc');
  const [tab, setTab] = useState<'sady' | 'kod'>('sady');
  /** Náhled přes celé okno — zmenšený na dvě pětiny se texty nepřečtou */
  const [solo, setSolo] = useState(false);
  const [clashes, setClashes] = useState<BannerClash[]>([]);
  const [busy, setBusy] = useState('');
  const [hrefHint, setHrefHint] = useState('');

  const apply = useCallback((next: BannersState, message?: string) => {
    setState(next);
    if (next.error) toast(next.error, 'error');
    else if (message) toast(message);
  }, [toast]);

  useEffect(() => {
    let alive = true;
    setBusy('Načítám');
    api.banners.load()
      .then(next => { if (alive) setState(next); })
      .catch(e => toast(String(e?.message ?? e), 'error'))
      .finally(() => { if (alive) setBusy(''); });
    return () => { alive = false; };
  }, [toast]);

  const sets = state?.sets ?? [];

  /* Překryvy se hlídají při psaní data, ne až při uložení. */
  const when = draft ? `${draft.id}|${draft.from}|${draft.to}|${draft.off}` : '';
  useEffect(() => {
    if (!draft || (!draft.from && !draft.to)) { setClashes([]); return; }
    let alive = true;
    api.banners.clashes(draft)
      .then(found => { if (alive) setClashes(found); })
      .catch(() => { if (alive) setClashes([]); });
    return () => { alive = false; };
  }, [when]);

  const shortenable = clashes.filter(one => one.shortenTo);

  const banner: Banner | null = draft?.banners[pick] ?? null;

  const setSet = (patch: Partial<BannerSet>) => setDraft(d => (d ? { ...d, ...patch } : d));

  const setBanner = (patch: Partial<Banner>) => setDraft(d => {
    if (!d) return d;
    const banners = d.banners.map((one, i) => (i === pick ? { ...one, ...patch } : one));
    return { ...d, banners };
  });

  const setCopy = (field: keyof Banner['copy'], value: string) => setBanner(banner ? {
    copy: { ...banner.copy, [field]: { ...banner.copy[field], [lang]: value } }
  } : {});

  const setLook = (patch: Partial<Banner['look']>) =>
    setBanner(banner ? { look: { ...banner.look, ...patch } } : {});

  const setSmart = (patch: Partial<Banner['smart']>) =>
    setBanner(banner ? { smart: { ...banner.smart, ...patch } } : {});

  /* ---------- akce ---------- */

  const run = async (label: string, work: () => Promise<BannersState>, done?: string) => {
    setBusy(label);
    try {
      apply(await work(), done);
    } catch (e: any) {
      toast(String(e?.message ?? e), 'error');
    } finally {
      setBusy('');
    }
  };

  const save = () => draft && run('Ukládám', async () => {
    const next = await api.banners.save(draft);
    // Uložená podoba může být přísnější (dorovnané ztmavení) — ukáže se hned
    const saved = next.sets.find(one => one.id === draft.id);
    if (saved) setDraft(saved);
    return next;
  }, 'Sada je na webu.');

  const saveAndShorten = () => draft && run('Ukládám', async () => {
    await api.banners.save(draft);
    return api.banners.shorten(draft.id, shortenable.map(one => one.id));
  }, 'Uloženo, předchozí sada zkrácena.');

  const remove = (id: string) => {
    if (!window.confirm('Smazat sadu bannerů? Z webu zmizí hned.')) return;
    run('Mažu', () => api.banners.remove(id), 'Sada je pryč.');
    if (draft?.id === id) setDraft(null);
  };

  const translate = () => draft && run('Překládám', async () => {
    setDraft(await api.banners.translate(draft));
    // Rovnou na slovenštinu: překlad se má zkontrolovat, ne jen spustit
    setLang('sk');
    return api.banners.state();
  }, 'Slovenština a angličtina doplněny — projdi je a ulož.');

  /** Kam povede český odkaz jinde — ptá se to hned, ne až po uložení. */
  const resolveHref = async () => {
    if (!banner?.copy.href.cz) return;
    try {
      const found = await api.banners.href(banner.copy.href.cz);
      setBanner({
        copy: {
          ...banner.copy,
          href: { cz: banner.copy.href.cz, sk: found.sk, en: found.en }
        }
      });
      /*
       * Odkud návrh je, se říká nahlas: „z přepínače jazyků na té stránce"
       * je jistota, kdežto „stejná cesta na jiné doméně" je dohad, u kterého
       * se vyplatí kliknout a podívat se.
       */
      const via = (v: string) => (v === 'page' || v === 'product'
        ? 'podle e-shopu' : v === 'map' ? 'z naučené mapy' : 'jen doménou — radši zkontroluj');
      setHrefHint(`SK ${via(found.skVia)} · EN ${via(found.enVia)}`);
    } catch (e: any) {
      toast(String(e?.message ?? e), 'error');
    }
  };

  const uploadImage = async (file: File) => {
    if (!state?.uploadReady) {
      toast('Chybí napojení na úložiště — nastav ho v Textech na webu.', 'error');
      return;
    }
    setBusy('Převádím a nahrávám');
    try {
      const raw = new Uint8Array(await file.arrayBuffer());
      /*
       * Zmenšuje se na 1800 px: širší banner než dva tisíce bodů na
       * e-shopu není a fotka z foťáku by do úvodní stránky přinesla
       * pár megabajtů, které Google počítá do hodnocení.
       */
      const done = await toWebp(raw, {
        quality: 82, resize: 'max', maxWidth: 1800, maxHeight: 1800,
        exactWidth: 0, exactHeight: 0, percent: 100, keepSmaller: true
      });
      const url = await api.banners.upload(file.name, Array.from(done.bytes));
      setLook({ image: url });
      const saved = Math.max(0, Math.round((1 - done.bytes.length / Math.max(1, raw.length)) * 100));
      toast(`Fotka nahrána · ${Math.round(done.bytes.length / 1024)} kB (o ${saved} % míň)`);
    } catch (e: any) {
      toast(String(e?.message ?? e), 'error');
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

  /* ---------- práce s bannery v sadě ---------- */

  const addBanner = (make: () => Banner) => setDraft(d => {
    if (!d) return d;
    const one = { ...make(), id: newId() };
    setPick(d.banners.length);
    return { ...d, banners: [...d.banners, one] };
  });

  const moveBanner = (by: number) => setDraft(d => {
    if (!d) return d;
    const to = pick + by;
    if (to < 0 || to >= d.banners.length) return d;
    const banners = [...d.banners];
    [banners[pick], banners[to]] = [banners[to], banners[pick]];
    setPick(to);
    return { ...d, banners };
  });

  const dropBanner = () => setDraft(d => {
    if (!d || d.banners.length <= 1) return d;
    const banners = d.banners.filter((_, i) => i !== pick);
    setPick(Math.max(0, pick - 1));
    return { ...d, banners };
  });

  const copyBanner = () => setDraft(d => {
    if (!d) return d;
    const one = { ...d.banners[pick], id: newId() };
    setPick(d.banners.length);
    return { ...d, banners: [...d.banners, one] };
  });

  /** Kolik dlaždic se na stránku vejde — podle toho má rotace smysl. */
  const perPage = draft?.layout === 'wide' ? 1 : 4;
  const pages = draft ? Math.ceil(draft.banners.length / perPage) : 0;

  // Vysvětlivka u odkazu platí pro jeden banner; u dalšího by lhala
  useEffect(() => setHrefHint(''), [pick, draft?.id]);

  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal bn-modal">
        <div className="modal-head">
          <span className="modal-title"><Icon name="drawGrid" size={15} /> Bannery</span>
          <div className="wt-head-right">
            <button className={`tab ${tab === 'sady' ? 'active' : ''}`} onClick={() => setTab('sady')}>Sady</button>
            <button className={`tab ${tab === 'kod' ? 'active' : ''}`} onClick={() => setTab('kod')}>Kód do e-shopu</button>
            {!okno && (
              <button className="icon-btn" onClick={onClose} disabled={!!busy}><Icon name="x" size={16} /></button>
            )}
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
            <span className="desc">Zatím nic nevystaveno — na webu je původní karusel.</span>
          )}
          <span className="wt-spacer" />
          {busy && <span className="desc">{busy}…</span>}
          <button className="btn ghost" disabled={!!busy || !state?.config.ready}
            onClick={() => run('Vystavuji', () => api.banners.publish(), 'Vystaveno.')}>
            <Icon name="upload" size={14} /> Vystavit znovu
          </button>
        </div>

        {tab === 'kod' ? (
          <div className="bn-code">
            <p className="desc">
              Tenhle kus kódu patří na <b>konec hlavičky</b> e-shopu (Upgates → Vzhled → HTML kódy →
              konec <code>&lt;head&gt;</code>). Schová původní karusel a na jeho místo nakreslí
              bannery z plánu. Vloží se <b>jednou</b>; další změny už jdou přes úložiště a v šabloně
              se nesahá na nic.
            </p>
            <p className="desc">
              Je v něm zapečená <b>záložní sada</b>
              {state?.fallbackId
                ? <> — „{sets.find(one => one.id === state.fallbackId)?.name || 'bez názvu'}"</>
                : <> — zatím žádná, vyber ji u sady tlačítkem „Dát do kódu"</>}.
              Ta se vykreslí hned při otevření stránky a zůstane, i kdyby úložiště nebylo dostupné.
              Když ji změníš, <b>zkopíruj skript znovu</b> — do šablony se sám nedostane.
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn primary" onClick={copyScript} disabled={!state?.script}>
                <Icon name="copy" size={14} /> Zkopírovat skript
              </button>
            </div>
            <textarea className="bn-script" readOnly value={state?.script ?? ''} spellCheck={false} />
          </div>
        ) : (
          <div className={`bn-body ${solo ? 'solo' : ''}`}>
            <aside className="wt-list">
              <button className="btn" disabled={!!busy}
                onClick={() => { setDraft(blankSet()); setPick(0); setLang('cz'); }}>
                <Icon name="plus" size={14} /> Nová sada
              </button>
              {sets.length === 0 && (
                <p className="desc" style={{ padding: '10px 2px' }}>
                  Zatím žádná sada. Na úvodní stránce je původní karusel z Upgates.
                </p>
              )}
              {sets.map(one => {
                const phase = phaseOf(one);
                return (
                  <button
                    key={one.id}
                    className={`wt-row ${phase} ${draft?.id === one.id ? 'sel' : ''}`}
                    onClick={() => { setDraft(one); setPick(0); setLang('cz'); }}
                  >
                    <span className="wt-row-top">
                      <b>{one.name || 'Beze jména'}</b>
                      <em className={`wt-badge ${phase}`}>{PHASES[phase]}</em>
                    </span>
                    <span className="desc">{whenLabel(one)}</span>
                    <span className="wt-chips">
                      <em>{one.banners.length} {one.banners.length === 1 ? 'banner' : 'bannery'}</em>
                      <em>{one.layout === 'wide' ? 'přes šířku' : '4 sloupce'}</em>
                      {one.rotate > 0 && <em>rotace {one.rotate} s</em>}
                      {state?.fallbackId === one.id && <em>v kódu</em>}
                    </span>
                  </button>
                );
              })}
            </aside>

            <div className="bn-edit">
              {!draft || !banner ? (
                <div className="empty-state" style={{ padding: '40px 10px' }}>
                  <div className="big">🖼️</div>
                  <p>Vyber sadu vlevo, nebo založ novou.</p>
                  <p className="desc">
                    Sada je to, co je na úvodní stránce vidět naráz. Plánuje se celá, aby první den
                    akce nebyly na stránce dva nové bannery a dva staré.
                  </p>
                </div>
              ) : (
                <>
                  <div className="bn-when">
                    <div className="field">
                      <label>Název sady</label>
                      <input value={draft.name} placeholder="Vánoční kampaň, výprodej…"
                        onChange={e => setSet({ name: e.target.value })} />
                    </div>
                    <label className="check-row">
                      <input type="checkbox" checked={!draft.from && !draft.to}
                        onChange={e => setSet(e.target.checked
                          ? { from: '', to: '' }
                          : { from: localNow(), to: localNow(7 * 24 * 60) })} />
                      Platí pořád
                    </label>
                    {(draft.from || draft.to) && (
                      <>
                        <div className="field">
                          <label>Od</label>
                          <input type="datetime-local" value={draft.from}
                            onChange={e => setSet({ from: e.target.value })} />
                        </div>
                        <div className="field">
                          <label>Do</label>
                          <input type="datetime-local" value={draft.to}
                            onChange={e => setSet({ to: e.target.value })} />
                        </div>
                      </>
                    )}
                  </div>
                  <p className="desc">
                    Časy jsou pražské. Sada se na webu objeví i zmizí sama — aplikace u toho být nemusí.
                    Při překryvu vyhraje ta, která začala později.
                  </p>

                  {clashes.length > 0 && (
                    <div className="wt-clash">
                      <b><Icon name="alert" size={13} /> Překrývá se s jinou sadou</b>
                      <ul>
                        {clashes.map(one => (
                          <li key={one.id}>
                            {one.name} — {whenLabel({ ...blankSet(), from: one.from, to: one.to })}
                            {one.shortenTo ? '' : ' (začíná později, zkrátit ji nejde)'}
                          </li>
                        ))}
                      </ul>
                      {shortenable.length > 0 && (
                        <button className="btn ghost" onClick={saveAndShorten} disabled={!!busy}>
                          <Icon name="clock" size={14} /> Uložit a zkrátit předchozí
                        </button>
                      )}
                    </div>
                  )}

                  <div className="bn-layout">
                    <div className="field">
                      <label>Na počítači</label>
                      <div className="tabs">
                        <button className={`tab ${draft.layout === 'quad' ? 'active' : ''}`}
                          onClick={() => setSet({ layout: 'quad' })}>4 sloupce</button>
                        <button className={`tab ${draft.layout === 'wide' ? 'active' : ''}`}
                          onClick={() => setSet({ layout: 'wide' })}>Přes šířku</button>
                      </div>
                    </div>
                    <div className="field">
                      <label>Na telefonu</label>
                      <div className="tabs">
                        <button className={`tab ${draft.phone === 'grid' ? 'active' : ''}`}
                          onClick={() => setSet({ phone: 'grid' })}>2 vedle sebe</button>
                        <button className={`tab ${draft.phone === 'wide' ? 'active' : ''}`}
                          onClick={() => setSet({ phone: 'wide' })}>Přes šířku</button>
                      </div>
                    </div>
                    <div className="field">
                      <label>Přetáčet po vteřinách</label>
                      <input type="number" min={0} max={60} value={draft.rotate}
                        onChange={e => setSet({ rotate: Number(e.target.value) || 0 })} />
                    </div>
                  </div>
                  <p className="desc">
                    {pages > 1
                      ? `${draft.banners.length} bannerů = ${pages} otočky po ${perPage}. `
                        + (draft.rotate > 0
                          ? 'Přetáčí se prolnutím, takže se stránka pod bannerem nehne.'
                          : 'Bez přetáčení bude vidět jen první otočka — nastav vteřiny.')
                      : 'Všechno se vejde na jednu obrazovku, přetáčet není co.'}
                  </p>

                  <div className="bn-strip">
                    {draft.banners.map((one, i) => (
                      <button key={one.id || i}
                        className={`bn-tile ${i === pick ? 'sel' : ''} ${one.off ? 'off' : ''}`}
                        onClick={() => setPick(i)}
                        style={{
                          backgroundColor: one.look.bg,
                          backgroundImage: one.look.image ? `url("${one.look.image}")` : undefined,
                          color: one.look.fg
                        }}
                      >
                        <span className="bn-tile-n">{i + 1}</span>
                        <span className="bn-tile-name">
                          {one.copy.title.cz || one.name || 'bez nadpisu'}
                        </span>
                      </button>
                    ))}
                    {draft.banners.length < 12 && (
                      <div className="bn-add">
                        {PRESETS.map(one => (
                          <button key={one.id} className="btn ghost" title={one.label}
                            onClick={() => addBanner(one.make)}>
                            {one.emoji} {one.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="bn-tools">
                    <button className="btn ghost" onClick={() => moveBanner(-1)} disabled={pick === 0}>
                      <Icon name="chevLeft" size={13} /> Dřív
                    </button>
                    <button className="btn ghost" onClick={() => moveBanner(1)}
                      disabled={pick >= draft.banners.length - 1}>
                      Později <Icon name="chevRight" size={13} />
                    </button>
                    <button className="btn ghost" onClick={copyBanner}>
                      <Icon name="copy" size={13} /> Duplikovat
                    </button>
                    <label className="check-row" style={{ margin: 0 }}>
                      <input type="checkbox" checked={banner.off}
                        onChange={e => setBanner({ off: e.target.checked })} />
                      Vypnout tenhle banner
                    </label>
                    <span className="wt-spacer" />
                    <button className="btn ghost danger" onClick={dropBanner}
                      disabled={draft.banners.length <= 1}>
                      <Icon name="trash" size={13} /> Smazat banner
                    </button>
                  </div>

                  <div className="tabs wt-langs">
                    {LANGS.map(l => (
                      <button key={l.id} className={`tab ${lang === l.id ? 'active' : ''}`}
                        onClick={() => setLang(l.id)}>
                        {l.label} <small>{l.hint}</small>
                      </button>
                    ))}
                    <span className="wt-spacer" />
                    <button className="btn ghost" onClick={translate} disabled={!!busy}>
                      <Icon name="globe" size={14} /> Přeložit celou sadu
                    </button>
                  </div>

                  <div className="field">
                    <label>Nadpis</label>
                    <input value={banner.copy.title[lang]} maxLength={70}
                      placeholder={lang === 'cz' ? 'Kšandy k obleku' : banner.copy.title.cz}
                      onChange={e => setCopy('title', e.target.value)} />
                  </div>
                  <div className="field">
                    <label>Text pod nadpisem</label>
                    <textarea rows={2} value={banner.copy.text[lang]} maxLength={180}
                      placeholder={lang === 'cz' ? 'Ručně šité, skladem' : banner.copy.text.cz}
                      onChange={e => setCopy('text', e.target.value)} />
                  </div>
                  <div className="bn-two">
                    <div className="field">
                      <label>Tlačítko</label>
                      <input value={banner.copy.button[lang]} maxLength={28}
                        placeholder={lang === 'cz' ? 'Prohlédnout' : banner.copy.button.cz}
                        onChange={e => setCopy('button', e.target.value)} />
                    </div>
                    <div className="field">
                      <label>Odkaz {lang !== 'cz' && <small>(dopočítaný z české verze)</small>}</label>
                      <input value={banner.copy.href[lang]} placeholder="/kravatove-sety"
                        onChange={e => setCopy('href', e.target.value)}
                        onBlur={() => { if (lang === 'cz') void resolveHref(); }} />
                    </div>
                  </div>
                  {lang === 'cz' && (
                    <p className="desc">
                      Stačí cesta od lomítka; slovenskou a anglickou adresu dopočítá mapa adres z článků.
                      {hrefHint && <> — {hrefHint}</>}
                    </p>
                  )}
                  <p className="desc">
                    Prázdné tlačítko nevadí: odkaz má celá dlaždice, takže se dá kliknout kamkoli.
                  </p>

                  <h4 className="bn-h">Vzhled</h4>
                  <div className="bn-two">
                    <div className="field">
                      <label>Fotka na pozadí</label>
                      <div className="bn-file">
                        <input type="file" accept="image/*" disabled={!!busy}
                          onChange={e => {
                            const file = e.target.files?.[0];
                            e.target.value = '';
                            if (file) void uploadImage(file);
                          }} />
                        {banner.look.image && (
                          <button className="btn ghost" onClick={() => setLook({ image: '' })}>
                            <Icon name="x" size={12} /> Odebrat
                          </button>
                        )}
                      </div>
                      <p className="desc">
                        Převede se na WebP a nahraje do úložiště sama. Fotka z foťáku je v pohodě —
                        zmenší se na 1800 px.
                      </p>
                    </div>
                    <div className="field">
                      <label>Výřez fotky</label>
                      <div className="bn-focus">
                        {['0%', '50%', '100%'].map(x => (
                          <div key={x} className="bn-focus-row">
                            {['0%', '50%', '100%'].map(y => {
                              const value = `${y} ${x}`;
                              return (
                                <button key={value}
                                  className={`bn-dot ${banner.look.focus === value ? 'sel' : ''}`}
                                  title={`Nechat vidět ${value}`}
                                  onClick={() => setLook({ focus: value })} />
                              );
                            })}
                          </div>
                        ))}
                      </div>
                      <p className="desc">
                        Dlaždice má pevný poměr stran, aby stránka nepodskakovala — fotka se proto
                        ořízne. Tady se vybere, co zůstane vidět.
                      </p>
                    </div>
                  </div>

                  <div className="bn-look">
                    <div className="field">
                      <label>Pozadí</label>
                      <input type="color" value={banner.look.bg}
                        onChange={e => setLook({ bg: e.target.value })} />
                    </div>
                    <div className="field">
                      <label>Písmo</label>
                      <input type="color" value={banner.look.fg}
                        onChange={e => setLook({ fg: e.target.value })} />
                    </div>
                    <div className="field bn-slider">
                      <label>Ztmavení fotky {banner.look.overlay} %</label>
                      <input type="range" min={banner.look.image && hasText(banner.copy.title) ? 18 : 0}
                        max={90} value={banner.look.overlay}
                        onChange={e => setLook({ overlay: Number(e.target.value) })} />
                    </div>
                    <div className="field">
                      <label>Zarovnání</label>
                      <div className="tabs">
                        {(['left', 'center', 'right'] as const).map(one => (
                          <button key={one} className={`tab ${banner.look.align === one ? 'active' : ''}`}
                            onClick={() => setLook({ align: one })}>
                            {one === 'left' ? 'Vlevo' : one === 'center' ? 'Na střed' : 'Vpravo'}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="field">
                      <label>Text v dlaždici</label>
                      <div className="tabs">
                        {(['top', 'middle', 'bottom'] as const).map(one => (
                          <button key={one} className={`tab ${banner.look.pos === one ? 'active' : ''}`}
                            onClick={() => setLook({ pos: one })}>
                            {one === 'top' ? 'Nahoře' : one === 'middle' ? 'Uprostřed' : 'Dole'}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                  {banner.look.image && (
                    <p className="desc">
                      Ztmavení pod textem se nedá stáhnout pod 18 % — bílý nadpis na světlé látce
                      na telefonu ve slunci nepřečte nikdo.
                    </p>
                  )}

                  <h4 className="bn-h">Chytrý banner</h4>
                  <div className="tabs">
                    {KINDS.map(one => (
                      <button key={one.id} className={`tab ${banner.smart.kind === one.id ? 'active' : ''}`}
                        title={one.hint} onClick={() => setSmart({ kind: one.id })}>
                        {one.label}
                      </button>
                    ))}
                  </div>
                  <p className="desc">{KINDS.find(one => one.id === banner.smart.kind)?.hint}</p>

                  {(banner.smart.kind === 'countdown' || banner.smart.kind === 'delivery') && (
                    <div className="field">
                      <label>{banner.smart.kind === 'delivery' ? 'Poslední objednávka do' : 'Odpočet do'}</label>
                      <input type="datetime-local" value={banner.smart.until}
                        onChange={e => setSmart({ until: e.target.value })} />
                      <p className="desc">
                        Počítá prohlížeč, ne aplikace — tiká i v noci a po vypršení odpočet sám zmizí.
                        Dlaždice zůstane, aby v mřížce nevznikla díra.
                      </p>
                    </div>
                  )}
                  {banner.smart.kind === 'code' && (
                    <div className="field">
                      <label>Slevový kód</label>
                      <input value={banner.smart.code} placeholder="SLEVA10"
                        onChange={e => setSmart({ code: e.target.value.toUpperCase() })} />
                      <p className="desc">Klepnutím na kód se zkopíruje a dlaždice přitom nikam neodejde.</p>
                    </div>
                  )}

                  <div className="bn-two">
                    <div className="field">
                      <label>Emoji</label>
                      <div className="bn-emoji">
                        <button className={`bn-em ${!banner.smart.emoji ? 'sel' : ''}`}
                          onClick={() => setSmart({ emoji: '' })}>bez</button>
                        {EMOJI.map(one => (
                          <button key={one} className={`bn-em ${banner.smart.emoji === one ? 'sel' : ''}`}
                            onClick={() => setSmart({ emoji: one })}>{one}</button>
                        ))}
                      </div>
                    </div>
                    <div className="field">
                      <label>Pohyb</label>
                      <select value={banner.smart.effect}
                        onChange={e => setSmart({ effect: e.target.value as Banner['smart']['effect'] })}>
                        {EFFECTS.map(one => <option key={one.id} value={one.id}>{one.label}</option>)}
                      </select>
                      <p className="desc">
                        {EFFECTS.find(one => one.id === banner.smart.effect)?.hint}
                        {banner.smart.effect === 'snow' && !banner.smart.emoji
                          ? ' — vyber emoji, jinak nemá co padat.'
                          : ''}
                        {' '}Komu systém hlásí, že nechce pohyb, se nic nehýbe.
                      </p>
                    </div>
                  </div>

                  <div className="bn-save">
                    <button className="btn primary" onClick={save} disabled={!!busy || !draft.name}>
                      <Icon name="save" size={14} /> Uložit a vystavit
                    </button>
                    {draft.id && (
                      <>
                        <button className="btn ghost" disabled={!!busy}
                          onClick={() => run('Ukládám', () => api.banners.toggle(draft.id, !draft.off))}>
                          <Icon name={draft.off ? 'check' : 'ban'} size={14} />
                          {draft.off ? ' Zapnout sadu' : ' Vypnout sadu'}
                        </button>
                        <button className="btn ghost" disabled={!!busy || state?.fallbackId === draft.id}
                          onClick={() => run('Ukládám', async () => {
                            const next = await api.banners.fallback(draft.id);
                            toast('Sada je v kódu. Zkopíruj skript znovu do šablony e-shopu.');
                            setTab('kod');
                            return next;
                          })}>
                          <Icon name="download" size={14} />
                          {state?.fallbackId === draft.id ? ' Je v kódu' : ' Dát do kódu'}
                        </button>
                        <span className="wt-spacer" />
                        <button className="btn ghost danger" onClick={() => remove(draft.id)} disabled={!!busy}>
                          <Icon name="trash" size={14} /> Smazat sadu
                        </button>
                      </>
                    )}
                  </div>
                </>
              )}
            </div>

            <div className="bn-right">
              <div className="tabs bn-devices">
                {([['pc', 'Počítač'], ['tablet', 'Tablet'], ['phone', 'Telefon']] as const).map(([id, label]) => (
                  <button key={id} className={`tab ${device === id ? 'active' : ''}`}
                    onClick={() => setDevice(id)}>{label}</button>
                ))}
                <span className="wt-spacer" />
                <select value={lang} onChange={e => setLang(e.target.value as Lang)}>
                  {LANGS.map(one => <option key={one.id} value={one.id}>{one.label}</option>)}
                </select>
                <button className="icon-btn" onClick={() => setSolo(one => !one)}
                  title={solo ? 'Zpátky k editaci' : 'Náhled přes celé okno'}>
                  <Icon name={solo ? 'shrink' : 'expand'} size={15} />
                </button>
              </div>
              {draft ? (
                <BannerPreview set={draft} device={device} lang={lang} />
              ) : (
                <div className="bn-stage empty">
                  <span className="desc">Náhled se ukáže, jakmile vybereš sadu.</span>
                </div>
              )}
              <p className="desc">
                Náhled běží na tomtéž skriptu, který bude na e-shopu — včetně odpočtu, rotace
                a padajících emoji. Co je vidět tady, bude vidět i tam.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
