/**
 * Co dělaly sociální sítě — podklad pro přehled.
 *
 * Aplikace ví o příspěvcích na Instagramu: kdy vyšly, kolik mají lajků
 * a komentářů a na které trhy se rozeslaly. To samo o sobě není tržba, ale
 * je to **jediná věc, kterou e-shop v tom období dělal navenek**, takže když
 * se objednávky hnou, je to první místo, kam se člověk podívá.
 *
 * ## Co se dá spočítat a co ne
 *
 * Spočítat jde, jestli **ve dnech s příspěvkem chodilo víc objednávek** než
 * ve dnech bez něj. Je to korelace, ne důkaz — příspěvek se často pouští
 * právě ve chvíli, kdy je co nabídnout — a tak se to i píše. Je to ale
 * dost na to, aby se dalo poznat, že se za poslední měsíc nepostovalo vůbec
 * a objednávky mezitím spadly.
 *
 * **Zhlédnutí a dosah aplikace nemá.** Instagram je vydává jen přes rozhraní
 * `insights` u vlastního účtu a to se zatím nestahuje; lajky a komentáře ano,
 * ty chodí spolu s příspěvkem. Kdyby se dosah někdy dotahoval, stačí ho
 * přidat sem — zbytek přehledu se měnit nemusí.
 */
import { getDb } from './db';

export interface SocialPost {
  at: string;
  caption: string;
  /** Lajky a komentáře jsou vždycky z Instagramu — Facebook metriky nedává */
  likes: number;
  comments: number;
  permalink: string;
  /** Na kolik trhů se příspěvek rozeslal */
  markets: number;
  /** Které trhy to byly — „CZ, SK, EN" */
  marketLabels?: string[];
  /** „IG" nebo „IG + FB" podle toho, kam se sdílelo */
  channels?: string;
  /**
   * Byl za příspěvkem placený dosah?
   *
   * `null` znamená **nevíme** — starší napojení propagaci nehlásí a „nevíme"
   * se nesmí tvářit jako „ne". Bez tohohle se úspěch koupeného dosahu čte
   * jako úspěch příspěvku a starší propagovaný kus přebije všechno ostatní.
   */
  boosted?: boolean | null;
  /** O kolik % víc objednávek chodilo kolem vydání; null = nedá se spočítat */
  lift?: number | null;
  /** Proč je tenhle příspěvek v seznamu — počítáno z čísel vedle */
  why?: string;
}

export interface SocialView {
  /** Kolik příspěvků vyšlo v okně */
  posts: number;
  likes: number;
  comments: number;
  /** Nejúspěšnější příspěvek okna podle lajků a komentářů */
  best: SocialPost | null;
  /** Kolik dní v okně mělo příspěvek */
  daysWithPost: number;
  /** Průměr objednávek ve dnech s příspěvkem a bez něj */
  ordersWithPost: number;
  ordersWithout: number;
  /** Kolik příspěvků bylo v předchozím okně — na srovnání aktivity */
  prevPosts: number;
  /**
   * Nejúspěšnější příspěvky **z poslední doby** (půl roku).
   *
   * Hlavní pohled je na to, co funguje teď — co zabralo před dvěma lety, je
   * zajímavé u sezóny, ne u rozhodnutí, co postnout příští týden.
   */
  bestEver: SocialPost[];
  /** Doplněk: co fungovalo dávno, ale stojí za připomenutí */
  bestOlder: SocialPost[];
  /** Čerstvé neplacené příspěvky, kterým by rozpočet mohl pomoct */
  candidates: SocialPost[];
  /** Hlásí Instagram u tohohle napojení propagaci? Bez toho se nedá odlišit placené */
  boostKnown: boolean;
}

/**
 * Přehled sítí za okno.
 *
 * `days` je denní řada z přehledu (den a počet objednávek), aby se dvakrát
 * nepočítalo totéž a aby srovnání sedělo přesně na dny, které jsou v grafu.
 */
