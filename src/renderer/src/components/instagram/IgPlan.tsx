import { useCallback, useEffect, useState } from 'react';
import type { IgOverview, IgPlanSetup, IgPlanProposal, IgPlanned } from '@shared/types';
import { api } from '../../api';
import { useToast } from '../../toast';
import Icon from '../Icon';

/**
 * Plán příspěvků na měsíc dopředu.
 *
 * ## Proč to není jen „seznam rozdělaných"
 *
 * Rozdělaný příspěvek je práce, kterou někdo začal. Plán je **rozhodnutí,
 * které ještě nikdo nezačal** — a právě to je na sociálních sítích to
 * těžké: v sezóně na obsah nezbyde čas, takže se měsíc mlčí a pak vyjde
 * pět příspěvků o tomtéž zboží. Plán se proto ukazuje jako kalendář:
 * co se blíží, co je hotové a co se nestíhá.
 *
 * ## Co je na každém řádku
 *
 * Datum, druh (prodávané / opomíjené / sezóna / zákulisí), název a
 * hlavně **čeho se nedostává** — fotky, text, zařazení k odeslání. Bez
 * toho by se den před termínem zjistilo, že u poloviny příspěvků nejsou
 * snímky, a plán by nebyl k ničemu.
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

const STAVY: Record<IgPlanned['state'], { label: string; tone: string }> = {
  waiting: { label: 'Chybí fotky', tone: 'warn' },
  ready: { label: 'Fotky hotové', tone: 'ok' },
  scheduled: { label: 'Čeká na odeslání', tone: 'ok' },
  published: { label: 'Vyšlo', tone: 'done' }
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

interface Props {
  overview: IgOverview;
  onOpenPost: (id: number) => void;
}

export default function IgPlan({ overview, onOpenPost }: Props) {
  const toast = useToast();
  const [setup, setSetup] = useState<IgPlanSetup | null>(null);
  const [plan, setPlan] = useState<IgPlanned[]>([]);
  const [navrh, setNavrh] = useState<IgPlanProposal[] | null>(null);
  const [busy, setBusy] = useState('');
  const [openSetup, setOpenSetup] = useState(false);
  /*
   * Jak daleko je návrh. Model posílá příspěvky jeden po druhém a čekat
   * na poslední znamenalo dívat se přes minutu na tlačítko „Přemýšlím"
   * bez jediné známky toho, že se něco děje — a při delším čekání se
   * okno zavíralo s dojmem, že se to zaseklo.
   */
  const [krok, setKrok] = useState<{ hotovo: number; celkem: number } | null>(null);

  /* Okno plánu: od dneška měsíc a kousek dopředu, ať je vidět i přesah */
  const dnes = new Date();
  const od = dnes.toISOString().slice(0, 10);
  const doKdy = new Date(dnes.getTime() + 45 * 86400000).toISOString().slice(0, 10) + ' 23:59';

  const load = useCallback(async () => {
    try {
      const [s, p] = await Promise.all([api.ig.planSetup(), api.ig.planned(od, doKdy)]);
      setSetup(s);
      setPlan(p);
    } catch (e: any) {
      toast(e.message, 'error');
    }
  }, [toast, od, doKdy]);

  useEffect(() => { void load(); }, [load]);

  /*
   * Rozdělané příspěvky přicházejí z hlavního procesu, ne z návratové
   * hodnoty — ta dorazí až s posledním. Ukazují se rovnou v seznamu
   * návrhu, takže je vidět, co model vymyslel, ještě než dopíše zbytek.
   */
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

  const navrhni = async () => {
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
    if (!navrh || navrh.length === 0) return;
    setBusy('prijmout');
    try {
      const kolik = await api.ig.planAccept(navrh);
      setNavrh(null);
      await load();
      toast(`Do plánu přibylo ${kolik} ${kusy(kolik)}. Zbývá k nim přidat fotky.`);
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const presun = async (one: IgPlanned, dnu: number) => {
    const d = new Date(one.at.replace(' ', 'T'));
    if (Number.isNaN(d.getTime())) return;
    d.setDate(d.getDate() + dnu);
    const at = `${d.toISOString().slice(0, 10)} ${String(d.getHours()).padStart(2, '0')}:00`;
    try {
      await api.ig.planMove(one.id, at);
      await load();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  /* Seskupení po týdnech: měsíc v jednom sloupci se nedá přehlédnout */
  const tydny = new Map<string, IgPlanned[]>();
  for (const one of plan) {
    const d = new Date(one.at.replace(' ', 'T'));
    const pondeli = new Date(d);
    pondeli.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    const klic = pondeli.toISOString().slice(0, 10);
    if (!tydny.has(klic)) tydny.set(klic, []);
    tydny.get(klic)!.push(one);
  }

  const chybiFotky = plan.filter(one => one.state === 'waiting').length;

  return (
    <div className="ig-plan">
      <div className="ig-plan-head">
        <div>
          <h2>Plán na měsíc</h2>
          <p className="desc">
            Návrh vychází z toho, co se <b>opravdu prodávalo</b> — a z toho, co leží skladem
            a nikdo o tom neví. Nepublikuje se nic: k příspěvku přidáš fotky a teprve pak ho
            pošleš do fronty.
          </p>
        </div>
        <div className="ig-plan-actions">
          <button className="btn ghost" onClick={() => setOpenSetup(one => !one)}>
            <Icon name="sliders" size={14} /> Kolik a kdy
          </button>
          <button className="btn primary" disabled={busy === 'navrh'} onClick={() => void navrhni()}>
            <Icon name="sparkles" size={14} />
            {busy === 'navrh'
              ? (krok && krok.celkem
                ? ` Píšu ${Math.min(krok.hotovo + 1, krok.celkem)}. z ${krok.celkem}…`
                : ' Přemýšlím…')
              : ' Navrhnout měsíc'}
          </button>
        </div>
      </div>

      {/*
        * Pruh postupu. Číslo v tlačítku se čte špatně přes celou šířku
        * okna, a hlavně z něj není poznat, jestli se něco hýbe — proužek
        * ano. Mizí s koncem návrhu.
        */}
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
            <label>
              Z toho o tom, co se prodává: {setup.mixBest} %
            </label>
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
                <Icon name="check" size={14} /> Zařadit do plánu
              </button>
            </div>
          </div>
          {navrh.map((one, i) => (
            <div key={`${one.day}-${i}`} className="ig-plan-card">
              <div className="ig-plan-when">
                <b>{denText(`${one.day} ${String(one.hour).padStart(2, '0')}:00`)}</b>
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

      {plan.length === 0 && !navrh && (
        <p className="desc" style={{ padding: '18px 2px' }}>
          V plánu zatím nic není. Tlačítkem „Navrhnout měsíc" dostaneš rozvržení podle prodejů —
          a pak už jen doplňuješ fotky.
        </p>
      )}

      {chybiFotky > 0 && (
        <p className="md-warn">
          <Icon name="alert" size={13} /> U {chybiFotky} příspěvků v plánu ještě nejsou fotky.
        </p>
      )}

      {[...tydny.entries()].map(([klic, list]) => (
        <div key={klic} className="ig-plan-week">
          <div className="ig-plan-week-head">
            Týden od {new Intl.DateTimeFormat('cs-CZ', { day: 'numeric', month: 'numeric' })
              .format(new Date(klic))}
            <em>{list.length} {kusy(list.length)}</em>
          </div>
          {list.map(one => (
            <div key={one.id} className={`ig-plan-row ${STAVY[one.state].tone}`}>
              <div className="ig-plan-when">
                <b>{denText(one.at)}</b>
                <em className="ig-plan-kind" title={DRUHY[one.kind]?.hint}>
                  {DRUHY[one.kind]?.label ?? one.kind}
                </em>
              </div>
              <button className="ig-plan-title" onClick={() => onOpenPost(one.id)}>
                <b>{one.title || 'Bez názvu'}</b>
                {one.idea && <span className="desc">{one.idea}</span>}
              </button>
              <div className="ig-plan-state">
                <em className={STAVY[one.state].tone}>{STAVY[one.state].label}</em>
                <span className="desc">
                  {one.media > 0 ? `${one.media} médií` : 'bez médií'}
                  {one.texts > 0 ? ` · ${one.texts} textů` : ''}
                </span>
              </div>
              <div className="ig-plan-move">
                <button className="btn ghost" title="O den dřív" onClick={() => void presun(one, -1)}>
                  <Icon name="chevLeft" size={12} />
                </button>
                <button className="btn ghost" title="O den později" onClick={() => void presun(one, 1)}>
                  <Icon name="chevRight" size={12} />
                </button>
                <button className="btn ghost" title="Otevřít a dodělat"
                  onClick={() => onOpenPost(one.id)}>
                  <Icon name="pen" size={12} />
                </button>
              </div>
            </div>
          ))}
        </div>
      ))}

      {!overview.hasSource && (
        <p className="desc">
          Účty zatím nejsou připojené — plánovat jde i tak, publikovat ale ne.
        </p>
      )}
    </div>
  );
}
