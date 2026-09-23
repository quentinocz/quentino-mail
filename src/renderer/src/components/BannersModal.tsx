import { useCallback, useEffect, useState } from 'react';
import type {
  Banner, BannerClash, BannerLink, BannerLinks, BannerSet, BannerSharedLook,
  BannersState, WebText
} from '@shared/types';
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

/*
 * Je v tom aspoň jedno emoji? Na web se totiž nic jiného nedostane —
 * rozhoduje o tom `onlyEmoji` v hlavním procesu. Tady se to jen říká
 * nahlas, aby se písmeno nevytratilo tiše: v pruhu odkazů takhle na
 * e-shopu skončilo „N B S B" místo ikonek.
 */
const jeEmoji = (value: string) => /\p{Extended_Pictographic}/u.test(value || '');
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

/**
 * Písma.
 *
 * „Jako e-shop" je první a výchozí schválně: nenastavuje `font-family`,
 * takže banner zdědí písmo stránky (Rajdhani) a nestáhne se nic navíc.
 * Každé další písmo je soubor ke stažení na úvodní stránce — a ta se
 * načítá nejčastěji ze všech.
 */
const FONTS: { id: Banner['look']['font']; label: string; hint: string }[] = [
  { id: 'shop', label: 'Jako e-shop', hint: 'Zdědí Rajdhani ze stránky, nic se nestahuje' },
  { id: 'inter', label: 'Inter', hint: 'Neutrální, výborně čitelný i drobně' },
  { id: 'jost', label: 'Jost', hint: 'Geometrický, blízko Futuře' },
  { id: 'playfair', label: 'Playfair Display', hint: 'Patkový, na slavnostní sdělení' },
  { id: 'bebas', label: 'Bebas Neue', hint: 'Úzké verzálky, na krátká hesla' }
];

const WEIGHTS: { id: number; label: string }[] = [
  { id: 300, label: 'Lehké' },
  { id: 400, label: 'Normální' },
  { id: 600, label: 'Polotučné' },
  { id: 700, label: 'Tučné' },
  { id: 800, label: 'Velmi tučné' }
];

const BUTTONS: { id: Banner['look']['button']; label: string; hint: string }[] = [
  { id: 'shop', label: 'Jako na e-shopu', hint: 'Černé hranaté tlačítko ze šablony' },
  { id: 'fill', label: 'Plné', hint: 'Barvou písma — nejvíc vidět na tmavé fotce' },
  { id: 'outline', label: 'Obrys', hint: 'Jen rámeček, při najetí se vybarví' },
  { id: 'soft', label: 'Prosklené', hint: 'Průsvitné s rozostřením pozadí' },
  { id: 'link', label: 'Podtržený odkaz', hint: 'Když má mluvit fotka, ne tlačítko' }
];

/**
 * Tvary dlaždice.
 *
 * „Podle rozvržení" je výchozí a drží dnešní chování: na počítači čtyři
 * sloupce na výšku, na telefonu čtverec. Čtverec je ale těsný — na dva
 * řádky nadpisu, popisek a tlačítko v něm nezbývá místo.
 */