export function socialView(
  days: { day: string; orders: number }[], windowDays = 30
): SocialView | null {
  const d = getDb();
  const empty: SocialView = {
    posts: 0, likes: 0, comments: 0, best: null, daysWithPost: 0,
    ordersWithPost: 0, ordersWithout: 0, prevPosts: 0, bestEver: [],
    bestOlder: [], candidates: [], boostKnown: false
  };

  let rows: any[] = [];
  try {
    const from = days[0]?.day ?? '';
    const prevFrom = new Date(new Date(`${from}T12:00:00`).getTime() - windowDays * 86_400_000);
    const prevKey = Number.isNaN(prevFrom.getTime()) ? from : prevFrom.toISOString().slice(0, 10);
    rows = d.prepare(
      `SELECT posted_at, caption, like_count, comment_count, permalink, ig_media_id
         FROM ig_source_posts WHERE substr(posted_at, 1, 10) >= ? ORDER BY posted_at DESC LIMIT 200`
    ).all(prevKey) as any[];
  } catch {
    // Instagram v téhle instalaci vůbec není — přehled se kvůli tomu nemění
    return null;
  }
  if (rows.length === 0) return empty;

  const inWindow = new Set(days.map(one => one.day));
  const fromDay = days[0]?.day ?? '';

  const published = (mediaId: string): number => {
    try {
      return Number((d.prepare(
        'SELECT COUNT(*) AS n FROM ig_published WHERE source_media_id = ?'
      ).get(String(mediaId)) as any)?.n ?? 0);
    } catch {
      return 0;
    }
  };

  const postDays = new Set<string>();
  let posts = 0;
  let likes = 0;
  let comments = 0;
  let prevPosts = 0;
  let best: SocialPost | null = null;

  for (const row of rows) {
    const day = String(row.posted_at ?? '').slice(0, 10);
    if (!day) continue;
    if (!inWindow.has(day)) {
      if (day < fromDay) prevPosts++;
      continue;
    }
    posts++;
    postDays.add(day);
    const like = Number(row.like_count ?? 0);
    const comment = Number(row.comment_count ?? 0);
    likes += like;
    comments += comment;
    const one: SocialPost = {
      at: String(row.posted_at ?? ''),
      caption: String(row.caption ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
      likes: like,
      comments: comment,
      permalink: String(row.permalink ?? ''),
      markets: published(row.ig_media_id)
    };
    // Komentář stojí víc práce než lajk, tak i víc váží
    if (!best || like + comment * 3 > best.likes + best.comments * 3) best = one;
  }

  /*
   * Objednávky ve dnech s příspěvkem a bez něj. Den se počítá celý —
   * příspěvek vyšlý večer se do něj promítne jen zčásti, ale rozlišovat
   * hodiny by u dvou desítek příspěvků nic nepřineslo.
   */
  const withPost = days.filter(one => postDays.has(one.day));
  const without = days.filter(one => !postDays.has(one.day));
  const avg = (list: { orders: number }[]) =>
    list.length ? Math.round((list.reduce((sum, one) => sum + one.orders, 0) / list.length) * 10) / 10 : 0;

  return {
    posts,
    likes,
    comments,
    best,
    daysWithPost: postDays.size,
    ordersWithPost: avg(withPost),
    ordersWithout: avg(without),
    prevPosts,
    /*
     * Dva pohledy zvlášť. Hlavní je poslední půlrok — podle něj se
     * rozhoduje, co postnout teď. Starší úspěchy se přidávají jako
     * připomenutí, ne jako měřítko: co fungovalo před dvěma lety, mohlo
     * mít zaplacený dosah nebo docela jinou nabídku.
     */
    bestEver: bestPosts({ limit: 3, sinceDays: 180 }),
    bestOlder: bestPosts({ limit: 2, beforeDays: 180 }),
    candidates: boostCandidates(days),
    boostKnown: knowsBoost()
  };
}

/* ---------- dlouhodobě ---------- */

/**
 * Kudy příspěvek vyšel.
 *
 * Aplikace publikuje na Instagram a volitelně sdílí na Facebook — a to je
 * jediné, co se o Facebooku dá z databáze zjistit. **Lajky a komentáře jsou
 * vždycky z Instagramu**, protože metriky Facebooku se nikam neukládají;
 * říká se to proto rovnou, ať se čísla nepřipisují oběma sítím.
 */
function channelsOf(sourceMediaId: string): string {
  try {
    const fb = Number((getDb().prepare(
      `SELECT COUNT(*) AS n FROM ig_jobs j
        WHERE j.fb_post_id IS NOT NULL AND j.fb_post_id != ''
          AND j.ig_media_id IN (SELECT ig_media_id FROM ig_published WHERE source_media_id = ?)`
    ).get(String(sourceMediaId)) as any)?.n ?? 0);
    return fb > 0 ? 'IG + FB' : 'IG';
  } catch {
    return 'IG';
  }
}

/** Na které trhy příspěvek šel — jazyky, ne jen počet */
function marketsOf(sourceMediaId: string): string[] {
  try {
    const rows = getDb().prepare(
      'SELECT lang FROM ig_published WHERE source_media_id = ? ORDER BY lang'
    ).all(String(sourceMediaId)) as any[];
    return rows.map(one => String(one.lang ?? '').toUpperCase()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Nejúspěšnější příspěvky za celou historii, případně jen z určitých měsíců.
 *
 * `months` (0 = leden) se hodí u sezóny: „co fungovalo loni v listopadu
 * a prosinci" je pro chystanou kampaň lepší podklad než to, co se povedlo
 * minulý týden. Řadí se podle lajků a komentářů, kde komentář váží víc —
 * napsat ho dá víc práce než klepnout na srdíčko.
 */
export function bestPosts(
  options: { months?: number[]; limit?: number; sinceDays?: number; beforeDays?: number } = {}
): SocialPost[] {
  const limit = options.limit ?? 3;
  let rows: any[] = [];
  try {
    rows = getDb().prepare(
      `SELECT posted_at, caption, like_count, comment_count, permalink, ig_media_id, boosted
         FROM ig_source_posts WHERE posted_at != '' ORDER BY posted_at DESC LIMIT 2000`
    ).all() as any[];
  } catch {
    return [];
  }

  const wanted = options.months;
  const now = Date.now();
  const picked = rows.filter(row => {
    if (wanted?.length) {
      const month = Number(String(row.posted_at ?? '').slice(5, 7)) - 1;
      if (!wanted.includes(month)) return false;
    }
    /*
     * Stáří. Hlavní seznam se dívá na poslední půlrok — podle něj se
     * rozhoduje, co postnout teď; starší se ukazují zvlášť jako připomenutí.
     */
    const when = new Date(String(row.posted_at ?? '')).getTime();
    if (!Number.isFinite(when)) return !options.sinceDays;
    const age = (now - when) / 86_400_000;
    if (options.sinceDays != null && age > options.sinceDays) return false;
    if (options.beforeDays != null && age <= options.beforeDays) return false;
    return true;
  });

  return picked
    .sort((a, b) => score(b) - score(a))
    .slice(0, limit)
    .map(row => toPost(row));
}

/**
 * Ví se u téhle instalace, které příspěvky byly propagované?
 *
 * Stačí jeden příspěvek s vyplněnou hodnotou — pak Instagram propagaci
 * hlásí a dá se rozlišovat. Když ne, řekne se to nahlas: bez toho by
 * „neplacený úspěch" byl jen dohad.
 */
export function knowsBoost(): boolean {
  try {
    return Number((getDb().prepare(
      'SELECT COUNT(*) AS n FROM ig_source_posts WHERE boosted IS NOT NULL'
    ).get() as any)?.n ?? 0) > 0;
  } catch {
    return false;
  }
}

/* ---------- co má smysl propagovat ---------- */

/**
 * Příspěvky, které si říkají o rozpočet.
 *
 * Úspěch placeného příspěvku není zásluha příspěvku — je koupený. Když se
 * pak žebříček řadí jen podle lajků, starší propagovaný příspěvek přebije
 * všechno ostatní a vypadá to, že „tohle funguje", i když to jen mělo
 * zaplacený dosah. Proto se hledá opak: **čerstvý příspěvek, který si vede
 * nadprůměrně bez placení** — u toho má přidání rozpočtu smysl, protože
 * začíná z něčeho, co lidi zabralo samo.
 *
 * Měřítko je medián nedávných neplacených příspěvků, ne průměr: jeden
 * virál by průměr vytáhl tak, že by pak neprošlo nic.
 *
 * `days` je denní řada objednávek z přehledu — u každého kandidáta se
 * přidá, kolik objednávek chodilo v den vydání a dva dny po něm proti
 * běžnému dni. Je to **souvislost, ne důkaz**, a tak se to i píše.
 */
export function boostCandidates(
  days: { day: string; orders: number }[], limit = 3
): SocialPost[] {
  let rows: any[] = [];
  try {
    rows = getDb().prepare(
      `SELECT posted_at, caption, like_count, comment_count, permalink, ig_media_id, boosted
         FROM ig_source_posts WHERE posted_at != '' ORDER BY posted_at DESC LIMIT 200`
    ).all() as any[];
  } catch {
    return [];
  }
  if (rows.length === 0) return [];

  const now = Date.now();
  const fresh = rows.filter(row => {
    const when = new Date(String(row.posted_at ?? '')).getTime();
    return Number.isFinite(when) && now - when <= 60 * 86_400_000;
  });
  if (fresh.length === 0) return [];

  // Měřítko: medián neplacených z posledního půlroku
  const organic = rows
    .filter(row => row.boosted !== 1)
    .map(row => score(row))
    .sort((a, b) => a - b);
  if (organic.length === 0) return [];
  const median = organic[Math.floor(organic.length / 2)] || 1;

  const daily = new Map(days.map(one => [one.day, one.orders]));
  const average = days.length
    ? days.reduce((sum, one) => sum + one.orders, 0) / days.length
    : 0;

  return fresh
    .filter(row => row.boosted !== 1 && score(row) >= median * 1.3)
    .sort((a, b) => score(b) - score(a))
    .slice(0, limit)
    .map(row => {
      const post = toPost(row);
      /*
       * Objednávky kolem vydání. Den vydání a dva dny po něm — déle už se
       * to míchá s čímkoli jiným, co se ten týden dělo.
       */
      const day = String(row.posted_at ?? '').slice(0, 10);
      const around: number[] = [];
      for (let ahead = 0; ahead <= 2; ahead++) {
        const key = new Date(new Date(`${day}T12:00:00`).getTime() + ahead * 86_400_000)
          .toISOString().slice(0, 10);
        const found = daily.get(key);
        if (found != null) around.push(found);
      }
      const mine = around.length
        ? around.reduce((sum, one) => sum + one, 0) / around.length
        : 0;
      const lift = average > 0 && around.length
        ? Math.round(((mine - average) / average) * 100)
        : null;

      const times = Math.round((score(row) / Math.max(1, median)) * 10) / 10;
      post.lift = lift;
      post.why = `Zaujal ${times}× víc než běžný neplacený příspěvek`
        + (post.boosted === false ? ' a rozpočet za ním nestál' : '')
        + (lift != null
          ? `; v den vydání a dva dny po něm chodilo ${lift > 0 ? `o ${lift} % víc` : lift < 0 ? `o ${-lift} % míň` : 'stejně'} objednávek než obvykle (souvislost, ne důkaz)`
          : '')
        + '.';
      return post;
    });
}

/** Lajk je klepnutí, komentář práce — proto váží víc */
function score(row: any): number {
  return Number(row.like_count ?? 0) + Number(row.comment_count ?? 0) * 3;
}

/** Řádek z databáze na příspěvek i s trhy, kanály a propagací */
function toPost(row: any): SocialPost {
  const mediaId = String(row.ig_media_id ?? '');
  const markets = marketsOf(mediaId);
  return {
    at: String(row.posted_at ?? ''),
    caption: String(row.caption ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
    likes: Number(row.like_count ?? 0),
    comments: Number(row.comment_count ?? 0),
    permalink: String(row.permalink ?? ''),
    markets: markets.length,
    marketLabels: markets,
    channels: channelsOf(mediaId),
    // `null` = Instagram propagaci u tohohle napojení nehlásí
    boosted: row.boosted == null ? null : row.boosted === 1
  };
}
