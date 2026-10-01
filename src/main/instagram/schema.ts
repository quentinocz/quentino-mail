/**
 * Tabulky instagramového modulu. Všechny mají prefix `ig_`, aby bylo v databázi
 * na první pohled vidět, co patří poště a co sociálním sítím.
 *
 * Schéma se spouští při každém startu (CREATE TABLE IF NOT EXISTS), takže
 * u existující instalace jen doplní, co chybí.
 */
export const igSchema = `
  CREATE TABLE IF NOT EXISTS ig_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ig_user_id TEXT NOT NULL UNIQUE,
    username TEXT NOT NULL DEFAULT '',
    lang TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#7c5cff',
    is_source INTEGER NOT NULL DEFAULT 0,
    token_enc TEXT NOT NULL DEFAULT '',
    token_expires TEXT,
    connected_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_error TEXT,
    page_id TEXT NOT NULL DEFAULT '',
    page_name TEXT NOT NULL DEFAULT '',
    share_fb INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS ig_markets (
    lang TEXT PRIMARY KEY,
    label TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '#7c5cff',
    enabled INTEGER NOT NULL DEFAULT 1,
    ord INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS ig_source_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ig_media_id TEXT NOT NULL UNIQUE,
    media_type TEXT NOT NULL DEFAULT 'IMAGE',
    permalink TEXT NOT NULL DEFAULT '',
    caption TEXT NOT NULL DEFAULT '',
    posted_at TEXT NOT NULL DEFAULT '',
    like_count INTEGER NOT NULL DEFAULT 0,
    comment_count INTEGER NOT NULL DEFAULT 0,
    children_json TEXT NOT NULL DEFAULT '[]',
    thumb_path TEXT,
    -- Byl příspěvek propagovaný? Prázdná hodnota znamená nevíme (Instagram
    -- to u téhle verze napojení neposlal) — a nevíme se nesmí tvářit jako ne.
    boosted INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_ig_source_date ON ig_source_posts(posted_at DESC);

  CREATE TABLE IF NOT EXISTS ig_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL DEFAULT 'new',
    source_post_id INTEGER REFERENCES ig_source_posts(id) ON DELETE SET NULL,
    brief TEXT NOT NULL DEFAULT '',
    media_note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    archived INTEGER NOT NULL DEFAULT 0,
    -- Kdy má příspěvek vyjít podle plánu. Není to totéž co naplánovaná
    -- publikace: ta vzniká až tehdy, když jsou hotová média i text.
    -- Tohle je záměr („ve čtvrtek večer o kravatách"), podle kterého se
    -- pozná, co je na tento týden rozdělané a co se nestihlo.
    plan_at TEXT NOT NULL DEFAULT '',
    -- Proč tenhle příspěvek vznikl: nejprodávanější, opomíjené zboží,
    -- sezóna, ze zákulisí. Podle toho se hlídá, aby měsíc nebyl
    -- třicetkrát totéž.
    plan_kind TEXT NOT NULL DEFAULT '',
    -- Odkud příspěvek pochází: 'ai' z návrhu plánovače, 'hand' od člověka,
    -- 'repost' z přepisu vlastního příspěvku. V jednom seznamu je potřeba
    -- poznat, co vymyslela aplikace a co člověk — u návrhu se čte jinak
    -- pozorně než u toho, co jsem psal sám.
    origin TEXT NOT NULL DEFAULT '',
    -- Krátký název do přehledu.
    --
    -- Dřív se bral první řádek zadání — jenže zadání začíná textem
    -- příspěvku, takže v plánu stála místo názvu první věta useknutá
    -- uprostřed slova a u příspěvku bez textu „Bez názvu". Všechny
    -- řádky pak vypadaly stejně a nedalo se v nich nic najít.
    plan_title TEXT NOT NULL DEFAULT '',
    -- Nápad na fotku nebo video, tak jak ho navrhla AI
    plan_idea TEXT NOT NULL DEFAULT '',
    -- Ke kterému produktu se příspěvek váže (kód z katalogu)
    plan_code TEXT NOT NULL DEFAULT '',
    -- Odsouhlasený k publikaci.
    --
    -- Text od modelu a fotky od člověka nestačí: mezi „je to hotové" a
    -- „může to ven" je krok, který dělá hlava, ne aplikace. Bez něj by
    -- naplánovaná publikace odešla i s překlepem, kterého si nikdo
    -- nevšiml, protože se na příspěvek od zařazení do plánu nikdo
    -- nepodíval.
    approved INTEGER NOT NULL DEFAULT 0,
    approved_at TEXT NOT NULL DEFAULT '',
    -- Klíč pro sdílení mezi zařízeními.
    --
    -- Číslo řádku je na každém počítači jiné, takže podle něj se plán
    -- spárovat nedá. Tenhle se zakládá s příspěvkem a putuje s ním.
    share_id TEXT NOT NULL DEFAULT '',
    -- Kdy se s příspěvkem naposledy hnulo. Při slučování vyhrává novější —
    -- bez razítka by starší zařízení přepsalo práci toho druhého.
    updated_at TEXT NOT NULL DEFAULT '',
    -- Má se video objevit i v mřížce profilu? Jedno video Instagram
    -- publikuje vždycky jako reel a v mřížce se ukáže jen na požádání;
    -- výchozí je ano, protože příspěvek, který v profilu není vidět,
    -- nikdo nečeká.
    reel_feed INTEGER NOT NULL DEFAULT 1
  );
  -- Rejstřík nad plan_at tady schválně NENÍ. Tenhle blok běží i nad databází
  -- z minulé verze, kde tabulka ig_posts sloupec plan_at ještě nemá —
  -- „no such column: plan_at" by shodilo celé zakládání schématu a aplikace
  -- by se neotevřela. Rejstřík proto patří až za ALTERy, do igAlters.

  CREATE TABLE IF NOT EXISTS ig_post_media (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL REFERENCES ig_posts(id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 0,
    path TEXT NOT NULL DEFAULT '',
    mime TEXT NOT NULL DEFAULT '',
    is_video INTEGER NOT NULL DEFAULT 0,
    -- Pro který trh je médium určené. Prázdno znamená „pro všechny" a je
    -- to běžný případ: jedna fotka se publikuje na všech účtech. Vyplněné
    -- to je u videí s vypálenými titulky, kde má každý trh vlastní soubor
    -- s textem ve svém jazyce.
    lang TEXT NOT NULL DEFAULT '',
    width INTEGER,
    height INTEGER,
    cover_offset REAL,
    source_url TEXT,
    public_url TEXT,
    storage_key TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ig_media_post ON ig_post_media(post_id, position);

  -- Střih videa k jednomu příspěvku: záběry, přechody, titulky, zvuk
  -- a vlastní verze pro jednotlivé trhy.
  --
  -- Jeden JSON, ne tři tabulky. Nic se v tom nevyhledává (vždycky se čte
  -- celý projekt jednoho příspěvku) a časová osa se ještě bude měnit —
  -- rozepsané do sloupců by každá nová vlastnost přechodu znamenala
  -- migraci, ze které nic nekouká.
  CREATE TABLE IF NOT EXISTS ig_video (
    post_id INTEGER PRIMARY KEY REFERENCES ig_posts(id) ON DELETE CASCADE,
    json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS ig_captions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL REFERENCES ig_posts(id) ON DELETE CASCADE,
    lang TEXT NOT NULL,
    variants_json TEXT NOT NULL DEFAULT '[]',
    chosen INTEGER NOT NULL DEFAULT 0,
    edited TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(post_id, lang)
  );

  CREATE TABLE IF NOT EXISTS ig_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    caption_id INTEGER NOT NULL REFERENCES ig_captions(id) ON DELETE CASCADE,
    account_id INTEGER NOT NULL REFERENCES ig_accounts(id) ON DELETE CASCADE,
    state TEXT NOT NULL DEFAULT 'scheduled',
    scheduled_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT,
    finished_at TEXT,
    container_id TEXT,
    ig_media_id TEXT,
    permalink TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    fb_post_id TEXT,
    fb_error TEXT,
    channels TEXT NOT NULL DEFAULT 'ig'
  );
  CREATE INDEX IF NOT EXISTS idx_ig_jobs_due ON ig_jobs(state, scheduled_at);

  -- Co už na kterém trhu vyšlo.
  --
  -- Samostatný záznam schválně, i když se to dá odvodit z popisků a odeslaných
  -- prací. Ty totiž popisují **práci na tomhle zařízení**: kdo si příspěvek
  -- rozepsal a co odeslal. Když se reels publikuje z počítače, telefon o tom
  -- neví a nabízí ho k publikaci znovu.
  --
  -- Tahle tabulka popisuje **skutečnost venku na Instagramu** — a ta je pro
  -- všechna zařízení stejná. Proto se dá bezpečně slučovat: publikace je
  -- jednosměrný fakt, který nikdo nemůže vzít zpět, takže při sloučení
  -- vždycky vyhrává „vyšlo to".
  --
  -- Klíčem je Instagramové id zdrojového příspěvku, ne místní číslo řádku —
  -- to je na každém zařízení jiné.
  CREATE TABLE IF NOT EXISTS ig_published (
    source_media_id TEXT NOT NULL,
    lang TEXT NOT NULL,
    at TEXT NOT NULL DEFAULT '',
    permalink TEXT NOT NULL DEFAULT '',
    ig_media_id TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (source_media_id, lang)
  );
`;

