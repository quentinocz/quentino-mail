import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ZkKrokProOkno, ZkNahled, ZkNastaveni, ZkPrehled, ZkProduktRadek,
  ZkVrstvaProOkno, ZkVrstvaTyp, ZkZkouskaModelu, ZkKotvy
} from '@shared/zkusebna';
import {
  ZK_BARVY, ZK_KVALITY, ZK_VRSTVY, dilKvality, dilPlochy, doZakladu, vrstvaDef
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
  const [rozsahAi, setRozsahAi] = useState<'sady' | 'vse'>('sady');
  const [revizePostava, setRevizePostava] = useState('');
  const [revizeFotky, setRevizeFotky] = useState(true);
  const [revize, setRevize] = useState('');
  const [rozpoznavam, setRozpoznavam] = useState('');
  const rozpoznejJeden = async (kod: string) => {
    setRozpoznavam(kod);
    try {
      const r = await api.zk.rozpoznej(kod);
      toast(r.kontrola ? `Rozpoznáno: ${r.kusu} kus(y) — zkontroluj a potvrď.` : `Rozpoznáno: ${r.kusu} kus, látka je z fotky.`, 'info');
      setProdukty(await api.zk.produkty(300));
    } catch (e: any) { toast(e.message, 'error'); }
    setRozpoznavam('');
  };

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
                        <span className="desc">{v.variantaNazev}{sablona ? ' · šablona' : zPostavy ? ' · z postavy' : ''}</span>
                        <em className={`zk-odznak ${stavVrstvy.trida}`}>{stavVrstvy.nazev}</em>
                      </div>
                      {v.potiz && <p className="zk-potiz">{v.potiz}</p>}
                      <div className="zk-karta-btns">
                        {sablona ? (
                          <button className="btn ghost" onClick={() => generuj(v.typ, v.varianta)}
                            disabled={!!pracuje || !stav?.hotovo}
                            data-tip="Šablona podle bodů na postavě — nic nestojí">
                            {v.soubor ? 'Překreslit' : 'Nakreslit'}
                          </button>
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
                {/*
                  * AI jako oko: pozná, co je na fotce (kšandy, motýlek,
                  * knoflíčky), a ukáže, kde je rovná látka. Sady jdou samy
                  * při projití katalogu; celý katalog je na vyžádání, protože
                  * stojí kolem koruny za produkt.
                  */}
                <div className="zk-ai-rozpoznani">
                  <select value={rozsahAi} onChange={e => setRozsahAi(e.target.value as 'sady' | 'vse')}
                    aria-label="Co rozpoznat">
                    <option value="sady">Sady a kusy ke kontrole</option>
                    <option value="vse">Celý katalog (~1 Kč/produkt)</option>
                  </select>
                  <button className="btn ghost" disabled={!!pracuje} onClick={async () => {
                    setPracuje('Rozpoznávám fotky…');
                    try {
                      const r = await api.zk.rozpoznejVse(rozsahAi);
                      toast(`AI rozpoznala ${r.hotovo} produktů${r.chyb ? `, ${r.chyb} se nepovedlo: ${r.posledniChyba}` : ''}.`,
                        r.chyb ? 'error' : 'info');
                      setProdukty(await api.zk.produkty(300));
                    } catch (e: any) { toast(e.message, 'error'); }
                    setPracuje('');
                  }}><Icon name="sparkles" size={13} /> Rozpoznat fotky AI</button>
                </div>
              </div>
            </header>

            <div className="zk-tabulka">
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
                  {p.typ && (
                    <button className="icon-btn" data-tip="Rozpoznat fotky AI — co na nich je a kde je látka"
                      disabled={!!rozpoznavam} onClick={() => void rozpoznejJeden(p.kod)}>
                      {rozpoznavam === p.kod ? <span className="spin" /> : <Icon name="sparkles" size={14} />}
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
                {(p.kontrola || p.casti.length > 0 || p.ai) && (
                  <SadaProduktu p={p} onZmena={zmena => setProdukty(prev => prev.map(one =>
                    one.kod === p.kod ? { ...one, ...zmena } : one))} />
                )}
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
      {p.ai && (
        <div className="zk-ai">
          <div className="zk-ai-kusy">
            {p.ai.kusy.map((k, i) => (
              <figure key={i} className={`zk-ai-kus ${k.typ ? '' : 'mimo'}`}>
                {k.vyrez ? <img src={k.vyrez} alt="" /> : <span className="zk-vzorek zk-chybi" />}
                <figcaption>
                  <b>{k.popis || k.druh}</b>
                  <span className="desc">
                    {!k.typ ? 'na model nepatří'
                      : k.zdroj === 'fotka' ? 'látka z fotky'
                        : k.zdroj === 'ai' ? 'látka dokreslená AI podle fotky'
                          : 'jen barva'}
                    {k.typ ? ` · jistota ${Math.round(k.jistota * 100)} %` : ''}
                  </span>
                </figcaption>
              </figure>
            ))}
          </div>
          {p.ai.poznamky.length > 0 && (
            <ul className="zk-ai-poznamky">
              {p.ai.poznamky.map((one, i) => <li key={i}>{one}</li>)}
            </ul>
          )}
        </div>
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

function BodyNaPostave({ postava, obnova, onZmena }: {
  postava: string;
  /** Změna vrstev (po generování) — náhled se načte znovu. */
  obnova: unknown;
  onZmena: () => void | Promise<void>;
}) {
  const toast = useToast();
  const [k, setK] = useState<ZkKotvy | null>(null);
  const [ukladam, setUkladam] = useState(false);
  const [tah, setTah] = useState<{ co: string; x: number; y: number } | null>(null);

  useEffect(() => {
    let platne = true;
    api.zk.kotvy(postava).then(one => { if (platne) setK(one); }).catch(() => { if (platne) setK(null); });
    return () => { platne = false; };
  }, [postava, obnova]);

  if (!k) return null;

  const uloz = async (zmena: Partial<{ limec: [number, number]; pas: number; kapsa: [number, number]; ramena: number; spony: number }> | null) => {
    setUkladam(true);
    try {
      const nove = await api.zk.kotvyUloz(postava, zmena === null ? null : {
        limec: k.limec, pas: k.pas, kapsa: k.kapsa, ramena: k.ramena, spony: k.spony, ...zmena
      });
      setK(nove);
      await onZmena();
    } catch (e: any) { toast(e.message, 'error'); }
    setUkladam(false);
  };

  /* Bod v dílech obrázku z pozice myši */
  const dil = (e: React.PointerEvent, prvek: HTMLElement): [number, number] => {
    const r = prvek.getBoundingClientRect();
    return [
      Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
      Math.max(0, Math.min(1, (e.clientY - r.top) / r.height))
    ];
  };

  const bod = (co: string, x: number, y: number, popis: string) => {
    const ted = tah?.co === co ? tah : { x, y };
    return (
      <span key={co} className={`zk-bod ${tah?.co === co ? 'tahne' : ''}`} data-tip={popis}
        style={{ left: `${ted.x * 100}%`, top: `${ted.y * 100}%` }}
        onPointerDown={e => {
          e.preventDefault();
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          setTah({ co, x, y });
        }} />
    );
  };

  const pohyb = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!tah) return;
    const [x, y] = dil(e, e.currentTarget);
    /* Pas, ramena a spony se posouvají jen jedním směrem */
    if (tah.co === 'pas') setTah({ ...tah, y });
    else if (tah.co === 'ramena' || tah.co === 'spony') setTah({ ...tah, x });
    else setTah({ ...tah, x, y });
  };

  const pust = () => {
    if (!tah) return;
    const t = tah;
    setTah(null);
    if (t.co === 'limec') void uloz({ limec: [t.x, t.y] });
    else if (t.co === 'pas') void uloz({ pas: t.y });
    else if (t.co === 'kapsa') void uloz({ kapsa: [t.x, t.y] });
    else if (t.co === 'ramena') void uloz({ ramena: t.x - k.limec[0] });
    else if (t.co === 'spony') void uloz({ spony: t.x - k.limec[0] });
  };

  return (
    <div className="zk-body">
      <div className="zk-body-text">
        <h4>Body pro šablony</h4>
        <p className="desc">
          Odsud se kreslí kravata, motýlek, kšandy a kapesníček. Když něco sedí o kus vedle,
          chyť bod a posuň ho — šablony se hned překreslí.
        </p>
        <ul className="desc">
          <li><b>Límec</b> — horní střed límce, odtud visí kravata.</li>
          <li><b>Pas</b> — horní hrana kalhot, tam končí špička kravaty a chytají se kšandy.</li>
          <li><b>Rameno</b> a <b>spona</b> — kudy vedou kšandy.</li>
          <li><b>Kapsa</b> — horní hrana náprsní kapsy saka.</li>
        </ul>
        <div className="zk-akce">
          {k.rucne && (
            <button className="btn ghost" disabled={ukladam} onClick={() => void uloz(null)}>
              Měřit znovu z obrázku
            </button>
          )}
          {ukladam && <span className="desc"><span className="spin" /> Překresluji…</span>}
        </div>
      </div>
      <div className="zk-body-obr" style={{ aspectRatio: `${k.sirka} / ${k.vyska}` }}
        onPointerMove={pohyb} onPointerUp={pust} onPointerCancel={() => setTah(null)}>
        <img src={k.bezSaka} alt="Kravata a kšandy na postavě" draggable={false} />
        <i className="zk-pas" style={{ top: `${(tah?.co === 'pas' ? tah.y : k.pas) * 100}%` }} />
        {bod('limec', k.limec[0], k.limec[1], 'Límec')}
        {bod('pas', k.limec[0], k.pas, 'Pas (horní hrana kalhot)')}
        {bod('ramena', k.limec[0] + k.ramena, k.ramenoY, 'Rameno — začátek kšand')}
        {bod('spony', k.limec[0] + k.spony, k.pas, 'Spona kšand')}
      </div>
      <div className="zk-body-obr" style={{ aspectRatio: `${k.sirka} / ${k.vyska}` }}
        onPointerMove={pohyb} onPointerUp={pust} onPointerCancel={() => setTah(null)}>
        <img src={k.seSakem} alt="Motýlek a kapesníček na postavě se sakem" draggable={false} />
        {bod('kapsa', k.kapsa[0], k.kapsa[1], 'Kapsa saka')}
      </div>
    </div>
  );
}

function popisPostavy(vek: string, telo: string): string {
  return `${VEKY[vek] ?? vek} — ${TELA[telo] ?? telo}`;
}
