import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { IgOverview } from '@shared/types';
import type {
  VidProjekt, VidKlip, VidTitulek, VidZnelka, VidPrechod, VidStyl, VidPozice, VidPomer, VidZvuk,
  VidBarva, VidZarovnani
} from '@shared/videoedit';
import {
  osa, delkaVidea, klipyTrhu, zvukTrhu, textTitulku, potize, cas, vyrez, vyrezStyl, rozdel, doladeni,
  PRECHODY, STYLY, POZICE, POMERY, BARVY, ZAROVNANI, MIN_KLIP
} from '@shared/videoedit';
import { api } from '../../api';
import { useToast } from '../../toast';
import Icon from '../Icon';
import { nakresliTitulek, titulekPng } from './videokresba';

/**
 * Střih krátkého videa s titulky pro každý trh.
 *
 * ## Jak je obrazovka poskládaná a proč
 *
 * Čtyři kroky pod sebou, každý s číslem: **záběry → titulky → trhy a zvuk
 * → vykreslení**. Nic není schované v druhé záložce. Dřívější okno bannerů
 * mělo nahrávání fotek až za druhým proklikem a nikdo ho nenašel; tady je
 * navíc každý krok závislý na předchozím, takže pořadí shora dolů je
 * zároveň postup práce.
 *
 * ## Náhled je ten výsledek, ne obrázek výsledku
 *
 * Titulek v náhledu kreslí **tentýž kód**, který pak vypaluje ffmpeg
 * (`videokresba.ts`), jen na menším plátně. Není to tedy přibližná
 * představa: co je vidět v okně, bude i ve videu. Bez toho by se ladění
 * titulků dělalo naslepo a poznalo by se až v hotovém reelu.
 *
 * ## Co se sdílí a co je zvlášť
 *
 * **Časy titulků jsou pro všechny trhy stejné, texty jiné.** To je
 * podstata celé úspory: časová osa se naladí jednou a pro další trhy
 * se jen přeloží slova. Zvuk a výjimečně i záběry si trh může mít
 * vlastní — ale nemusí, a proto se to nabízí až jako možnost, ne jako
 * další povinné pole.
 */

interface Props {
  overview: IgOverview;
  postId: number | null;
  onBack: () => void;
}

/** Jak dlouhý úsek se z nového videa nabídne, když je delší než reel. */
const NABIDKA = 12;

