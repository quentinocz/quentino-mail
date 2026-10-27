import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ZkKrokProOkno, ZkNahled, ZkNastaveni, ZkPrehled, ZkProduktRadek,
  ZkVrstvaProOkno, ZkVrstvaTyp
} from '@shared/zkusebna';
import {
  ZK_BARVY, ZK_KVALITY, ZK_VRSTVY, dilKvality, dilPlochy, doZakladu, vrstvaDef
} from '@shared/zkusebna';
import { api } from '../api';
import { useToast } from '../toast';
import Icon from './Icon';
import { inToolWindow } from '../toolwindows';

/**
 * Zkušební kabina — okno, ve kterém se vizuály dělají a schvalují.
 *
 * ## Proč jsou to tři různé obrazovky, a ne jedna
 *
 * Jsou to tři různé práce, každá v jiný den:
 *
 *  1. **Kabina** je to, co uvidí zákazník. Běží v ní **tentýž skript**,
 *     který se vkládá do e-shopu — ne jeho napodobenina v Reactu. Kdyby
 *     si okno kreslilo vlastní podobu, schvalovalo by se něco jiného, než
 *     co pak lidé uvidí.
 *  2. **Vizuály** jsou dílna: vrstvy se generují, kontrolují a schvalují.
 *     Tady se utrácí za obrázky, proto je u všeho vidět, kolik to stojí.
 *  3. **Produkty** říkají, co z katalogu kam patří a jakou to má barvu.
 *
 * ## Proč se začíná zástupnou kresbou
 *
 * Než se zaplatí první obrázek, má být jasné, jestli se kabina dobře
 * ovládá. Zástupná kresba projde tou samou cestou jako skutečné vrstvy
 * (kroky oblékání, rozdíl, maska, kontrola), takže se na ní pozná všechno
 * kromě toho, jak to vypadá. V okně je u ní napsáno, že je zástupná —
 * vydávat ji za fotku by bylo to nejhorší, co se s ní dá udělat.
 */

type Zalozka = 'kabina' | 'vizualy' | 'produkty' | 'nastaveni';

const STAVY: Record<string, { nazev: string; trida: string }> = {
  ceka: { nazev: 'Chybí', trida: 'ceka' },
  hotovo: { nazev: 'Hotovo', trida: 'hotovo' },
  nesedi: { nazev: 'Nesedí', trida: 'nesedi' },
  schvaleno: { nazev: 'Schváleno', trida: 'schvaleno' }
};

