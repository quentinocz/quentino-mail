import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { IgOverview } from '@shared/types';
import type {
  VidProjekt, VidKlip, VidTitulek, VidZnelka, VidPrechod, VidStyl, VidPozice, VidPomer, VidZvuk
} from '@shared/videoedit';
import {
  osa, delkaVidea, klipyTrhu, zvukTrhu, textTitulku, potize, cas, vyrez, vyrezStyl, rozdel,
  PRECHODY, STYLY, POZICE, POMERY, MIN_KLIP
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
    const k = klipy[i];
    const el = video.current;
    if (!el) return;
    if (nactenyKlip !== k.id) {
      el.src = await adresa(k.soubor);
      setNactenyKlip(k.id);
      await new Promise<void>(hotovo => {
        const ok = () => { el.removeEventListener('loadedmetadata', ok); hotovo(); };
        el.addEventListener('loadedmetadata', ok);
      });
    }
    el.currentTime = k.od + (cíl - rozvrzeni.místa[i].start);
    if (pustit) { try { await el.play(); } catch { /* prohlížeč občas odmítne */ } }
  }, [delka, klipV, klipy, nactenyKlip, adresa, rozvrzeni]);

  /*
   * Hodiny přehrávání.
   *
   * Čas se nebere z `<video>` přímo: element zná jen svůj soubor, kdežto
   * časová osa je slepená z několika. Přepočítává se proto na čas
   * výsledku a na konci výstřižku se sáhne po dalším záběru — bez toho
   * by přehrávání pokračovalo i do části, která je z videa vystřižená.
   */
  useEffect(() => {
    if (!hraje) return;
    let zive = true;
    const tik = () => {
      if (!zive) return;
      const el = video.current;
      const i = klipV(kdeRef.current);
      if (el && i >= 0) {
        const k = klipy[i];
        const uvnitr = el.currentTime - k.od;
        const t = rozvrzeni.místa[i].start + uvnitr;
        if (el.currentTime >= k.do - 0.02 || uvnitr < -0.5) {
          if (i + 1 < klipy.length) {
            void skoc(rozvrzeni.místa[i + 1].start, true);
          } else {
            setHraje(false);
            el.pause();
            setKde(delka);
            return;
          }
        } else {
          setKde(Math.min(delka, t));
        }
      }
      requestAnimationFrame(tik);
    };
    requestAnimationFrame(tik);
    return () => { zive = false; };
  }, [hraje, klipy, rozvrzeni, delka, klipV, skoc]);

  const kdeRef = useRef(0);
  useEffect(() => { kdeRef.current = kde; }, [kde]);

  /*
   * Hned po otevření se navede první záběr.
   *
   * Bez toho zůstal náhled černý, dokud se na něj nekleplo — a protože
   * je to jediné místo, kde je vidět, jak titulky vypadají, vypadalo to
   * jako by se střih vůbec nenačetl. Navede se i při výměně záběrů, aby
   * po smazání prvního nezůstal v okně snímek z neexistujícího souboru.
   */
  useEffect(() => {
    if (klipy.length === 0 || hraje) return;
    const porad = klipy.some(k => k.id === nactenyKlip);
    if (!porad) void skoc(0);
  }, [klipy, nactenyKlip, hraje, skoc]);

  const prehraj = useCallback(async () => {
    if (hraje) {
      video.current?.pause();
      setHraje(false);
      return;
    }
    if (kde >= delka - 0.05) await skoc(0);
    setHraje(true);
    try { await video.current?.play(); } catch { /* prohlížeč občas odmítne */ }
  }, [hraje, kde, delka, skoc]);

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
    for (const t of p.titulky) {
      if (kde < t.od - 0.001 || kde > t.do) continue;
      const text = textTitulku(t, lang, p.zdroj);
      if (!text) continue;
      nakresliTitulek(ctx, sirka, vyska, { text, styl: t.styl, pozice: t.pozice });
    }
  }, [kde, p, lang]);

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

  const prelozit = useCallback(async () => {
    if (!p || !postId) return;
    setPracuje('Překládám titulky…');
    try {
      const novy = await api.ig.videoTranslate(postId, trhy.map(t => t.lang));
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
            return { id: t.id, png: titulekPng(rozmer.sirka, rozmer.vyska, { text, styl: t.styl, pozice: t.pozice }) };
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
      <div className="qv-telo">
        <div className="qv-rail">
        <div className="qv-prehravac">
          <div className={`qv-obal pomer-${p.pomer.replace(':', '-')}`} ref={obal}
            onClick={() => void prehraj()}>
            {/* Výřez se promítá i do náhledu — jinak by se ořez ladil naslepo */}
            <video ref={video} playsInline muted={zvuk.druh !== 'original'}
              style={nactenyKlip ? vyrezStyl(klipy.find(k => k.id === nactenyKlip) ?? klipy[0] ?? { id: '', soubor: '', zdrojDelka: 0, od: 0, do: 0, prechod: 'zadny', prechodDelka: 0 }) : undefined} />
            <canvas ref={platno} className="qv-titulky" />
            {!hraje && (
              <div className="qv-play"><Icon name="play" size={26} /></div>
            )}
          </div>
          <div className="qv-ovladani">
            <button className="icon-btn" onClick={() => void prehraj()} title={hraje ? 'Pauza' : 'Přehrát'}>
              <Icon name={hraje ? 'pause' : 'play'} size={16} />
            </button>
            <span className="qv-cas">{cas(kde)} / {cas(delka)}</span>
            <div className="qv-pomery">
              {(Object.keys(POMERY) as VidPomer[]).map(pom => (
                <button key={pom} className={p.pomer === pom ? 'on' : ''} title={POMERY[pom].popis}
                  onClick={() => uloz({ ...p, pomer: pom })}>{POMERY[pom].nazev}</button>
              ))}
            </div>
          </div>
          <p className="desc qv-poznamka">
            Titulky vidíš tak, jak se vypálí — kreslí je tentýž kód. Přechody mezi
            záběry se v náhledu nepřehrávají, ve videu tam budou.
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
                  void skoc(rozvrzeni.místa[i].start);
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
                Z celých {cas(vybranyKlip.zdrojDelka)} zůstane <b>{cas(vybranyKlip.do - vybranyKlip.od)}</b>
              </span>
              {/* Nastavit podle přehrávače je rychlejší než hádat sekundy */}
              <button className="btn ghost" onClick={() => {
                const el = video.current;
                if (el) upravKlip(vybranyKlip.id, { od: Math.min(el.currentTime, vybranyKlip.do - MIN_KLIP) });
              }}>Začátek tady</button>
              <button className="btn ghost" onClick={() => {
                const el = video.current;
                if (el) upravKlip(vybranyKlip.id, { do: Math.max(el.currentTime, vybranyKlip.od + MIN_KLIP) });
              }}>Konec tady</button>
              {/*
                * Rozdělení v místě přehrávače. Z jednoho dlouhého záběru
                * se tím dá udělat několik kratších, mezi které jde dát
                * přechod — a hlavně vyhodit to, co je uprostřed.
                */}
              <button className="btn ghost" onClick={() => {
                const el = video.current;
                if (!el || nactenyKlip !== vybranyKlip.id) {
                  toast('Nejdřív pusť přehrávač na místo, kde se má záběr rozdělit.', 'error');
                  return;
                }
                const i = klipy.indexOf(vybranyKlip);
                const novy = rozdel(klipy, i, el.currentTime, () => crypto.randomUUID());
                if (novy.length === klipy.length) {
                  toast('Tady se rozdělit nedá — bylo by to moc blízko kraje.', 'error');
                  return;
                }
                zapisKlipy(novy);
              }}>Rozdělit tady</button>
            </div>

            {/*
              * Jeden pás se dvěma úchyty, ne dva nezávislé posuvníky.
              * Dva posuvníky nad týmž zdrojem nešlo přečíst: nebylo z nich
              * poznat, který kus videa vlastně zůstane, a dal se nastavit
              * konec před začátkem. Tady je vidět zdroj celý a v něm
              * zvýrazněný výstřižek.
              */}
            <div className="qv-vystrizek" ref={strihRef}
              onPointerMove={behemStrihu} onPointerUp={konecStrihu} onPointerLeave={konecStrihu}>
              {(zdrojSnimky[vybranyKlip.id] ?? []).length > 0 && (
                <div className="qv-snimky qv-snimky-zdroj" aria-hidden="true">
                  {zdrojSnimky[vybranyKlip.id].map((src, j) => <img key={j} src={src} alt="" />)}
                </div>
              )}
              <div className="qv-vystrizek-vybrano"
                style={{
                  left: `${(vybranyKlip.od / Math.max(0.1, vybranyKlip.zdrojDelka)) * 100}%`,
                  width: `${((vybranyKlip.do - vybranyKlip.od) / Math.max(0.1, vybranyKlip.zdrojDelka)) * 100}%`
                }} />
              <button className="qv-vystrizek-uchop" title="Začátek záběru"
                style={{ left: `${(vybranyKlip.od / Math.max(0.1, vybranyKlip.zdrojDelka)) * 100}%` }}
                onPointerDown={e => zacniStrih(e, 'od')} />
              <button className="qv-vystrizek-uchop" title="Konec záběru"
                style={{ left: `${(vybranyKlip.do / Math.max(0.1, vybranyKlip.zdrojDelka)) * 100}%` }}
                onPointerDown={e => zacniStrih(e, 'do')} />
            </div>
            <div className="qv-vystrizek-popis">
              <span>{cas(vybranyKlip.od)}</span>
              <span>{cas(vybranyKlip.zdrojDelka)}</span>
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
              Časy jsou pro všechny trhy stejné, text jiný. Nastav je jednou v{' '}
              {jazykNazev(trhy, p.zdroj)} a zbytek nech přeložit.
            </p>
          </div>
          <div className="qv-akce">
            <button className="btn ghost" disabled={!!pracuje || p.titulky.length === 0} onClick={prelozit}>
              Přeložit do ostatních trhů
            </button>
          </div>
        </header>

        <div className="qv-osa-box">
          <div className="qv-osa-hlava">
            <b>Časová osa</b>
            <span className="desc">Klikni do osy a přidej titulek přesně tam.</span>
            <button className="btn ghost" onClick={() => pridejTitulek()} disabled={klipy.length === 0}>
              <Icon name="plus" size={14} /> Titulek
            </button>
          </div>
          <div className="qv-osa" ref={osaRef}
            onPointerMove={behemTahu}
            onPointerUp={konecTahu}
            onClick={e => {
              const box = osaRef.current;
              if (!box) return;
              const r = box.getBoundingClientRect();
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
                  <span>{i + 1}</span>
                  {rozvrzeni.místa[i].prechod > 0 && (
                    <em className="qv-prolnuti" style={{ width: naSekundu(rozvrzeni.místa[i].prechod) }} />
                  )}
                </div>
              ))}
            </div>
            <div className="qv-vrstva qv-vrstva-titulky">
              {p.titulky.map(t => (
                <div key={t.id}
                  className={`qv-tit ${t.pozice}`}
                  style={{ left: naSekundu(t.od), width: naSekundu(Math.max(0.3, t.do - t.od)) }}
                  onPointerDown={e => zacniTah(e, t, 'celý')}
                  onClick={e => e.stopPropagation()}
                  title={`${textTitulku(t, lang, p.zdroj) || 'bez textu'} · ${cas(t.od)}–${cas(t.do)}`}>
                  <i className="qv-uchop od" onPointerDown={e => zacniTah(e, t, 'od')} />
                  <span>{textTitulku(t, lang, p.zdroj) || '—'}</span>
                  <i className="qv-uchop do" onPointerDown={e => zacniTah(e, t, 'do')} />
                </div>
              ))}
            </div>
            <div className="qv-hlava" style={{ left: naSekundu(kde) }} />
          </div>
        </div>

        <div className="qv-jazyky">
          {trhy.map(t => {
            const kolik = p.titulky.filter(x => textTitulku(x, t.lang, '').trim()).length;
            return (
              <button key={t.lang} className={`tab ${lang === t.lang ? 'active' : ''}`}
                onClick={() => setLang(t.lang)}>
                {t.lang}
                {t.lang === p.zdroj ? <em> zdroj</em> : <em> {kolik}/{p.titulky.length}</em>}
              </button>
            );
          })}
        </div>

        {p.titulky.length === 0 && (
          <p className="desc">
            Žádný titulek. Přidej ho tlačítkem u časové osy — objeví se v místě, kde
            stojí přehrávač.
          </p>
        )}

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
                  <button className="icon-btn danger" title="Smazat titulek" onClick={() => smazTitulek(t.id)}>
                    <Icon name="trash" size={13} />
                  </button>
                </div>
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