const RATIOS: { id: BannerSet['ratio']; label: string }[] = [
  { id: 'auto', label: 'Podle rozvržení' },
  { id: '2:3', label: 'Hodně na výšku 2:3' },
  { id: '3:4', label: 'Na výšku 3:4' },
  { id: '4:5', label: 'Mírně na výšku 4:5' },
  { id: '1:1', label: 'Čtverec 1:1' },
  { id: '4:3', label: 'Na šířku 4:3' },
  { id: '16:9', label: 'Široký 16:9' },
  { id: '2:1', label: 'Pruh 2:1' },
  { id: '3:1', label: 'Pruh 3:1' }
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

/** Výchozí podrobnosti efektu. Na jednom místě, ať se předlohy neliší. */
const blankSmart = (): Banner['smart'] => ({
  kind: 'none', until: '', untilMs: 0, code: '', emoji: '', effect: 'none',
  fxCount: 14, fxSize: 15, fxSpeed: 8
});

function blankBanner(): Banner {
  return {
    id: '',
    name: '',
    off: false,
    copy: {
      kicker: emptyText(), title: emptyText(), text: emptyText(),
      button: emptyText(), href: emptyText()
    },
    /*
     * Výchozí vzhled je opsaný z e-shopu (quentino.cz, změřeno 22. 9. 2026):
     * černá jako primární barva, hranaté rohy, nadpis ve váze 400 a text
     * i tlačítko po webu. Tučný nadpis v zakulacené dlaždici by vedle
     * zbytku stránky byl cizí prvek.
     */
    look: {
      image: '', bg: '#000000', fg: '#ffffff', overlay: 40,
      align: 'center', pos: 'middle', focus: '50% 50%',
      font: 'shop', titleWeight: 400, titleSize: 100, caps: false,
      textWeight: 400, button: 'shop', radius: 0
    },
    smart: { ...blankSmart(), kind: 'none', effect: 'none' },
    // Skoro vždycky se banner řídí sadou; výjimka je vědomé zaškrtnutí
    ownLook: false
  };
}

/** Společný vzhled nové sady — tytéž hodnoty, co má prázdný banner. */
const blankShared = (): BannerSharedLook => {
  const { image, bg, focus, ...shared } = blankBanner().look;
  void image; void bg; void focus;
  return shared;
};

/**
 * Předlohy.
 *
 * Nejsou to ozdoby: rozdíl mezi „prázdný banner" a „banner s odpočtem"
 * je pět políček na čtyřech různých místech a kdo si na ně nevzpomene,
 * udělá obyčejnou dlaždici. Předloha je nastaví a zbyde napsat text.
 */
const PRESETS: { id: string; label: string; emoji: string; make: () => Banner }[] = [
  {
    id: 'dlazdice', label: 'Dlaždice kategorie', emoji: '🖼️',
    make: () => {
      const one = blankBanner();
      one.name = 'Dlaždice kategorie';
      /*
       * Dolů a doleva, na rozdíl od zbytku. Čtyři úzké dlaždice vedle sebe
       * se čtou jako sloupec pod sebou a text zarovnaný ke stejné svislici
       * je v nich klidnější než čtyři osy na střed.
       */
      one.look = { ...one.look, align: 'left', pos: 'bottom' };
      return one;
    }
  },
  {
    id: 'odpocet', label: 'Akce s odpočtem', emoji: '⏳',
    make: () => {
      const one = blankBanner();
      one.name = 'Akce s odpočtem';
      one.copy.kicker.cz = 'Končí brzy';
      one.smart = { ...blankSmart(), kind: 'countdown', until: localNow(3 * 24 * 60), effect: 'shine' };
      one.look = { ...one.look, overlay: 48, titleWeight: 700, caps: true };
      return one;
    }
  },
  {
    id: 'kod', label: 'Sleva s kódem', emoji: '🏷️',
    make: () => {
      const one = blankBanner();
      one.name = 'Sleva s kódem';
      one.copy.kicker.cz = 'Slevový kód';
      one.smart = { ...blankSmart(), kind: 'code', code: 'SLEVA10', effect: 'shine' };
      one.look = { ...one.look, bg: '#111111', overlay: 46, titleWeight: 700, button: 'outline' };
      return one;
    }
  },
  {
    id: 'vanoce', label: 'Doručení do Vánoc', emoji: '🎄',
    make: () => {
      const one = blankBanner();
      one.name = 'Doručení do Vánoc';
      const year = new Date().getFullYear();
      one.copy.kicker.cz = 'Garance';
      one.copy.title.cz = 'Stihneme to pod stromeček';
      one.smart = {
        ...blankSmart(), kind: 'delivery', until: `${year}-12-18T12:00`,
        emoji: '❄️', effect: 'snow', fxCount: 12, fxSize: 14, fxSpeed: 9
      };
      one.look = { ...one.look, bg: '#0b1a24', overlay: 44, button: 'soft' };
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
    look: blankShared(), ratio: 'auto', phoneRatio: 'auto',
    banners: [{ ...blankBanner(), id: newId() }],
    links: { on: false, shape: 'circle', items: [] }
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
  /*
   * Editace má dvě úrovně: co se edituje (sada / bannery / odkazy) a u
   * banneru ještě čím se zabývám (text / vzhled / efekty). Jeden dlouhý
   * sloupec se vším dohromady znamenal rolovat přes nastavení sady pokaždé,
   * když se šlo přepsat nadpis.
   */
  const [section, setSection] = useState<'sada' | 'bannery' | 'odkazy'>('bannery');
  const [part, setPart] = useState<'text' | 'vzhled' | 'efekty'>('text');
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

  /** Společný vzhled sady — to, co se nastavuje pro všechny bannery naráz. */
  const shared = (): BannerSharedLook => draft?.look ?? blankShared();
  const setShared = (patch: Partial<BannerSharedLook>) => setSet({ look: { ...shared(), ...patch } });

  /*
   * Co se zrovna edituje: u banneru s vlastním vzhledem jeho hodnoty,
   * jinak hodnoty sady. Jedna dvojice funkcí místo dvou sad políček —
   * kdyby se formulář zdvojil, rozešly by se dřív nebo později.
   */
  const vlastni = !!banner?.ownLook;
  const vzhled = (): BannerSharedLook => (vlastni && banner ? banner.look : shared());
  const setVzhled = (patch: Partial<BannerSharedLook>) =>
    (vlastni ? setLook(patch) : setShared(patch));

  /** Zapnutí výjimky: banner si odnese to, co mu dosud dávala sada. */
  const setOwnLook = (on: boolean) => setBanner(banner
    ? { ownLook: on, look: on ? { ...banner.look, ...shared() } : banner.look }
    : {});

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
      toast('Aplikace nezná adresu administrace e-shopu — doplň ji v Nastavení → AI → Upgates.',
        'error');
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
      toast(`Fotka je na e-shopu · ${Math.round(done.bytes.length / 1024)} kB (o ${saved} % míň)`);
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

  /* ---------- odkazy na kategorie pod bannerem ---------- */

  const linksOf = (): BannerLinks => draft?.links ?? { on: false, shape: 'circle', items: [] };
  const setLinks = (patch: Partial<BannerLinks>) => setSet({ links: { ...linksOf(), ...patch } });
  const setLink = (i: number, patch: Partial<BannerLink>) => setLinks({
    items: linksOf().items.map((one, at) => (at === i ? { ...one, ...patch } : one))
  });
  const addLink = () => setLinks({
    on: true,
    items: [...linksOf().items,
      { id: newId(), image: '', emoji: '', text: emptyText(), href: emptyText() }]
  });
  const dropLink = (i: number) => setLinks({ items: linksOf().items.filter((_, at) => at !== i) });
  const moveLink = (i: number, by: number) => {
    const items = [...linksOf().items];
    const to = i + by;
    if (to < 0 || to >= items.length) return;
    [items[i], items[to]] = [items[to], items[i]];
    setLinks({ items });
  };

  /** Dohledání odkazu do ostatních trhů pro jednu položku pruhu. */
  const resolveLink = async (i: number) => {
    const cz = linksOf().items[i]?.href.cz;
    if (!cz) return;
    try {
      const found = await api.banners.href(cz);
      setLink(i, { href: { cz, sk: found.sk, en: found.en } });
      if (!found.sk && !found.en) {
        toast('Protějšek se na e-shopu nenašel — doplň adresu ručně.', 'error');
      }
    } catch (e: any) {
      toast(String(e?.message ?? e), 'error');
    }
  };

  /** Ikonka odkazu. Jde stejnou cestou jako fotka banneru — do e-shopu. */
  const uploadLinkImage = async (i: number, file: File) => {
    if (!state?.uploadReady) {
      toast('Aplikace nezná adresu administrace e-shopu — doplň ji v Nastavení → AI → Upgates.',
        'error');
      return;
    }
    setBusy('Převádím a nahrávám');
    try {
      const raw = new Uint8Array(await file.arrayBuffer());
      // Ikonka je malá; víc než 400 px z ní nikdo neuvidí
      const done = await toWebp(raw, {
        quality: 82, resize: 'max', maxWidth: 400, maxHeight: 400,
        exactWidth: 0, exactHeight: 0, percent: 100, keepSmaller: true
      });
      setLink(i, { image: await api.banners.upload(file.name, Array.from(done.bytes)) });
      toast('Ikonka je na e-shopu.');
    } catch (e: any) {
      toast(String(e?.message ?? e), 'error');
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal bn-modal">
        <div className="modal-head">
          <span className="modal-title"><Icon name="banner" size={15} /> Bannery</span>
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
                  {/*
                    * Tři oddíly místo jednoho dlouhého sloupce. Dřív se
                    * muselo rolovat přes celé nastavení sady, aby se došlo
                    * k textu banneru — a při psaní se pak nebylo čeho chytit.
                    * Takhle má každý oddíl tolik, kolik se vejde bez rolování.
                    */}
                  <div className="tabs bn-sections">
                    <button className={`tab ${section === 'sada' ? 'active' : ''}`}
                      onClick={() => setSection('sada')}>Sada</button>
                    <button className={`tab ${section === 'bannery' ? 'active' : ''}`}
                      onClick={() => setSection('bannery')}>
                      Bannery <em>{draft.banners.length}</em>
                    </button>
                    <button className={`tab ${section === 'odkazy' ? 'active' : ''}`}
                      onClick={() => setSection('odkazy')}>
                      Odkazy pod bannerem <em>{linksOf().items.length}</em>
                    </button>
                  </div>

                  {section === 'sada' && (
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
                        Časy jsou pražské. Sada se na webu objeví i zmizí sama — aplikace u toho
                        být nemusí. Při překryvu vyhraje ta, která začala později.
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

                      <h4 className="bn-h">Rozvržení</h4>
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
                        <div className="field">
                          <label>Tvar dlaždice</label>
                          <select value={draft.ratio}
                            onChange={e => setSet({ ratio: e.target.value as BannerSet['ratio'] })}>
                            {RATIOS.map(one => <option key={one.id} value={one.id}>{one.label}</option>)}
                          </select>
                        </div>
                        <div className="field">
                          <label>Tvar na telefonu</label>
                          <select value={draft.phoneRatio}
                            onChange={e => setSet({ phoneRatio: e.target.value as BannerSet['ratio'] })}>
                            {RATIOS.map(one => (
                              <option key={one.id} value={one.id}>
                                {one.id === 'auto' ? 'Jako na počítači' : one.label}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>
                      <p className="desc">
                        Tvar platí pro celou sadu — různě vysoké dlaždice vedle sebe v jednom
                        řádku vypadají jako chyba sazby. Na telefonu se bez vlastní volby použije
                        ten z počítače; „podle rozvržení" nechá čtverec u mřížky a širokou plochu
                        u banneru přes celou šířku. <b>Ve čtverci je na dva řádky nadpisu,
                        popisek a tlačítko málo místa</b> — když se texty tísní, sáhni po 3:4.
                      </p>
                      <p className="desc">
                        {pages > 1
                          ? `${draft.banners.length} bannerů = ${pages} otočky po ${perPage}. `
                            + (draft.rotate > 0
                              ? 'Přetáčí se prolnutím, takže se stránka pod bannerem nehne.'
                              : 'Bez přetáčení bude vidět jen první otočka — nastav vteřiny.')
                          : 'Všechno se vejde na jednu obrazovku, přetáčet není co.'}
                      </p>
                    </>
                  )}

                  {section === 'bannery' && (
                    <>
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
                          Vypnout
                        </label>
                        <span className="wt-spacer" />
                        <button className="btn ghost danger" onClick={dropBanner}
                          disabled={draft.banners.length <= 1}>
                          <Icon name="trash" size={13} /> Smazat
                        </button>
                      </div>

                      <div className="tabs bn-parts">
                        <button className={`tab ${part === 'text' ? 'active' : ''}`}
                          onClick={() => setPart('text')}>Text a odkaz</button>
                        <button className={`tab ${part === 'vzhled' ? 'active' : ''}`}
                          onClick={() => setPart('vzhled')}>Vzhled</button>
                        <button className={`tab ${part === 'efekty' ? 'active' : ''}`}
                          onClick={() => setPart('efekty')}>Chytré a efekty</button>
                      </div>

                      {part === 'text' && (
                        <>
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
                            <label>Řádek nad nadpisem <small>(drobně a verzálkami, nepovinné)</small></label>
                            <input value={banner.copy.kicker[lang]} maxLength={28}
                              placeholder={lang === 'cz' ? 'Novinka, Jen do neděle…' : banner.copy.kicker.cz}
                              onChange={e => setCopy('kicker', e.target.value)} />
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
                              placeholder={lang === 'cz' ? 'Ručně šité, **skladem**' : banner.copy.text.cz}
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
                              <label>Odkaz {lang !== 'cz' && <small>(dohledaný z české verze)</small>}</label>
                              <input value={banner.copy.href[lang]} placeholder="/kravatove-sety"
                                onChange={e => setCopy('href', e.target.value)}
                                onBlur={() => { if (lang === 'cz') void resolveHref(); }} />
                            </div>
                          </div>
                          {lang === 'cz' && (
                            <p className="desc">
                              Stačí cesta od lomítka. Slovenskou a anglickou adresu si aplikace
                              <b> přečte z přepínače jazyků</b> na té stránce — trhy mají vlastní
                              slugy, takže složit je výměnou domény by vedlo na 404.
                              {hrefHint && <> — {hrefHint}</>}
                            </p>
                          )}
                          <p className="desc">
                            Prázdné tlačítko nevadí: odkaz má celá dlaždice, takže se dá kliknout
                            kamkoli. Slovo mezi dvěma hvězdičkami — <code>**takhle**</code> — bude
                            tučně, stejně jako v naplánovaných textech.
                          </p>
                        </>
                      )}

                      {part === 'vzhled' && (
                        <>
                          {/*
                            * Výjimka, ne pravidlo. Písmo, tlačítko a zaoblení
                            * jsou vlastnosti celé řady dlaždic — čtyři vedle
                            * sebe, každá s jiným zaoblením, vypadají jako čtyři
                            * cizí bannery slepené k sobě.
                            */}
                          <div className={`bn-scope ${vlastni ? 'own' : ''}`}>
                            <label className="check-row">
                              <input type="checkbox" checked={vlastni}
                                onChange={e => setOwnLook(e.target.checked)} />
                              Tenhle banner má vlastní vzhled
                            </label>
                            <span className="desc">
                              {vlastni
                                ? 'Změny níž platí jen pro tuhle dlaždici. Odškrtnutím se vrátí k sadě.'
                                : 'Písmo, tlačítko, zaoblení i zarovnání se berou ze sady — '
                                  + 'nastavují se jednou pro všechny bannery.'}
                            </span>
                          </div>

                          <div className="bn-type">
                            <div className="field">
                              <label>Písmo</label>
                              <select value={vzhled().font}
                                onChange={e => setVzhled({ font: e.target.value as Banner['look']['font'] })}>
                                {FONTS.map(one => <option key={one.id} value={one.id}>{one.label}</option>)}
                              </select>
                            </div>
                            <div className="field">
                              <label>Nadpis</label>
                              <select value={vzhled().titleWeight}
                                onChange={e => setVzhled({ titleWeight: Number(e.target.value) })}>
                                {WEIGHTS.map(one => <option key={one.id} value={one.id}>{one.label}</option>)}
                              </select>
                            </div>
                            <div className="field">
                              <label>Text</label>
                              <select value={vzhled().textWeight}
                                onChange={e => setVzhled({ textWeight: Number(e.target.value) })}>
                                {WEIGHTS.slice(0, 3).map(one =>
                                  <option key={one.id} value={one.id}>{one.label}</option>)}
                              </select>
                            </div>
                            <div className="field">
                              <label>Tlačítko</label>
                              <select value={vzhled().button}
                                onChange={e => setVzhled({ button: e.target.value as Banner['look']['button'] })}>
                                {BUTTONS.map(one => <option key={one.id} value={one.id}>{one.label}</option>)}
                              </select>
                            </div>
                          </div>
                          <p className="desc">
                            {FONTS.find(one => one.id === vzhled().font)?.hint}
                            {' · '}
                            {BUTTONS.find(one => one.id === vzhled().button)?.hint}
                            {vzhled().font === 'shop'
                              && (vzhled().titleWeight === 600 || vzhled().titleWeight === 800)
                              ? ' — pozor: e-shop má z Rajdhani jen lehké, normální a tučné, '
                                + 'ostatní tloušťky si prohlížeč dopočítá.'
                              : ''}
                          </p>

                          <div className="bn-type">
                            <div className="field bn-slider">
                              <label>Velikost nadpisu {vzhled().titleSize} %</label>
                              <input type="range" min={70} max={150} step={5} value={vzhled().titleSize}
                                onChange={e => setVzhled({ titleSize: Number(e.target.value) })} />
                            </div>
                            <div className="field bn-slider">
                              <label>Zaoblení rohů {vzhled().radius} px</label>
                              <input type="range" min={0} max={28} value={vzhled().radius}
                                onChange={e => setVzhled({ radius: Number(e.target.value) })} />
                            </div>
                            <label className="check-row">
                              <input type="checkbox" checked={vzhled().caps}
                                onChange={e => setVzhled({ caps: e.target.checked })} />
                              Nadpis verzálkami
                            </label>
                          </div>
                          <p className="desc">
                            E-shop má rohy hranaté (0 px) a tlačítka černá — nastavené nuly jsou po
                            něm. Zaoblení platí pro dlaždici i pro tlačítko naráz, aby si neodporovaly.
                          </p>

                          <h4 className="bn-h">Fotka a barva pozadí <small>(vždy jen této dlaždice)</small></h4>
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
                                Převede se na WebP a nahraje se <b>do správce souborů e-shopu</b> —
                                použije se adresa z jeho CDN, stejná jako u ostatních fotek na webu.
                                Otevře se k tomu okno administrace. Fotka z foťáku je v pohodě,
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
                                Dlaždice má pevný poměr stran, aby stránka nepodskakovala — fotka se
                                proto ořízne. Tady se vybere, co zůstane vidět.
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
                              <input type="color" value={vzhled().fg}
                                onChange={e => setVzhled({ fg: e.target.value })} />
                            </div>
                            <div className="field bn-slider">
                              <label>Ztmavení fotky {vzhled().overlay} %</label>
                              <input type="range" min={banner.look.image && hasText(banner.copy.title) ? 18 : 0}
                                max={90} value={vzhled().overlay}
                                onChange={e => setVzhled({ overlay: Number(e.target.value) })} />
                            </div>
                            <div className="field">
                              <label>Zarovnání</label>
                              <div className="tabs">
                                {(['left', 'center', 'right'] as const).map(one => (
                                  <button key={one} className={`tab ${vzhled().align === one ? 'active' : ''}`}
                                    onClick={() => setVzhled({ align: one })}>
                                    {one === 'left' ? 'Vlevo' : one === 'center' ? 'Na střed' : 'Vpravo'}
                                  </button>
                                ))}
                              </div>
                            </div>
                            <div className="field">
                              <label>Text v dlaždici</label>
                              <div className="tabs">
                                {(['top', 'middle', 'bottom'] as const).map(one => (
                                  <button key={one} className={`tab ${vzhled().pos === one ? 'active' : ''}`}
                                    onClick={() => setVzhled({ pos: one })}>
                                    {one === 'top' ? 'Nahoře' : one === 'middle' ? 'Uprostřed' : 'Dole'}
                                  </button>
                                ))}
                              </div>
                            </div>
                          </div>
                          {banner.look.image && (
                            <p className="desc">
                              Ztmavení pod textem se nedá stáhnout pod 18 % — bílý nadpis na světlé
                              látce na telefonu ve slunci nepřečte nikdo.
                            </p>
                          )}
                        </>
                      )}

                      {part === 'efekty' && (
                        <>
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
                              <label>
                                {banner.smart.kind === 'delivery' ? 'Poslední objednávka do' : 'Odpočet do'}
                              </label>
                              <input type="datetime-local" value={banner.smart.until}
                                onChange={e => setSmart({ until: e.target.value })} />
                              <p className="desc">
                                Počítá prohlížeč, ne aplikace — tiká i v noci a po vypršení odpočet
                                sám zmizí. Dlaždice zůstane, aby v mřížce nevznikla díra.
                              </p>
                            </div>
                          )}
                          {banner.smart.kind === 'code' && (
                            <div className="field">
                              <label>Slevový kód</label>
                              <input value={banner.smart.code} placeholder="SLEVA10"
                                onChange={e => setSmart({ code: e.target.value.toUpperCase() })} />
                              <p className="desc">
                                Klepnutím na kód se zkopíruje a dlaždice přitom nikam neodejde.
                              </p>
                            </div>
                          )}

                          <h4 className="bn-h">Emoji a pohyb</h4>
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
                              {/*
                                * Vlastní emoji políčkem: nabídka je na to, co se
                                * používá pořád, ne na všechno, co existuje.
                                */}
                              <input value={banner.smart.emoji} maxLength={6}
                                placeholder="nebo si vlož vlastní"
                                onChange={e => setSmart({ emoji: e.target.value })} />
                              {banner.smart.emoji && !jeEmoji(banner.smart.emoji) && (
                                <p className="desc wt-bad">
                                  To není emoji — písmeno by na webu vypadalo jako nenačtený
                                  obrázek, takže se při uložení zahodí.
                                </p>
                              )}
                            </div>
                            <div className="field">
                              <label>Pohyb</label>
                              <select value={banner.smart.effect}
                                onChange={e => setSmart({ effect: e.target.value as Banner['smart']['effect'] })}>
                                {EFFECTS.map(one => <option key={one.id} value={one.id}>{one.label}</option>)}
                              </select>
                              <p className="desc">
                                {EFFECTS.find(one => one.id === banner.smart.effect)?.hint}
                                {' '}Komu systém hlásí, že nechce pohyb, se nic nehýbe.
                              </p>
                            </div>
                          </div>

                          {banner.smart.effect === 'snow' && (
                            <>
                              <div className="bn-type">
                                <div className="field bn-slider">
                                  <label>Kolik jich padá · {banner.smart.fxCount}</label>
                                  <input type="range" min={3} max={40} value={banner.smart.fxCount}
                                    onChange={e => setSmart({ fxCount: Number(e.target.value) })} />
                                </div>
                                <div className="field bn-slider">
                                  <label>Velikost · {banner.smart.fxSize} px</label>
                                  <input type="range" min={8} max={44} value={banner.smart.fxSize}
                                    onChange={e => setSmart({ fxSize: Number(e.target.value) })} />
                                </div>
                                <div className="field bn-slider">
                                  <label>Propadne za · {banner.smart.fxSpeed} s</label>
                                  <input type="range" min={2} max={24} value={banner.smart.fxSpeed}
                                    onChange={e => setSmart({ fxSpeed: Number(e.target.value) })} />
                                </div>
                              </div>
                              <p className="desc">
                                Padá to přes <b>celou</b> dlaždici, ne jen v horním proužku.
                                Na telefonu se počet sám zkrátí na dvě třetiny — dlaždice je tam
                                poloviční a stejná hustota by z ní udělala clonu přes text.
                                {!banner.smart.emoji && ' Vyber emoji, jinak nemá co padat.'}
                              </p>
                            </>
                          )}
                        </>
                      )}
                    </>
                  )}

                  {section === 'odkazy' && (
                    <>
                      <p className="desc">
                        Pruh pod bannerem. Banner prodává jednu věc, tohle říká, co všechno tu je —
                        je to nejkratší cesta z úvodní stránky do kategorie. Na telefonu se pruh
                        posouvá prstem, aby osm kategorií nezakrylo celou obrazovku.
                      </p>
                      <div className="bn-layout">
                        <label className="check-row">
                          <input type="checkbox" checked={linksOf().on}
                            onChange={e => setLinks({ on: e.target.checked })} />
                          Ukazovat pruh odkazů
                        </label>
                        <div className="field">
                          <label>Podoba</label>
                          <div className="tabs">
                            {([['circle', 'Kolečka'], ['square', 'Dlaždičky'], ['text', 'Jen text']] as const)
                              .map(([id, label]) => (
                                <button key={id} className={`tab ${linksOf().shape === id ? 'active' : ''}`}
                                  onClick={() => setLinks({ shape: id })}>{label}</button>
                              ))}
                          </div>
                        </div>
                      </div>

                      {linksOf().items.length === 0 && (
                        <p className="desc">Zatím žádný odkaz. Přidej první tlačítkem dole.</p>
                      )}
                      {linksOf().items.map((one, i) => (
                        <div className="bn-link-row" key={one.id}>
                          <div className="bn-link-ico" style={one.image
                            ? { backgroundImage: `url("${one.image}")` } : undefined}>
                            {!one.image && (one.emoji || '—')}
                          </div>
                          <div className="bn-link-fields">
                            <div className="bn-two">
                              <div className="field">
                                <label>Název {lang !== 'cz' && <small>({lang.toUpperCase()})</small>}</label>
                                <input value={one.text[lang]} maxLength={26}
                                  placeholder={lang === 'cz' ? 'Kravaty' : one.text.cz}
                                  onChange={e => setLink(i, { text: { ...one.text, [lang]: e.target.value } })} />
                              </div>
                              <div className="field">
                                <label>Odkaz {lang !== 'cz' && <small>(dohledaný)</small>}</label>
                                <input value={one.href[lang]} placeholder="/kravaty"
                                  onChange={e => setLink(i, { href: { ...one.href, [lang]: e.target.value } })}
                                  onBlur={() => { if (lang === 'cz') void resolveLink(i); }} />
                              </div>
                            </div>
                            <div className="bn-tools">
                              <input value={one.emoji} maxLength={6} placeholder="emoji"
                                style={{ width: 90 }}
                                title={one.emoji && !jeEmoji(one.emoji)
                                  ? 'To není emoji — při uložení se to zahodí.'
                                  : 'Emoji do kolečka; místo něj jde nahrát obrázek'}
                                className={one.emoji && !jeEmoji(one.emoji) ? 'bad' : ''}
                                onChange={e => setLink(i, { emoji: e.target.value })} />
                              <input type="file" accept="image/*" disabled={!!busy}
                                style={{ fontSize: 11, maxWidth: 150 }}
                                onChange={e => {
                                  const file = e.target.files?.[0];
                                  e.target.value = '';
                                  if (file) void uploadLinkImage(i, file);
                                }} />
                              {one.image && (
                                <button className="btn ghost" onClick={() => setLink(i, { image: '' })}>
                                  <Icon name="x" size={12} /> Obrázek pryč
                                </button>
                              )}
                              <span className="wt-spacer" />
                              <button className="btn ghost" onClick={() => moveLink(i, -1)} disabled={i === 0}>
                                <Icon name="chevLeft" size={12} />
                              </button>
                              <button className="btn ghost" onClick={() => moveLink(i, 1)}
                                disabled={i >= linksOf().items.length - 1}>
                                <Icon name="chevRight" size={12} />
                              </button>
                              <button className="btn ghost danger" onClick={() => dropLink(i)}>
                                <Icon name="trash" size={12} />
                              </button>
                            </div>
                          </div>
                        </div>
                      ))}
                      {linksOf().items.length < 8 && (
                        <button className="btn" onClick={addLink} style={{ alignSelf: 'flex-start' }}>
                          <Icon name="plus" size={14} /> Přidat odkaz
                        </button>
                      )}
                    </>
                  )}

                  {/*
                    * Tlačítka akcí zůstávají dole vidět, ať je člověk v kterémkoli
                    * oddílu. Rozdělaná sada, ke které se musí rolovat pro uložení,
                    * je nejčastější způsob, jak o práci přijít.
                    */}
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
                        <button className="btn ghost" disabled={!!busy}
                          onClick={() => run('Kopíruji', async () => {
                            const next = await api.banners.copy(draft.id);
                            const kopie = next.sets.find(one => one.name === `${draft.name} (kopie)`);
                            if (kopie) { setDraft(kopie); setPick(0); }
                            return next;
                          }, 'Kopie je hotová — je vypnutá, ať se nepere s originálem.')}>
                          <Icon name="copy" size={14} /> Duplikovat sadu
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