/**
 * Doplňky pro databáze založené starší verzí. Spouští se po jednom a chyba
 * „sloupec už existuje" se ignoruje — stejný postup jako u tabulek pošty.
 */
export const igAlters: string[] = [
  "ALTER TABLE ig_accounts ADD COLUMN page_id TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE ig_accounts ADD COLUMN page_name TEXT NOT NULL DEFAULT ''",
  'ALTER TABLE ig_accounts ADD COLUMN share_fb INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE ig_jobs ADD COLUMN fb_post_id TEXT',
  'ALTER TABLE ig_jobs ADD COLUMN fb_error TEXT',
  "ALTER TABLE ig_jobs ADD COLUMN channels TEXT NOT NULL DEFAULT 'ig'",
  'ALTER TABLE ig_source_posts ADD COLUMN boosted INTEGER',
  "ALTER TABLE ig_posts ADD COLUMN plan_at TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE ig_posts ADD COLUMN plan_kind TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE ig_posts ADD COLUMN plan_idea TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE ig_posts ADD COLUMN plan_code TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE ig_posts ADD COLUMN origin TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE ig_posts ADD COLUMN plan_title TEXT NOT NULL DEFAULT ''",
  'ALTER TABLE ig_posts ADD COLUMN approved INTEGER NOT NULL DEFAULT 0',
  "ALTER TABLE ig_posts ADD COLUMN approved_at TEXT NOT NULL DEFAULT ''",
  // Až tady, po doplnění sloupce. V bloku se schématem by rejstřík nad
  // starou databází spadl na „no such column: plan_at".
  "ALTER TABLE ig_posts ADD COLUMN share_id TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE ig_posts ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''",
  // Video pro každý trh: médium si nese jazyk, pro který je vypálené
  "ALTER TABLE ig_post_media ADD COLUMN lang TEXT NOT NULL DEFAULT ''",
  'ALTER TABLE ig_posts ADD COLUMN reel_feed INTEGER NOT NULL DEFAULT 1',
  'CREATE INDEX IF NOT EXISTS idx_ig_posts_plan ON ig_posts(plan_at)',
  'CREATE INDEX IF NOT EXISTS idx_ig_posts_share ON ig_posts(share_id)'
];

/** Trhy, se kterými se začíná. Uživatel je v rozhraní přepíše. */
export const DEFAULT_MARKETS: { lang: string; label: string; color: string; note: string; tags: string }[] = [
  { lang: 'CS', label: 'Čeština', color: '#232849', note: 'Domácí trh, zdroj příspěvků.', tags: '' },
  { lang: 'EN', label: 'Angličtina', color: '#2F6BE0', note: 'Mezinárodní publikum, spíš stručně.', tags: '' },
  { lang: 'DE', label: 'Němčina', color: '#B5701A', note: 'Německy mluvící trh, věcný tón.', tags: '' },
  { lang: 'PL', label: 'Polština', color: '#0E7A61', note: 'Polský trh, přátelský tón.', tags: '' },
  { lang: 'ES', label: 'Španělština', color: '#BE3730', note: 'Španělsky mluvící trh, živější tón.', tags: '' }
];