export default function IgVideo({ overview, postId, onBack }: Props) {
  const toast = useToast();
  const [p, setP] = useState<VidProjekt | null>(null);
  const [lang, setLang] = useState('');
  const [vybrany, setVybrany] = useState<string | null>(null);
  const [znelky, setZnelky] = useState<VidZnelka[]>([]);
  const [znelkyOtevrene, setZnelkyOtevrene] = useState(false);
  const [ffmpeg, setFfmpeg] = useState<{ ok: boolean; note: string } | null>(null);
  const [prubeh, setPrubeh] = useState<Record<string, number>>({});
  const [pracuje, setPracuje] = useState('');
  const [nahrava, setNahrava] = useState(false);
  const [prechodMenu, setPrechodMenu] = useState<string | null>(null);
  /** U kterého titulku jsou rozbalené podrobnosti. */
  const [podrobne, setPodrobne] = useState<string | null>(null);
  /**
   * Velikost náhledu. Na malém se titulky ladí špatně — a právě kvůli
   * nim se sem chodí; na velkém zase není vidět zbytek obrazovky.
   * Proto volba, ne pevná hodnota.
   */
  const [velikostNahledu, setVelikostNahledu] = useState<'s' | 'm' | 'l'>('m');

  /* Přehrávač */
  const video = useRef<HTMLVideoElement | null>(null);
  const platno = useRef<HTMLCanvasElement | null>(null);
  const obal = useRef<HTMLDivElement | null>(null);
  const [hraje, setHraje] = useState(false);
  const [kde, setKde] = useState(0);
  const [nactenyKlip, setNactenyKlip] = useState<string | null>(null);

  const trhy = useMemo(
    () => overview.markets.filter(m => m.enabled !== false),
    [overview.markets]
  );

  /* ---------- načtení ---------- */

  useEffect(() => {
    if (!postId) return;
    let zive = true;
    (async () => {
      try {
        const projekt = await api.ig.video(postId);
        if (!zive) return;
        setP(projekt);
        setLang(projekt.zdroj || trhy[0]?.lang || 'CS');
        setZnelky(await api.ig.stings());
        try {
          const list = await api.ig.fonts();
          // Seznam může dorazit prázdný i jako nic — nabídka písem se tím
          // jen zkrátí na to, co má aplikace, obrazovka kvůli tomu nepadá
          if (zive) setPisma(Array.isArray(list) ? list : []);
        } catch { /* bez seznamu se použije písmo aplikace */ }
        const tool = await api.media.ffmpeg();
        if (zive) setFfmpeg({ ok: tool.ok, note: tool.note });
      } catch (e: any) {
        toast(e.message, 'error');
      }
    })();
    return () => { zive = false; };
  }, [postId]);

  useEffect(() => {
    const off = api.on('ig:videoStep', (payload: any) => {
      if (payload?.lang) setPrubeh(prev => ({ ...prev, [payload.lang]: payload.percent ?? 0 }));
    });
    return off;
  }, []);

  /**
   * Ukládá se **po každé změně**, zpožděně o půl sekundy.
   *
   * Časová osa se ladí desítkami drobných tahů a „neuložil jsem to" je
   * tady nejhorší možná chyba: přijde se o práci, kterou nejde zopakovat
   * z hlavy. Zpoždění je jen proto, aby se při tažení neukládalo
   * šedesátkrát za sekundu.
   */
  const casovac = useRef<number | null>(null);
  const uloz = useCallback((next: VidProjekt) => {
    setP(next);
    if (casovac.current) window.clearTimeout(casovac.current);
    casovac.current = window.setTimeout(() => {
      api.ig.videoSave(next).catch((e: any) => toast(e.message, 'error'));
    }, 500);
  }, [toast]);

  /* ---------- záběry daného trhu ---------- */

  const vlastniKlipy = !!(p && lang !== p.zdroj && p.trhy?.[lang]?.klipy?.length);
  const klipy = useMemo(() => (p ? klipyTrhu(p, lang) : []), [p, lang]);
  const rozvrzeni = useMemo(() => osa(klipy), [klipy]);
  const delka = rozvrzeni.delka;
  const rozmer = POMERY[(p?.pomer ?? '9:16') as VidPomer];

  /** Zapíše záběry tam, kam patří: společné, nebo vlastní pro trh. */
  const zapisKlipy = useCallback((list: VidKlip[]) => {
    if (!p) return;
    if (vlastniKlipy) {
      uloz({ ...p, trhy: { ...p.trhy, [lang]: { ...(p.trhy[lang] ?? {}), klipy: list } } });
    } else {
      uloz({ ...p, klipy: list });
    }
  }, [p, lang, vlastniKlipy, uloz]);

  /* ---------- písma pro titulky ---------- */

  /**
   * Písmo se do okna musí nejdřív načíst.
   *
   * Titulky kreslí okno na plátno, takže s písmem pracuje **prohlížeč**,
   * ne ffmpeg — stačí mu soubor z disku, který se podává tímtéž vlastním
   * protokolem jako video. Načítá se až ve chvíli, kdy si ho někdo
   * vybere: projít při otevření pár set systémových písem by znamenalo
   * čekat na obrazovku, která se většinou používá s výchozím.
   */
  const [pisma, setPisma] = useState<{ nazev: string; soubor: string; vlastni?: boolean }[]>([]);
  const nactenaPisma = useRef<Set<string>>(new Set());

  const nactiPismo = useCallback(async (nazev: string) => {
    if (!nazev || nactenaPisma.current.has(nazev)) return;
    const f = pisma.find(x => x.nazev === nazev);
    if (!f) return;
    nactenaPisma.current.add(nazev);
    try {
      const url = await api.ig.fontUrl(f.soubor);
      const face = new FontFace(nazev, `url(${url})`);
      await face.load();
      (document.fonts as any).add(face);
      // Překreslit náhled, ať se nové písmo projeví hned
      setKde(k => k + 0.0001);
    } catch {
      nactenaPisma.current.delete(nazev);
      toast(`Písmo ${nazev} se nepodařilo načíst — zkus jiný soubor.`, 'error');
    }
  }, [pisma, toast]);

  useEffect(() => {
    if (!p) return;
    const chce = new Set<string>();
    if (p.pismo) chce.add(p.pismo);
    for (const t of p.titulky) if (t.pismo) chce.add(t.pismo);
    for (const nazev of chce) void nactiPismo(nazev);
  }, [p, nactiPismo]);

  /* ---------- adresy souborů pro přehrávač ---------- */

  const adresy = useRef<Map<string, string>>(new Map());
  const adresa = useCallback(async (soubor: string): Promise<string> => {
    const mam = adresy.current.get(soubor);
    if (mam) return mam;
    const url = await api.ig.videoUrl(soubor);
    adresy.current.set(soubor, url);
    return url;
  }, []);

  /* ---------- přehrávání ---------- */

  /**
   * Náhled má **dva obrazy**, ne jeden.
   *
   * Přechod je ze své podstaty chvíle, kdy jsou vidět oba záběry naráz —
   * s jedním přehrávačem se ukázat nedá. Dřív se proto překryv
   * přeskakoval a prolnutí se v náhledu nikdy neobjevilo: člověk si
   * vybral přechod, nic neviděl a došel k závěru, že přechody nefungují.
   * Teď druhý obraz dojede připravený a přes první se podle druhu
   * přechodu prolne, zatmí, přijede nebo otevře kruhem.
   *
   * Prolínání kreslí přímo smyčka snímků do stylů prvků — ne přes stav
   * Reactu. Šedesát překreslení za sekundu kvůli průhlednosti by bylo
   * plýtvání a náhled by sebou cukal.
   */
  const vidA = useRef<HTMLVideoElement | null>(null);
  const vidB = useRef<HTMLVideoElement | null>(null);
  const zavoj = useRef<HTMLDivElement | null>(null);
  const hlavniRef = useRef<'a' | 'b'>('a');
  const [hlavni, setHlavni] = useState<'a' | 'b'>('a');
  /** Co je zrovna v kterém obrazu — podle identifikátoru záběru. */
  const vElementu = useRef<{ a: string | null; b: string | null }>({ a: null, b: null });
  const hranyIndex = useRef(0);
  const prichystano = useRef(false);
  const prepina = useRef(false);

  const elHlavni = () => (hlavniRef.current === 'a' ? vidA.current : vidB.current);
  const elDruhy = () => (hlavniRef.current === 'a' ? vidB.current : vidA.current);
  const kterySlot = (el: HTMLVideoElement | null): 'a' | 'b' => (el === vidA.current ? 'a' : 'b');

  /** Výřez se promítá i do náhledu — jinak by se ořez ladil naslepo. */
  const nastavVyrez = useCallback((el: HTMLVideoElement | null, k: VidKlip | undefined, navic = '') => {
    if (!el) return;
    const zaklad = k ? vyrezStyl(k).transform : 'none';
    el.style.transform = navic
      ? `${navic} ${zaklad === 'none' ? '' : zaklad}`.trim()
      : zaklad;
  }, []);

  const nacti = useCallback(async (el: HTMLVideoElement | null, k: VidKlip | undefined) => {
    if (!el || !k) return;
    const slot = kterySlot(el);
    if (vElementu.current[slot] !== k.id) {
      el.src = await adresa(k.soubor);
      vElementu.current[slot] = k.id;
      await new Promise<void>(hotovo => {
        const ok = () => { el.removeEventListener('loadedmetadata', ok); hotovo(); };
        el.addEventListener('loadedmetadata', ok);
        window.setTimeout(hotovo, 4000);
      });
    }
    nastavVyrez(el, k);
  }, [adresa, nastavVyrez]);

  /** Konec přechodu: druhý obraz se schová a vrátí do výchozí podoby. */
  const zrusPrechod = useCallback(() => {
    const b = elDruhy();
    if (b) { b.style.opacity = '0'; b.style.clipPath = 'none'; }
    if (zavoj.current) zavoj.current.style.opacity = '0';
    prichystano.current = false;
  }, []);

  /** Který záběr běží v čase `t` výsledného videa. */
  const klipV = useCallback((t: number) => {
    for (let i = klipy.length - 1; i >= 0; i--) {
      if (t >= rozvrzeni.místa[i].start - 0.0001) return i;
    }
    return klipy.length ? 0 : -1;
  }, [klipy, rozvrzeni]);

  const skoc = useCallback(async (t: number, pustit = false) => {
    const cíl = Math.max(0, Math.min(delka, t));
    setKde(cíl);
    const i = klipV(cíl);
    if (i < 0) return;
    hranyIndex.current = i;
    zrusPrechod();
    const k = klipy[i];
    const el = elHlavni();
    if (!el) return;
    await nacti(el, k);
    el.currentTime = k.od + (cíl - rozvrzeni.místa[i].start);
    el.style.opacity = '1';
    if (pustit) { try { await el.play(); } catch { /* prohlížeč občas odmítne */ } }
  }, [delka, klipV, klipy, rozvrzeni, nacti, zrusPrechod]);

  /** Jak má přechod vypadat v daném podílu (0 = ještě první, 1 = už druhý). */
  const kresliPrechod = useCallback((druh: VidPrechod, podil: number, dalsi: VidKlip) => {
    const a = elHlavni();
    const b = elDruhy();
    if (!a || !b) return;
    const kryt = zavoj.current;
    b.style.clipPath = 'none';
    nastavVyrez(b, dalsi);
    if (kryt) kryt.style.opacity = '0';

    if (druh === 'cerna' || druh === 'bila') {
      /*
       * Přes barvu: v první půlce se zatmívá první záběr, ve druhé
       * vysvitne druhý. Výměna je přesně uprostřed, kdy je obraz celý
       * krytý — jinak by v půlce probleskl skok.
       */
      if (kryt) {
        kryt.style.background = druh === 'cerna' ? '#000' : '#fff';
        kryt.style.opacity = String(1 - Math.abs(2 * podil - 1));
      }
      b.style.opacity = podil >= 0.5 ? '1' : '0';
      return;
    }
    if (druh === 'posun') {
      b.style.opacity = '1';
      nastavVyrez(b, dalsi, `translateX(${((1 - podil) * 100).toFixed(2)}%)`);
      return;
    }
    if (druh === 'kruh') {
      b.style.opacity = '1';
      b.style.clipPath = `circle(${(podil * 75).toFixed(1)}% at 50% 50%)`;
      return;
    }
    // prolínačka i rozpad — v náhledu obojí prolnutím, ve videu se liší
    b.style.opacity = podil.toFixed(3);
  }, [nastavVyrez]);

  /*
   * Hodiny přehrávání celé osy.
   *
   * Čas se nebere z `<video>` přímo: element zná jen svůj soubor, kdežto
   * časová osa je slepená z několika. Běží se proto podle **indexu
   * právě hraného záběru**, ne podle dopočítávání z času — to se rozbilo
   * přesně na přechodu, který se s oběma záběry překrývá.
   */
  useEffect(() => {
    if (!hraje || rezimRef.current === 'zaber') return;
    let zive = true;
    const tik = () => {
      if (!zive) return;
      const el = elHlavni();
      const i = hranyIndex.current;
      const k = klipy[i];
      if (el && k) {
        const misto = rozvrzeni.místa[i];
        const cas = misto.start + Math.max(0, el.currentTime - k.od);
        setKde(Math.min(delka, cas));

        const dalsi = klipy[i + 1];
        const mistoDalsi = rozvrzeni.místa[i + 1];
        const prechodem = !!dalsi && mistoDalsi.prechod > 0 && dalsi.prechod !== 'zadny';

        if (dalsi && !prepina.current) {
          // Druhý obraz se chystá s předstihem, ať v okamžiku přechodu
          // nenaskakuje černá, než se soubor otevře
          const kdyChystat = prechodem ? mistoDalsi.start - 0.4 : k.do - 0.4 + (misto.start - k.od);
          if (!prichystano.current && cas >= kdyChystat) {
            prichystano.current = true;
            const b = elDruhy();
            void (async () => {
              await nacti(b, dalsi);
              if (b) {
                b.currentTime = dalsi.od;
                b.style.opacity = '0';
                try { await b.play(); } catch { /* prohlížeč občas odmítne */ }
              }
            })();
          }

          if (prechodem && cas >= mistoDalsi.start) {
            const podil = Math.max(0, Math.min(1, (cas - mistoDalsi.start) / mistoDalsi.prechod));
            kresliPrechod(dalsi.prechod, podil, dalsi);
            if (podil >= 1) {
              prepina.current = true;
              const novy = hlavniRef.current === 'a' ? 'b' : 'a';
              const stary = elHlavni();
              hlavniRef.current = novy;
              setHlavni(novy);
              hranyIndex.current = i + 1;
              prichystano.current = false;
              prepina.current = false;
              if (stary) { stary.pause(); stary.style.opacity = '0'; }
              const b = elHlavni();
              if (b) { b.style.opacity = '1'; b.style.clipPath = 'none'; nastavVyrez(b, dalsi); }
              if (zavoj.current) zavoj.current.style.opacity = '0';
            }
          } else if (!prechodem && el.currentTime >= k.do - 0.03) {
            // Tvrdý střih: výměna obrazu v jednom snímku
            prepina.current = true;
            const novy = hlavniRef.current === 'a' ? 'b' : 'a';
            const stary = elHlavni();
            hlavniRef.current = novy;
            setHlavni(novy);
            hranyIndex.current = i + 1;
            prichystano.current = false;
            prepina.current = false;
            if (stary) { stary.pause(); stary.style.opacity = '0'; }
            const b = elHlavni();
            if (b) { b.style.opacity = '1'; nastavVyrez(b, dalsi); }
          }
        } else if (!dalsi && el.currentTime >= k.do - 0.03) {
          setHraje(false);
          el.pause();
          setKde(delka);
          return;
        }
      }
      requestAnimationFrame(tik);
    };
    requestAnimationFrame(tik);
    return () => { zive = false; };
  }, [hraje, klipy, rozvrzeni, delka, nacti, kresliPrechod, nastavVyrez]);

  /* ---------- režim zkracování jednoho záběru ---------- */

  /**
   * Zkracování má **vlastní náhled**.
   *
   * Dřív ukazoval přehrávač čas ve výsledném videu, zatímco úchyty
   * výstřižku pracují s časem ve zdrojovém souboru — a tlačítko
   * „Začátek tady" bralo zdrojový čas. Dva různé časy pod jedním údajem
   * se nedaly přečíst a nebylo poznat, k čemu se „tady" vztahuje.
   * Ve zkracování proto náhled přepne na **celý zdroj vybraného záběru**
   * a pod ním stojí, že je to zdroj a jak je dlouhý.
   */
  const [rezim, setRezim] = useState<'osa' | 'zaber'>('osa');
  const rezimRef = useRef<'osa' | 'zaber'>('osa');
  useEffect(() => { rezimRef.current = rezim; }, [rezim]);
  const [kdeZdroj, setKdeZdroj] = useState(0);
  /** Běží „přehrát jen výstřižek"? Pak se na konci výstřižku zastaví. */
  const jenVystrizek = useRef(false);

  const doZaberu = useCallback(async (k: VidKlip, kam?: number) => {
    setRezim('zaber');
    setHraje(false);
    zrusPrechod();
    const el = elHlavni();
    const b = elDruhy();
    if (b) { b.pause(); b.style.opacity = '0'; }
    if (!el) return;
    el.pause();
    await nacti(el, k);
    el.style.opacity = '1';
    el.currentTime = kam ?? k.od;
    setKdeZdroj(el.currentTime);
  }, [nacti, zrusPrechod]);

  useEffect(() => {
    if (rezim !== 'zaber' || !hraje) return;
    let zive = true;
    const tik = () => {
      if (!zive) return;
      const el = elHlavni();
      const k = klipy.find(x => x.id === vybrany);
      if (el && k) {
        setKdeZdroj(el.currentTime);
        if (jenVystrizek.current && el.currentTime >= k.do - 0.03) {
          el.pause();
          setHraje(false);
          jenVystrizek.current = false;
          return;
        }
      }
      requestAnimationFrame(tik);
    };
    requestAnimationFrame(tik);
    return () => { zive = false; };
  }, [rezim, hraje, klipy, vybrany]);

  /*
   * Hned po otevření se navede první záběr.
   *
   * Bez toho zůstal náhled černý, dokud se na něj nekleplo — a protože
   * je to jediné místo, kde je vidět, jak titulky vypadají, vypadalo to,
   * jako by se střih vůbec nenačetl.
   */
  useEffect(() => {
    if (klipy.length === 0 || hraje || rezim === 'zaber') return;
    const slot = hlavniRef.current;
    const porad = klipy.some(k => k.id === vElementu.current[slot]);
    if (!porad) void skoc(0);
  }, [klipy, hraje, rezim, skoc]);

  const prehraj = useCallback(async () => {
    const el = elHlavni();
    if (hraje) {
      el?.pause();
      elDruhy()?.pause();
      setHraje(false);
      return;
    }
    if (rezim === 'osa' && kde >= delka - 0.05) await skoc(0);
    setHraje(true);
    try { await el?.play(); } catch { /* prohlížeč občas odmítne */ }
  }, [hraje, kde, delka, skoc, rezim]);

  /* Titulky nad videem — kreslí je tentýž kód, který je pak vypaluje */
  useEffect(() => {
    const c = platno.current;
    const box = obal.current;
    if (!c || !box || !p) return;
    const sirka = box.clientWidth;
    const vyska = box.clientHeight;
    if (c.width !== sirka || c.height !== vyska) { c.width = sirka; c.height = vyska; }
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, sirka, vyska);
    // Ve zkracování se titulky nekreslí — tam jde o obraz, ne o text
    if (rezim === 'zaber') return;
    for (const t of p.titulky) {
      if (kde < t.od - 0.001 || kde > t.do) continue;
      const text = textTitulku(t, lang, p.zdroj);
      if (!text) continue;
      nakresliTitulek(ctx, sirka, vyska,
        { text, styl: t.styl, pozice: t.pozice, ...doladeni(t), pismo: t.pismo || p.pismo || '' });
    }
  }, [kde, p, lang, rezim, velikostNahledu]);

  /* ---------- práce se záběry ---------- */

  const pridejKlipy = useCallback(async () => {
    if (!p) return;
    try {
      const vybrane = await api.ig.videoPick();
      if (vybrane.length === 0) return;
      const nove: VidKlip[] = vybrane.map(v => ({
        id: crypto.randomUUID(),
        soubor: v.soubor,
        zdrojDelka: v.delka,
        od: 0,
        /*
         * Z dlouhého videa se nabídne prvních dvanáct sekund, ne celé.
         * Reel má být krátký a nastavit konec je práce; nastavit ho
         * z celé minuty je práce zbytečná.
         */
        do: v.delka > 0 ? Math.min(v.delka, NABIDKA) : NABIDKA,
        prechod: 'zadny',
        prechodDelka: 0.5
      }));
      zapisKlipy([...klipy, ...nove]);
      if (!vybrany) setVybrany(nove[0].id);
    } catch (e: any) {
      toast(e.message, 'error');
    }
  }, [p, klipy, vybrany, zapisKlipy, toast]);

  const pridejZnelku = useCallback((z: VidZnelka, kam: 'zacatek' | 'konec') => {
    const novy: VidKlip = {
      id: crypto.randomUUID(),
      soubor: z.soubor,
      zdrojDelka: z.delka,
      od: 0,
      do: z.delka > 0 ? z.delka : 3,
      prechod: kam === 'konec' ? 'prolinacka' : 'zadny',
      prechodDelka: 0.4,
      znelka: true
    };
    const list = kam === 'zacatek'
      // Znělka na začátku nemůže mít přechod „před sebou" — a ten, co byl
      // u prvního záběru, se teď hodí na spoj mezi znělkou a záběrem
      ? [{ ...novy, prechod: 'zadny' as VidPrechod }, ...klipy.map((k, i) =>
          i === 0 ? { ...k, prechod: k.prechod === 'zadny' ? 'prolinacka' as VidPrechod : k.prechod } : k)]
      : [...klipy, novy];
    zapisKlipy(list);
    setZnelkyOtevrene(false);
  }, [klipy, zapisKlipy]);

  const smazKlip = useCallback((id: string) => {
    const list = klipy.filter(k => k.id !== id);
    // První záběr nemá co prolínat — přechod u něj by se ve výsledku ztratil
    if (list.length) list[0] = { ...list[0], prechod: 'zadny' };
    zapisKlipy(list);
    if (vybrany === id) setVybrany(list[0]?.id ?? null);
  }, [klipy, vybrany, zapisKlipy]);

  const upravKlip = useCallback((id: string, patch: Partial<VidKlip>) => {
    zapisKlipy(klipy.map(k => (k.id === id ? { ...k, ...patch } : k)));
  }, [klipy, zapisKlipy]);

  /* Tažení úchytů výstřižku nad zdrojovým videem */
  const strihRef = useRef<HTMLDivElement | null>(null);
  const strih = useRef<{ id: string; konec: 'od' | 'do' } | null>(null);

  const zacniStrih = (e: React.PointerEvent, konec: 'od' | 'do') => {
    if (!vybrany) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    strih.current = { id: vybrany, konec };
  };

  const behemStrihu = (e: React.PointerEvent) => {
    const t = strih.current;
    const box = strihRef.current;
    if (!t || !box) return;
    const k = klipy.find(x => x.id === t.id);
    if (!k) return;
    const r = box.getBoundingClientRect();
    const podil = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const cas = podil * Math.max(0.1, k.zdrojDelka);
    if (t.konec === 'od') {
      upravKlip(k.id, { od: Math.max(0, Math.min(cas, k.do - MIN_KLIP)) });
    } else {
      upravKlip(k.id, { do: Math.min(k.zdrojDelka || cas, Math.max(cas, k.od + MIN_KLIP)) });
    }
    /*
     * Během tažení se přehrávač posune na místo, kam se zrovna sahá.
     * Stříhat podle čísel na posuvníku znamená hádat — tady je vidět
     * snímek, na kterém záběr začne nebo skončí.
     */
    const el = video.current;
    if (el && nactenyKlip === k.id) el.currentTime = cas;
  };

  const konecStrihu = () => { strih.current = null; };

  /* Přetažení záběru na jiné místo */
  const tahany = useRef<string | null>(null);
  const [nad, setNad] = useState<string | null>(null);
  const pust = useCallback((cilId: string) => {
    const zId = tahany.current;
    tahany.current = null;
    setNad(null);
    if (!zId || zId === cilId) return;
    const list = [...klipy];
    const from = list.findIndex(k => k.id === zId);
    const to = list.findIndex(k => k.id === cilId);
    if (from < 0 || to < 0) return;
    const [kus] = list.splice(from, 1);
    list.splice(to, 0, kus);
    if (list.length) list[0] = { ...list[0], prechod: 'zadny' };
    zapisKlipy(list);
  }, [klipy, zapisKlipy]);

  /* ---------- náhledy snímků do časové osy ---------- */

  /**
   * Pásek snímků pod bloky záběrů.
   *
   * Posouvat titulek podle čísel znamená pamatovat si, co v tu chvíli
   * v obraze je. Na pásku je to vidět — a při tažení se navíc přehrávač
   * posune na místo úchytu, takže se titulek dá umístit na konkrétní
   * záběr, ne na sekundu.
   *
   * Snímky bere okno z téhož souboru, který přehrává: nakreslí si je na
   * plátno. Vytahovat je ffmpegem by znamenalo čekat na převod a mít
   * někde na disku desítky dočasných obrázků.
   */
  const [snimky, setSnimky] = useState<Record<string, string[]>>({});
  /** Pásek přes **celý zdroj** vybraného záběru — podklad pro výstřižek. */
  const [zdrojSnimky, setZdrojSnimky] = useState<Record<string, string[]>>({});

  /*
   * Snímky se kreslí jedním pomocným přehrávačem a postupně, ne naráz:
   * deset přetočení najednou nad jedním souborem si prohlížeč rozhodí
   * a vrátí deset stejných obrázků.
   */
  const vytahni = useCallback(async (soubor: string, casy: number[]): Promise<string[]> => {
    const url = await adresa(soubor);
    const el = document.createElement('video');
    el.muted = true;
    el.preload = 'metadata';
    el.src = url;
    await new Promise<void>(ok => {
      const hotovo = () => { el.removeEventListener('loadeddata', hotovo); ok(); };
      el.addEventListener('loadeddata', hotovo);
      window.setTimeout(ok, 4000);
    });
    const out: string[] = [];
    for (const kdy of casy) {
      const obr = await new Promise<string>(hotovo => {
        const strop = window.setTimeout(() => hotovo(''), 4000);
        el.onseeked = () => {
          window.clearTimeout(strop);
          try {
            const c = document.createElement('canvas');
            c.width = 64;
            c.height = Math.max(16, Math.round(64 * (el.videoHeight / Math.max(1, el.videoWidth))));
            c.getContext('2d')?.drawImage(el, 0, 0, c.width, c.height);
            hotovo(c.toDataURL('image/jpeg', 0.6));
          } catch { hotovo(''); }
        };
        el.currentTime = kdy;
      });
      if (obr) out.push(obr);
    }
    el.src = '';
    return out;
  }, [adresa]);

  useEffect(() => {
    if (klipy.length === 0) return;
    let zive = true;
    (async () => {
      for (const k of klipy) {
        if (!zive) break;
        const delkaKlipu = Math.max(0.2, k.do - k.od);
        const kolik = Math.max(1, Math.min(8, Math.round((delkaKlipu / Math.max(1, delka)) * 14)));
        const casy = Array.from({ length: kolik },
          (_x, i) => k.od + (delkaKlipu * (i + 0.5)) / kolik);
        try {
          const rada = await vytahni(k.soubor, casy);
          if (zive) setSnimky(prev => ({ ...prev, [k.id]: rada }));
        } catch { /* jeden nepovedený pásek zbytek osy nerozbije */ }
      }
    })();
    return () => { zive = false; };
    // Přepočítá se, jen když se změní soubory nebo výstřižky — ne při každém tahu
  }, [klipy.map(k => `${k.id}:${k.soubor}:${k.od}:${k.do}`).join('|'), delka, vytahni]);

  /**
   * Snímky v místech střihu.
   *
   * Posouvat úchyt podle čísel znamená hádat, čím záběr začne a skončí.
   * Tady jsou ty dva snímky vidět vedle sebe — a třetí ukazuje, kde by
   * se záběr rozdělil. Dotahuje se se zpožděním, aby se při tažení
   * nevytahoval snímek po každém pixelu.
   */
  const [koncovky, setKoncovky] = useState<Record<string, string>>({});

  useEffect(() => {
    const k = klipy.find(x => x.id === vybrany);
    if (!k) return;
    let zive = true;
    const casovac = window.setTimeout(async () => {
      try {
        const [zacatek, konec] = await vytahni(k.soubor, [k.od, Math.max(0, k.do - 0.05)]);
        if (!zive) return;
        setKoncovky(prev => ({ ...prev, [`${k.id}:od`]: zacatek || '', [`${k.id}:do`]: konec || '' }));
      } catch { /* bez snímků se stříhá dál, jen hůř */ }
    }, 260);
    return () => { zive = false; window.clearTimeout(casovac); };
  }, [vybrany, klipy, vytahni]);

  /* Snímek v místě, kde stojí náhled — podklad pro rozdělení */
  useEffect(() => {
    const k = klipy.find(x => x.id === vybrany);
    if (!k || rezim !== 'zaber') return;
    let zive = true;
    const casovac = window.setTimeout(async () => {
      try {
        const [ted] = await vytahni(k.soubor, [kdeZdroj]);
        if (zive) setKoncovky(prev => ({ ...prev, [`${k.id}:ted`]: ted || '' }));
      } catch { /* nevadí */ }
    }, 320);
    return () => { zive = false; window.clearTimeout(casovac); };
  }, [vybrany, klipy, kdeZdroj, rezim, vytahni]);

  /* Pásek přes celý zdroj vybraného záběru — aby bylo vidět, z čeho se stříhá */
  useEffect(() => {
    const k = klipy.find(x => x.id === vybrany);
    if (!k || !k.zdrojDelka || zdrojSnimky[k.id]) return;
    let zive = true;
    (async () => {
      const casy = Array.from({ length: 10 }, (_x, i) => (k.zdrojDelka * (i + 0.5)) / 10);
      try {
        const rada = await vytahni(k.soubor, casy);
        if (zive) setZdrojSnimky(prev => ({ ...prev, [k.id]: rada }));
      } catch { /* bez pásku se stříhá dál, jen hůř */ }
    })();
    return () => { zive = false; };
  }, [vybrany, klipy, zdrojSnimky, vytahni]);

  /* ---------- titulky ---------- */

  const pridejTitulek = useCallback((od?: number) => {
    if (!p) return;
    const start = Math.max(0, Math.min(od ?? kde, Math.max(0, delka - 1)));
    const konec = Math.min(delka, start + 2.5);
    const novy: VidTitulek = {
      id: crypto.randomUUID(),
      od: start,
      do: konec,
      styl: p.titulky[p.titulky.length - 1]?.styl ?? 'klasik',
      pozice: p.titulky[p.titulky.length - 1]?.pozice ?? 'dole',
      texty: { [p.zdroj]: '' }
    };
    uloz({ ...p, titulky: [...p.titulky, novy].sort((a, b) => a.od - b.od) });
  }, [p, kde, delka, uloz]);

  const upravTitulek = useCallback((id: string, patch: Partial<VidTitulek>) => {
    if (!p) return;
    uloz({ ...p, titulky: p.titulky.map(t => (t.id === id ? { ...t, ...patch } : t)) });
  }, [p, uloz]);

  const textTitulku2 = useCallback((t: VidTitulek, hodnota: string) => {
    if (!p) return;
    upravTitulek(t.id, { texty: { ...t.texty, [lang]: hodnota } });
  }, [p, lang, upravTitulek]);

  const smazTitulek = useCallback((id: string) => {
    if (!p) return;
    uloz({ ...p, titulky: p.titulky.filter(t => t.id !== id) });
  }, [p, uloz]);

  /* Tažení titulku po časové ose */
  const osaRef = useRef<HTMLDivElement | null>(null);
  const tah = useRef<{ id: string; druh: 'celý' | 'od' | 'do'; x: number; od: number; do: number } | null>(null);

  const zacniTah = (e: React.PointerEvent, t: VidTitulek, druh: 'celý' | 'od' | 'do') => {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    tah.current = { id: t.id, druh, x: e.clientX, od: t.od, do: t.do };
  };

  const behemTahu = (e: React.PointerEvent) => {
    const t = tah.current;
    const box = osaRef.current;
    if (!t || !box || !p) return;
    const naSekundu = box.clientWidth / Math.max(0.5, delka);
    const posun = (e.clientX - t.x) / naSekundu;
    const titulek = p.titulky.find(x => x.id === t.id);
    if (!titulek) return;
    let kam = titulek.od;
    if (t.druh === 'celý') {
      const sirka = t.do - t.od;
      const od = Math.max(0, Math.min(delka - sirka, t.od + posun));
      upravTitulek(t.id, { od, do: od + sirka });
      kam = od;
    } else if (t.druh === 'od') {
      kam = Math.max(0, Math.min(t.do - 0.3, t.od + posun));
      upravTitulek(t.id, { od: kam });
    } else {
      kam = Math.min(delka, Math.max(t.od + 0.3, t.do + posun));
      upravTitulek(t.id, { do: kam });
    }
    /*
     * Přehrávač jde s úchytem. Bez toho se titulek posouval podle čísel
     * a co je v tu chvíli v obraze, se zjistilo až po puštění.
     */
    void skoc(kam);
  };

  const konecTahu = () => {
    if (!tah.current || !p) { tah.current = null; return; }
    tah.current = null;
    // Po tažení se titulky srovnají podle času, ať seznam odpovídá obrazu
    uloz({ ...p, titulky: [...p.titulky].sort((a, b) => a.od - b.od) });
  };

  /* ---------- zvuk ---------- */

  const zvuk = p ? zvukTrhu(p, lang) : { druh: 'original' as const };

  const zapisZvuk = useCallback((patch: Partial<VidZvuk>) => {
    if (!p) return;
    const novy = { ...zvuk, ...patch };
    uloz({ ...p, trhy: { ...p.trhy, [lang]: { ...(p.trhy[lang] ?? {}), zvuk: novy } } });
  }, [p, lang, zvuk, uloz]);

  const vyberZvuk = useCallback(async () => {
    try {
      const v = await api.ig.videoPickAudio();
      if (!v) return;
      zapisZvuk({ druh: 'soubor', soubor: v.soubor, od: 0, do: v.delka || delka, zdrojDelka: v.delka });
    } catch (e: any) {
      toast(e.message, 'error');
    }
  }, [zapisZvuk, delka, toast]);

  /**
   * Nahrávání z mikrofonu.
   *
   * Nahrává **okno**, ne hlavní proces: přístup k mikrofonu má prohlížeč.
   * Hotové bajty se pošlou k uložení, protože v okně by zůstaly jen do
   * zavření a ffmpeg by je neměl odkud vzít.
   */
  const rekorder = useRef<MediaRecorder | null>(null);
  const kusy = useRef<Blob[]>([]);

  const zacniNahravat = useCallback(async () => {
    if (!postId) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      kusy.current = [];
      rec.ondataavailable = e => { if (e.data.size) kusy.current.push(e.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        try {
          const blob = new Blob(kusy.current, { type: 'audio/webm' });
          const bytes = new Uint8Array(await blob.arrayBuffer());
          const ulozeny = await api.ig.videoRecord(postId, lang, bytes, 'webm');
          if (ulozeny) {
            const info = await api.ig.videoProbe(ulozeny.soubor);
            zapisZvuk({ druh: 'soubor', soubor: info.soubor, od: 0, do: info.delka, zdrojDelka: info.delka });
            toast(`Nahráno ${cas(info.delka)}.`);
          }
        } catch (e: any) {
          toast(e.message, 'error');
        }
      };
      rec.start();
      rekorder.current = rec;
      setNahrava(true);
    } catch {
      toast('K mikrofonu se nepodařilo dostat. Povol aplikaci mikrofon v nastavení systému.', 'error');
    }
  }, [postId, lang, zapisZvuk, toast]);

  const dokonciNahravani = useCallback(() => {
    rekorder.current?.stop();
    rekorder.current = null;
    setNahrava(false);
  }, []);

  /* ---------- překlad a vykreslení ---------- */

  const [proTrhy, setProTrhy] = useState<string[]>([]);
  useEffect(() => {
    if (p && proTrhy.length === 0) setProTrhy(trhy.map(t => t.lang));
  }, [p, trhy]);

  const prelozit = useCallback(async (kam?: string[]) => {
    if (!p || !postId) return;
    const cile = kam && kam.length ? kam : trhy.map(t => t.lang);
    setPracuje(kam && kam.length === 1 ? `Překládám do ${kam[0]}…` : 'Překládám titulky…');
    try {
      const novy = await api.ig.videoTranslate(postId, cile);
      setP(novy);
      toast('Titulky přeloženy.');
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setPracuje('');
    }
  }, [p, postId, trhy, toast]);

  /**
   * Vykreslení. Pro každý vybraný trh se nakreslí titulky s jeho textem
   * a pošlou se ffmpegu — proto jeden průchod na trh, ne jeden na všechny.
   */
  const vykreslit = useCallback(async () => {
    if (!p || !postId) return;
    const chyby = potize(p, proTrhy);
    if (chyby.length) { toast(chyby[0], 'error'); return; }
    if (proTrhy.length === 0) { toast('Vyber aspoň jeden trh.', 'error'); return; }

    setPrubeh({});
    for (const trh of proTrhy) {
      setPracuje(`Vykresluji video pro ${trh}…`);
      try {
        const obrazky = p.titulky
          .map(t => {
            const text = textTitulku(t, trh, p.zdroj);
            if (!text) return null;
            return {
              id: t.id,
              png: titulekPng(rozmer.sirka, rozmer.vyska,
                { text, styl: t.styl, pozice: t.pozice, ...doladeni(t), pismo: t.pismo || p.pismo || '' })
            };
          })
          .filter((x): x is { id: string; png: string } => !!x);
        const novy = await api.ig.videoRender(postId, trh, obrazky);
        setP(novy);
      } catch (e: any) {
        toast(`${trh}: ${e.message}`, 'error');
        setPracuje('');
        return;
      }
    }
    setPracuje('');
    toast(`Hotovo — videa pro ${proTrhy.length} trh${proTrhy.length > 1 ? 'y' : ''} jsou přiložená k příspěvku.`);
  }, [p, postId, proTrhy, rozmer, toast]);

  /* ---------- uložení na disk ---------- */

  /*
   * Ne všechno, co se sestříhá, jde na Instagram. Stejné video se hodí
   * do e-shopu, do newsletteru nebo ho chce člověk jen vidět dřív, než
   * se zveřejní. Bez tohohle by se muselo hledat v datech aplikace.
   */
  const ulozNaDisk = useCallback(async (trh: string) => {
    if (!postId) return;
    try {
      const kam = await api.ig.videoExport(postId, trh);
      if (kam) toast(`Uloženo: ${kam.split('/').pop()}`);
    } catch (e: any) {
      toast(e.message, 'error');
    }
  }, [postId, toast]);

  const ulozVse = useCallback(async () => {
    if (!postId) return;
    try {
      const soubory = await api.ig.videoExportAll(postId);
      if (soubory.length) {
        toast(`Uloženo ${soubory.length} ${soubory.length === 1 ? 'video' : 'videa'} do vybrané složky.`);
      }
    } catch (e: any) {
      toast(e.message, 'error');
    }
  }, [postId, toast]);

  /* ---------- vykreslení obrazovky ---------- */

  if (!postId) {
    return (
      <div className="ig-pane">
        <p className="desc">Střih videa se otevírá u konkrétního příspěvku.</p>
        <button className="btn ghost" onClick={onBack}>Zpět</button>
      </div>
    );
  }
  if (!p) return <div className="ig-pane"><p className="desc">Načítám…</p></div>;

  const chyby = potize(p, proTrhy.length ? proTrhy : [p.zdroj]);
  const vybranyKlip = klipy.find(k => k.id === vybrany) ?? null;
  /** Spoj, jehož přechod se zrovna nastavuje — panel pod pásem. */
  const spoj = klipy.find(k => k.id === prechodMenu) ?? null;
  const naSekundu = (s: number) => `${(s / Math.max(0.5, delka)) * 100}%`;
  /*
   * Po kolika sekundách značit. U krátkého videa po jedné, u delšího
   * řidčeji — jinak by se čísla slila do šedé kaše.
   */
  const krokZnacek = delka <= 8 ? 1 : delka <= 20 ? 2 : delka <= 45 ? 5 : 10;
  const znacky = Array.from({ length: Math.floor(delka / krokZnacek) + 1 }, (_x, i) => i * krokZnacek);
  const hotovoKolik = Object.keys(p.hotovo ?? {}).length;

  return (
    <div className="ig-pane qv">
      <div className="qv-top">
        <button className="btn ghost" onClick={onBack}><Icon name="chevLeft" size={15} /> Zpět na příspěvek</button>
        <div className="qv-top-t">
          <h2>Video s titulky</h2>
          <span className="desc">
            {klipy.length
              ? `${klipy.length} ${klipy.length === 1 ? 'záběr' : klipy.length < 5 ? 'záběry' : 'záběrů'} · ${cas(delka)} · ${p.titulky.length} ${p.titulky.length === 1 ? 'titulek' : 'titulky'}`
              : 'Začni tím, že přidáš video.'}
          </span>
        </div>
        <button className="btn primary" disabled={!!pracuje || !ffmpeg?.ok || chyby.length > 0} onClick={vykreslit}>
          {pracuje ? pracuje : `Vykreslit pro ${proTrhy.length} trh${proTrhy.length === 1 ? '' : 'y'}`}
        </button>
      </div>

      {ffmpeg && !ffmpeg.ok && (
        <div className="warn-box">
          <b>Bez ffmpegu se video nevykreslí.</b>
          <span>{ffmpeg.note}</span>
        </div>
      )}

      {/*
        * Náhled zůstává u kraje a drží se při rolování.
        *
        * Dřív stál v řadě s časovou osou nahoře: při práci s titulky
        * ve spodní části obrazovky nebyl vidět, takže se po každé změně
        * muselo rolovat nahoru a zpátky. Ladit titulek naslepo je přitom
        * to poslední, co má tahle obrazovka dovolit.
        */}
      <div className={`qv-telo vel-${velikostNahledu}`}>
        <div className="qv-rail">
        <div className="qv-prehravac">
          {/*
            * Dva obrazy nad sebou. Přechod je chvíle, kdy jsou vidět oba
            * záběry naráz — s jedním přehrávačem se ukázat nedá, a právě
            * proto se dřív v náhledu žádný přechod neobjevil.
            */}
          <div className={`qv-obal pomer-${p.pomer.replace(':', '-')} vel-${velikostNahledu}`} ref={obal}
            onClick={() => void prehraj()}>
            <video ref={vidA} playsInline muted={zvuk.druh !== 'original'} />
            <video ref={vidB} playsInline muted style={{ opacity: 0 }} />
            {/* Závoj pro přechod přes černou nebo bílou */}
            <div ref={zavoj} className="qv-zavoj" style={{ opacity: 0 }} />
            <canvas ref={platno} className="qv-titulky" />
            {!hraje && (
              <div className="qv-play"><Icon name="play" size={26} /></div>
            )}
            {rezim === 'zaber' && vybranyKlip && (
              <div className="qv-stitek">Zdroj záběru {klipy.indexOf(vybranyKlip) + 1}</div>
            )}
          </div>
          <div className="qv-ovladani">
            <button className="icon-btn" onClick={() => void prehraj()} title={hraje ? 'Pauza' : 'Přehrát'}>
              <Icon name={hraje ? 'pause' : 'play'} size={16} />
            </button>
            {/*
              * Údaj času říká, čeho se týká. Dřív tu stál čas výsledného
              * videa i ve chvíli, kdy se zkracoval záběr v jeho vlastním
              * čase — a nedalo se poznat, k čemu se „tady" vztahuje.
              */}
            {rezim === 'zaber' && vybranyKlip ? (
              <span className="qv-cas">
                {cas(kdeZdroj)} / {cas(vybranyKlip.zdrojDelka)} <em>ve zdroji</em>
              </span>
            ) : (
              <span className="qv-cas">{cas(kde)} / {cas(delka)} <em>ve videu</em></span>
            )}
            {rezim === 'zaber' && (
              <button className="btn ghost" onClick={() => { setVybrany(null); setRezim('osa'); void skoc(kde); }}>
                Zpět na celé video
              </button>
            )}
            <div className="qv-zvetseni">
              <span className="desc">Náhled</span>
              {(['s', 'm', 'l'] as const).map(v => (
                <button key={v} className={velikostNahledu === v ? 'on' : ''}
                  title={v === 's' ? 'Malý náhled' : v === 'm' ? 'Střední náhled' : 'Velký náhled'}
                  onClick={() => setVelikostNahledu(v)}>
                  {v === 's' ? 'S' : v === 'm' ? 'M' : 'L'}
                </button>
              ))}
            </div>
            <div className="qv-pomery">
              {(Object.keys(POMERY) as VidPomer[]).map(pom => (
                <button key={pom} className={p.pomer === pom ? 'on' : ''} title={POMERY[pom].popis}
                  onClick={() => uloz({ ...p, pomer: pom })}>{POMERY[pom].nazev}</button>
              ))}
            </div>
          </div>
          <p className="desc qv-poznamka">
            {rezim === 'zaber'
              ? 'Náhled ukazuje celý zdrojový soubor. Co z něj zůstane, vybereš úchyty pod ním.'
              : 'Titulky i přechody vidíš tak, jak se vypálí — kreslí a prolíná je náhled stejně jako výsledek.'}
          </p>
        </div>
        </div>

        <div className="qv-kroky">

      {/* ---------- 1 ZÁBĚRY ---------- */}
      <section className="qv-krok">
        <header>
          <span className="qv-cislo">1</span>
          <div>
            <h3>Záběry</h3>
            <p className="desc">
              Postupně za sebou. Táhnutím se přehodí pořadí, kliknutím na spoj se
              nastaví přechod.
            </p>
          </div>
          <div className="qv-akce">
            <button className="btn ghost" onClick={pridejKlipy}><Icon name="plus" size={14} /> Video</button>
            <button className="btn ghost" onClick={() => setZnelkyOtevrene(v => !v)}>Znělky</button>
          </div>
        </header>

        {znelkyOtevrene && (
          <div className="qv-znelky">
            <p className="desc">
              Videa, která se opakují u každého příspěvku — logo na začátek, odkaz na
              e-shop na konec. Nahrají se jednou a pak se jen vkládají.
            </p>
            {znelky.length === 0 && <p className="desc">Zatím žádná znělka.</p>}
            {znelky.map(z => (
              <div className="qv-znelka" key={z.id}>
                <input
                  value={z.nazev}
                  onChange={e => setZnelky(znelky.map(x => (x.id === z.id ? { ...x, nazev: e.target.value } : x)))}
                  onBlur={e => api.ig.stingSave(z.id, { nazev: e.target.value }).then(setZnelky)} />
                <span className="desc">{cas(z.delka)}</span>
                <button className="btn ghost" onClick={() => pridejZnelku(z, 'zacatek')}>Na začátek</button>
                <button className="btn ghost" onClick={() => pridejZnelku(z, 'konec')}>Na konec</button>
                <button className="icon-btn danger" title="Odebrat znělku"
                  onClick={() => api.ig.stingRemove(z.id).then(setZnelky)}>
                  <Icon name="trash" size={14} />
                </button>
              </div>
            ))}
            <button className="btn ghost" onClick={() => api.ig.stingAdd('kamkoli').then(setZnelky)}>
              <Icon name="plus" size={14} /> Nahrát znělku
            </button>
          </div>
        )}

        {lang !== p.zdroj && (
          <div className="qv-vlastni">
            {vlastniKlipy ? (
              <>
                <span><b>{lang}</b> má vlastní záběry. Titulky zůstávají společné.</span>
                <button className="btn ghost" onClick={() => {
                  const { [lang]: _pryc, ...zbytek } = p.trhy;
                  void _pryc;
                  uloz({ ...p, trhy: zbytek });
                }}>Vrátit společné</button>
              </>
            ) : (
              <>
                <span>Záběry jsou společné pro všechny trhy.</span>
                <button className="btn ghost" onClick={() => uloz({
                  ...p,
                  trhy: { ...p.trhy, [lang]: { ...(p.trhy[lang] ?? {}), klipy: p.klipy.map(k => ({ ...k, id: crypto.randomUUID() })) } }
                })}>Jiné video pro {lang}</button>
              </>
            )}
          </div>
        )}

        <div className="qv-pas">
          {klipy.length === 0 && (
            <button className="qv-prazdno" onClick={pridejKlipy}>
              <Icon name="plus" size={20} />
              <b>Přidat video</b>
              <span>Jedno delší, nebo několik kratších za sebou.</span>
            </button>
          )}
          {klipy.map((k, i) => (
            <div className="qv-spoj-a-klip" key={k.id}>
              {i > 0 && (
                <div className="qv-spoj">
                  {/*
                    * Jen přepínač výběru. Vyskakovací nabídka tu dřív visela
                    * uvnitř pásu, a protože se pás při více záběrech posouvá,
                    * ořízl ji — při třech a víc záběrech se po klepnutí na
                    * spoj nestalo nic viditelného. Volby jsou proto v panelu
                    * pod pásem, kde je na ně místo.
                    */}
                  <button
                    className={`qv-prechod ${k.prechod === 'zadny' ? '' : 'on'} ${prechodMenu === k.id ? 'vybrany' : ''}`}
                    title={PRECHODY[k.prechod].popis}
                    onClick={() => {
                      setPrechodMenu(prechodMenu === k.id ? null : k.id);
                      setVybrany(null);
                    }}>
                    {k.prechod === 'zadny' ? '✂' : '◑'}
                    <em>{PRECHODY[k.prechod].nazev}</em>
                  </button>
                </div>
              )}
              <div
                className={`qv-klip ${vybrany === k.id ? 'on' : ''} ${nad === k.id ? 'over' : ''} ${k.znelka ? 'znelka' : ''}`}
                draggable
                onDragStart={() => { tahany.current = k.id; }}
                onDragOver={e => { e.preventDefault(); setNad(k.id); }}
                onDragLeave={() => setNad(n => (n === k.id ? null : n))}
                onDrop={e => { e.preventDefault(); pust(k.id); }}
                onClick={() => {
                  setVybrany(k.id);
                  setPrechodMenu(null);
                  // Výběr záběru = práce s jeho zdrojem, ne s celou osou
                  void doZaberu(k);
                }}>
                {/*
                  * Pořadí, značka a koš mají vlastní řádek. Dřív stálo číslo
                  * i koš nad textem napevno a dlouhý název souboru se s nimi
                  * překrýval — a názvy z telefonu dlouhé bývají.
                  */}
                <div className="qv-klip-hlava">
                  <span className="qv-klip-c">{i + 1}</span>
                  {k.znelka && <em className="qv-znacka">znělka</em>}
                  <button className="icon-btn danger" title="Odebrat záběr"
                    onClick={e => { e.stopPropagation(); smazKlip(k.id); }}>
                    <Icon name="trash" size={13} />
                  </button>
                </div>
                <b title={souborNazev(k.soubor)}>{souborNazev(k.soubor)}</b>
                <span className="desc">{cas(k.do - k.od)}</span>
              </div>
            </div>
          ))}
        </div>

        {spoj && (
          <div className="qv-strih">
            <div className="qv-strih-hlava">
              <b>Přechod mezi {klipy.indexOf(spoj)} a {klipy.indexOf(spoj) + 1}</b>
              <span className="desc">{PRECHODY[spoj.prechod].popis}</span>
              <button className="btn ghost" onClick={() => setPrechodMenu(null)}>Hotovo</button>
            </div>
            <div className="qv-prechody">
              {(Object.keys(PRECHODY) as VidPrechod[]).map(druh => (
                <button key={druh} className={`qv-prechod-volba ${spoj.prechod === druh ? 'on' : ''}`}
                  onClick={() => upravKlip(spoj.id, { prechod: druh })}>
                  <b>{PRECHODY[druh].nazev}</b>
                  <span>{PRECHODY[druh].popis}</span>
                </button>
              ))}
            </div>
            {spoj.prechod !== 'zadny' && (
              <label className="qv-prechod-delka">
                <span>Délka přechodu <b>{spoj.prechodDelka.toFixed(1)} s</b> — o tolik bude video kratší</span>
                <input type="range" min={0.2} max={2} step={0.1} value={spoj.prechodDelka}
                  onChange={e => upravKlip(spoj.id, { prechodDelka: Number(e.target.value) })} />
              </label>
            )}
          </div>
        )}

        {vybranyKlip && !spoj && (
          <div className="qv-strih">
            <div className="qv-strih-hlava">
              <b>Záběr {klipy.indexOf(vybranyKlip) + 1}</b>
              <span className="desc">
                Ze zdroje dlouhého {cas(vybranyKlip.zdrojDelka)} zůstane{' '}
                <b>{cas(vybranyKlip.do - vybranyKlip.od)}</b>
                {' '}({cas(vybranyKlip.od)} – {cas(vybranyKlip.do)})
              </span>
              <button className="btn ghost" onClick={() => {
                jenVystrizek.current = true;
                void (async () => {
                  await doZaberu(vybranyKlip, vybranyKlip.od);
                  setHraje(true);
                  try { await elHlavni()?.play(); } catch { /* prohlížeč občas odmítne */ }
                })();
              }}>
                <Icon name="play" size={13} /> Přehrát výstřižek
              </button>
            </div>

            {/*
              * Celý zdroj v jednom pásu: co se vyhodí, je ztlumené, co
              * zůstane, je světlé a ohraničené úchyty. Dva nezávislé
              * posuvníky se nedaly přečíst — nebylo z nich poznat, který
              * kus videa vlastně projde.
              */}
            <div className="qv-vystrizek" ref={strihRef}
              onPointerMove={behemStrihu} onPointerUp={konecStrihu} onPointerLeave={konecStrihu}
              onClick={e => {
                if (strih.current) return;
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                const kdy = ((e.clientX - r.left) / r.width) * Math.max(0.1, vybranyKlip.zdrojDelka);
                const el = elHlavni();
                if (el && rezim === 'zaber') { el.currentTime = kdy; setKdeZdroj(kdy); }
              }}>
              {(zdrojSnimky[vybranyKlip.id] ?? []).length > 0 && (
                <div className="qv-snimky qv-snimky-zdroj" aria-hidden="true">
                  {zdrojSnimky[vybranyKlip.id].map((src, j) => <img key={j} src={src} alt="" />)}
                </div>
              )}
              {/* Zahozené části — ztlumené, ať je vidět, co se nepoužije */}
              <div className="qv-vystrizek-mimo"
                style={{ left: 0, width: `${(vybranyKlip.od / Math.max(0.1, vybranyKlip.zdrojDelka)) * 100}%` }} />
              <div className="qv-vystrizek-mimo"
                style={{ left: `${(vybranyKlip.do / Math.max(0.1, vybranyKlip.zdrojDelka)) * 100}%`, right: 0 }} />
              <div className="qv-vystrizek-vybrano"
                style={{
                  left: `${(vybranyKlip.od / Math.max(0.1, vybranyKlip.zdrojDelka)) * 100}%`,
                  width: `${((vybranyKlip.do - vybranyKlip.od) / Math.max(0.1, vybranyKlip.zdrojDelka)) * 100}%`
                }} />
              {rezim === 'zaber' && (
                <div className="qv-hlava qv-hlava-zdroj"
                  style={{ left: `${(kdeZdroj / Math.max(0.1, vybranyKlip.zdrojDelka)) * 100}%` }} />
              )}
              <button className="qv-vystrizek-uchop" title="Začátek záběru"
                style={{ left: `${(vybranyKlip.od / Math.max(0.1, vybranyKlip.zdrojDelka)) * 100}%` }}
                onPointerDown={e => zacniStrih(e, 'od')} />
              <button className="qv-vystrizek-uchop" title="Konec záběru"
                style={{ left: `${(vybranyKlip.do / Math.max(0.1, vybranyKlip.zdrojDelka)) * 100}%` }}
                onPointerDown={e => zacniStrih(e, 'do')} />
            </div>
            <div className="qv-vystrizek-popis">
              <span>0:00,0</span>
              <span>{cas(vybranyKlip.zdrojDelka)}</span>
            </div>

            {/*
              * Snímek v místě střihu. Posouvat úchyt podle čísel znamená
              * hádat, čím záběr začne a skončí — tady je to vidět, a je
              * u toho tlačítko, které hranici nastaví podle přehrávače.
              */}
            <div className="qv-konce">
              <div className="qv-konec-snimek">
                <span className="qv-konec-popis">Začíná na {cas(vybranyKlip.od)}</span>
                {koncovky[`${vybranyKlip.id}:od`]
                  ? <img src={koncovky[`${vybranyKlip.id}:od`]} alt="" />
                  : <div className="qv-konec-prazdno">načítám snímek…</div>}
                <button className="btn ghost" onClick={() => {
                  const el = elHlavni();
                  if (el && rezim === 'zaber') {
                    upravKlip(vybranyKlip.id, { od: Math.min(el.currentTime, vybranyKlip.do - MIN_KLIP) });
                  } else {
                    toast('Posuň náhled na místo, kde má záběr začít.', 'error');
                  }
                }}>Začátek tady</button>
              </div>
              <div className="qv-konec-snimek">
                <span className="qv-konec-popis">Končí na {cas(vybranyKlip.do)}</span>
                {koncovky[`${vybranyKlip.id}:do`]
                  ? <img src={koncovky[`${vybranyKlip.id}:do`]} alt="" />
                  : <div className="qv-konec-prazdno">načítám snímek…</div>}
                <button className="btn ghost" onClick={() => {
                  const el = elHlavni();
                  if (el && rezim === 'zaber') {
                    upravKlip(vybranyKlip.id, { do: Math.max(el.currentTime, vybranyKlip.od + MIN_KLIP) });
                  } else {
                    toast('Posuň náhled na místo, kde má záběr skončit.', 'error');
                  }
                }}>Konec tady</button>
              </div>
              <div className="qv-konec-snimek qv-konec-rozdelit">
                <span className="qv-konec-popis">Rozdělit v {cas(kdeZdroj)}</span>
                {koncovky[`${vybranyKlip.id}:ted`]
                  ? <img src={koncovky[`${vybranyKlip.id}:ted`]} alt="" />
                  : <div className="qv-konec-prazdno">posuň náhled</div>}
                <button className="btn ghost" onClick={() => {
                  if (rezim !== 'zaber') {
                    toast('Posuň náhled na místo, kde se má záběr rozdělit.', 'error');
                    return;
                  }
                  const i = klipy.indexOf(vybranyKlip);
                  const novy = rozdel(klipy, i, kdeZdroj, () => crypto.randomUUID());
                  if (novy.length === klipy.length) {
                    toast('Tady se rozdělit nedá — bylo by to moc blízko kraje.', 'error');
                    return;
                  }
                  zapisKlipy(novy);
                  toast('Záběr rozdělen na dva.');
                }}>Rozdělit tady</button>
              </div>
            </div>

            {/*
              * Výřez. Natáčí se na šířku, publikuje na výšku — automatický
              * ořez ze středu trefí půlku kravaty a kus zdi. Náhled ukazuje
              * přesně to, co se vypálí, takže se dá zarovnat okem.
              */}
            <div className="qv-vyrez">
              <label>
                Přiblížení <b>{vyrez(vybranyKlip).zoom.toFixed(2)}×</b>
                <input type="range" min={1} max={3} step={0.05} value={vyrez(vybranyKlip).zoom}
                  onChange={e => upravKlip(vybranyKlip.id, { zoom: Number(e.target.value) })} />
              </label>
              <label>
                Posun vodorovně
                <input type="range" min={-1} max={1} step={0.02} value={vyrez(vybranyKlip).x}
                  disabled={vyrez(vybranyKlip).zoom <= 1}
                  onChange={e => upravKlip(vybranyKlip.id, { posunX: Number(e.target.value) })} />
              </label>
              <label>
                Posun svisle
                <input type="range" min={-1} max={1} step={0.02} value={vyrez(vybranyKlip).y}
                  disabled={vyrez(vybranyKlip).zoom <= 1}
                  onChange={e => upravKlip(vybranyKlip.id, { posunY: Number(e.target.value) })} />
              </label>
              <button className="btn ghost"
                onClick={() => upravKlip(vybranyKlip.id, { zoom: 1, posunX: 0, posunY: 0 })}>
                Celý záběr
              </button>
            </div>
          </div>
        )}
      </section>

      {/* ---------- 2 TITULKY ---------- */}
      <section className="qv-krok">
        <header>
          <span className="qv-cislo">2</span>
          <div>
            <h3>Titulky</h3>
            <p className="desc">
              Časy jsou pro všechny trhy stejné, text jiný. Nastav je jednou
              v {jazykNazev(trhy, p.zdroj)} a zbytek nech přeložit.
            </p>
          </div>
        </header>

        <div className="qv-osa-box">
          <div className="qv-osa-hlava">
            <b>Časová osa</b>
            <span className="desc">Klepnutím do osy se náhled přesune, tlačítkem vznikne titulek v tom místě.</span>
            <button className="btn ghost" onClick={() => pridejTitulek()} disabled={klipy.length === 0}>
              <Icon name="plus" size={14} /> Titulek tady
            </button>
          </div>

          {/*
            * Měřítko nad osou. Bez něj byla osa jen dva pruhy beze jmen
            * a bez čísel — nedalo se z ní odhadnout, v které sekundě co
            * je, a tím pádem ani kam titulek patří.
            */}
          <div className="qv-osa-ramec">
            <div className="qv-osa-jmena">
              <span>Záběry</span>
              <span>Titulky</span>
            </div>

            <div className="qv-osa-plocha">
              <div className="qv-stupnice">
                {znacky.map(z => (
                  <i key={z} style={{ left: naSekundu(z) }}><em>{cas(z)}</em></i>
                ))}
              </div>

              <div className="qv-osa" ref={osaRef}
                onPointerMove={behemTahu}
                onPointerUp={konecTahu}
                onClick={e => {
                  const box = osaRef.current;
                  if (!box) return;
                  const r = box.getBoundingClientRect();
                  setRezim('osa');
                  setVybrany(null);
                  void skoc(((e.clientX - r.left) / r.width) * delka);
                }}>
                <div className="qv-vrstva qv-vrstva-klipy">
                  {klipy.map((k, i) => (
                    <div key={k.id}
                      className={`qv-blok ${vybrany === k.id ? 'on' : ''} ${k.znelka ? 'znelka' : ''}`}
                      style={{ left: naSekundu(rozvrzeni.místa[i].start), width: naSekundu(rozvrzeni.místa[i].delka) }}
                      title={`${souborNazev(k.soubor)} · ${cas(rozvrzeni.místa[i].delka)}`}>
                      {(snimky[k.id] ?? []).length > 0 && (
                        <div className="qv-snimky" aria-hidden="true">
                          {snimky[k.id].map((src, j) => <img key={j} src={src} alt="" />)}
                        </div>
                      )}
                      <span className="qv-blok-popis">
                        {i + 1}
                        {k.znelka ? ' · znělka' : ''}
                      </span>
                      {/* Překryv přechodu — proto je video kratší než součet záběrů */}
                      {rozvrzeni.místa[i].prechod > 0 && (
                        <em className="qv-prolnuti" style={{ width: naSekundu(rozvrzeni.místa[i].prechod) }}>
                          <b>{PRECHODY[k.prechod].nazev}</b>
                        </em>
                      )}
                    </div>
                  ))}
                </div>
                <div className="qv-vrstva qv-vrstva-titulky">
                  {p.titulky.map(t => (
                    <div key={t.id}
                      className={`qv-tit ${t.pozice} ${podrobne === t.id ? 'on' : ''}`}
                      style={{ left: naSekundu(t.od), width: naSekundu(Math.max(0.3, t.do - t.od)) }}
                      onPointerDown={e => zacniTah(e, t, 'celý')}
                      onClick={e => { e.stopPropagation(); setPodrobne(t.id); }}
                      title={`${textTitulku(t, lang, p.zdroj) || 'bez textu'} · ${cas(t.od)}–${cas(t.do)}`}>
                      <i className="qv-uchop od" onPointerDown={e => zacniTah(e, t, 'od')} />
                      <span>{textTitulku(t, lang, p.zdroj) || '—'}</span>
                      <i className="qv-uchop do" onPointerDown={e => zacniTah(e, t, 'do')} />
                    </div>
                  ))}
                  {p.titulky.length === 0 && (
                    <span className="qv-osa-prazdno">Zatím žádný titulek — klepni do osy a přidej ho tlačítkem výš.</span>
                  )}
                </div>
                {/* Hlava s časem: kde přesně náhled stojí */}
                <div className="qv-hlava" style={{ left: naSekundu(kde) }}>
                  <b>{cas(kde)}</b>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/*
          * Jazyk se přepíná velkým, ne záložkou mezi ostatními. Je to
          * nejčastější úkon celé obrazovky a zároveň jediné místo, kde
          * se dá splést trh — text napsaný do špatného jazyka se pozná
          * až na hotovém videu.
          */}
        <div className="qv-jazyky">
          {trhy.map(t => {
            const kolik = p.titulky.filter(x => textTitulku(x, t.lang, '').trim()).length;
            const hotovo = p.titulky.length > 0 && kolik === p.titulky.length;
            return (
              <button key={t.lang}
                className={`qv-jazyk ${lang === t.lang ? 'on' : ''} ${hotovo ? 'hotovo' : ''}`}
                style={{ '--trh': t.color } as React.CSSProperties}
                onClick={() => setLang(t.lang)}>
                <b>{t.lang}</b>
                <span>{t.label || t.lang}</span>
                {t.lang === p.zdroj
                  ? <em className="qv-jazyk-zdroj">zdroj</em>
                  : <em className={hotovo ? 'ok' : ''}>{kolik} / {p.titulky.length}</em>}
              </button>
            );
          })}
        </div>

        {/*
          * Překlad se nabízí tam, kde chybí — ne v hlavičce kroku. Tlačítko
          * „přeložit" dává smysl ve chvíli, kdy se člověk přepne na trh
          * a vidí prázdná pole; nahoře u nadpisu ho hledal jinde.
          */}
        {p.titulky.length > 0 && (() => {
          const chybi = p.titulky.filter(x => !textTitulku(x, lang, '').trim()).length;
          const vseChybi = trhy
            .filter(t => t.lang !== p.zdroj)
            .filter(t => p.titulky.some(x => !textTitulku(x, t.lang, '').trim()));
          if (lang === p.zdroj) {
            return vseChybi.length > 0 ? (
              <div className="qv-jazyk-stav">
                <span>
                  Zdrojový jazyk. Nepřeložené trhy: <b>{vseChybi.map(t => t.lang).join(', ')}</b>
                </span>
                <button className="btn primary" disabled={!!pracuje}
                  onClick={() => void prelozit(vseChybi.map(t => t.lang))}>
                  Přeložit do ostatních trhů
                </button>
              </div>
            ) : (
              <div className="qv-jazyk-stav ok">
                <span>Zdrojový jazyk. Všechny trhy mají titulky přeložené.</span>
              </div>
            );
          }
          return chybi > 0 ? (
            <div className="qv-jazyk-stav">
              <span>
                V trhu <b>{lang}</b> {chybi === p.titulky.length ? 'zatím nejsou titulky' : `chybí ${chybi} z ${p.titulky.length} titulků`}
                {' '}— vypálí se místo nich {p.zdroj}.
              </span>
              <button className="btn primary" disabled={!!pracuje} onClick={() => void prelozit([lang])}>
                Přeložit do {lang}
              </button>
              {vseChybi.length > 1 && (
                <button className="btn ghost" disabled={!!pracuje}
                  onClick={() => void prelozit(vseChybi.map(t => t.lang))}>
                  Přeložit všechny trhy
                </button>
              )}
            </div>
          ) : (
            <div className="qv-jazyk-stav ok">
              <span>Trh <b>{lang}</b> má přeložené všechny titulky.</span>
            </div>
          );
        })()}

        {p.titulky.length === 0 && (
          <p className="desc">
            Žádný titulek. Přidej ho tlačítkem u časové osy — objeví se v místě, kde
            stojí přehrávač.
          </p>
        )}

        {/*
          * Písmo pro celý projekt. Styl určuje tloušťku, obtah a umístění,
          * písmo je na tom nezávislé — firemní písmo se často liší od
          * toho, co má aplikace, a nahrát ho jde rovnou odsud.
          */}
        <div className="qv-pismo">
          <label>
            Písmo titulků
            <select value={p.pismo || ''}
              onChange={e => { uloz({ ...p, pismo: e.target.value }); void nactiPismo(e.target.value); }}>
              <option value="">Montserrat (písmo aplikace)</option>
              {pisma.map(f => (
                <option key={f.soubor} value={f.nazev}>{f.nazev}{f.vlastni ? ' (vlastní)' : ''}</option>
              ))}
            </select>
          </label>
          <button className="btn ghost" onClick={async () => {
            try {
              const list = await api.ig.fontAdd();
              const bezpecny = Array.isArray(list) ? list : [];
              setPisma(bezpecny);
              const novy = bezpecny.find(f => f.vlastni);
              if (novy) { uloz({ ...p, pismo: novy.nazev }); void nactiPismo(novy.nazev); }
            } catch (e: any) { toast(e.message, 'error'); }
          }}>Nahrát vlastní písmo</button>
          <span className="desc">
            {pisma.length ? `Z počítače: ${pisma.length} písem.` : 'Písma z počítače se načítají…'}
          </span>
        </div>

        <div className="qv-titulky-list">
          {[...p.titulky].sort((a, b) => a.od - b.od).map((t, i) => {
            const text = t.texty?.[lang] ?? '';
            const zeZdroje = !text.trim() && !!textTitulku(t, lang, p.zdroj);
            return (
              <div className={`qv-tit-radek ${kde >= t.od && kde <= t.do ? 'nyni' : ''}`} key={t.id}>
                <span className="qv-tit-c">{i + 1}</span>
                <div className="qv-tit-cas">
                  <input type="number" step={0.1} min={0} max={delka} value={round1(t.od)}
                    onChange={e => upravTitulek(t.id, { od: Math.min(Number(e.target.value), t.do - 0.2) })} />
                  <em>→</em>
                  <input type="number" step={0.1} min={0} max={delka} value={round1(t.do)}
                    onChange={e => upravTitulek(t.id, { do: Math.max(Number(e.target.value), t.od + 0.2) })} />
                </div>
                <div className="qv-tit-text">
                  <textarea
                    rows={2}
                    value={text}
                    placeholder={zeZdroje ? `Nepřeloženo — použije se ${p.zdroj}` : 'Text titulku, klidně s emoji'}
                    onChange={e => textTitulku2(t, e.target.value)} />
                  {zeZdroje && <em className="qv-tit-zdroj">Vypálí se {p.zdroj}: „{textTitulku(t, lang, p.zdroj)}"</em>}
                </div>
                <div className="qv-tit-vzhled">
                  <select value={t.styl} onChange={e => upravTitulek(t.id, { styl: e.target.value as VidStyl })}
                    title={STYLY[t.styl].popis}>
                    {(Object.keys(STYLY) as VidStyl[]).map(s => (
                      <option key={s} value={s}>{STYLY[s].nazev}</option>
                    ))}
                  </select>
                  <select value={t.pozice} onChange={e => upravTitulek(t.id, { pozice: e.target.value as VidPozice })}>
                    {(Object.keys(POZICE) as VidPozice[]).map(s => (
                      <option key={s} value={s}>{POZICE[s]}</option>
                    ))}
                  </select>
                </div>
                <div className="qv-tit-btns">
                  <button className="icon-btn" title="Přeskočit na titulek" onClick={() => void skoc(t.od)}>
                    <Icon name="play" size={13} />
                  </button>
                  {/*
                    * Podrobnosti jsou schované, ale na jedno klepnutí.
                    * Styl dává společný vzhled; tohle je výjimka pro jeden
                    * titulek — delší věta, světlý záběr, posun nad ovládání
                    * přehrávače. Mít to rozbalené u všech by z deseti řádků
                    * udělalo nepřehlednou zeď.
                    */}
                  <button className={`icon-btn ${podrobne === t.id ? 'on' : ''}`} title="Víc možností"
                    onClick={() => setPodrobne(podrobne === t.id ? null : t.id)}>
                    <Icon name="sliders" size={13} />
                  </button>
                  <button className="icon-btn danger" title="Smazat titulek" onClick={() => smazTitulek(t.id)}>
                    <Icon name="trash" size={13} />
                  </button>
                </div>

                {podrobne === t.id && (
                  <div className="qv-tit-vic">
                    <label>
                      Velikost <b>{Math.round(doladeni(t).velikost * 100)} %</b>
                      <input type="range" min={0.7} max={1.5} step={0.05} value={doladeni(t).velikost}
                        onChange={e => upravTitulek(t.id, { velikost: Number(e.target.value) })} />
                    </label>
                    <label>
                      Svislé doladění <b>{doladeni(t).posunY === 0 ? 'žádné' : `${Math.round(doladeni(t).posunY * 100)} %`}</b>
                      <input type="range" min={-0.25} max={0.25} step={0.01} value={doladeni(t).posunY}
                        onChange={e => upravTitulek(t.id, { posunY: Number(e.target.value) })} />
                    </label>
                    <label>
                      Barva
                      <select value={doladeni(t).barva}
                        onChange={e => upravTitulek(t.id, { barva: e.target.value as VidBarva })}>
                        {(Object.keys(BARVY) as VidBarva[]).map(b => (
                          <option key={b} value={b}>{BARVY[b].nazev}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Vodorovné doladění <b>{doladeni(t).posunX === 0 ? 'žádné' : `${Math.round(doladeni(t).posunX * 100)} %`}</b>
                      <input type="range" min={-0.4} max={0.4} step={0.01} value={doladeni(t).posunX}
                        onChange={e => upravTitulek(t.id, { posunX: Number(e.target.value) })} />
                    </label>
                    <label>
                      Zarovnání
                      <select value={doladeni(t).zarovnani}
                        onChange={e => upravTitulek(t.id, { zarovnani: e.target.value as VidZarovnani })}>
                        {(Object.keys(ZAROVNANI) as VidZarovnani[]).map(z => (
                          <option key={z} value={z}>{ZAROVNANI[z]}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Písmo jen pro tenhle titulek
                      <select value={t.pismo || ''}
                        onChange={e => {
                          upravTitulek(t.id, { pismo: e.target.value });
                          void nactiPismo(e.target.value);
                        }}>
                        <option value="">Jako celý projekt</option>
                        {pisma.map(f => (
                          <option key={f.soubor} value={f.nazev}>{f.nazev}{f.vlastni ? ' (vlastní)' : ''}</option>
                        ))}
                      </select>
                    </label>
                    <button className="btn ghost" onClick={() => upravTitulek(t.id,
                      { velikost: 1, posunY: 0, posunX: 0, barva: 'auto', zarovnani: 'stred', pismo: '' })}>
                      Zpět podle stylu
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* ---------- 3 ZVUK ---------- */}
      <section className="qv-krok">
        <header>
          <span className="qv-cislo">3</span>
          <div>
            <h3>Zvuk pro {lang}</h3>
            <p className="desc">
              Každý trh může mít vlastní — třeba mluvené slovo ve svém jazyce.
              Bez nastavení se použije zvuk z videa.
            </p>
          </div>
        </header>

        <div className="qv-zvuk">
          <div className="qv-volby">
            {([['original', 'Zvuk z videa'], ['soubor', 'Vlastní zvuk'], ['ticho', 'Bez zvuku']] as const).map(([druh, label]) => (
              <button key={druh} className={`qv-volba ${zvuk.druh === druh ? 'on' : ''}`}
                onClick={() => zapisZvuk({ druh })}>{label}</button>
            ))}
          </div>

          {zvuk.druh === 'soubor' && (
            <div className="qv-zvuk-detail">
              <div className="qv-zvuk-rada">
                <button className="btn ghost" onClick={vyberZvuk}>Vybrat soubor</button>
                {nahrava
                  ? <button className="btn danger" onClick={dokonciNahravani}>● Zastavit nahrávání</button>
                  : <button className="btn ghost" onClick={zacniNahravat}>Nahrát mikrofonem</button>}
                {zvuk.soubor && <span className="desc">{souborNazev(zvuk.soubor)}</span>}
              </div>
              {zvuk.soubor && (
                <>
                  <label>
                    Od <b>{cas(zvuk.od ?? 0)}</b>
                    <input type="range" min={0} max={Math.max(1, zvuk.zdrojDelka ?? delka)} step={0.1}
                      value={zvuk.od ?? 0}
                      onChange={e => zapisZvuk({ od: Math.min(Number(e.target.value), (zvuk.do ?? delka) - 0.5) })} />
                  </label>
                  <label>
                    Do <b>{cas(zvuk.do ?? delka)}</b>
                    <input type="range" min={0} max={Math.max(1, zvuk.zdrojDelka ?? delka)} step={0.1}
                      value={zvuk.do ?? delka}
                      onChange={e => zapisZvuk({ do: Math.max(Number(e.target.value), (zvuk.od ?? 0) + 0.5) })} />
                  </label>
                  <label>
                    Hlasitost <b>{Math.round((zvuk.hlasitost ?? 1) * 100)} %</b>
                    <input type="range" min={0} max={1.5} step={0.05} value={zvuk.hlasitost ?? 1}
                      onChange={e => zapisZvuk({ hlasitost: Number(e.target.value) })} />
                  </label>
                  <p className="desc">
                    Vybraný úsek je {cas(Math.max(0, (zvuk.do ?? delka) - (zvuk.od ?? 0)))}, video {cas(delka)}.
                    {(zvuk.do ?? delka) - (zvuk.od ?? 0) < delka - 0.2
                      ? ' Zbytek videa doběhne v tichu.'
                      : ' Přesah se ustřihne a na konci zvuk doznívá.'}
                  </p>
                </>
              )}
            </div>
          )}
        </div>
      </section>

      {/* ---------- 4 VYKRESLENÍ ---------- */}
      <section className="qv-krok">
        <header>
          <span className="qv-cislo">4</span>
          <div>
            <h3>Vykreslení a publikace</h3>
            <p className="desc">
              Pro každý vybraný trh vznikne vlastní soubor s jeho titulky a přiloží
              se k příspěvku. Publikace se pak spouští v příspěvku jako u fotek.
            </p>
          </div>
        </header>

        <div className="qv-trhy">
          {trhy.map(t => {
            const zaskrtnuto = proTrhy.includes(t.lang);
            const hotovo = p.hotovo?.[t.lang];
            const kolikTextu = p.titulky.filter(x => textTitulku(x, t.lang, '').trim()).length;
            return (
              <label key={t.lang} className={`qv-trh ${zaskrtnuto ? 'on' : ''}`}>
                <input type="checkbox" checked={zaskrtnuto}
                  onChange={e => setProTrhy(e.target.checked
                    ? [...proTrhy, t.lang]
                    : proTrhy.filter(x => x !== t.lang))} />
                <b>{t.lang}</b>
                <span className="desc">
                  {kolikTextu === 0 && p.titulky.length > 0
                    ? `bez překladu — vypálí se ${p.zdroj}`
                    : `${kolikTextu} z ${p.titulky.length} titulků`}
                </span>
                {prubeh[t.lang] != null && prubeh[t.lang] < 100 && (
                  <div className="qv-pruh"><i style={{ width: `${prubeh[t.lang]}%` }} /></div>
                )}
                {hotovo && (
                  <div className="qv-hotovo-radek">
                    <em className="qv-hotovo">hotovo {cas(hotovo.delka)}</em>
                    {/* Klepnutí na uložení nesmí přehodit zaškrtnutí trhu */}
                    <button className="btn ghost" title="Uložit video do počítače"
                      onClick={e => { e.preventDefault(); e.stopPropagation(); void ulozNaDisk(t.lang); }}>
                      Uložit
                    </button>
                    <button className="icon-btn" title="Ukázat ve složce"
                      onClick={e => {
                        e.preventDefault(); e.stopPropagation();
                        if (postId) api.ig.videoReveal(postId, t.lang);
                      }}>
                      <Icon name="folder" size={13} />
                    </button>
                  </div>
                )}
              </label>
            );
          })}
        </div>

        <label className="qv-mrizka">
          <input type="checkbox" checked={p.doMrizky !== false}
            onChange={e => {
              const on = e.target.checked;
              setP({ ...p, doMrizky: on });
              if (postId) api.ig.videoFeed(postId, on).then(setP).catch((err: any) => toast(err.message, 'error'));
            }} />
          <span>
            <b>Objevit se i v mřížce profilu</b>
            {/* Jedno video Instagram publikuje vždycky jako reel — v mřížce se
                ukáže, jen když se to řekne. Tvářit se, že jde vybrat mezi
                „příspěvkem" a „reelem", by bylo zavádějící. */}
            <em>Video se publikuje jako reel. Bez zaškrtnutí zůstane jen v reelech, ne v mřížce.</em>
          </span>
        </label>

        {chyby.length > 0 && (
          <div className="warn-box">
            <b>Než se dá vykreslit:</b>
            {chyby.slice(0, 4).map((ch, i) => <span key={i}>{ch}</span>)}
          </div>
        )}

        <div className="qv-konec">
          <button className="btn primary" disabled={!!pracuje || !ffmpeg?.ok || chyby.length > 0} onClick={vykreslit}>
            {pracuje || 'Vykreslit videa'}
          </button>
          {pracuje && <button className="btn ghost" onClick={() => api.ig.videoStop()}>Zastavit</button>}
          {/*
            * Uložení do počítače je rovnocenná cesta ven, ne drobnost
            * schovaná u jednoho trhu: hotová videa se často jen stahují
            * a publikují se jindy nebo jinde.
            */}
          {hotovoKolik > 0 && (
            <button className="btn ghost" onClick={ulozVse}>
              <Icon name="download" size={14} /> Uložit {hotovoKolik === 1 ? 'video' : 'videa'} do počítače
            </button>
          )}
          {hotovoKolik > 0 && (
            <button className="btn ghost" onClick={onBack}>
              Zpět na příspěvek — {hotovoKolik} {hotovoKolik === 1 ? 'video je' : 'videa jsou'} přiložená
            </button>
          )}
        </div>
      </section>
        </div>
      </div>
    </div>
  );
}

function souborNazev(cesta: string): string {
  return (cesta || '').split(/[\\/]/).pop() || 'video';
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function jazykNazev(trhy: { lang: string; label?: string }[], lang: string): string {
  return trhy.find(t => t.lang === lang)?.label || lang;
}
