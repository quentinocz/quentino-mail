import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ZkFrontaRadek, ZkKrokProOkno, ZkNahled, ZkNastaveni, ZkPrehled, ZkProduktRadek,
  ZkVrstvaProOkno, ZkVrstvaTyp, ZkZkouskaModelu, ZkKotvy, ZkVykresleniProOkno
} from '@shared/zkusebna';
import {
  ZK_BARVY, ZK_DRUHY_FOTEK, ZK_KVALITY, ZK_VRSTVY, dilKvality, dilPlochy, doZakladu, vrstvaDef
} from '@shared/zkusebna';
import { api } from '../api';
import { useToast } from '../toast';
import Icon from './Icon';
import HelpButton from './HelpPanel';
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
  /* Náhled jako na telefonu — většina zákazníků kabinu otevře na mobilu (Patrik, 23. 11.) */
  const [naMobilu, setNaMobilu] = useState(false);

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
  /* Projití katalogu a rozpoznávání fotek trvají minuty — ať je vidět, kde to je */
  useEffect(() => api.on('zk:katalog-krok', (krok: any) => {
    setPracuje(`${krok?.co ?? 'Pracuji'}…`);
  }), []);
  const [revizePostava, setRevizePostava] = useState('');
  /* Produkty: zařazení a látky, nebo vykreslení na modelu */
  const [produktyPohled, setProduktyPohled] = useState<'schvaleni' | 'zarazeni'>('schvaleni');
  const [revizeFotky, setRevizeFotky] = useState(true);
  const [revize, setRevize] = useState('');
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
    } catch (e: any) {
      toast(e.message, 'error');
      /* Chyba zůstane vidět nad vrstvami — bublina zmizí dřív, než ji kdo přečte */
      await nactiPrehled();
    }
    setPracuje('');
  };

  /*
   * Realistické šablony (Patrik, 25. 11.: „šablony by mohly být mnohem
   * více realistické a lépe sedět na modelu"). AI dokreslí tvar a světlo
   * jednou za postavu; vzor jde dál ze skutečné fotky každého produktu.
   */
  const [aiPredPo, setAiPredPo] = useState<Record<string, string>>({});
  const [odhadAi, setOdhadAi] = useState<{ kusu: number; usd: number } | null>(null);
  useEffect(() => {
    let platne = true;
    api.zk.realistickeOdhad(postava).then(one => { if (platne) setOdhadAi(one); }).catch(() => { if (platne) setOdhadAi(null); });
    return () => { platne = false; };
  }, [postava, vrstvy]);
  const realisticky = async (typ: ZkVrstvaTyp, varianta: string) => {
    setPracuje('AI dokresluje šablonu…');
    try {
      const r = await api.zk.realisticka(postava, typ, varianta);
      setAiPredPo(prev => ({ ...prev, [`${typ}:${varianta}`]: r.nahled }));
      toast(r.ok ? 'Šablona je realistická — v kabině hned.' : `Návrh od AI neprošel kontrolou: ${r.potiz}`, r.ok ? 'info' : 'error');
      setVrstvy(await api.zk.vrstvy(postava));
      setNahled(null);
    } catch (e: any) { toast(e.message, 'error'); }
    setPracuje('');
  };
  const realistickeVse = async () => {
    setPracuje('AI dokresluje šablony…');
    try {
      const r = await api.zk.realistickeVse(postava);
      toast(`Realistických šablon: ${r.hotovo}${r.navrhu ? `, ${r.navrhu} ke kontrole` : ''}${r.chyb ? `, ${r.chyb} chyb: ${r.posledniChyba}` : ''}.`,
        r.chyb ? 'error' : 'info');
      setVrstvy(await api.zk.vrstvy(postava));
      setNahled(null);
    } catch (e: any) { toast(e.message, 'error'); }
    setPracuje('');
  };
  const navrhAi = async (typ: ZkVrstvaTyp, varianta: string, co: 'pouzij' | 'zahod') => {
    try {
      await api.zk.realistickaNavrh(postava, typ, varianta, co);
      toast(co === 'pouzij' ? 'Návrh od AI je použitý.' : 'Návrh zahozen, zůstává kreslená šablona.', 'info');
      setVrstvy(await api.zk.vrstvy(postava));
      setNahled(null);
    } catch (e: any) { toast(e.message, 'error'); }
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
    } catch (e: any) {
      toast(e.message, 'error');
      /* Co se do chyby stihlo, se ukáže — a chyba zůstane nad vrstvami */
      try {
        setVrstvy(await api.zk.vrstvy(postava));
        setKroky(await api.zk.kroky(postava));
      } catch { /* okno to zkusí příště */ }
      await nactiPrehled();
    }
    setPracuje('');
  };

  /*
   * Zkouška modelu: jeden levný obrázek. Řekne najisto, jestli jde
   * o klíč, ověření organizace, kredit, nebo model — dřív, než se
   * pustí běh za dolary.
   */
  const [zkouska, setZkouska] = useState<ZkZkouskaModelu | null>(null);
  const [zkousim, setZkousim] = useState(false);
  const vyzkousej = async () => {
    setZkousim(true);
    setZkouska(null);
    try {
      setZkouska(await api.zk.zkouska());
      await nactiPrehled();
    } catch (e: any) { toast(e.message, 'error'); }
    setZkousim(false);
  };

  const zkouskaVysledek = zkouska && (
    <p className={`zk-zkouska ${zkouska.ok ? 'ok' : 'chyba'}`}>
      {zkouska.ok
        ? <>Kreslení funguje — {zkouska.model}, obrázek za {zkouska.sekund} s.
            {zkouska.pruhledne
              ? ' Průhledné pozadí vrací model sám.'
              : ' Průhledné pozadí model nevrací; aplikace ho vyřízne sama (postava se kreslí na bílém).'}
            {zkouska.bez.length ? ` Nepodporované volby vynechány: ${zkouska.bez.join(', ')}.` : ''}</>
        : zkouska.chyba}
    </p>
  );

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
    /* Postava ze starého postupu se nakreslí znovu i se vším, co se na ni dokreslovalo */
    const znovu = !!stav?.zastarala;
    for (const v of vrstvy) {
      if (!znovu && (v.stav === 'hotovo' || v.stav === 'schvaleno')) continue;
      const def = ZK_VRSTVY.find(one => one.typ === v.typ);
      if (!def) continue;
      /* Šablony a kulisa z obrázku postavy nic nestojí */
      if (def.sablona || def.zPostavy === v.varianta) continue;
      if (rozsah === 'zakladni' && !doZakladu(def, v.varianta)) continue;
      suma += cenaObrazku * dilPlochy(v.typ, volneRozmery);
    }
    return Math.round(suma * 100) / 100;
  }, [vrstvy, cenaObrazku, volneRozmery, stav?.zastarala]);

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
          <HelpButton topic="zkusebna" />
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
              {(nahled?.chybi?.length ?? 0) > 0 && (
                <div className="zk-chybi-vrstvy" role="status">
                  <Icon name="alert" size={13} />
                  <span>
                    Bez vypínače v kabině:{' '}
                    {nahled!.chybi!.map((one, i) => (
                      <span key={`${one.postava}-${one.typ}`}>
                        {i > 0 ? ', ' : ''}
                        <button className="zk-odkaz" title={one.potiz || 'Vrstva ještě není nakreslená'} onClick={() => {
                          setPostava(one.postava);
                          setZalozka('vizualy');
                        }}>
                          {one.typ === 'sako' ? 'sako' : 'vesta'} ({popisPostavy(one.vek, one.telo).toLowerCase()}
                          {one.stav === 'nesedi' ? ', nesedí' : ''})
                        </button>
                      </span>
                    ))}
                    {' '}— dokresli ve Vizuálech.
                  </span>
                </div>
              )}
              <div className="pk-seg zk-zarizeni" role="group" aria-label="Zařízení">
                <button className={`pk-seg-btn ${naMobilu ? '' : 'on'}`} aria-pressed={!naMobilu}
                  onClick={() => setNaMobilu(false)}>Počítač</button>
                <button className={`pk-seg-btn ${naMobilu ? 'on' : ''}`} aria-pressed={naMobilu}
                  onClick={() => setNaMobilu(true)}>Mobil</button>
              </div>
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
                /*
                 * Mobil je rámeček na šířku telefonu (390 bodů), ne zmenšená
                 * stránka: kabina se rozkládá podle šířky okna, takže jen tak
                 * se ukáže to, co uvidí zákazník v telefonu — model nahoře,
                 * nabídka pod ním.
                 */
                <div className={`zk-ramec-obal ${naMobilu ? 'mobil' : ''}`}>
                  <iframe className="zk-ramec" src={nahled.url} title="Zkušební kabina"
                    sandbox="allow-scripts allow-same-origin allow-downloads" />
                </div>
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
                    Model kreslí jen postavu (rovnou v košili, kalhotách a botách — vyříznou se
                    z jednoho obrázku, takže na sebe sedí), vestu a sako. Kravaty, motýlky, kšandy
                    a kapesníčky jsou <b>šablony</b> v rozměrech z katalogu: zadarmo a na bod.
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
                      ? `Postava, vesta a sako od modelu, doplňky ze šablon. Odhad ${odhad} $.`
                      : 'Nejdřív vlož klíč k OpenAI v Nastavení.'}>
                    Dogenerovat potřebné{odhad ? ` · ${odhad} $` : ''}
                  </button>
                  {!!odhadAi?.kusu && stav?.hotovo && (
                    <button className="btn ghost" onClick={() => void realistickeVse()}
                      disabled={!!pracuje || !prehled?.maKlic}
                      data-tip="AI dokreslí kravaty, motýlky, kšandy a kapesníček realisticky — záhyby, uzel, spony. Jednou za postavu; vzor každého produktu jde dál z jeho fotky.">
                      <Icon name="sparkles" size={13} /> Realistické šablony ({odhadAi.kusu}) · ~{odhadAi.usd.toLocaleString('cs-CZ')} $
                    </button>
                  )}
                  {odhadVse > odhad && (
                    <button className="btn ghost" onClick={() => generujVse('vse')}
                      disabled={!!pracuje || !prehled?.maKlic}
                      data-tip="Včetně variant navíc — dvouřadové sako, košile se stojáčkem.">
                      I varianty navíc · {odhadVse} $
                    </button>
                  )}
                </div>
              </header>

              {stav?.zastarala && (
                <div className="zk-pozor zk-pozor-v">
                  <Icon name="alert" size={13} />
                  <span>
                    Tahle postava je ze starého postupu (v šedém tričku, oblečení dokreslované po
                    kusech). Při <b>Dogenerovat potřebné</b> se nakreslí znovu — rovnou v košili —
                    a kulisa i šablony se z ní vyrobí nově.
                  </span>
                </div>
              )}

              {prehled?.posledniChyba && (
                <div className="zk-chyba-pruh" role="alert">
                  <Icon name="alert" size={14} />
                  <div>
                    <b>Generování naposledy selhalo</b>
                    <span className="desc">
                      {new Date(prehled.posledniChyba.kdy).toLocaleString('cs-CZ')} · {prehled.posledniChyba.model}
                    </span>
                    <p>{prehled.posledniChyba.text}</p>
                    {zkouskaVysledek}
                  </div>
                  <button className="btn ghost" onClick={vyzkousej} disabled={zkousim || !!pracuje || !prehled.maKlic}
                    data-tip="Jeden malý obrázek v nízké kvalitě, kolem centu">
                    {zkousim ? <><span className="spin" /> Zkouším…</> : 'Vyzkoušet model'}
                  </button>
                </div>
              )}
              {/* Povedená zkouška chybu smaže — výsledek pak zůstane vidět samostatně */}
              {!prehled?.posledniChyba && zkouskaVysledek}

              {stav?.hotovo && !stav.zastarala && (
                <BodyNaPostave postava={postava} obnova={vrstvy}
                  onZmena={async () => { setVrstvy(await api.zk.vrstvy(postava)); setNahled(null); }} />
              )}

              <div className="zk-mrizka">
                {vrstvyVPoradi.map(v => {
                  const klic = `${v.typ}:${v.varianta}`;
                  const stavVrstvy = STAVY[v.stav] ?? STAVY.ceka;
                  const defV = ZK_VRSTVY.find(one => one.typ === v.typ);
                  /* Šablona a kulisa z postavy se nekreslí modelem: zadarmo, bez klíče, bez zadání */
                  const sablona = !!defV?.sablona;
                  const zPostavy = defV?.zPostavy === v.varianta;
                  return (
                    <div key={klic} className={`zk-karta ${stavVrstvy.trida}`}>
                      <div className="zk-obrazek">
                        {v.nahled
                          ? <img src={v.nahled} alt={`${v.nazev} — ${v.variantaNazev}`} />
                          : <span className="zk-chybi">zatím nic</span>}
                      </div>
                      <div className="zk-karta-text">
                        <b>{v.nazev}</b>
                        <span className="desc">{v.variantaNazev}{sablona ? (v.realisticka ? ' · realistická (AI)' : ' · šablona') : zPostavy ? ' · z postavy' : ''}</span>
                        <em className={`zk-odznak ${stavVrstvy.trida}`}>{stavVrstvy.nazev}</em>
                      </div>
                      {v.potiz && <p className="zk-potiz">{v.potiz}</p>}
                      <div className="zk-karta-btns">
                        {sablona ? (
                          <>
                            <button className="btn ghost" onClick={() => generuj(v.typ, v.varianta)}
                              disabled={!!pracuje || !stav?.hotovo}
                              data-tip={v.realisticka ? 'Zpátky na kreslenou šablonu podle bodů — nic nestojí' : 'Šablona podle bodů na postavě — nic nestojí'}>
                              {v.realisticka ? 'Vrátit kreslenou' : v.soubor ? 'Překreslit' : 'Nakreslit'}
                            </button>
                            {v.soubor && (
                              <button className="btn ghost" onClick={() => void realisticky(v.typ, v.varianta)}
                                disabled={!!pracuje || !stav?.hotovo || !prehled?.maKlic}
                                data-tip="AI dokreslí tvar a světlo realisticky (jeden obrázek). Vzor zůstává z fotky produktu.">
                                <Icon name="sparkles" size={13} /> {v.realisticka ? 'Znovu AI' : 'Realisticky'}
                              </button>
                            )}
                          </>
                        ) : zPostavy ? (
                          <button className="btn ghost" onClick={() => generuj(v.typ, v.varianta)}
                            disabled={!!pracuje || !stav?.hotovo || !!stav?.zastarala}
                            data-tip="Vyřízne se znovu z obrázku postavy — nic nestojí">
                            Vyříznout znovu
                          </button>
                        ) : (
                          <button className="btn ghost" onClick={() => generuj(v.typ, v.varianta)}
                            disabled={!!pracuje || !prehled?.maKlic}>
                            {v.soubor ? 'Přegenerovat' : 'Vygenerovat'}
                          </button>
                        )}
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
                        {!sablona && !zPostavy && (
                          <button className="icon-btn" data-tip="Zadání pro model"
                            onClick={() => setPodrobne(podrobne === klic ? null : klic)}>
                            <Icon name="sliders" size={13} />
                          </button>
                        )}
                      </div>
                      {sablona && (v.navrhAi || aiPredPo[klic]) && (
                        <div className={`zk-ai-navrh ${v.navrhAi ? 'nesedi' : ''}`}>
                          <img src={v.navrhAi?.nahled || aiPredPo[klic]} alt="Šablona před a po dokreslení AI" />
                          <span className="desc">
                            {v.navrhAi ? <>Návrh od AI neprošel kontrolou: {v.navrhAi.potiz}</> : 'Před a po dokreslení AI.'}
                          </span>
                          {v.navrhAi && (
                            <span className="zk-karta-btns">
                              <button className="btn ghost" onClick={() => void navrhAi(v.typ, v.varianta, 'pouzij')}>Přesto použít</button>
                              <button className="btn ghost" onClick={() => void navrhAi(v.typ, v.varianta, 'zahod')}>Zahodit</button>
                            </span>
                          )}
                        </div>
                      )}
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
                              await api.zk.zadani(klic === 'postava:zaklad' ? `postava2:${stav?.vek}:${stav?.telo}` : klic, e.target.value);
                              toast('Zadání uloženo.', 'info');
                            }} />
                          <button className="btn ghost" onClick={async () => {
                            await api.zk.zadaniZpet(klic === 'postava:zaklad' ? `postava2:${stav?.vek}:${stav?.telo}` : klic);
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
                  Varianta určuje šablonu na modelu — šířku kravaty a kšand, velikost motýlka; bere
                  se z parametru „Šířka" nebo z popisu. Špatně zařazený kus obleče zákazníkovi
                  motýlka místo kravaty, proto to nakonec potvrzuje člověk.
                </p>
              </div>
              <div className="zk-akce">
                <input className="zk-hledani" placeholder="Hledat v produktech"
                  value={filtr} onChange={e => setFiltr(e.target.value)} />
                <button className="btn primary" disabled={!!pracuje} onClick={async () => {
                  setPracuje('Procházím katalog…');
                  try {
                    const vysledek = await api.zk.katalog(true, true);
                    toast(`Zařazeno ${vysledek.zarazeno}, barvu z fotky má ${vysledek.obarveno}`
                      + (vysledek.rozpoznano ? `, AI rozpoznala ${vysledek.rozpoznano} sad.` : '.')
                      + (vysledek.chybaRozpoznani ? ` Rozpoznání: ${vysledek.chybaRozpoznani}` : ''),
                      vysledek.chybaRozpoznani ? 'error' : 'info');
                    setProdukty(await api.zk.produkty(300));
                    await nactiPrehled();
                  } catch (e: any) { toast(e.message, 'error'); }
                  setPracuje('');
                }}>Projít katalog</button>
              </div>
            </header>

            <div className="pk-seg zk-produkty-pohled" role="group" aria-label="Pohled">
              <button className={`pk-seg-btn ${produktyPohled === 'schvaleni' ? 'on' : ''}`}
                onClick={() => setProduktyPohled('schvaleni')}>Na modelu</button>
              <button className={`pk-seg-btn ${produktyPohled === 'zarazeni' ? 'on' : ''}`}
                onClick={() => setProduktyPohled('zarazeni')}>Zařazení</button>
            </div>

            {produktyPohled === 'schvaleni' && (
              <SchvalovaniPanel pracuje={pracuje} setPracuje={setPracuje} />
            )}

            {produktyPohled === 'zarazeni' && <div className="zk-tabulka">
              {produktyFiltr.map(p => (
                <div key={p.kod} className={`zk-produkt ${p.kontrola && !p.schvaleno ? 'ceka' : ''}`}>
                <div className={`zk-radek ${p.schvaleno ? 'ok' : ''}`}>
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
                  {/*
                    * Velikost vzoru: odhad „kolik centimetrů látky je na fotce"
                    * se může splést — tímhle se doladí, aby kytičky na
                    * kravatě byly kytičky, ne talíře.
                    */}
                  {p.vzorek && p.typ !== 'kapesnicek' && (
                    <label className="zk-meritko" data-tip="Velikost vzoru na modelu">
                      <span>Vzor</span>
                      <input type="range" min={0.4} max={2.5} step={0.1} value={p.meritko || 1}
                        onChange={e => {
                          const meritko = Number(e.target.value);
                          setProdukty(prev => prev.map(one => one.kod === p.kod ? { ...one, meritko } : one));
                        }}
                        onMouseUp={e => void api.zk.produkt(p.kod, { meritko: Number((e.target as HTMLInputElement).value) })}
                        onKeyUp={e => void api.zk.produkt(p.kod, { meritko: Number((e.target as HTMLInputElement).value) })}
                        onTouchEnd={e => void api.zk.produkt(p.kod, { meritko: Number((e.target as HTMLInputElement).value) })} />
                      <b>{(p.meritko || 1).toFixed(1)}×</b>
                    </label>
                  )}
                  {p.typ && p.vKabine && (
                    <button className="icon-btn" data-tip="Vykreslit na modelu (AI podle fotky)"
                      disabled={!!pracuje} onClick={async () => {
                        setPracuje(`Vykresluji ${p.nazev}…`);
                        try {
                          const r = await api.zk.vykresli('vse', [p.kod]);
                          toast(r.chyb ? r.posledniChyba : `Vykresleno ${r.hotovo}${r.nesedi ? `, ${r.nesedi} nesedí` : ''} — zkontroluj v pohledu Na modelu.`,
                            r.chyb || r.nesedi ? 'error' : 'info');
                        } catch (e: any) { toast(e.message, 'error'); }
                        setPracuje('');
                      }}>
                      <Icon name="image" size={14} />
                    </button>
                  )}
                  <button className={`icon-btn ${p.schvaleno ? 'on' : ''}`} data-tip="Potvrdit zařazení"
                    onClick={() => {
                      void api.zk.produkt(p.kod, { schvaleno: !p.schvaleno });
                      setProdukty(prev => prev.map(one => one.kod === p.kod ? { ...one, schvaleno: !one.schvaleno } : one));
                    }}>
                    <Icon name="check" size={14} />
                  </button>
                </div>
                {(p.kontrola || p.casti.length > 0) && (
                  <SadaProduktu p={p} onZmena={zmena => setProdukty(prev => prev.map(one =>
                    one.kod === p.kod ? { ...one, ...zmena } : one))} />
                )}
                </div>
              ))}
              {produktyFiltr.length === 0 && (
                <p className="desc">Zatím nic. Projdi katalog — zařadí se podle názvu a zbytek dotřídí AI.</p>
              )}
            </div>}
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
              <div className="zk-zkouska-rada">
                <button className="btn ghost" onClick={vyzkousej} disabled={zkousim || !nastaveni.maKlic}
                  data-tip="Jeden malý obrázek v nízké kvalitě, kolem centu">
                  {zkousim ? <><span className="spin" /> Zkouším…</> : 'Vyzkoušet model'}
                </button>
                <span className="desc">
                  Ověří klíč, model i průhledné pozadí jedním levným obrázkem — dřív než běh za dolary.
                </span>
              </div>
              {zkouskaVysledek}
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
                Jeden obrázek ve vysoké kvalitě stojí čtyřikrát tolik co v nízké a postavy jsou tři
                po patnácti vrstvách. Projet řetěz nejdřív nízkou kvalitou stojí pár korun a
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

            {/*
              * Patrik (23. 11.): „co kdybys udělal nějaký export těch podkladů
              * do nějaké formy, kterou budeš schopen zrevidovat a upravit".
              * ZIP má všechno, z čeho se model skládá, i spustitelnou kabinu;
              * upravený se načte zpátky stejným tlačítkem.
              */}
            <section className="zk-revize">
              <h3>Revize podkladů</h3>
              <p className="desc">
                Export do ZIPu: vrstvy postav a doplňků, původní obrázky od modelu, body na
                postavách, vzorky látek s rozměry, fotky sad a celá kabina ke spuštění.
                Hodí se k pečlivé kontrole a dotažení — upravené soubory se načtou zpátky
                a ručně upravené šablony se pak už samy nepřepíšou.
              </p>
              <div className="zk-akce">
                <select value={revizePostava} onChange={e => setRevizePostava(e.target.value)} aria-label="Které postavy">
                  <option value="">Všechny postavy</option>
                  {(prehled?.postavy ?? []).map(one => (
                    <option key={one.id} value={one.id}>{popisPostavy(one.vek, one.telo)}</option>
                  ))}
                </select>
                <label className="zk-zaskrt">
                  <input type="checkbox" checked={revizeFotky} onChange={e => setRevizeFotky(e.target.checked)} />
                  i fotky sad z e-shopu
                </label>
                <button className="btn primary" disabled={!!revize} onClick={async () => {
                  setRevize('Balím podklady…');
                  try {
                    const hotovo = await api.zk.revizeExport({ postavy: revizePostava ? [revizePostava] : [], fotky: revizeFotky });
                    if (hotovo) toast(`Uloženo: ${hotovo.souboru} souborů, ${hotovo.megabajtu} MB — ${hotovo.soubor}`, 'info');
                  } catch (e: any) { toast(e.message, 'error'); }
                  setRevize('');
                }}>
                  {revize ? <span className="spin" /> : <Icon name="download" size={13} />} Exportovat podklady
                </button>
                <button className="btn ghost" disabled={!!revize} onClick={async () => {
                  setRevize('Načítám úpravy…');
                  try {
                    const r = await api.zk.revizeImport();
                    if (r) {
                      toast(`Načteno: ${r.vrstev} vrstev, ${r.vzorku} vzorků, ${r.produktu} produktů, ${r.kotev} postav s body`
                        + (r.preskoceno.length ? `. Přeskočeno ${r.preskoceno.length}: ${r.preskoceno.slice(0, 3).join('; ')}` : '.'),
                        r.preskoceno.length ? 'error' : 'info');
                      await nactiPrehled();
                      setProdukty([]);
                      setNahled(null);
                    }
                  } catch (e: any) { toast(e.message, 'error'); }
                  setRevize('');
                }}>
                  <Icon name="upload" size={13} /> Načíst upravené
                </button>
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
                {(['kravata', 'ksandy', 'kapesnicek'] as const).map(typ => (
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

/**
 * Body, ze kterých se kreslí šablony — a náhled, na kterém se posouvají.
 *
 * Body se měří z obrázku postavy (límec je nejvyšší bod košile uprostřed,
 * pas horní hrana kalhot). U neobvyklé postavy to může ujet o centimetr;
 * tažením se bod posune a šablony se hned překreslí. Nic to nestojí.
 */
const KRESBA: Record<ZkFrontaRadek['kresba'], { nazev: string; trida: string }> = {
  zadne: { nazev: 'nevykresleno', trida: '' },
  hotovo: { nazev: 'ke kontrole', trida: 'ceka' },
  nesedi: { nazev: 'nesedí', trida: 'chyba' },
  schvaleno: { nazev: 'schváleno', trida: 'ok' },
  zamitnuto: { nazev: 'zamítnuto', trida: 'pryc' }
};

type FiltrFronty = 'kontrola' | 'nesedi' | 'nevykresleno' | 'schvalene' | 'vse';

/** Kolik uplynulo od začátku kreslení — ať je vidět, že se něco děje. */
function Odpocet({ od }: { od: string }) {
  const [, setTik] = useState(0);
  useEffect(() => { const t = setInterval(() => setTik(n => n + 1), 1000); return () => clearInterval(t); }, []);
  const s = Math.max(0, Math.round((Date.now() - new Date(od).getTime()) / 1000));
  return <>{Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}</>;
}

/** Karta v mřížce: náhled na modelu se načte, až když je karta vidět. */
function KartaProduktu({ p, nahled, vybrany, onVyber, onNacti, onOtevri }: {
  p: ZkFrontaRadek;
  nahled: { obraz: string; vykresleno: boolean } | string | undefined;
  vybrany: boolean;
  onVyber: (ano: boolean) => void;
  onNacti: () => void;
  onOtevri: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (nahled !== undefined || !ref.current) return;
    if (typeof IntersectionObserver === 'undefined') { onNacti(); return; }
    const pozor = new IntersectionObserver(zaznamy => {
      if (zaznamy.some(one => one.isIntersecting)) { onNacti(); pozor.disconnect(); }
    }, { rootMargin: '300px' });
    pozor.observe(ref.current);
    return () => pozor.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nahled === undefined]);
  const stav = KRESBA[p.kresba];
  return (
    <div ref={ref} className={`zk-karta-produktu ${vybrany ? 'vybrany' : ''} ${p.kresliSe ? 'kresli' : ''} kresba-${p.kresba}`}
      onClick={onOtevri} role="button" tabIndex={0} onKeyDown={e => { if (e.key === ' ') { e.preventDefault(); onVyber(!vybrany); } }}>
      <label className="zk-karta-vyber" onClick={e => e.stopPropagation()}>
        <input type="checkbox" checked={vybrany} onChange={e => onVyber(e.target.checked)} aria-label={`Vybrat ${p.nazev}`} />
      </label>
      <div className="zk-karta-model">
        {typeof nahled === 'object'
          ? <img src={nahled.obraz} alt="" loading="lazy" />
          : typeof nahled === 'string' ? <span className="desc">{nahled}</span> : <span className="spin" />}
        {p.obrazek && <img className="zk-karta-fotka" src={p.obrazek} alt="" loading="lazy" />}
        {/* Kreslí se: přímo na kartě, s časem — ať je vidět, že se něco děje */}
        {p.kresliSe && (
          <div className="zk-karta-kresli" aria-live="polite">
            <span className="spin" />
            <b>AI kreslí</b>
            <span><Odpocet od={p.kresliSe} /></span>
          </div>
        )}
      </div>
      <div className="zk-karta-popis">
        <b title={p.nazev}>{p.nazev}</b>
        <span className="zk-karta-stavy">
          <em className={`zk-odznak ${stav.trida}`}>{p.kresliSe ? 'kreslí se…' : stav.nazev}</em>
          {p.sada && <em className="zk-odznak">sada</em>}
        </span>
        {p.potiz && p.kresba === 'nesedi' && !p.kresliSe && <span className="zk-karta-potiz" title={p.potiz}>{p.potiz}</span>}
      </div>
    </div>
  );
}

/**
 * Produkty na modelu — vykreslení a schválení.
 *
 * Patrik (25. 11.): „je nutná ta příprava AI, když stejně funguje až
 * vykreslení? Zaměřil bych se na vykreslení… spolehlivost, rychlost,
 * kvalitu a efektivitu" a „lépe znázorni přímo v gridu, na čem se
 * zrovna pracuje… jde vykreslovat paralelně víc produktů najednou?"
 *
 * Jedna linka: vykreslit (AI z fotek výrobku, několik kusů naráz) →
 * zkontrolovat na modelu → schválit. Karta, na které AI zrovna kreslí,
 * to ukazuje i s časem; hotová se hned překreslí. AI kreslí jen na
 * hlavní postavu, ostatní postavy dostanou kresbu přetvarovanou zadarmo.
 */
function SchvalovaniPanel({ pracuje, setPracuje }: { pracuje: string; setPracuje: (t: string) => void }) {
  const toast = useToast();
  const [fronta, setFronta] = useState<ZkFrontaRadek[]>([]);
  const [filtr, setFiltr] = useState<FiltrFronty>('vse');
  const [kod, setKod] = useState('');
  const [detail, setDetail] = useState<ZkProduktRadek | null>(null);
  const [nahledy, setNahledy] = useState<Record<string, { obraz: string; vykresleno: boolean } | string>>({});
  const [velke, setVelke] = useState<Record<string, string>>({});
  const [jenSchvalene, setJenSchvalene] = useState(false);
  const [pohled, setPohled] = useState<'mrizka' | 'jeden'>('mrizka');
  const [otevreno, setOtevreno] = useState(false);
  const [vybrane, setVybrane] = useState<Set<string>>(new Set());
  const [odhad, setOdhad] = useState<{ kusu: number; usd: number } | null>(null);
  const [naraz, setNaraz] = useState(4);
  const [behu, setBehu] = useState(0);
  const [prubeh, setPrubeh] = useState<{ hotovo: number; celkem: number } | null>(null);

  const nactiFrontu = useCallback(async () => {
    try {
      setFronta(await api.zk.fronta());
      setOdhad(await api.zk.vykresleniOdhad('chybi'));
    } catch (e: any) { toast(e.message, 'error'); }
  }, [toast]);
  useEffect(() => {
    void nactiFrontu();
    api.zk.jenSchvalene().then(setJenSchvalene).catch(() => undefined);
    api.zk.soubezne().then(setNaraz).catch(() => undefined);
  }, [nactiFrontu]);

  const zahodNahled = (k: string) => {
    setNahledy(prev => { const n = { ...prev }; delete n[k]; return n; });
    setVelke(prev => { const n = { ...prev }; delete n[k]; return n; });
  };

  /* Průběh kreslení: karta se rozsvítí, když se na ní začne, a překreslí, když je hotová */
  useEffect(() => api.on('zk:katalog-krok', (krok: any) => {
    if (!krok?.kod || !krok.faze) return;
    setPrubeh(krok.celkem ? { hotovo: krok.hotovo ?? 0, celkem: krok.celkem } : null);
    setFronta(prev => prev.map(one => {
      if (one.kod !== krok.kod) return one;
      if (krok.faze === 'kresli') return { ...one, kresliSe: new Date().toISOString() };
      if (krok.faze === 'chyba') return { ...one, kresliSe: '', potiz: String(krok.potiz ?? '') };
      return { ...one, kresliSe: '', kresba: krok.faze === 'hotovo' ? 'hotovo' : 'nesedi', potiz: String(krok.potiz ?? ''), vykresleno: true };
    }));
    if (krok.faze === 'hotovo' || krok.faze === 'nesedi') zahodNahled(krok.kod);
  }), []);

  const videt = useMemo(() => fronta.filter(one =>
    filtr === 'vse' ? true
      : filtr === 'kontrola' ? one.kresba === 'hotovo'
        : filtr === 'nesedi' ? one.kresba === 'nesedi'
          : filtr === 'nevykresleno' ? one.kresba === 'zadne'
            : one.kresba === 'schvaleno' || one.schvaleno), [fronta, filtr]);
  const index = Math.max(0, videt.findIndex(one => one.kod === kod));
  const ted = videt.length ? videt[Math.min(index, videt.length - 1)] : null;
  const aktivni = pohled === 'jeden' || otevreno;

  const nactiNahled = useCallback(async (k: string, znovu = false) => {
    if (!znovu && nahledy[k]) return;
    try {
      const n = await api.zk.nahledProduktu(k);
      setNahledy(prev => ({ ...prev, [k]: { obraz: n.obraz, vykresleno: n.vykresleno } }));
    } catch (e: any) {
      setNahledy(prev => ({ ...prev, [k]: String(e?.message ?? e) }));
    }
  }, [nahledy]);

  useEffect(() => {
    if (!ted || !aktivni) { setDetail(null); return; }
    let platne = true;
    api.zk.produktDetail(ted.kod).then(d => { if (platne) setDetail(d); }).catch(() => undefined);
    void nactiNahled(ted.kod);
    for (const dalsi of videt.slice(index + 1, index + 3)) void nactiNahled(dalsi.kod);
    if (!velke[ted.kod]) {
      api.zk.nahledProduktu(ted.kod, undefined, 1200)
        .then(n => { if (platne) setVelke(prev => ({ ...prev, [ted.kod]: n.obraz })); })
        .catch(() => undefined);
    }
    return () => { platne = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ted?.kod, ted?.kresba, aktivni, nahledy[ted?.kod ?? '']]);

  const posun = (o: number) => {
    if (!videt.length) return;
    setKod(videt[Math.max(0, Math.min(videt.length - 1, index + o))].kod);
  };

  /* Kreslení běží na pozadí — okno se dá dál používat, schvalovat, kreslit další */
  const vykresli = async (rozsah: 'chybi' | 'vse', kody?: string[]) => {
    setBehu(n => n + 1);
    try {
      const r = await api.zk.vykresli(rozsah, kody);
      toast(`Vykresleno ${r.hotovo}${r.nesedi ? `, ${r.nesedi} ke kontrole barev` : ''}${r.chyb ? `, ${r.chyb} chyb: ${r.posledniChyba}` : ''}.`,
        r.chyb ? 'error' : 'info');
    } catch (e: any) { toast(e.message, 'error'); }
    setBehu(n => n - 1);
    setPracuje('');
    await nactiFrontu();
  };

  const schval = async (co: 'schvalit' | 'zrusit' | 'zamitnout', kody?: string[]) => {
    const seznam = kody ?? (ted ? [ted.kod] : []);
    if (!seznam.length) return;
    const dalsi = !kody && ted ? (videt[index + 1]?.kod ?? videt[index - 1]?.kod ?? '') : '';
    for (const k of seznam) await api.zk.schvalProdukt(k, co);
    setFronta(prev => prev.map(one => (seznam.includes(one.kod)
      ? { ...one, schvaleno: co === 'schvalit', kresba: one.kresba === 'zadne' ? 'zadne' : co === 'schvalit' ? 'schvaleno' : co === 'zamitnout' ? 'zamitnuto' : 'hotovo' }
      : one)));
    if (kody) { setVybrane(new Set()); toast(`${co === 'schvalit' ? 'Schváleno' : co === 'zamitnout' ? 'Zamítnuto' : 'Zrušeno'}: ${seznam.length}.`, 'info'); }
    else if (co !== 'zrusit' && filtr !== 'vse') setKod(dalsi);
    else posun(1);
  };

  const zmenZarazeni = async (co: { typ?: ZkVrstvaTyp | ''; varianta?: string }) => {
    if (!ted) return;
    await api.zk.produkt(ted.kod, co);
    await nactiFrontu();
    setDetail(await api.zk.produktDetail(ted.kod));
    zahodNahled(ted.kod);
  };

  const vyber = (k: string, ano: boolean) => setVybrane(prev => {
    const n = new Set(prev);
    if (ano) n.add(k); else n.delete(k);
    return n;
  });

  /* Klávesy: Enter schválit a další, šipky listovat, R nakreslit znovu, Esc zavře okno */
  useEffect(() => {
    const klavesa = (e: KeyboardEvent) => {
      const cil = e.target as HTMLElement | null;
      if (e.key === 'Escape' && otevreno) { e.preventDefault(); setOtevreno(false); return; }
      if (!aktivni || !ted) return;
      if (cil && /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(cil.tagName)) return;
      if (e.key === 'Enter' && ted.kresba !== 'zadne') { e.preventDefault(); void schval('schvalit'); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); posun(1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); posun(-1); }
      else if ((e.key === 'r' || e.key === 'R') && !ted.kresliSe) { e.preventDefault(); void vykresli('vse', [ted.kod]); }
    };
    window.addEventListener('keydown', klavesa);
    return () => window.removeEventListener('keydown', klavesa);
  });

  const pocty = {
    vse: fronta.length,
    schvaleno: fronta.filter(one => one.kresba === 'schvaleno').length,
    kontrola: fronta.filter(one => one.kresba === 'hotovo').length,
    nesedi: fronta.filter(one => one.kresba === 'nesedi').length,
    nevykresleno: fronta.filter(one => one.kresba === 'zadne').length,
    kresli: fronta.filter(one => one.kresliSe).length
  };
  const zaKus = odhad && odhad.kusu ? odhad.usd / odhad.kusu : null;
  const cena = (n: number) => (zaKus ? ` · ~${(Math.round(n * zaKus * 100) / 100).toLocaleString('cs-CZ')} $` : '');
  const nahled = ted ? nahledy[ted.kod] : undefined;
  const def = ted?.typ ? vrstvaDef(ted.typ) : null;

  const teloDetailu = !ted ? null : (
    <div className="zk-schvaleni-telo">
      <figure className="zk-schvaleni-model">
        {typeof nahled === 'string'
          ? <span className="zk-potiz">{nahled}</span>
          : nahled ? <img src={velke[ted.kod] || nahled.obraz} alt={`${ted.nazev} na modelu`} /> : <span className="spin" />}
        {ted.kresliSe && (
          <div className="zk-karta-kresli"><span className="spin" /><b>AI kreslí</b><span><Odpocet od={ted.kresliSe} /></span></div>
        )}
      </figure>

      <div className="zk-schvaleni-info">
        <div className="zk-schvaleni-nazev">
          <h3>{ted.nazev}</h3>
          <span className="desc">{ted.kod}{ted.sada ? ' · sada' : ''}{!ted.skladem ? ' · není skladem' : ''}</span>
          <em className={`zk-odznak ${KRESBA[ted.kresba].trida}`}>{ted.kresliSe ? 'kreslí se…' : KRESBA[ted.kresba].nazev}</em>
        </div>
        {ted.potiz && <p className="zk-potiz">{ted.potiz}</p>}
        {ted.kresba === 'zadne' && !ted.kresliSe && (
          <p className="desc">Zatím je na modelu šablona v barvě výrobku. „Vykreslit AI" nakreslí skutečný kus podle fotek.</p>
        )}

        <div className="zk-schvaleni-zarazeni">
          <select value={ted.typ} onChange={e => {
            const typ = e.target.value as ZkVrstvaTyp | '';
            void zmenZarazeni({ typ, varianta: typ ? vrstvaDef(typ).varianty[0].id : '' });
          }} aria-label="Kam na model">
            <option value="">— nepatří na model —</option>
            {ZK_VRSTVY.filter(one => one.zbozi).map(one => <option key={one.typ} value={one.typ}>{one.nazev}</option>)}
          </select>
          {def && def.varianty.length > 1 && (
            <select value={ted.varianta} onChange={e => void zmenZarazeni({ varianta: e.target.value })} aria-label="Varianta">
              {def.varianty.map(one => <option key={one.id} value={one.id}>{one.nazev}</option>)}
            </select>
          )}
        </div>

        {(detail?.fotky?.length ?? 0) > 0 && (
          <div className="zk-schvaleni-fotky">
            {detail!.fotky!.map((url, i) => (
              <figure key={i}><img src={url} alt="" loading="lazy" /><figcaption>fotka {i + 1}</figcaption></figure>
            ))}
          </div>
        )}

        <div className="zk-schvaleni-tlacitka">
          {ted.kresba !== 'zadne' && (
            <button className="btn primary" onClick={() => void schval('schvalit')} disabled={!!ted.kresliSe}>
              <Icon name="check" size={13} /> {ted.kresba === 'nesedi' ? 'Přesto použít' : ted.kresba === 'schvaleno' ? 'Schváleno — další' : 'Schválit a další'} <kbd>Enter</kbd>
            </button>
          )}
          <button className={`btn ${ted.kresba === 'zadne' ? 'primary' : 'ghost'}`} disabled={!!ted.kresliSe} onClick={() => void vykresli('vse', [ted.kod])}
            data-tip={`AI nakreslí kus podle fotek výrobku (jeden obrázek${cena(1)}); ostatní postavy dostanou kresbu zadarmo`}>
            {ted.kresliSe ? <span className="spin" /> : <Icon name="image" size={13} />} {ted.kresba === 'zadne' ? 'Vykreslit AI' : 'Vykreslit znovu'} <kbd>R</kbd>
          </button>
          {ted.kresba !== 'zadne' && ted.kresba !== 'zamitnuto' && (
            <button className="btn ghost" onClick={() => void schval('zamitnout')}>Zamítnout</button>
          )}
          {ted.kresba === 'schvaleno' && <button className="btn ghost" onClick={() => void schval('zrusit')}>Zrušit schválení</button>}
        </div>
        <div className="zk-schvaleni-listovani">
          <button className="icon-btn" onClick={() => posun(-1)} disabled={index <= 0} data-tip="Předchozí (←)"><Icon name="chevron-left" size={14} /></button>
          <span className="desc">{index + 1} z {videt.length}</span>
          <button className="icon-btn" onClick={() => posun(1)} disabled={index >= videt.length - 1} data-tip="Další (→)"><Icon name="chevron-right" size={14} /></button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="zk-schvaleni">
      <div className="zk-schvaleni-hlava">
        <div className="zk-schvaleni-stav">
          <b>Schváleno {pocty.schvaleno} z {pocty.vse}</b>
          <span className="desc">
            ke kontrole {pocty.kontrola} · nesedí {pocty.nesedi} · nevykresleno {pocty.nevykresleno}
          </span>
          <span className="zk-pruh zk-pruh-dvojity">
            <i className="pripraveno" style={{ width: `${((pocty.vse - pocty.nevykresleno) / Math.max(1, pocty.vse)) * 100}%` }} />
            <i style={{ width: `${(pocty.schvaleno / Math.max(1, pocty.vse)) * 100}%` }} />
          </span>
        </div>
        <div className="zk-akce">
          {(behu > 0 || pocty.kresli > 0) && (
            <span className="zk-schvaleni-bezi">
              <span className="spin" /> AI kreslí {pocty.kresli || ''}{prubeh ? ` · hotovo ${prubeh.hotovo} z ${prubeh.celkem}` : ''}
            </span>
          )}
          <button className="btn primary" disabled={!odhad?.kusu} onClick={() => void vykresli('chybi')}
            data-tip="AI nakreslí na model každý produkt, který kresbu ještě nemá — několik naráz, ostatní postavy zadarmo">
            <Icon name="sparkles" size={13} /> Vykreslit nevykreslené ({odhad?.kusu ?? 0}){odhad?.kusu ? ` · ~${odhad.usd.toLocaleString('cs-CZ')} $` : ''}
          </button>
          <label className="zk-naraz" data-tip="Kolik kusů kreslí AI současně. Při hlášce o limitu (rate limit) uber.">
            naráz
            <select value={naraz} onChange={async e => setNaraz(await api.zk.soubezne(Number(e.target.value)))} aria-label="Kolik naráz">
              {[1, 2, 3, 4, 6, 8].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <select value={filtr} onChange={e => { setFiltr(e.target.value as FiltrFronty); setKod(''); }} aria-label="Které produkty">
            <option value="vse">Všechny ({pocty.vse})</option>
            <option value="kontrola">Ke kontrole ({pocty.kontrola})</option>
            <option value="nesedi">Nesedí ({pocty.nesedi})</option>
            <option value="nevykresleno">Nevykreslené ({pocty.nevykresleno})</option>
            <option value="schvalene">Schválené ({pocty.schvaleno})</option>
          </select>
          <div className="pk-seg" role="group" aria-label="Zobrazení">
            <button className={`pk-seg-btn ${pohled === 'mrizka' ? 'on' : ''}`} onClick={() => setPohled('mrizka')}>Mřížka</button>
            <button className={`pk-seg-btn ${pohled === 'jeden' ? 'on' : ''}`} onClick={() => { setPohled('jeden'); setOtevreno(false); }}>Po jednom</button>
          </div>
          <label className="zk-zaskrt" data-tip="Zákazník uvidí jen produkty, které jsi tady schválil">
            <input type="checkbox" checked={jenSchvalene} onChange={async e => {
              setJenSchvalene(await api.zk.jenSchvalene(e.target.checked));
            }} />
            do kabiny jen schválené
          </label>
        </div>
      </div>

      {pohled === 'jeden' && (!ted
        ? <p className="desc zk-schvaleni-prazdno">V tomhle výběru nic není.</p>
        : teloDetailu)}

      {pohled === 'mrizka' && (
        <>
          <div className="zk-mrizka-lista">
            <label className="zk-zaskrt">
              <input type="checkbox" checked={videt.length > 0 && videt.every(one => vybrane.has(one.kod))}
                onChange={e => setVybrane(e.target.checked ? new Set(videt.map(one => one.kod)) : new Set())} />
              vybrat vše ({videt.length})
            </label>
            {vybrane.size > 0 && (
              <>
                <span className="desc">vybráno {vybrane.size}</span>
                <button className="btn primary" onClick={() => void vykresli('vse', [...vybrane])}
                  data-tip={`AI nakreslí vybrané kusy (${naraz} naráz), ostatní postavy zadarmo`}>
                  <Icon name="image" size={13} /> Vykreslit AI ({vybrane.size}){cena(vybrane.size)}
                </button>
                <button className="btn ghost" onClick={() => void schval('schvalit', [...vybrane])}><Icon name="check" size={13} /> Schválit</button>
                <button className="btn ghost" onClick={() => void schval('zamitnout', [...vybrane])}>Zamítnout</button>
                <button className="btn ghost" onClick={() => setVybrane(new Set())}>Zrušit výběr</button>
              </>
            )}
          </div>
          {!videt.length ? (
            <p className="desc zk-schvaleni-prazdno">V tomhle výběru nic není.</p>
          ) : (
            <div className="zk-mrizka-produktu">
              {videt.map(one => (
                <KartaProduktu key={one.kod} p={one} nahled={nahledy[one.kod]} vybrany={vybrane.has(one.kod)}
                  onVyber={ano => vyber(one.kod, ano)} onNacti={() => void nactiNahled(one.kod)}
                  onOtevri={() => { setKod(one.kod); setOtevreno(true); }} />
              ))}
            </div>
          )}
        </>
      )}

      {pohled === 'mrizka' && otevreno && ted && (
        <div className="zk-popup" role="dialog" aria-label={ted.nazev}
          onMouseDown={e => { if (e.target === e.currentTarget) setOtevreno(false); }}>
          <div className="zk-popup-okno">
            <div className="zk-popup-hlava">
              <button className="icon-btn" onClick={() => posun(-1)} disabled={index <= 0} data-tip="Předchozí (←)"><Icon name="chevron-left" size={15} /></button>
              <span className="desc">{index + 1} z {videt.length}</span>
              <button className="icon-btn" onClick={() => posun(1)} disabled={index >= videt.length - 1} data-tip="Další (→)"><Icon name="chevron-right" size={15} /></button>
              <span style={{ flex: 1 }} />
              <button className="icon-btn" onClick={() => setOtevreno(false)} data-tip="Zavřít (Esc)"><Icon name="x" size={15} /></button>
            </div>
            {teloDetailu}
          </div>
        </div>
      )}

      {pohled === 'jeden' && videt.length > 1 && (
        <div className="zk-schvaleni-fronta" role="list">
          {videt.slice(Math.max(0, index - 6), index + 24).map(one => (
            <button key={one.kod} role="listitem" className={`zk-fronta-kus ${one.kod === ted?.kod ? 'on' : ''} ${one.kresba === 'schvaleno' ? 'ok' : ''}`}
              onClick={() => setKod(one.kod)} data-tip={one.nazev}>
              {one.obrazek ? <img src={one.obrazek} alt="" loading="lazy" /> : <span className="zk-chybi" />}
              {one.kresba === 'schvaleno' && <i className="zk-fronta-fajfka"><Icon name="check" size={10} /></i>}
              {one.kresliSe && <i className="zk-fronta-ceka" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Sada nebo produkt ke kontrole: co s ním je a látka pro každý kus.
 *
 * Patrik (23. 11.): u dárkových sad se na model dláždila fotka, na které
 * je víc věcí, a u sady kšandy + motýlek byly vidět jen kšandy. Aplikace
 * takové produkty pozná sama a **do kabiny je nepustí bez kontroly**.
 * Tady se ke každému kusu nahraje fotka jen té jedné věci (nebo se nechá
 * barva) a zařazení se potvrdí fajfkou.
 */
function SadaProduktu({ p, onZmena }: {
  p: ZkProduktRadek;
  onZmena: (zmena: Partial<ZkProduktRadek>) => void;
}) {
  const toast = useToast();
  const [nahravam, setNahravam] = useState<number | null>(null);
  const kusy = [
    { cast: -1, typ: p.typ, varianta: p.varianta, hex: p.hex, vzorek: p.vzorek },
    ...p.casti.map((c, i) => ({ cast: i, ...c }))
  ].filter(one => one.typ);
  const nahraj = (cast: number) => {
    const vstup = document.createElement('input');
    vstup.type = 'file';
    vstup.accept = 'image/png,image/jpeg,image/webp';
    vstup.onchange = () => {
      const soubor = vstup.files?.[0];
      if (!soubor) return;
      const cteni = new FileReader();
      cteni.onload = async () => {
        setNahravam(cast);
        try {
          const latka = await api.zk.latka(p.kod, cast, String(cteni.result || ''));
          if (cast < 0) onZmena({ hex: latka.hex || p.hex, vzorek: latka.vzorek || p.vzorek });
          else {
            onZmena({
              casti: p.casti.map((c, i) => i === cast
                ? { ...c, hex: latka.hex || c.hex, vzorek: latka.vzorek || c.vzorek } : c)
            });
          }
          toast('Látka z fotky je uložená.', 'info');
        } catch (e: any) { toast(e.message, 'error'); }
        setNahravam(null);
      };
      cteni.readAsDataURL(soubor);
    };
    vstup.click();
  };
  return (
    <div className="zk-sada">
      {p.kontrola && (
        <p className="zk-sada-rada">
          <Icon name="alert" size={13} />
          <span>
            {p.kontrola}{' '}
            {p.schvaleno
              ? 'Potvrzeno — v kabině je.'
              : 'Do kabiny se dostane, až zařazení potvrdíš fajfkou. Zákazník do té doby uvidí slušné „připravujeme" a podobné kusy.'}
          </span>
        </p>
      )}
      <div className="zk-sada-kusy">
        {kusy.map(k => (
          <div key={k.cast} className="zk-sada-kus">
            {k.vzorek
              ? <img className="zk-vzorek" src={k.vzorek} alt="" />
              : <span className="zk-vzorek" style={{ background: k.hex || '#808080' }} />}
            <span className="zk-sada-text">
              <b>{vrstvaDef(k.typ as ZkVrstvaTyp).nazev}</b>
              <span className="desc">
                {vrstvaDef(k.typ as ZkVrstvaTyp).varianty.find(v => v.id === k.varianta)?.nazev ?? k.varianta}
                {k.cast < 0 ? ' · hlavní kus' : ''}
              </span>
            </span>
            <button className="btn ghost" disabled={nahravam !== null} onClick={() => nahraj(k.cast)}>
              {nahravam === k.cast ? <span className="spin" /> : <Icon name="upload" size={13} />} Nahrát fotku
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

type KotvyRucneOkno = ZkKotvy['rucneBody'];
type BodKotvy = 'limec' | 'pas' | 'ramena' | 'spony' | 'kapsa';

const POPISY_BODU: Record<BodKotvy, string> = {
  limec: 'Límec', pas: 'Pas', ramena: 'Rameno', spony: 'Spona', kapsa: 'Kapsa'
};

function BodyNaPostave({ postava, obnova, onZmena }: {
  postava: string;
  /** Změna vrstev (po generování) — náhled se načte znovu. */
  obnova: unknown;
  onZmena: () => void | Promise<void>;
}) {
  const [velky, setVelky] = useState(false);
  return (
    <>
      <EditorBodu postava={postava} obnova={obnova} onZmena={onZmena} velky={false} onVelky={() => setVelky(true)} />
      {velky && (
        <div className="zk-popup zk-body-popup" role="dialog" aria-label="Body pro šablony"
          onMouseDown={e => { if (e.target === e.currentTarget) setVelky(false); }}>
          <div className="zk-popup-okno zk-body-okno">
            <EditorBodu postava={postava} obnova={obnova} onZmena={onZmena} velky onZavrit={() => setVelky(false)} />
          </div>
        </div>
      )}
    </>
  );
}

/**
 * Body, ze kterých se kreslí šablony — malý náhled ve Vizuálech a velký
 * editor přes celé okno.
 *
 * Patrik (25. 11.): „úprava polohy na modelu moc nefunguje, překreslení
 * není přesné a obrázek je moc malý na přesun myší, nemůžu se pořádně
 * trefit ani vlastně moc nevidím, co dělám". Velký editor proto ukazuje
 * jen hlavu až boky v plném rozlišení, body jsou větší a s popisem,
 * při tahu vede bod nitkový kříž, šipkami se posouvá po jednom bodu
 * (Shift po pěti) a poslední změna jde vrátit. Ukládá se jen bod, se
 * kterým se hýbalo — ostatní se dál měří z obrázku (dřív se s každým
 * posunem „zamkly" všechny a kapesníček ztratil sklon kapsy).
 */
function EditorBodu({ postava, obnova, onZmena, velky, onVelky, onZavrit }: {
  postava: string;
  obnova: unknown;
  onZmena: () => void | Promise<void>;
  velky: boolean;
  onVelky?: () => void;
  onZavrit?: () => void;
}) {
  const toast = useToast();
  const [k, setK] = useState<ZkKotvy | null>(null);
  const [ukladam, setUkladam] = useState(false);
  const [tah, setTah] = useState<{ co: BodKotvy; x: number; y: number } | null>(null);
  const [vybrany, setVybrany] = useState<BodKotvy | null>(null);
  const [historie, setHistorie] = useState<(KotvyRucneOkno | null)[]>([]);
  const [posun, setPosun] = useState<{ co: BodKotvy; dx: number; dy: number } | null>(null);

  useEffect(() => {
    let platne = true;
    api.zk.kotvy(postava, velky).then(one => { if (platne) setK(one); }).catch(() => { if (platne) setK(null); });
    return () => { platne = false; };
  }, [postava, obnova, velky]);

  const uloz = useCallback(async (zmena: KotvyRucneOkno | null) => {
    if (!k) return;
    setUkladam(true);
    try {
      setHistorie(prev => [...prev.slice(-19), Object.keys(k.rucneBody ?? {}).length ? { ...k.rucneBody } : null]);
      const nove = await api.zk.kotvyUloz(postava, zmena === null ? null : { ...(k.rucneBody ?? {}), ...zmena }, velky);
      setK(nove);
      await onZmena();
    } catch (e: any) { toast(e.message, 'error'); }
    setUkladam(false);
  }, [k, postava, velky, onZmena, toast]);

  const vratit = async () => {
    if (!historie.length) return;
    const predtim = historie[historie.length - 1];
    setHistorie(prev => prev.slice(0, -1));
    setUkladam(true);
    try {
      setK(await api.zk.kotvyUloz(postava, predtim, velky));
      await onZmena();
    } catch (e: any) { toast(e.message, 'error'); }
    setUkladam(false);
  };

  /* Šipky: posun vybraného bodu po jednom bodu postavy (Shift po pěti), uloží se po chvilce klidu */
  useEffect(() => {
    if (!velky || !vybrany || !k) return;
    const klavesa = (e: KeyboardEvent) => {
      const cil = e.target as HTMLElement | null;
      if (cil && /^(INPUT|SELECT|TEXTAREA)$/.test(cil.tagName)) return;
      const krok = e.shiftKey ? 5 : 1;
      const d = { ArrowLeft: [-krok, 0], ArrowRight: [krok, 0], ArrowUp: [0, -krok], ArrowDown: [0, krok] }[e.key];
      if (!d) return;
      e.preventDefault();
      setPosun(prev => ({ co: vybrany, dx: (prev?.co === vybrany ? prev.dx : 0) + d[0], dy: (prev?.co === vybrany ? prev.dy : 0) + d[1] }));
    };
    window.addEventListener('keydown', klavesa);
    return () => window.removeEventListener('keydown', klavesa);
  }, [velky, vybrany, k]);
  useEffect(() => {
    if (!posun || !k) return;
    const t = setTimeout(() => {
      const dx = posun.dx / k.sirka; const dy = posun.dy / k.vyska;
      setPosun(null);
      const b = polohy(k).find(one => one.co === posun.co)!;
      void ulozBod(posun.co, b.x + dx, b.y + dy);
    }, 650);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [posun]);

  if (!k) return null;
  const vr = k.vyrez ?? { x: 0, y: 0, w: 1, h: 1 };
  /* Z dílů celé postavy do dílů výřezu a zpátky */
  const naObr = (x: number, y: number) => ({ l: (x - vr.x) / vr.w, t: (y - vr.y) / vr.h });
  const zObr = (l: number, t: number) => ({ x: vr.x + l * vr.w, y: vr.y + t * vr.h });

  function polohy(kk: ZkKotvy): { co: BodKotvy; x: number; y: number; obr: 0 | 1 }[] {
    return [
      { co: 'limec', x: kk.limec[0], y: kk.limec[1], obr: 0 },
      { co: 'pas', x: kk.limec[0], y: kk.pas, obr: 0 },
      { co: 'ramena', x: kk.limec[0] + kk.ramena, y: kk.ramenoY, obr: 0 },
      { co: 'spony', x: kk.limec[0] + kk.spony, y: kk.pas, obr: 0 },
      { co: 'kapsa', x: kk.kapsa[0], y: kk.kapsa[1], obr: 1 }
    ];
  }

  function ulozBod(co: BodKotvy, x: number, y: number) {
    if (co === 'limec') return uloz({ limec: [x, y] });
    if (co === 'pas') return uloz({ pas: y });
    if (co === 'kapsa') return uloz({ kapsa: [x, y] });
    if (co === 'ramena') return uloz({ ramena: x - k!.limec[0] });
    return uloz({ spony: x - k!.limec[0] });
  }

  const dil = (e: React.PointerEvent, prvek: HTMLElement) => {
    const r = prvek.getBoundingClientRect();
    const l = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const t = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
    return zObr(l, t);
  };

  const pohyb = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!tah) return;
    const p = dil(e, e.currentTarget);
    /* Pas jen svisle, rameno a spona jen vodorovně */
    if (tah.co === 'pas') setTah({ ...tah, y: p.y });
    else if (tah.co === 'ramena' || tah.co === 'spony') setTah({ ...tah, x: p.x });
    else setTah({ ...tah, x: p.x, y: p.y });
  };

  const pust = () => {
    if (!tah) return;
    const t = tah;
    setTah(null);
    void ulozBod(t.co, t.x, t.y);
  };

  const obrazek = (index: 0 | 1, src: string, alt: string) => {
    const body = polohy(k).filter(one => one.obr === index);
    return (
      <div className={`zk-body-obr ${velky ? 'velky' : ''}`} style={{ aspectRatio: `${k.sirka * vr.w} / ${k.vyska * vr.h}` }}
        onPointerMove={pohyb} onPointerUp={pust} onPointerCancel={() => setTah(null)}>
        <img src={src} alt={alt} draggable={false} />
        {index === 0 && <i className="zk-pas" style={{ top: `${naObr(0, tah?.co === 'pas' ? tah.y : k.pas).t * 100}%` }} />}
        {body.map(b => {
          const ted = tah?.co === b.co ? tah
            : posun?.co === b.co ? { x: b.x + posun.dx / k.sirka, y: b.y + posun.dy / k.vyska } : b;
          const o = naObr(ted.x, ted.y);
          return (
            <span key={b.co} className={`zk-bod ${tah?.co === b.co ? 'tahne' : ''} ${vybrany === b.co ? 'vybrany' : ''}`}
              data-tip={POPISY_BODU[b.co]} style={{ left: `${o.l * 100}%`, top: `${o.t * 100}%` }}
              onPointerDown={e => {
                e.preventDefault();
                (e.target as HTMLElement).setPointerCapture(e.pointerId);
                setVybrany(b.co);
                setTah({ co: b.co, x: b.x, y: b.y });
              }}>
              {velky && <em className="zk-bod-popis">{POPISY_BODU[b.co]}</em>}
            </span>
          );
        })}
        {/* Nitkový kříž: kam přesně bod padne */
        }{velky && tah && tah.co !== 'pas' && (() => {
          const o = naObr(tah.x, tah.y);
          return (
            <>
              <i className="zk-kriz svisle" style={{ left: `${o.l * 100}%` }} />
              {tah.co !== 'ramena' && tah.co !== 'spony' && <i className="zk-kriz vodorovne" style={{ top: `${o.t * 100}%` }} />}
            </>
          );
        })()}
        {ukladam && <span className="zk-body-uklada"><span className="spin" /> Překresluji…</span>}
      </div>
    );
  };

  return (
    <div className={`zk-body ${velky ? 'velky' : ''}`}>
      <div className="zk-body-text">
        <h4>Body pro šablony</h4>
        <p className="desc">
          Odsud se kreslí kravata, motýlek, kšandy a kapesníček. Když něco sedí o kus vedle,
          chyť bod a posuň ho — šablony se hned překreslí. Realistické šablony od AI se tím vrátí
          na kreslené (seděly by vedle), takže body dolaď <b>před</b> dokreslením AI.
        </p>
        <ul className="desc">
          <li><b>Límec</b> — horní střed límce, odtud visí kravata.</li>
          <li><b>Pas</b> — horní hrana kalhot, tam končí špička kravaty a chytají se kšandy.</li>
          <li><b>Rameno</b> a <b>spona</b> — kudy vedou kšandy.</li>
          <li><b>Kapsa</b> — horní hrana náprsní kapsy saka.</li>
        </ul>
        {velky && <p className="desc">Klikni na bod a dolaď ho <kbd>←</kbd> <kbd>→</kbd> <kbd>↑</kbd> <kbd>↓</kbd> (se Shiftem po pěti bodech).</p>}
        <div className="zk-akce">
          {!velky && onVelky && (
            <button className="btn primary" onClick={onVelky}><Icon name="expand" size={13} /> Upravit ve velkém</button>
          )}
          {historie.length > 0 && (
            <button className="btn ghost" disabled={ukladam} onClick={() => void vratit()}>Vrátit poslední změnu</button>
          )}
          {k.rucne && (
            <button className="btn ghost" disabled={ukladam} onClick={() => void uloz(null)}>
              Měřit znovu z obrázku
            </button>
          )}
          {velky && onZavrit && <button className="btn ghost" onClick={onZavrit}>Hotovo</button>}
        </div>
      </div>
      {obrazek(0, k.bezSaka, 'Kravata a kšandy na postavě')}
      {obrazek(1, k.seSakem, 'Motýlek a kapesníček na postavě se sakem')}
    </div>
  );
}

function popisPostavy(vek: string, telo: string): string {
  return `${VEKY[vek] ?? vek} — ${TELA[telo] ?? telo}`;
}
