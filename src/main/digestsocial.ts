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
  likes: number;
  comments: number;
  permalink: string;
  /** Na kolik trhů se příspěvek rozeslal */
  markets: number;
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
    ordersWithPost: 0, ordersWithout: 0, prevPosts: 0
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
    prevPosts
  };
}
