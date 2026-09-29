import { useCallback, useEffect, useMemo, useState } from 'react';
import type { IgAlert, IgOverview, IgPlanProposal, IgPlanSetup, IgPost } from '@shared/types';
import { api } from '../../api';
import { useToast } from '../../toast';
import Icon from '../Icon';
import { useFilePreview, marketColor } from './IgShared';

/**
 * Příspěvky — plán i rozdělaná práce na jednom místě.
 *
 * ## Proč to není dvě obrazovky
 *
 * Dřív byl zvlášť „Plán na měsíc" a zvlášť „Rozpracované". Rozdíl mezi
 * nimi byl přitom jen technický: v plánu byly příspěvky s termínem, ale
 * bez textů (ty vznikají až generováním), mezi rozdělanými ty, co už
 * nějaký text měly. Je to ale jedna a tatáž práce — jen v jiné fázi.
 * Dvě položky v nabídce znamenaly dvě místa, kde hledat, a příspěvek
 * mezi nimi beze slova přeskakoval, jakmile se vygeneroval text.
 *
 * ## Co karta ukazuje
 *
 * To, co uvidí zákazník: fotky, text a datum. A k tomu, co ještě zbývá —
 * chybějící fotky, nepřeložený trh, chybějící schválení. Podle řádku
 * textu se to poznat nedalo a den před termínem je pozdě.
 *
 * ## Odkud příspěvek je
 *
 * Návrh od aplikace se čte jinak pozorně než to, co jsem psal sám —
 * proto je na kartě vidět, jestli je to „návrh", „ruční", nebo přepis
 * vlastního příspěvku.
 */

const DNY = [
  { id: 1, label: 'Po' }, { id: 2, label: 'Út' }, { id: 3, label: 'St' },
  { id: 4, label: 'Čt' }, { id: 5, label: 'Pá' }, { id: 6, label: 'So' }, { id: 0, label: 'Ne' }
];

const DRUHY: Record<string, { label: string; hint: string }> = {
  bestseller: { label: 'Prodává se', hint: 'Co jde na odbyt, má smysl ukázat znovu' },
  lezak: { label: 'Leží skladem', hint: 'Je skladem a za dva měsíce se neprodal ani kus' },
  sezona: { label: 'Sezóna', hint: 'Svatby, Vánoce, plesy — co se zrovna děje' },
  zakulisi: { label: 'Zákulisí', hint: 'Jak to vzniká; bez toho je z profilu katalog' }
};

const PUVOD: Record<string, { label: string; hint: string }> = {
  ai: { label: 'návrh', hint: 'Vymyslela aplikace podle prodejů a skladu — přečti si to pozorně' },
  hand: { label: 'ruční', hint: 'Založeno ručně' },
  repost: { label: 'přepis', hint: 'Přepis vlastního příspěvku pro další trhy' }
};

/** Jeden příspěvek, dva příspěvky, pět příspěvků — jinak to drhne. */
const kusy = (n: number) => (n === 1 ? 'příspěvek' : n >= 2 && n <= 4 ? 'příspěvky' : 'příspěvků');