export default function ZkusebnaModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const okno = inToolWindow();
  const [zalozka, setZalozka] = useState<Zalozka>('kabina');
  const [prehled, setPrehled] = useState<ZkPrehled | null>(null);
  const [postava, setPostava] = useState('dospely-bezny');
  const [vrstvy, setVrstvy] = useState<ZkVrstvaProOkno[]>([]);
  const [kroky, setKroky] = useState<ZkKrokProOkno[]>([]);
  const [nahled, setNahled] = useState<ZkNahled | null>(null);
  const [nastaveni, setNastaveni] = useState<ZkNastaveni | null>(null);
  const [produkty, setProdukty] = useState<ZkProduktRadek[]>([]);
  const [pracuje, setPracuje] = useState('');
  const [vystavuji, setVystavuji] = useState('');
  const [podrobne, setPodrobne] = useState<string | null>(null);
  const [filtr, setFiltr] = useState('');

  const nactiPrehled = useCallback(async () => {
    try { setPrehled(await api.zk.prehled()); } catch (e: any) { toast(e.message, 'error'); }
  }, [toast]);

  useEffect(() => { void nactiPrehled(); }, [nactiPrehled]);

  useEffect(() => {
    (async () => {
      try {
        setVrstvy(await api.zk.vrstvy(postava));
        setKroky(await api.zk.kroky(postava));
      } catch (e: any) { toast(e.message, 'error'); }
    })();
  }, [postava, toast]);

  useEffect(() => {
    if (zalozka !== 'nastaveni' || nastaveni) return;
    api.zk.nastaveni().then(setNastaveni).catch((e: any) => toast(e.message, 'error'));
  }, [zalozka, nastaveni, toast]);

  /* Vystavení nahrává stovky obrázků — bez průběhu to vypadá zaseknutě */
  useEffect(() => api.on('zk:vystav-krok', (krok: any) => {
    setVystavuji(`${krok?.co ?? 'Vystavuji'} · ${krok?.hotovo ?? 0} z ${krok?.celkem ?? 0}`);
  }), []);

  useEffect(() => {
    if (zalozka !== 'produkty' || produkty.length) return;
    api.zk.produkty(300).then(setProdukty).catch((e: any) => toast(e.message, 'error'));
  }, [zalozka, produkty.length, toast]);

  const obnovNahled = useCallback(async () => {
    try { setNahled(await api.zk.nahled()); } catch (e: any) { toast(e.message, 'error'); }
  }, [toast]);

  useEffect(() => {
    if (zalozka === 'kabina' && !nahled) void obnovNahled();
  }, [zalozka, nahled, obnovNahled]);

  /* Postup generování chodí z hlavního procesu — jinak to vypadá zaseknutě */
  useEffect(() => api.on('zk:krok', (p: any) => {
    if (!p) return;
    if (p.stav === 'konec') { setPracuje(''); return; }
    const def = p.typ ? ZK_VRSTVY.find(one => one.typ === p.typ) : null;
    const kolik = p.celkem ? ` (${(p.hotovych ?? 0) + 1} z ${p.celkem})` : '';
    setPracuje(`Kreslím ${def ? def.nazev.toLowerCase() : p.typ ?? ''}${kolik}…`);
  }), []);

  const stav = prehled?.postavy.find(one => one.id === postava);

  /* ------------------------------------------------------------ akce */

  const udelejUkazku = async (vsechny: boolean) => {
    setPracuje('Kreslím zástupnou postavu…');
    try {
      const vysledek = vsechny ? await api.zk.ukazkaVse() : await api.zk.ukazka(postava);
      toast(vysledek.nesedi.length
        ? `Hotovo, ale ${vysledek.nesedi.length} vrstev nesedí.`
        : `Hotovo: ${vysledek.hotovo} vrstev.`, vysledek.nesedi.length ? 'error' : 'info');
      setVrstvy(await api.zk.vrstvy(postava));
      setKroky(await api.zk.kroky(postava));
      setNahled(null);
      await nactiPrehled();
    } catch (e: any) { toast(e.message, 'error'); }
    setPracuje('');
  };

  const generuj = async (typ: ZkVrstvaTyp, varianta: string) => {
    setPracuje('Kreslím…');
    try {
      if (typ === 'postava') await api.zk.generujPostavu(postava);
      else await api.zk.generujVrstvu(postava, typ, varianta);
      setVrstvy(await api.zk.vrstvy(postava));
      setKroky(await api.zk.kroky(postava));
      setNahled(null);
      await nactiPrehled();
    } catch (e: any) { toast(e.message, 'error'); }
    setPracuje('');
  };

  const generujVse = async (rozsah: 'zakladni' | 'vse' = 'zakladni') => {
    setPracuje('Kreslím…');
    try {
      const vysledek = await api.zk.generujVse(postava, true, rozsah);
      toast(vysledek.nesedi
        ? `Zastaveno u nepovedené vrstvy: ${vysledek.potize[0] ?? ''}`
        : `Hotovo: ${vysledek.hotovo} vrstev.`, vysledek.nesedi ? 'error' : 'info');
      setVrstvy(await api.zk.vrstvy(postava));
      setKroky(await api.zk.kroky(postava));
      setNahled(null);
      await nactiPrehled();
    } catch (e: any) { toast(e.message, 'error'); }
    setPracuje('');
  };

  const schval = async (v: ZkVrstvaProOkno, ano: boolean) => {
    await api.zk.schval(postava, v.typ, v.varianta, ano);
    setVrstvy(await api.zk.vrstvy(postava));
    await nactiPrehled();
  };

  /* Kolik by stálo dogenerovat, co chybí — než se klikne, ne až potom */
  /* Odhad musí počítat i s kvalitou — v nízké stojí obrázek čtvrtinu */
  const cenaObrazku = useMemo(() => {
    const zaklad = prehled?.modely.find(one => one.id === prehled?.model)?.cena ?? 0.05;
    return zaklad * dilKvality(prehled?.kvalita ?? 'high');
  }, [prehled]);

  /*
   * Odhad se počítá po vrstvách, ne po kusech: modelu jde jen výřez
   * kolem toho, co se obléká, a obrázek se platí podle plochy. Kravata
   * na výřezu hrudníku stojí zlomek toho, co postava na celé ploše —
   * a číslo u tlačítka má říkat, co to opravdu bude stát.
   */
  const volneRozmery = prehled?.modely.find(one => one.id === prehled?.model)?.volneRozmery ?? true;

  const odhadRozsahu = useCallback((rozsah: 'zakladni' | 'vse') => {
    let suma = 0;
    for (const v of vrstvy) {
      if (v.stav === 'hotovo' || v.stav === 'schvaleno') continue;
      const def = ZK_VRSTVY.find(one => one.typ === v.typ);
      if (!def) continue;
      if (rozsah === 'zakladni' && !doZakladu(def, v.varianta)) continue;
      suma += cenaObrazku * dilPlochy(v.typ, volneRozmery);
    }
    return Math.round(suma * 100) / 100;
  }, [vrstvy, cenaObrazku, volneRozmery]);

  const odhad = useMemo(() => odhadRozsahu('zakladni'), [odhadRozsahu]);
  const odhadVse = useMemo(() => odhadRozsahu('vse'), [odhadRozsahu]);

  /* ---------------------------------------------------------- výpis */

  const vrstvyVPoradi = useMemo(() => {
    const poradi = ZK_VRSTVY.map(one => one.typ);
    return [...vrstvy].sort((a, b) => poradi.indexOf(a.typ) - poradi.indexOf(b.typ));
  }, [vrstvy]);

  const produktyFiltr = useMemo(() => {
    const hledane = filtr.trim().toLowerCase();
    if (!hledane) return produkty;
    return produkty.filter(one =>
      one.nazev.toLowerCase().includes(hledane) || one.kod.toLowerCase().includes(hledane));
  }, [produkty, filtr]);

  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget && !pracuje) onClose(); }}>
      <div className="modal zk-modal">
        <div className="modal-head">
          <span className="modal-title"><Icon name="user" size={15} /> Zkušební kabina</span>
          <div className="zk-head-right">
            <button className={`tab ${zalozka === 'kabina' ? 'active' : ''}`} onClick={() => setZalozka('kabina')}>Kabina</button>
            <button className={`tab ${zalozka === 'vizualy' ? 'active' : ''}`} onClick={() => setZalozka('vizualy')}>Vizuály</button>
            <button className={`tab ${zalozka === 'produkty' ? 'active' : ''}`} onClick={() => setZalozka('produkty')}>Produkty</button>
            <button className={`tab ${zalozka === 'nastaveni' ? 'active' : ''}`} onClick={() => setZalozka('nastaveni')}>Nastavení</button>
            {!okno && <button className="icon-btn" onClick={onClose} disabled={!!pracuje}><Icon name="x" size={16} /></button>}
          </div>
        </div>

        {/*
          * Zástupná kresba se nesmí tvářit jako fotka. Je to jediná věta,
          * která odlišuje „kabina je hotová" od „kabina se dá zkoušet".
          */}
        {prehled?.ukazkove && (
          <div className="zk-pozor">
            <Icon name="alert" size={13} />
            <span>
              Postavy jsou zatím <b>zástupná kresba</b>, ne vygenerované fotky. Kabina se na nich
              dá proklikat celá — vyměnit se pak musí jen obrázky.
            </span>
          </div>
        )}
        {pracuje && <div className="zk-pracuje"><span className="spin" /> {pracuje}</div>}

        {zalozka === 'kabina' && (
          <div className="modal-body zk-kabina">
            <div className="zk-kabina-lista">
              <span className="desc">
                Tohle je <b>tentýž skript</b>, který poběží na e-shopu — ne jeho napodobenina.
              </span>
              {nahled && (
                <span className="desc">
                  Seznam {nahled.velikost.seznamKb} kB · {nahled.velikost.postav} postav ·{' '}
                  {nahled.velikost.vrstev} vrstev · {nahled.velikost.produktu} produktů
                </span>
              )}
              <button className="btn ghost" onClick={() => { setNahled(null); void obnovNahled(); }}>
                <Icon name="refresh" size={13} /> Obnovit
              </button>
            </div>
            {nahled?.url
              ? (
                /*
                 * `allow-same-origin` tu musí být. Bez něj má rámeček původ
                 * „null", takže mu prohlížeč zakáže sáhnout na vlastní
                 * seznam i na paměť — kabina pak ukázala jen „Teď to nejde"
                 * a minimalizace se neměla kam uložit. Obsah rámečku je
                 * naše vlastní stránka z vlastního protokolu, ne cizí web.
                 */
                <iframe className="zk-ramec" src={nahled.url} title="Zkušební kabina"
                  sandbox="allow-scripts allow-same-origin allow-downloads" />
              )
              : <div className="zk-prazdno">Náhled se připravuje…</div>}
          </div>
        )}

        {zalozka === 'vizualy' && (
          <div className="modal-body zk-vizualy">
            <aside className="zk-postavy">
              {(prehled?.postavy ?? []).map(one => (
                <button key={one.id}
                  className={`zk-postava ${postava === one.id ? 'sel' : ''}`}
                  onClick={() => setPostava(one.id)}>
                  <b>{popisPostavy(one.vek, one.telo)}</b>
                  <span className="desc">
                    {one.vrstev} z {one.chystanych} vrstev
                    {one.nesedi ? ` · ${one.nesedi} nesedí` : ''}
                    {one.upozorneni ? ` · ${one.upozorneni} k nahlédnutí` : ''}
                  </span>
                  <span className="zk-pruh">
                    <i style={{ width: `${Math.min(100, (one.vrstev / Math.max(1, one.chystanych)) * 100)}%` }} />
                  </span>
                </button>
              ))}
            </aside>

            <section className="zk-vrstvy">
              <header className="zk-vrstvy-hlava">
                <div>
                  <h3>{popisPostavy(stav?.vek ?? '', stav?.telo ?? '')}</h3>
                  <p className="desc">
                    Každý kus model nakreslí ve své kreslicí barvě a vrstva jsou body té barvy.
                    Kreslí se na postavu složenou z toho, co už je hotové — ne jedno z druhého.
                  </p>
                </div>
                <div className="zk-akce">
                  <button className="btn ghost" onClick={() => udelejUkazku(false)} disabled={!!pracuje}>
                    Zástupná kresba
                  </button>
                  {/*
                    * Dvě tlačítka, ne přepínač. Základní běh nakreslí
                    * všechny doplňky a jednu podobu kulisy — to je to, co
                    * prodává. Varianty navíc (čtvery vousy, dvoje sako)
                    * jsou vzhled modela a stojí další peníze, takže se
                    * o ně musí říct schválně.
                    */}
                  <button className="btn primary" onClick={() => generujVse('zakladni')}
                    disabled={!!pracuje || !prehled?.maKlic}
                    data-tip={prehled?.maKlic
                      ? `Doplňky a jedna podoba obleku. Odhad ${odhad} $.`
                      : 'Nejdřív vlož klíč k OpenAI v Nastavení.'}>
                    Dogenerovat potřebné{odhad ? ` · ${odhad} $` : ''}
                  </button>
                  {odhadVse > odhad && (
                    <button className="btn ghost" onClick={() => generujVse('vse')}
                      disabled={!!pracuje || !prehled?.maKlic}
                      data-tip="Včetně variant navíc — vousy, druhé sako, další účesy.">
                      I varianty navíc · {odhadVse} $
                    </button>
                  )}
                </div>
              </header>

              <div className="zk-mrizka">
                {vrstvyVPoradi.map(v => {
                  const klic = `${v.typ}:${v.varianta}`;
                  const stavVrstvy = STAVY[v.stav] ?? STAVY.ceka;
                  return (
                    <div key={klic} className={`zk-karta ${stavVrstvy.trida}`}>
                      <div className="zk-obrazek">
                        {v.nahled
                          ? <img src={v.nahled} alt={`${v.nazev} — ${v.variantaNazev}`} />
                          : <span className="zk-chybi">zatím nic</span>}
                      </div>
                      <div className="zk-karta-text">
                        <b>{v.nazev}</b>
                        <span className="desc">{v.variantaNazev}</span>
                        <em className={`zk-odznak ${stavVrstvy.trida}`}>{stavVrstvy.nazev}</em>
                      </div>
                      {v.potiz && <p className="zk-potiz">{v.potiz}</p>}
                      <div className="zk-karta-btns">
                        <button className="btn ghost" onClick={() => generuj(v.typ, v.varianta)}
                          disabled={!!pracuje || !prehled?.maKlic}>
                          {v.soubor ? 'Přegenerovat' : 'Vygenerovat'}
                        </button>
                        {v.stav === 'hotovo' && (
                          <button className="btn ghost" onClick={() => schval(v, true)}>Schválit</button>
                        )}
                        {/*
                          * Kontrola je mez, ne soud. Vlasy i s kotletami vyjdou
                          * na jedenáct procent postavy a mez je deset — na
                          * obrázku vedle je ale vidět, že jsou to vlasy.
                          * Rozhodnout to má člověk: přegenerovat stojí peníze.
                          */}
                        {v.stav === 'nesedi' && v.nahled && (
                          <button className="btn ghost" data-tip="Vrstva se použije, i když je mimo mez"
                            onClick={() => schval(v, true)}>Přesto použít</button>
                        )}
                        {v.stav === 'schvaleno' && (
                          <button className="btn ghost" onClick={() => schval(v, false)}>Zrušit schválení</button>
                        )}
                        <button className="icon-btn" data-tip="Zadání pro model"
                          onClick={() => setPodrobne(podrobne === klic ? null : klic)}>
                          <Icon name="sliders" size={13} />
                        </button>
                      </div>
                      {podrobne === klic && (
                        <div className="zk-zadani">
                          {/*
                            * Zadání se dá přepsat. Tohle je ta část, u které se
                            * nedá předem vědět, jak vyjde — pozná se to jedině
                            * tím, že se obrázek nakreslí a je vidět. Doladěná
                            * věta se uloží a použije i příště.
                            */}
                          <label>Zadání pro model (anglicky — tak mu to jde nejlíp)</label>
                          <textarea defaultValue={v.zadani} rows={5}
                            onBlur={async e => {
                              await api.zk.zadani(klic === 'postava:zaklad' ? `postava:${stav?.vek}:${stav?.telo}` : klic, e.target.value);
                              toast('Zadání uloženo.', 'info');
                            }} />
                          <button className="btn ghost" onClick={async () => {
                            await api.zk.zadaniZpet(klic === 'postava:zaklad' ? `postava:${stav?.vek}:${stav?.telo}` : klic);
                            setVrstvy(await api.zk.vrstvy(postava));
                            toast('Vráceno na výchozí.', 'info');
                          }}>Vrátit výchozí</button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {kroky.length > 0 && (
                <div className="zk-kroky">
                  <h4>Kroky oblékání</h4>
                  <p className="desc">
                    Takhle přišel kus od modelu, v kreslicí barvě. Když je obrázek jinak než
                    čekáš, je vidět proč.
                  </p>
                  <div className="zk-kroky-rada">
                    {kroky.map(k => (
                      <figure key={k.poradi}>
                        {k.nahled ? <img src={k.nahled} alt={k.typ} /> : <span className="zk-chybi">—</span>}
                        <figcaption>{k.poradi}. {k.typ}</figcaption>
                      </figure>
                    ))}
                  </div>
                </div>
              )}
            </section>
          </div>
        )}

        {zalozka === 'produkty' && (
          <div className="modal-body zk-produkty">
            <header className="zk-produkty-hlava">
              <div>
                <h3>Naše doplňky na modelu</h3>
                <p className="desc">
                  Zařazeno {prehled?.produkty.zarazenych ?? 0} doplňků, barvu a vzor z fotky má{' '}
                  {prehled?.produkty.sBarvou ?? 0}. Obleky a košile tu nejsou schválně — ty se
                  neprodávají a v kabině jsou jen kulisa, kterou si zákazník nastaví barvou.
                  Špatně zařazený kus obleče zákazníkovi kravatu místo pásku, proto to nakonec
                  potvrzuje člověk.
                </p>
              </div>
              <div className="zk-akce">
                <input className="zk-hledani" placeholder="Hledat v produktech"
                  value={filtr} onChange={e => setFiltr(e.target.value)} />
                <button className="btn primary" disabled={!!pracuje} onClick={async () => {
                  setPracuje('Procházím katalog…');
                  try {
                    const vysledek = await api.zk.katalog(true, true);
                    toast(`Zařazeno ${vysledek.zarazeno}, barvu z fotky má ${vysledek.obarveno}.`, 'info');
                    setProdukty(await api.zk.produkty(300));
                    await nactiPrehled();
                  } catch (e: any) { toast(e.message, 'error'); }
                  setPracuje('');
                }}>Projít katalog</button>
              </div>
            </header>

            <div className="zk-tabulka">
              {produktyFiltr.map(p => (
                <div key={p.kod} className={`zk-radek ${p.schvaleno ? 'ok' : ''}`}>
                  {p.obrazek ? <img src={p.obrazek} alt="" /> : <span className="zk-chybi" />}
                  {/* Vzorek látky: tohle se vydláždí na modelu, ne fotka produktu */}
                  {p.vzorek
                    ? <img className="zk-vzorek" src={p.vzorek} alt="" data-tip="Vzorek látky — tohle se vykreslí na modelu" />
                    : <span className="zk-vzorek zk-chybi" data-tip="Vzorek se nepodařilo z fotky vystřihnout — použije se barva" />}
                  <div className="zk-radek-text">
                    <b>{p.nazev}</b>
                    <span className="desc">{p.kod}{p.cena ? ` · ${p.cena}` : ''}{p.velikosti ? ' · má velikosti' : ''}</span>
                  </div>
                  <select value={p.typ} onChange={e => {
                    const typ = e.target.value as ZkVrstvaTyp | '';
                    void api.zk.produkt(p.kod, { typ, varianta: typ ? vrstvaDef(typ).varianty[0].id : '' });
                    setProdukty(prev => prev.map(one => one.kod === p.kod
                      ? { ...one, typ, varianta: typ ? vrstvaDef(typ).varianty[0].id : '' } : one));
                  }}>
                    <option value="">— nepatří na model —</option>
                    {/*
                      * Nabízí se jen **zboží**. Oblek a košile se neprodávají
                      * a v kabině jsou kulisa, kterou si zákazník nastavuje
                      * barvou — přiřadit k nim produkt nemá kam.
                      */}
                    {ZK_VRSTVY.filter(one => one.zbozi).map(one => (
                      <option key={one.typ} value={one.typ}>{one.nazev}</option>
                    ))}
                  </select>
                  {p.typ && vrstvaDef(p.typ).varianty.length > 1 && (
                    <select value={p.varianta} onChange={e => {
                      void api.zk.produkt(p.kod, { varianta: e.target.value });
                      setProdukty(prev => prev.map(one => one.kod === p.kod ? { ...one, varianta: e.target.value } : one));
                    }}>
                      {vrstvaDef(p.typ).varianty.map(one => (
                        <option key={one.id} value={one.id}>{one.nazev}</option>
                      ))}
                    </select>
                  )}
                  <input type="color" value={p.hex || '#808080'} title="Barva látky"
                    onChange={e => {
                      void api.zk.produkt(p.kod, { hex: e.target.value });
                      setProdukty(prev => prev.map(one => one.kod === p.kod
                        ? { ...one, hex: e.target.value, rucne: true } : one));
                    }} />
                  <button className={`icon-btn ${p.schvaleno ? 'on' : ''}`} data-tip="Potvrdit zařazení"
                    onClick={() => {
                      void api.zk.produkt(p.kod, { schvaleno: !p.schvaleno });
                      setProdukty(prev => prev.map(one => one.kod === p.kod ? { ...one, schvaleno: !one.schvaleno } : one));
                    }}>
                    <Icon name="check" size={14} />
                  </button>
                </div>
              ))}
              {produktyFiltr.length === 0 && (
                <p className="desc">Zatím nic. Projdi katalog — zařadí se podle názvu a zbytek dotřídí AI.</p>
              )}
            </div>
          </div>
        )}

        {zalozka === 'nastaveni' && nastaveni && (
          <div className="modal-body zk-nastaveni">
            <section>
              <h3>Klíč k OpenAI</h3>
              <p className="desc">
                Obrázky kreslí OpenAI — zbytek aplikace mluví s Anthropicem, který obrázky neumí.
                Klíč se uloží zašifrovaně a z aplikace už ho nejde přečíst.
              </p>
              <div className="zk-rada">
                <input type="password" placeholder={nastaveni.maKlic ? 'Klíč je uložený' : 'sk-…'}
                  onBlur={async e => {
                    if (!e.target.value) return;
                    await api.zk.nastav({ klic: e.target.value });
                    e.target.value = '';
                    setNastaveni(await api.zk.nastaveni());
                    await nactiPrehled();
                    toast('Klíč uložen.', 'info');
                  }} />
                {nastaveni.maKlic && (
                  <button className="btn ghost" onClick={async () => {
                    await api.zk.nastav({ klic: '' });
                    setNastaveni(await api.zk.nastaveni());
                    await nactiPrehled();
                  }}>Smazat klíč</button>
                )}
              </div>
            </section>

            <section>
              <h3>Model</h3>
              <div className="zk-modely">
                {(prehled?.modely ?? []).map(m => (
                  <label key={m.id} className={`zk-model ${nastaveni.model === m.id ? 'sel' : ''}`}>
                    <input type="radio" name="zkmodel" checked={nastaveni.model === m.id}
                      onChange={async () => {
                        await api.zk.nastav({ model: m.id });
                        setNastaveni(await api.zk.nastaveni());
                        await nactiPrehled();
                      }} />
                    <div>
                      <b>{m.nazev}</b>
                      <span className="desc">{m.popis}</span>
                      <span className="desc">asi {m.cena} $ za obrázek</span>
                    </div>
                  </label>
                ))}
              </div>
            </section>

            <section>
              <h3>Kvalita kreslení</h3>
              <p className="desc">
                Jeden obrázek ve vysoké kvalitě stojí čtyřikrát tolik co v nízké a postav je devět
                po dvaadvaceti vrstvách. Projet řetěz nejdřív nízkou kvalitou stojí pár korun a
                ukáže to podstatné — jestli model drží postavu mezi kroky a jestli vrstvy sedí.
                Načisto se pak dogeneruje ve vysoké.
              </p>
              <div className="zk-modely">
                {ZK_KVALITY.map(k => (
                  <label key={k.id} className={`zk-model ${nastaveni.kvalita === k.id ? 'sel' : ''}`}>
                    <input type="radio" name="zkkvalita" checked={nastaveni.kvalita === k.id}
                      onChange={async () => {
                        await api.zk.nastav({ kvalita: k.id });
                        setNastaveni(await api.zk.nastaveni());
                        void nactiPrehled();
                      }} />
                    <b>{k.nazev}</b>
                    <span className="desc">{k.popis}</span>
                    <span className="desc">
                      asi {Math.round((prehled?.modely.find(one => one.id === prehled?.model)?.cena ?? 0.05)
                        * k.dil * 1000) / 1000} $ za obrázek
                    </span>
                  </label>
                ))}
              </div>
            </section>

            <section>
              <h3>Strop na měsíc</h3>
              <p className="desc">
                Generování je smyčka přes postavy a kusy oblečení — jeden překlep v počtu a je to
                sto obrázků místo deseti. Přes strop se nedostane ani opakování.
              </p>
              <div className="zk-rada">
                <input type="number" min={0} max={500} defaultValue={nastaveni.strop}
                  onBlur={async e => {
                    await api.zk.nastav({ strop: Number(e.target.value) });
                    setNastaveni(await api.zk.nastaveni());
                    await nactiPrehled();
                  }} />
                <span className="desc">
                  Tenhle měsíc utraceno {Math.round((prehled?.utrata.usd ?? 0) * 100) / 100} $
                  za {prehled?.utrata.kusu ?? 0} obrázků.
                </span>
              </div>
            </section>

            <section>
              <h3>Rádi poradíme osobně</h3>
              <p className="desc">
                Tahle věta je v kabině vidět pořád. Kdo si není jistý, je přesně ten, kdo zavolá —
                a pak koupí.
              </p>
              <div className="zk-kontakt">
                <input defaultValue={nastaveni.kontakt.text} placeholder="Věta pro zákazníka"
                  onBlur={e => void api.zk.kontakt({ ...nastaveni.kontakt, text: e.target.value })} />
                <input defaultValue={nastaveni.kontakt.telefon} placeholder="Telefon"
                  onBlur={e => void api.zk.kontakt({ ...nastaveni.kontakt, telefon: e.target.value })} />
                <input defaultValue={nastaveni.kontakt.mail} placeholder="E-mail"
                  onBlur={e => void api.zk.kontakt({ ...nastaveni.kontakt, mail: e.target.value })} />
              </div>
            </section>

            <section>
              <h3>Kabina na e-shopu</h3>
              <p className="desc">
                Do šablony e-shopu se vkládá <b>jen zavaděč</b> — pár kilobajtů, které do kliknutí
                nic nestáhnou. Sama kabina i obrázky vrstev leží v úložišti a mění se tady;
                kód v administraci se podruhé vkládat nemusí.
              </p>
              <div className="zk-akce">
                <button className="btn primary" disabled={!!vystavuji}
                  onClick={async () => {
                    setVystavuji('Vystavuji…');
                    try {
                      const hotovo = await api.zk.vystav();
                      setNastaveni(await api.zk.nastaveni());
                      toast(`Vystaveno: ${hotovo.nahranych} souborů (${hotovo.megabajtu} MB), `
                        + `${hotovo.preskocenych} beze změny.`);
                    } catch (e: any) { toast(e.message, 'error'); }
                    setVystavuji('');
                  }}>
                  <Icon name="upload" size={13} /> Vystavit na web
                </button>
                {vystavuji && <span className="desc"><span className="spin" /> {vystavuji}</span>}
                {!vystavuji && nastaveni.vystaveno?.kdy && (
                  <span className="desc">
                    Naposledy {new Date(nastaveni.vystaveno?.kdy).toLocaleString('cs-CZ')}
                  </span>
                )}
              </div>
              {nastaveni.vystaveno?.kod
                ? (
                  <>
                    <textarea className="zk-zavadec" readOnly rows={4} value={nastaveni.vystaveno?.kod}
                      onFocus={e => e.currentTarget.select()} />
                    <div className="zk-akce">
                      <button className="btn ghost" onClick={async () => {
                        await navigator.clipboard.writeText(nastaveni.vystaveno?.kod);
                        toast('Zavaděč je ve schránce — vlož ho do šablony e-shopu.');
                      }}>
                        <Icon name="copy" size={13} /> Zkopírovat zavaděč
                      </button>
                      <span className="desc">{Math.round(nastaveni.vystaveno?.kod.length / 1000)} tisíc znaků</span>
                    </div>
                  </>
                )
                : (
                  <p className="desc">
                    Zavaděč se ukáže po prvním vystavení — nese v sobě adresu, na které kabina leží.
                  </p>
                )}
            </section>

            <section>
              <h3>Pobídky na modelu</h3>
              <p className="desc">
                Když zákazník klikne na prázdné místo v klopě, kabina nabídne kapesníčky. Kdo chce
                vidět celou nabídku, má jít do kategorie — jen ta adresa se nedá uhodnout, slug je
                v každé jazykové verzi jiný. Bez adresy zůstane hledání uvnitř kabiny.
              </p>
              <div className="zk-kategorie">
                {(['kravata', 'ksandy', 'pasek', 'kapesnicek'] as const).map(typ => (
                  <label key={typ}>
                    <span>{ZK_VRSTVY.find(one => one.typ === typ)?.nazev ?? typ}</span>
                    {(['cz', 'sk', 'en'] as const).map(jazyk => (
                      <input key={jazyk} placeholder={jazyk.toUpperCase()}
                        defaultValue={nastaveni.kategorie?.[typ]?.[jazyk] ?? ''}
                        onBlur={e => {
                          const vse = { ...(nastaveni.kategorie ?? {}) };
                          vse[typ] = { ...(vse[typ] ?? {}), [jazyk]: e.target.value.trim() };
                          void api.zk.nastav({ kategorie: vse });
                        }} />
                    ))}
                  </label>
                ))}
              </div>
            </section>

            <section>
              <h3>Rada s velikostí kšand</h3>
              <p className="desc">
                Rodič, který netuší, jestli „70 cm" je na čtyřleté dítě, nákup odloží. Kabina proto
                poradí podle výšky — a přizná, že je to odhad. Tenhle poměr říká, jakou část výšky
                člověka kšandy měří; až se z vrácených zásilek pozná přesnější číslo, přepiš ho.
              </p>
              <div className="zk-kontakt">
                <input type="number" step={0.01} min={0.3} max={1.1} defaultValue={nastaveni.ksandyDil}
                  onBlur={async e => {
                    await api.zk.nastav({ ksandyDil: Number(e.target.value) });
                    setNastaveni(await api.zk.nastaveni());
                  }} />
                <span className="desc">
                  Dítě 120 cm → {Math.round(120 * (nastaveni.ksandyDil || 0.62))} cm ·
                  dospělý 180 cm → {Math.round(180 * (nastaveni.ksandyDil || 0.62))} cm
                </span>
              </div>
            </section>

            <section>
              <h3>Nabídka barev v kabině</h3>
              <p className="desc">
                Odsud si zákazník vybírá jedním klikem; přesnou barvu si k tomu může doladit sám.
              </p>
              <div className="zk-barvy">
                {ZK_BARVY.map(b => (
                  <span key={b.id} className="zk-barva" style={{ background: b.hex }} title={b.nazev} />
                ))}
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

const VEKY: Record<string, string> = { dospely: 'Dospělý', dite: 'Dítě', kojenec: 'Kojenec' };
const TELA: Record<string, string> = { hubeny: 'štíhlý', bezny: 'běžný', silny: 'silnější' };

function popisPostavy(vek: string, telo: string): string {
  return `${VEKY[vek] ?? vek} — ${TELA[telo] ?? telo}`;
}