const denText = (at: string) => {
  const d = new Date(at.replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return at;
  return new Intl.DateTimeFormat('cs-CZ', {
    weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit'
  }).format(d);
};

/** Kdy vyjde, lidsky. Datum je to, podle čeho se práce řadí. */
function kdy(at: string): { den: string; cas: string; za: string; pozde: boolean } {
  if (!at) return { den: 'bez termínu', cas: '', za: 'dodělat, až bude čas', pozde: false };
  const d = new Date(at.replace(' ', 'T'));
  if (!Number.isFinite(d.getTime())) return { den: at, cas: '', za: '', pozde: false };
  const den = d.toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric' });
  const dow = d.toLocaleDateString('cs-CZ', { weekday: 'short' });
  const cas = d.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
  const rozdil = d.getTime() - Date.now();
  const dny = Math.round(rozdil / 86_400_000);
  const za = rozdil < 0
    ? 'termín už minul'
    : dny <= 0 ? 'dnes' : dny === 1 ? 'zítra' : `za ${dny} dní`;
  return { den: `${dow} ${den}`, cas, za, pozde: rozdil < 0 };
}

function Nahled({ file, video }: { file: string; video: boolean }) {
  const preview = useFilePreview(video ? null : file);
  return (
    <div className="igd-thumb">
      {preview
        ? <img src={preview} alt="" />
        : <span className="igd-thumb-ph"><Icon name={video ? 'zap' : 'image'} size={16} /></span>}
      {video && <span className="igd-thumb-tag">video</span>}
    </div>
  );
}

type Filtr = 'vse' | 'fotky' | 'texty' | 'schvalit' | 'hotove';

const FILTRY: { id: Filtr; label: string; hint: string }[] = [
  { id: 'vse', label: 'Vše', hint: 'Všechno, co ještě nevyšlo' },
  { id: 'fotky', label: 'Chybí fotky', hint: 'Bez fotek se publikovat nedá' },
  { id: 'texty', label: 'Chybí texty', hint: 'Některý trh ještě nemá text' },
  { id: 'schvalit', label: 'Ke schválení', hint: 'Hotové, ale nikdo to neodsouhlasil' },
  { id: 'hotove', label: 'Hotové', hint: 'Fotky, texty i schválení' }
];

export default function IgPosts({ overview, onOpenPost }: {
  overview: IgOverview;
  onOpenPost: (id: number) => void;
}) {
  const toast = useToast();
  const [posts, setPosts] = useState<IgPost[]>([]);
  const [alerts, setAlerts] = useState<IgAlert[]>([]);
  const [setup, setSetup] = useState<IgPlanSetup | null>(null);
  const [navrh, setNavrh] = useState<IgPlanProposal[] | null>(null);
  const [busy, setBusy] = useState('');
  const [openSetup, setOpenSetup] = useState(false);
  const [wish, setWish] = useState('');
  const [openWish, setOpenWish] = useState(false);
  const [filtr, setFiltr] = useState<Filtr>('vse');
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  /*
   * Jak daleko je návrh. Model posílá příspěvky jeden po druhém a čekat
   * na poslední znamenalo dívat se přes minutu na „Přemýšlím" bez jediné
   * známky toho, že se něco děje.
   */
  const [krok, setKrok] = useState<{ hotovo: number; celkem: number } | null>(null);
  /*
   * Jazyk náhledu. Texty vznikají překladem z češtiny a zkontrolovat se
   * musí i ostatní trhy — dokud šel vidět jen první, poznalo se prázdné
   * německé znění až ve frontě.
   */
  const [lang, setLang] = useState('');

  const load = useCallback(async () => {
    try {
      const [list, al, s] = await Promise.all([
        api.ig.drafts(), api.ig.alerts(), api.ig.planSetup()
      ]);
      setPosts(list);
      setAlerts(al);
      setSetup(one => one ?? s);
    } catch (e: any) {
      toast(e.message, 'error');
    }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => api.on('ig:changed', () => { void load(); }), [load]);

  useEffect(() => api.on('ig:planStep', (data: any) => {
    setKrok({ hotovo: Number(data?.hotovo) || 0, celkem: Number(data?.celkem) || 0 });
    if (Array.isArray(data?.items) && data.items.length > 0) setNavrh(data.items);
  }), []);

  const uprav = (patch: Partial<IgPlanSetup>) => setSetup(one => (one ? { ...one, ...patch } : one));

  const ulozSetup = async () => {
    if (!setup) return;
    try {
      setSetup(await api.ig.savePlanSetup(setup));
      toast('Nastavení plánu je uložené.');
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const navrhniMesic = async () => {
    setBusy('navrh');
    setNavrh(null);
    setKrok(null);
    try {
      if (setup) await api.ig.savePlanSetup(setup);
      setNavrh(await api.ig.planPropose());
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
      setKrok(null);
    }
  };

  const prijmi = async () => {
    if (!navrh) return;
    setBusy('prijmout');
    try {
      const kolik = await api.ig.planAccept(navrh);
      setNavrh(null);
      await load();
      toast(`Do plánu přibylo ${kolik} ${kusy(kolik)}.`);
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const navrhniJeden = async () => {
    setBusy('jeden');
    try {
      const one = await api.ig.proposeOne(wish);
      const id = await api.ig.acceptOne(one);
      setWish('');
      setOpenWish(false);
      await load();
      toast('Návrh je mezi příspěvky — dodělej fotky a text.');
      onOpenPost(id);
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const schval = async (post: IgPost, on: boolean) => {
    try {
      await api.ig.approve(post.id, on);
      await load();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const smaz = async (post: IgPost) => {
    const nazev = (post.planTitle || post.brief || post.planIdea || 'příspěvek').slice(0, 40);
    if (!window.confirm(`Smazat „${nazev}"? Texty i připravené fotky k němu zmizí.`)) return;
    try {
      await api.ig.deletePost(post.id);
      await load();
      toast('Smazáno.');
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  /* Tažení: prohodí termíny dvou příspěvků, zbytek plánu zůstane */
  const pust = async (cil: IgPost) => {
    const zdroj = drag;
    setDrag(null);
    setOver(null);
    if (zdroj == null || zdroj === cil.id) return;
    try {
      await api.ig.planSwap(zdroj, cil.id);
      await load();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  /** Trhy, ve kterých má smysl přepínat — ty, které v příspěvcích opravdu jsou */
  const jazyky = useMemo(() => {
    const set = new Set<string>();
    for (const one of posts) for (const c of one.captions) set.add(c.lang);
    return [...set].sort();
  }, [posts]);

  /** Kolik trhů má hotový text — číslo, ne hádání z barevných teček */
  const trhy = (post: IgPost) => {
    const celkem = post.captions.length || overview.markets.filter(m => m.enabled).length;
    const hotovo = post.captions.filter(c => c.text.trim()).length;
    return { celkem, hotovo };
  };

  const stav = (post: IgPost) => {
    const t = trhy(post);
    if (post.media.length === 0) return 'fotky';
    if (t.celkem === 0 || t.hotovo < t.celkem) return 'texty';
    if (!post.approved) return 'schvalit';
    return 'hotove';
  };

  const videt = posts.filter(one => filtr === 'vse' || stav(one) === filtr);

  /* Seskupení po týdnech: měsíc v jednom sloupci se nedá přehlédnout */
  const tydny: { klic: string; list: IgPost[] }[] = [];
  const bezTerminu: IgPost[] = [];
  for (const one of videt) {
    if (!one.planAt) { bezTerminu.push(one); continue; }
    const d = new Date(one.planAt.replace(' ', 'T'));
    const pondeli = new Date(d);
    pondeli.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    const klic = pondeli.toISOString().slice(0, 10);
    const uz = tydny.find(w => w.klic === klic);
    if (uz) uz.list.push(one);
    else tydny.push({ klic, list: [one] });
  }

  const potiz = (post: IgPost) => alerts.find(a => a.postId === post.id) ?? null;
  const pocty = (id: Filtr) => (id === 'vse' ? posts.length : posts.filter(one => stav(one) === id).length);

  const karta = (one: IgPost) => {
    const t = kdy(one.planAt);
    const problem = potiz(one);
    const caption = (lang && one.captions.find(c => c.lang === lang)) || one.captions[0] || null;
    const text = (caption?.text || one.brief || '').trim();
    const bezMedii = one.media.length === 0;
    const market = trhy(one);
    const prazdne = market.hotovo === 0;
    const puvod = PUVOD[one.origin] ?? PUVOD.hand;
    return (
      <article
        key={one.id}
        className={`igd-card ${drag === one.id ? 'drag' : ''} ${over === one.id ? 'over' : ''}`
          + `${one.approved ? ' ok' : ''}`}
        draggable={!!one.planAt}
        onDragStart={() => setDrag(one.id)}
        onDragEnd={() => { setDrag(null); setOver(null); }}
        onDragOver={e => { if (drag != null && one.planAt) { e.preventDefault(); setOver(one.id); } }}
        onDragLeave={() => setOver(o => (o === one.id ? null : o))}
        onDrop={e => { e.preventDefault(); void pust(one); }}
      >
        {/* Datum je to první, podle čeho se práce řadí — proto je velké */}
        <div className={`igd-when ${t.pozde ? 'late' : ''}`}>
          <b>{t.den}</b>
          <span>{t.cas}</span>
          <small>{t.za}</small>
          {one.planKind && (
            <em title={DRUHY[one.planKind]?.hint}>{DRUHY[one.planKind]?.label ?? one.planKind}</em>
          )}
          <span className={`igd-origin ${one.origin}`} data-tip={puvod.hint}>{puvod.label}</span>
        </div>

        <div className="igd-body">
          <div className="igd-media">
            {one.media.slice(0, 4).map((m, i) => (
              <Nahled key={`${m.path}-${i}`} file={m.path} video={m.isVideo} />
            ))}
            {bezMedii && (
              <div className="igd-nomedia">
                <Icon name="image" size={16} />
                <span>{one.planIdea ? one.planIdea.slice(0, 90) : 'Chybí fotka'}</span>
              </div>
            )}
            {one.media.length > 4 && <span className="igd-more">+{one.media.length - 4}</span>}
          </div>

          {one.planTitle && <h4 className="igd-title">{one.planTitle}</h4>}
          <p className="igd-text">{text ? text.slice(0, 260) : 'Zatím bez textu'}</p>

          <div className="igd-langs-mini">
            {/*
              * Kolik trhů má text, číslem — z barevných teček se to
              * počítalo okem a u pěti trhů se v tom nikdo nevyznal.
              */}
            <span className={`igd-trhy ${market.hotovo === market.celkem && market.celkem > 0 ? 'ok' : ''}`}>
              {market.hotovo} / {market.celkem || '?'} trhů s textem
            </span>
            {one.captions.map(c => (
              <span key={c.id}
                className={`igd-lang ${c.text.trim() ? '' : 'empty'} ${c.status === 'published' ? 'out' : ''}`}
                style={{ borderColor: marketColor(overview.markets, c.lang) }}
                data-tip={c.status === 'published'
                  ? `${c.lang}: už vyšlo`
                  : c.text.trim() ? `${c.lang}: text hotový` : `${c.lang}: text chybí`}>
                {c.lang}
              </span>
            ))}
          </div>
        </div>

        <div className="igd-side">
          {problem && (
            <div className={`igd-warn ${problem.kind}`}>
              <Icon name="alert" size={13} />
              {problem.kind === 'media' && 'Chybí fotka a termín se blíží'}
              {problem.kind === 'approve' && 'Zítra má vyjít — chybí schválení'}
              {problem.kind === 'late' && 'Termín minul, příspěvek nevyšel'}
            </div>
          )}
          <label className="igd-approve" data-tip={bezMedii
            ? 'Bez fotky to síť nepřijme — schválit nejde'
            : 'Odsouhlasené smí odejít; každá změna textu nebo fotek schválení zruší'}>
            <input type="checkbox" checked={one.approved}
              disabled={bezMedii || prazdne}
              onChange={e => void schval(one, e.target.checked)} />
            Schváleno k publikaci
          </label>
          <div className="igd-btns">
            <button className="btn ghost" onClick={() => onOpenPost(one.id)}>
              <Icon name="pen" size={13} /> Otevřít
            </button>
            <button className="icon-btn danger" onClick={() => void smaz(one)}
              data-tip="Smazat příspěvek" aria-label="Smazat příspěvek">
              <Icon name="trash" size={14} />
            </button>
          </div>
        </div>
      </article>
    );
  };

  return (
    <div className="ig-page ig-plan igd">
      <div className="ig-plan-head">
        <div>
          <h2>Příspěvky</h2>
          <p className="desc">
            Plán i rozdělaná práce na jednom místě. Návrh vychází z toho, co se
            <b> opravdu prodávalo</b> — a z toho, co leží skladem a nikdo o tom neví.
            Nepublikuje se nic: k příspěvku přidáš fotky, odsouhlasíš ho a teprve pak jde ven.
          </p>
        </div>
        <div className="ig-plan-actions">
          <button className="btn ghost" onClick={() => setOpenSetup(one => !one)}>
            <Icon name="sliders" size={14} /> Kolik a kdy
          </button>
          <button className="btn ghost" disabled={busy === 'jeden'}
            onClick={() => setOpenWish(one => !one)}>
            <Icon name="sparkles" size={14} /> Jeden příspěvek
          </button>
          <button className="btn primary" disabled={!!busy} onClick={() => void navrhniMesic()}>
            <Icon name="sparkles" size={14} />
            {busy === 'navrh'
              ? (krok && krok.celkem
                ? ` Píšu ${Math.min(krok.hotovo + 1, krok.celkem)}. z ${krok.celkem}…`
                : ' Přemýšlím…')
              : ' Navrhnout měsíc'}
          </button>
        </div>
      </div>

      {busy === 'navrh' && (
        <div className="ig-plan-progress" role="status">
          <div className="ig-plan-bar">
            <span style={{ width: krok && krok.celkem
              ? `${Math.round((krok.hotovo / krok.celkem) * 100)}%`
              : '8%' }} />
          </div>
          <span className="desc">
            {krok && krok.celkem
              ? `Hotovo ${krok.hotovo} z ${krok.celkem} — rozepsané příspěvky se ukazují níž, jak přibývají.`
              : 'Čtu, co se prodávalo, a chystám rozvržení měsíce…'}
          </span>
        </div>
      )}

      {/*
        * Jeden příspěvek na vyžádání. Měsíční plán je pro rozvahu dopředu,
        * tohle pro chvíli, kdy je důvod hned teď — přišly nové vzory nebo
        * je hezké světlo. Přání je nepovinné.
        */}
      {openWish && (
        <div className="igd-wish">
          <input
            value={wish}
            placeholder={'Na co? Třeba „červená kravata" nebo „nové vzory hedvábných"… (nepovinné)'}
            onChange={e => setWish(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !busy) void navrhniJeden(); }}
          />
          <button className="btn primary" disabled={!!busy} onClick={() => void navrhniJeden()}>
            {busy === 'jeden'
              ? <><span className="spinner-inline" /> Přemýšlím…</>
              : <><Icon name="sparkles" size={14} /> Navrhnout</>}
          </button>
          <p className="desc">
            Bez přání vybere téma sám — podle toho, co se prodávalo a co leží skladem.
            Uloží se <b>bez termínu</b>: dodělat fotky a poslat ho jde hned.
          </p>
        </div>
      )}

      {openSetup && setup && (
        <div className="ig-plan-setup">
          <div className="field">
            <label>Kolik příspěvků na měsíc</label>
            <input type="number" min={1} max={60} value={setup.count}
              onChange={e => uprav({ count: Number(e.target.value) || 1 })} />
          </div>
          <div className="field">
            <label>Ve které dny</label>
            <div className="ig-plan-days">
              {DNY.map(one => (
                <button key={one.id}
                  className={`tab ${setup.days.includes(one.id) ? 'active' : ''}`}
                  onClick={() => uprav({
                    days: setup.days.includes(one.id)
                      ? setup.days.filter(d => d !== one.id)
                      : [...setup.days, one.id]
                  })}>{one.label}</button>
              ))}
            </div>
          </div>
          <div className="field">
            <label>V kolik hodin</label>
            <input type="number" min={0} max={23} value={setup.hour}
              onChange={e => uprav({ hour: Number(e.target.value) || 0 })} />
          </div>
          <div className="field">
            <label>Z toho o tom, co se prodává: {setup.mixBest} %</label>
            <input type="range" min={0} max={100} step={10} value={setup.mixBest}
              onChange={e => uprav({ mixBest: Number(e.target.value) })} />
            <p className="desc">
              Zbytek připadne na zboží, které leží skladem, na sezónu a na zákulisí.
              Měsíc bez jediného opomíjeného kusu znamená, že se sklad nepohne.
            </p>
          </div>
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label>Na co nezapomenout</label>
            <textarea rows={2} value={setup.note}
              placeholder="Chystáme svatební kolekci, v půlce měsíce dorazí nové motýlky…"
              onChange={e => uprav({ note: e.target.value })} />
          </div>
          <div className="ig-plan-actions" style={{ gridColumn: '1 / -1' }}>
            <button className="btn" onClick={() => void ulozSetup()}>Uložit nastavení</button>
          </div>
        </div>
      )}

      {/*
        * Návrh se ukazuje **před uložením**. Měsíc příspěvků, který se
        * rovnou zapíše, pak někdo maže po jednom — takhle se dá nejdřív
        * přečíst a vyhodit, co se nehodí.
        */}
      {navrh && (
        <div className="ig-plan-proposal">
          <div className="ig-plan-head">
            <b>
              Návrh na {navrh.length} {kusy(navrh.length)}
              {busy === 'navrh' && <span className="ig-plan-live"> · další se dopisují</span>}
            </b>
            <div className="ig-plan-actions">
              <button className="btn ghost" disabled={busy === 'navrh'}
                onClick={() => setNavrh(null)}>Zahodit</button>
              <button className="btn primary" disabled={busy === 'prijmout' || busy === 'navrh'}
                onClick={() => void prijmi()}>
                <Icon name="check" size={14} /> Zařadit mezi příspěvky
              </button>
            </div>
          </div>
          {navrh.map((one, i) => (
            <div key={`${one.day}-${i}`} className="ig-plan-card">
              <div className="ig-plan-when">
                <b>{one.day ? denText(`${one.day} ${String(one.hour).padStart(2, '0')}:00`) : 'bez termínu'}</b>
                <em className="ig-plan-kind" title={DRUHY[one.kind]?.hint}>
                  {DRUHY[one.kind]?.label ?? one.kind}
                </em>
              </div>
              <div className="ig-plan-body">
                <b>{one.title}</b>
                <p>{one.text}</p>
                <p className="desc"><Icon name="camera" size={12} /> {one.idea}</p>
                {one.tags.length > 0 && <p className="desc">{one.tags.join(' ')}</p>}
              </div>
              <button className="btn ghost danger" title="Tenhle vyhodit"
                onClick={() => setNavrh(list => (list ?? []).filter((_, at) => at !== i))}>
                <Icon name="x" size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/*
        * Filtr podle toho, co zbývá. „Chybí fotky" je nejčastější dotaz
        * ze všech: fotí se dávkou a je potřeba vědět, ke kterým.
        */}
      {posts.length > 0 && (
        <div className="igd-filters">
          {FILTRY.map(one => (
            <button key={one.id} data-tip={one.hint}
              className={`tab ${filtr === one.id ? 'active' : ''}`}
              onClick={() => setFiltr(one.id)}>
              {one.label} <em>{pocty(one.id)}</em>
            </button>
          ))}
          <span className="wt-spacer" />
          {jazyky.length > 1 && (
            <>
              {/* Vlastní třída, ať se přepínač jazyka neplete s filtrem */}
              <span className="desc">Text:</span>
              <button className={`tab igd-lang-tab ${lang === '' ? 'active' : ''}`}
                onClick={() => setLang('')}>první trh</button>
              {jazyky.map(one => (
                <button key={one} className={`tab igd-lang-tab ${lang === one ? 'active' : ''}`}
                  onClick={() => setLang(one)}>{one}</button>
              ))}
            </>
          )}
        </div>
      )}

      {posts.length === 0 && !navrh && (
        <p className="desc" style={{ padding: '18px 2px' }}>
          Zatím tu nic není. <b>Navrhnout měsíc</b> rozvrhne příspěvky podle prodejů,
          <b> Jeden příspěvek</b> vymyslí jeden na teď — a <b>Nový příspěvek</b> vlevo
          založí prázdný, do kterého si napíšeš vlastní.
        </p>
      )}
      {posts.length > 0 && videt.length === 0 && (
        <p className="desc" style={{ padding: '18px 2px' }}>
          V téhle skupině nic není — zkus „Vše".
        </p>
      )}

      {tydny.map(({ klic, list }) => (
        <div key={klic} className="ig-plan-week">
          <div className="ig-plan-week-head">
            Týden od {new Intl.DateTimeFormat('cs-CZ', { day: 'numeric', month: 'numeric' })
              .format(new Date(klic))}
            <em>{list.length} {kusy(list.length)}</em>
          </div>
          <div className="igd-list">{list.map(karta)}</div>
        </div>
      ))}

      {bezTerminu.length > 0 && (
        <div className="ig-plan-week">
          <div className="ig-plan-week-head">
            Bez termínu
            <em>{bezTerminu.length} {kusy(bezTerminu.length)}</em>
          </div>
          <div className="igd-list">{bezTerminu.map(karta)}</div>
        </div>
      )}

      {tydny.length > 0 && (
        <p className="desc">
          Příspěvky s termínem se dají <b>přetáhnout</b> jeden na druhý — prohodí si termíny.
          Zbytek plánu zůstane, jak byl.
        </p>
      )}
    </div>
  );
}
