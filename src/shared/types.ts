// Sdílené typy mezi main a renderer procesem

export interface AccountConfig {
  id?: number;
  name: string;
  email: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  username: string;
  /** Heslo — posílá se jen při vytváření/úpravě, nikdy zpět do UI */
  password?: string;
  signatureHtml: string;
  /** Strukturovaný podpis — má přednost před signatureHtml, lokalizuje se dle jazyka mailu */
  sigConfig?: SigConfig | null;
  /** Cesta k logu podpisu; vkládá se jako CID příloha (zobrazí se všem klientům) */
  logoPath?: string | null;
  color: string;
}

export interface AccountPublic {
  id: number;
  name: string;
  email: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  username: string;
  signatureHtml: string;
  sigConfig: SigConfig | null;
  logoPath: string | null;
  color: string;
}

export type Category = 'orders' | 'people' | 'companies' | 'other';

export interface MessageHeader {
  id: number; // DB primary key
  accountId: number;
  folder: string;
  uid: number;
  messageId: string;
  subject: string;
  fromAddr: string;
  fromName: string;
  toAddr: string;
  date: string; // ISO
  snippet: string;
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  hasAttachments: boolean;
  category: Category | null;
  summary: string | null;
  archived: boolean;
  threadKey: string;
  /** Velikost zprávy v bajtech (ze serveru) */
  size: number;
  /** Objednávka, ke které se zpráva vztahuje (odpověď zákazníka na potvrzení) */
  orderRef: OrderRef | null;
}

/** Zpráva v historii komunikace se zákazníkem */
export interface CustomerMessage {
  id: number;
  date: string;
  subject: string;
  snippet: string;
  /** true = od zákazníka, false = naše odpověď */
  incoming: boolean;
  /** Text zprávy bez citované části; null = tělo ještě není stažené */
  text: string | null;
  hasAttachments: boolean;
  seen: boolean;
  answered: boolean;
  /** Potvrzení objednávky z e-shopu */
  isOrderMail: boolean;
}

export interface CustomerOrder {
  orderNumber: string;
  /** Zpráva s potvrzením — z ní se načte karta objednávky */
  messageId: number;
  date: string;
}

/** Vše, co o zákazníkovi víme z pošty */
export interface CustomerContext {
  email: string;
  name: string;
  messages: CustomerMessage[];
  orders: CustomerOrder[];
}

/** Vazba příchozí zprávy na objednávku */
export interface OrderRef {
  orderNumber: string;
  /** ID zprávy s potvrzením objednávky — z ní se bere karta */
  orderMessageId: number | null;
  resolved: boolean;
}

export type MessageSort = 'date_desc' | 'date_asc' | 'size_desc' | 'size_asc' | 'from_az';

export interface ListFilters {
  unread?: boolean;
  flagged?: boolean;
  attachments?: boolean;
  /** Ve složce „K objednávkám" zobrazit i vyřízené a starší zprávy */
  orderAll?: boolean;
}

export interface AttachmentInfo {
  id: number;
  filename: string;
  mime: string;
  size: number;
  path: string;
  /** Content-ID pro inline obrázky v HTML těle */
  cid: string | null;
}

export interface MessageFull extends MessageHeader {
  cc: string;
  bodyHtml: string | null;
  bodyText: string | null;
  attachments: AttachmentInfo[];
  detectedLang: string | null;
  translationCz: string | null;
}

export interface FolderInfo {
  path: string;
  name: string;
  specialUse: string | null; // \Sent, \Trash, \Drafts, \Junk, \Archive
  unseen: number;
  total: number;
}

export interface ComposeDraft {
  accountId: number;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  html: string;
  attachmentPaths: string[];
  inReplyTo?: string;
  references?: string;
  /** ISO čas plánovaného odeslání; prázdné = hned */
  sendAt?: string | null;
  /** Přeložit před odesláním do tohoto jazyka (např. "en") */
  translateTo?: string | null;
  replyToDbId?: number | null;
  /** Inline obrázky (logo podpisu, fotka osoby) vložené přes CID */
  inlineImages?: { cid: string; path: string }[];
  /** Zobrazované jméno odesílatele (dle podepsané osoby a jazyka); prázdné = název účtu */
  fromName?: string | null;
}

export interface OutboxItem {
  id: number;
  accountId: number;
  toAddr: string;
  subject: string;
  sendAt: string;
  status: 'scheduled' | 'sending' | 'sent' | 'failed';
  error: string | null;
}

export interface Settings {
  anthropicApiKey?: string; // jen zápis; čtení vrací pouze boolean hasApiKey
  hasApiKey?: boolean;
  /** Uložená hesla a klíče nejdou rozšifrovat — typicky po přejmenování aplikace */
  secretsLocked?: boolean;
  brandPrompt: string;
  draftModel: string;
  fastModel: string;
  autoSummarize: boolean;
  autoCategorize: boolean;
  autoTranslate: boolean;
  loadRemoteImages: boolean;
  categoryRules: CategoryRule[];
  /** Kategorie, které se mají automaticky shrnout AI hned při načtení ze serveru */
  autoSummarizeCategories: Category[];
  /** Kontaktní údaje firmy — AI je používá při návrzích odpovědí */
  contactInfo: string;
  /** URL produktového XML feedu (Upgates export) */
  productFeedUrl: string;
  /**
   * Kalibrace odkazu do administrace ve tvaru „cislo_objednavky:ID".
   * Adresa v administraci nese vnitřní ID, ne číslo objednávky; obě řady
   * rostou po jedné, takže z jedné známé dvojice se dopočítají ostatní.
   */
  adminOrderRef: string;
  /** Cesta k logu, které se sází na dárkové poukazy */
  voucherLogo: string;
  /** Výchozí osoba pro podpis nových mailů a odpovědí */
  defaultPersonId: number | null;
  /** Systémové upozornění při nové zprávě */
  notifyNewMail: boolean;
  /** Vzhled aplikace */
  theme: 'light' | 'dark';
}

/** Zadání dárkového poukazu */
export interface VoucherSpec {
  /** Kódy poukazů — pro každý vznikne samostatné PDF na stejnou hodnotu */
  codes: string[];
  value: string;
  /** `shipping` = poukaz na dopravu zdarma, hodnota se pak nezadává */
  unit: 'CZK' | 'EUR' | 'percent' | 'shipping';
  /** Platnost do (ISO datum); prázdné = bez uvedení */
  validUntil: string;
  lang: MailLang;
  /** Drobná poznámka dole na poukazu (např. minimální hodnota nákupu) */
  note: string;
}

/** Šablona dárkového poukazu — hodnota, platnost a zdroj kódů */
export interface VoucherTemplate {
  /** UUID, aby šlo šablony slučovat mezi zařízeními */
  id: string;
  /** Interní název, zákazník ho nikdy neuvidí */
  name: string;
  value: string;
  unit: VoucherSpec['unit'];
  validUntil: string;
  note: string;
  lang: MailLang;
  /** `fixed` = pořád stejný kód, `unique` = odebírá se ze zásoby */
  codeMode: 'fixed' | 'unique';
  fixedCode: string;
  codesTotal: number;
  codesFree: number;
  updatedAt: string;
}

/** Objednávka z Upgates API (živá data e-shopu) */
export interface UpgatesOrder {
  orderNumber: string;
  status: string;
  creationTime: string;
  paidDate: string | null;
  deliveredDate: string | null;
  trackingCode: string | null;
  trackingUrl: string | null;
  total: number;
  currency: string;
  shipmentName: string;
  paymentName: string;
  products: string[];
  adminUrl: string | null;
}

export interface UpgatesConfig {
  url: string;
  login: string;
  hasKey: boolean;
}

/** Jedna položka objednávky vyčtená z potvrzovacího e-mailu */
export interface OrderCardItem {
  qty: number;
  /** Jednotka z mailu („ks", „pcs"…) */
  unit: string | null;
  title: string;
  code: string | null;
  /** Odkaz na produkt přímo z e-mailu */
  url: string | null;
  /** Cena za položku tak, jak je uvedená v mailu */
  price: string;
  availability: string | null;
  /** Varianty produktu z objednávky („Délka: 110cm") — při balení kritické */
  variants: string[];
  /** Obrázek z produktového feedu */
  image: string | null;
  feedUrl: string | null;
  feedPrice: string | null;
  /** Podařilo se položku spárovat s produktem ve feedu */
  matched: boolean;
}

export interface OrderAddress {
  name: string;
  company: string | null;
  lines: string[];
  country: string | null;
}

export type CarrierId = 'packeta' | 'ppl' | 'dpd' | 'cpost' | 'gls' | 'dhl' | 'wedo' | 'gopost';

/** Fáze cesty zásilky — kvůli barevnému rozlišení na první pohled */
export type ShipPhase = 'pending' | 'transit' | 'ready' | 'delivered' | 'problem' | 'unknown';

/** Poslední záznam z cesty zásilky u dopravce */
export interface ShipmentEvent {
  description: string;
  at: string;
  /** Souhrnná fáze, pokud ji dopravce uvádí („Zásilka je na cestě") */
  stage?: string;
  /** Zařazení hlášky pro barevné odlišení */
  phase?: ShipPhase;
}

/** Živá data ze stránky historie objednávky a od dopravce */
export interface OrderTracking {
  /** „page" = čteno ze stránky e-shopu, „api" = doplněno z Upgates API */
  source: 'page' | 'api';
  status: string | null;
  createdAt: string | null;
  paidDate: string | null;
  customerPhone: string | null;
  carrierId: CarrierId | null;
  carrierName: string | null;
  trackingCode: string | null;
  trackingUrl: string | null;
  shipment: ShipmentEvent | null;
  /** Proč se stav u dopravce nenačetl (null = v pořádku) */
  shipmentError: string | null;
}

/** Živý stav objednávky z Upgates API (jen když je API nastavené) */
export interface OrderLive {
  status: string | null;
  paid: boolean;
  paidDate: string | null;
  deliveredDate: string | null;
  trackingCode: string | null;
  trackingUrl: string | null;
  adminUrl: string | null;
}

/** Strukturovaný přehled objednávky z potvrzovacího e-mailu */
export interface OrderCard {
  orderNumber: string | null;
  lang: MailLang;
  placedAt: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  billing: OrderAddress | null;
  shipping: OrderAddress | null;
  items: OrderCardItem[];
  shipmentName: string | null;
  shipmentPrice: string | null;
  paymentName: string | null;
  paymentPrice: string | null;
  total: string | null;
  historyUrl: string | null;
  /** Odkaz do administrace e-shopu */
  adminUrl: string | null;
  /**
   * Odkud odkaz pochází: `api` = přesné ID z Upgates API, `offset` = dopočítané
   * z kalibrace (číslo objednávky vs. ID v administraci), `list` = jen přehled.
   */
  adminSource: 'api' | 'offset' | 'list' | null;
  live: OrderLive | null;
  /** Stav objednávky a zásilky ze stránky e-shopu / od dopravce */
  tracking: OrderTracking | null;
}

/** Objednávka v nástroji na balení */
export interface PackingOrder {
  /** ID zprávy v lokální databázi */
  messageId: number;
  /** Datum přijetí objednávky (ISO) */
  date: string;
  card: OrderCard;
  /** Indexy položek, které už jsou odškrtnuté */
  packed: number[];
  /** Objednávka označená jako zabalená */
  done: boolean;
  doneAt: string | null;
}

export interface PackingScan {
  orders: PackingOrder[];
  /** Stavy nalezené v načtených objednávkách — nabídka filtru se staví z dat */
  statuses: string[];
  scannedAt: string;
}

export interface PackingProgress {
  done: number;
  total: number;
  /** Aktuálně zpracovávaná objednávka */
  label: string | null;
}

/** Shrnutí objednávky pro odznak v seznamu zpráv — bez položek a adres */
export interface OrderBadge {
  orderNumber: string | null;
  total: string | null;
  /** Stav objednávky, jak ho hlásí e-shop („Odeslána", „Vyřizuje se") */
  status: string | null;
  /** Zjednodušení stavu do barvy odznaku */
  tone: 'new' | 'paid' | 'sent' | 'done' | 'problem';
  carrierName: string | null;
  shipmentStage: string | null;
}

export interface KnowledgeDoc {
  id: number;
  title: string;
  content: string;
}

/** Jazykové mutace e-shopu (dle produktového feedu) */
export type MailLang = 'cz' | 'sk' | 'en';

/** Osoba pro podpis e-mailu (kulatá fotka, jméno, pozice a jméno odesílatele v každém jazyce) */
export interface Person {
  id: number;
  name: string;
  positions: Record<MailLang, string>;
  /** Zobrazované jméno odesílatele, např. „Petra z Quentino" / „Petra from Quentino" */
  displayNames: Record<MailLang, string>;
  photoPath: string | null;
}

export interface ContactHit {
  email: string;
  name: string;
}

/** Strukturovaný podpis značky — vše se generuje v jazyce e-mailu (CZ/SK/EN) */
export interface SigConfig {
  phone: string;
  names: Record<MailLang, string>;
  emails: Record<MailLang, string>;
  taglines: Record<MailLang, string>;
  webs: Record<MailLang, string>;
}

export interface ProductHit {
  code: string;
  image: string | null;
  title: Record<MailLang, string>;
  url: Record<MailLang, string>;
  price: Record<MailLang, string>;
  /** Hlavní kategorie z feedu (PRIMARY_YN=1); prázdné, pokud feed kategorie neposílá */
  category?: string;
  /** Všechny kategorie produktu */
  categories?: string[];
  manufacturer?: string;
  /** Text dostupnosti z e-shopu, např. „Skladem více než 20 ks" */
  availability?: string;
  /** Počet kusů skladem; null = feed hodnotu neposlal */
  stock?: number | null;
}

/** Dotaz do katalogu pro prohlížeč produktů (stránkovaně) */
export interface ProductQuery {
  query?: string;
  category?: string;
  /** true = jen produkty se skladovou zásobou > 0 */
  inStockOnly?: boolean;
  sort?: 'title' | 'price' | 'stock';
  offset?: number;
  limit?: number;
  lang?: MailLang;
}

export interface ProductPage {
  items: ProductHit[];
  total: number;
  offset: number;
  limit: number;
}

/** Kategorie v katalogu i s počty produktů — pro filtr v prohlížeči */
export interface ProductFacets {
  categories: { name: string; count: number }[];
  total: number;
}

/** Jak se produkt vloží do těla e-mailu */
export type ProductCardStyle = 'card' | 'compact' | 'image';

export interface FeedStatus {
  url: string;
  count: number;
  lastSync: string | null;
}

export interface CategoryRule {
  field: 'from' | 'subject';
  contains: string;
  category: Category;
}

export interface AiReplyRequest {
  messageDbId: number;
  /** Krátká strohá poznámka od uživatele, ze které AI vytvoří plnou odpověď */
  note: string;
  /** Jazyk odpovědi; 'auto' = jazyk původní zprávy, jinak ISO kód (cs, sk, en…) */
  language: string;
}

export interface SyncState {
  accountId: number;
  syncing: boolean;
  error: string | null;
  lastSync: string | null;
}

export const CATEGORY_LABELS: Record<Category, string> = {
  orders: 'Objednávky',
  people: 'Lidé',
  companies: 'Firmy',
  other: 'Ostatní'
};

export const DEFAULT_BRAND_PROMPT = `Jsi asistent pro psaní e-mailů značky Quentino. Quentino je lovebrand – komunikace je vždy vřelá, pozitivní, lidská a vstřícná. Piš přátelsky, ale profesionálně. Zákazník se má po přečtení cítit dobře. Používej přirozenou češtinu (nebo jazyk konverzace), žádné fráze typu "S pozdravem tým podpory". Buď konkrétní a řeš věc zákazníka.

DŮLEŽITÝ KONTEXT: Quentino je internetový obchod (e-shop). Objednávky ZASÍLÁME přepravcem na adresu zákazníka – osobní vyzvednutí nenabízíme, pokud to ve vlákně není výslovně zmíněno. NIKDY si nevymýšlej fakta: termíny doručení, ceny, stavy objednávek, podmínky vracení apod. uváděj jen tehdy, když vyplývají z e-mailového vlákna nebo z poskytnutých firemních znalostí. Pokud informaci nemáš, formuluj odpověď obecně, nebo napiš, že věc ověříme a ozveme se.`;

/* ==================== Instagram ==================== */

export interface IgAccount {
  id: number;
  igUserId: string;
  username: string;
  /** Kód trhu, ke kterému účet patří (CS, EN, DE…) */
  lang: string;
  color: string;
  /** Zdrojový účet, ze kterého se čerpají příspěvky */
  isSource: boolean;
  tokenExpires: string | null;
  connectedAt: string;
  lastError: string | null;
  /** Facebook stránka, přes kterou účet publikuje */
  pageId: string;
  pageName: string;
  /** Zveřejnit stejný obsah i na té stránce */
  shareFb: boolean;
}

export interface IgMarket {
  lang: string;
  label: string;
  /** Čím se trh liší — jde přímo do promptu */
  note: string;
  /** Hashtagy, ze kterých může model vybírat */
  tags: string;
  color: string;
  enabled: boolean;
}

export interface IgBrand {
  context: string;
  loveOn: boolean;
  love: string;
  tones: string[];
  avoid: string;
  rules: string;
  /** Jak velkou volnost má model v emoji */
  emoji: 'none' | 'sparse' | 'free';
  /** Kolik variant popisku na trh model vytvoří */
  variants: number;
  /** Přibalit ke generování znalostní bázi z Nastavení */
  useKnowledge: boolean;
}

export interface IgConnection {
  hasAppId: boolean;
  hasAppSecret: boolean;
  appId: string;
  callbackUrl: string;
  storage: { url: string; bucket: string; hasKey: boolean };
  autoSync: boolean;
}

export interface IgOverview {
  accounts: IgAccount[];
  /** Kolik účtů má přístup platný míň než 10 dní */
  expiringSoon: number;
  markets: IgMarket[];
  brand: IgBrand;
  connection: IgConnection;
  storageReady: boolean;
  queued: number;
  failed: number;
  hasSource: boolean;
}

export interface IgSourcePost {
  id: number;
  igMediaId: string;
  mediaType: string;
  permalink: string;
  caption: string;
  postedAt: string;
  likeCount: number;
  commentCount: number;
  childCount: number;
  /** Trhy, kde už příspěvek vyšel */
  done: string[];
  /** Trhy, kde je rozepsaný nebo čeká ve frontě */
  pending: string[];
}

export interface IgMediaItem {
  id?: number;
  path: string;
  mime: string;
  isVideo: boolean;
  width?: number | null;
  height?: number | null;
  coverOffset?: number | null;
  /** `ig:<id>` u médií převzatých z vlastního účtu */
  sourceUrl?: string | null;
}

export interface IgCaption {
  id: number;
  lang: string;
  variants: string[];
  chosen: number;
  /** Text, který se opravdu odešle (vybraná varianta nebo ruční úprava) */
  text: string;
  status: 'draft' | 'approved' | 'published';
  edited: boolean;
}

export interface IgPost {
  id: number;
  kind: 'new' | 'source';
  sourcePostId: number | null;
  brief: string;
  mediaNote: string;
  createdAt: string;
  media: IgMediaItem[];
  captions: IgCaption[];
  sourceCaption?: string;
  sourcePermalink?: string;
}

/** Kam publikace míří: jen Instagram, jen Facebook stránka, nebo obojí. */
export type IgChannels = 'ig' | 'fb' | 'ig+fb';

export interface IgJob {
  id: number;
  captionId: number;
  postId: number;
  lang: string;
  username: string;
  color: string;
  state: 'scheduled' | 'publishing' | 'done' | 'failed';
  scheduledAt: string;
  finishedAt: string | null;
  permalink: string | null;
  error: string | null;
  /** Výsledek sdílení na Facebook stránku */
  fbPostId: string | null;
  fbError: string | null;
  channels: IgChannels;
  preview: string;
}

/* ==================== Chat ==================== */

export interface ChatConfig {
  /** Adresa Supabase projektu chatu */
  url: string;
  hasKey: boolean;
  /** Adresa nasazeného chatu (Vercel) — kvůli produktovým kartám */
  apiBase: string;
  ready: boolean;
  /** Kdo odpovídá — osoba ze stejného seznamu jako podpisy v poště */
  operatorPersonId: number | null;
  /** Kdy připojit podpis: jen k první odpovědi, ke každé, nebo nikdy */
  signMode: 'first' | 'always' | 'off';
  /** Co se píše za jméno — „Petra, Quentino" */
  signSuffix: string;
}

export interface ChatOverview {
  config: ChatConfig;
  /** Nepřečtené zprávy celkem */
  unread: number;
  /** Kolik konverzací čeká na odpověď */
  waiting: number;
  persons: { id: number; name: string; short: string }[];
}

export interface ChatConversation {
  id: string;
  sessionId: string;
  status: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  /** cs | sk | en */
  locale: string;
  lastMessageAt: string;
  unread: number;
  channel: string;
  createdAt: string;
  /** Kdy zákazník zavřel widget */
  leftAt: string | null;
  /** Poslední zpráva je od nás — odpovězeno (i z Telegramu nebo webového adminu) */
  answered: boolean;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  sender: 'customer' | 'operator' | 'system' | string;
  content: string;
  contentType: string | null;
  createdAt: string;
  readAt: string | null;
}

export interface ChatProduct {
  id: string;
  name: string;
  price: string;
  imgUrl: string;
  url: string;
  domain: string;
}

/* ---------- Překlady produktů ---------- */

export type PtransState = 'missing' | 'same' | 'source' | 'ok' | 'stale' | 'manual';

export interface PtransLanguage {
  code: string;
  label: string;
  enabled: boolean;
}

export interface PtransSettings {
  sourceLang: string;
  languages: PtransLanguage[];
  fields: Record<string, boolean>;
  prompt: string;
  glossary: { source: string; targets: Record<string, string> }[];
  googleTitle: Record<string, string>;
  limits: {
    seoTitle: number; seoDesc: number;
    googleTitle: number;
    /** Kolik z titulku Google v inzerátu zobrazí — sem se cílí */
    googleTitleVisible: number;
    googleDesc: number;
  };
  model: string;
  concurrency: number;
  secondsPerUnit: number;
}

export interface PtransProduct {
  code: string;
  title: string;
  image: string | null;
  category: string;
  manufacturer: string;
  availability: string;
  price: string;
  active: boolean;
  /** Z online feedu, nebo z ručně nahraného souboru */
  origin: 'feed' | 'file';
  /** Stav po jazycích — kolik polí čeká z celkového počtu */
  states: Record<string, { total: number; todo: number; worst: PtransState }>;
  /** Jazyky, kde je hotové úplně všechno */
  doneLangs: string[];
  /** Jazyky, kde ještě něco chybí */
  todoLangs: string[];
}

/* ---------- Google Nákupy a audit ---------- */

export type PtransGoogleField = 'google_title' | 'google_desc' | 'google_color' | 'google_gender'
  | 'google_age' | 'google_condition' | 'google_bundle' | 'google_identifier';

export interface PtransGoogleView {
  lang: string;
  fields: {
    field: PtransGoogleField;
    label: string;
    value: string;
    /** Co je právě teď ve feedu */
    feed: string;
    /** Co by aplikace zapsala */
    suggested: string;
    manual: boolean;
  }[];
  /** Proč vyšel set tak, jak vyšel */
  bundleReason: string;
  bundleLearned: boolean;
}

export interface PtransColorRule {
  source: string;
  base: string;
  hits: number;
  origin: 'feed' | 'rule' | 'manual';
  locked: boolean;
}

export interface PtransBaseColor {
  key: string;
  labels: Record<string, string>;
}

export interface PtransBundleRule {
  category: string;
  pattern: string;
  isBundle: boolean;
  hits: number;
  updatedAt: string | null;
}

export interface PtransAttributeRules {
  gender: { match: string; value: 'male' | 'female' | 'unisex' }[];
  age: { match: string; value: 'adult' | 'kids' | 'infant' | 'newborn' | 'toddler' }[];
  defaultGender: 'male' | 'female' | 'unisex';
  defaultAge: 'adult' | 'kids' | 'infant' | 'newborn' | 'toddler';
  condition: 'new' | 'refurbished' | 'used';
}

export type PtransSeverity = 'error' | 'warn' | 'info';

export interface PtransIssue {
  key: string;
  severity: PtransSeverity;
  message: string;
  field?: string;
  /** Aplikace to umí spravit sama */
  fixable?: boolean;
}

export interface PtransAudit {
  code: string;
  title: string;
  lang: string;
  score: number;
  issues: PtransIssue[];
}

export interface PtransAuditSummary {
  checked: number;
  averageScore: number;
  byLang: { lang: string; average: number; errors: number; warnings: number }[];
  top: { key: string; severity: PtransSeverity; message: string; count: number }[];
}

export interface PtransField {
  code: string;
  lang: string;
  field: string;
  /** Co je v feedu */
  value: string;
  /** Odpovídající zdrojový text */
  source: string;
  state: PtransState;
  /** Náš překlad, pokud existuje */
  translated: string | null;
  translatedAt: string | null;
  model: string;
  manual: boolean;
}

export interface PtransProgress {
  running: boolean;
  done: number;
  total: number;
  failed: number;
  /** Odhad zbývajícího času podle naměřené rychlosti */
  etaSeconds: number | null;
  secondsPerUnit: number;
  label: string;
  errors: string[];
}

export interface PtransOverview {
  settings: PtransSettings;
  feed: { syncedAt: string | null; products: number };
  langs: { lang: string; todo: number; total: number; byState: Record<string, number> }[];
  running: PtransProgress | null;
  /** Kolik odstínů se umí převést na základní barvu pro Google */
  colors: { shades: number; mapped: number; missing: string[] };
  googleRules: PtransAttributeRules;
}

/** Znalost naučená z hotových překladů — nebo ručně dopsaná. */
export type PtransMemoryKind = 'term' | 'pattern' | 'example';

export interface PtransMemoryEntry {
  id?: number;
  kind: PtransMemoryKind;
  lang: string;
  source: string;
  target: string;
  category: string;
  hits: number;
  confidence: number;
  origin: 'feed' | 'manual';
  locked: boolean;
  updatedAt?: string;
}

export interface PtransMemoryStat {
  lang: string;
  terms: number;
  patterns: number;
  examples: number;
  manual: number;
}

export interface PtransLearnResult {
  lang: string;
  pairs: number;
  terms: number;
  patterns: number;
  examples: number;
}

export interface PtransPage {
  rows: PtransProduct[];
  total: number;
  todo: number;
}

export interface PtransQuery {
  search?: string;
  category?: string;
  manufacturer?: string;
  lang?: string;
  state?: PtransState | 'todo' | 'all';
  field?: string;
  onlyActive?: boolean;
  /** `file` = pracovat jen s tím, co bylo nahráno ze souboru */
  origin?: 'all' | 'feed' | 'file';
  limit?: number;
  offset?: number;
  sort?: 'title' | 'todo' | 'code';
}

export interface PtransPattern {
  category: string;
  lang: string;
  /** Tvar názvu odvozený z hotových překladů, např. „Men's {…} tie" */
  pattern: string;
  samples: number;
  matching: number;
}

export interface PtransDeviation {
  code: string;
  title: string;
  translated: string;
  category: string;
  lang: string;
  pattern: string;
}

export interface PtransConsistency {
  patterns: PtransPattern[];
  deviations: PtransDeviation[];
}

/* ==================== Články ==================== */

export interface ArticleLanguage {
  code: string;
  label: string;
  enabled: boolean;
  /** Doména trhu — z ní se skládají odkazy v článku */
  domain: string;
}

export interface ArticleSettings {
  sourceLang: string;
  languages: ArticleLanguage[];
  prompt: string;
  wordCount: number;
  model: string;
  researchTerms: boolean;
  productPrefix: string;
  articlePrefix: string;
}

export interface ArticleBrief {
  products: string[];
  productImages: Record<string, string>;
  includeProductImages: boolean;
  productLayout: 'block' | 'left' | 'right';
  productSize: 'small' | 'medium' | 'large';
  images: { url: string; description: string; size: 'auto' | 'small' | 'medium' | 'full';
    layout: 'block' | 'left' | 'right'; isListing?: boolean }[];
  links: { name: string; urls: Record<string, string> }[];
  titleFixed: boolean;
  title: string;
}

export type ArticleVersionState = 'empty' | 'generated' | 'manual' | 'translated' | 'imported';

export interface ArticleVersion {
  lang: string;
  title: string;
  slug: string;
  short: string;
  long: string;
  seo_title: string;
  seo_desc: string;
  seo_url: string;
  state: ArticleVersionState;
  updatedAt: string | null;
  /** Viditelná slova — bez HTML značek */
  words: number;
}

export interface ArticleRow {
  id: number;
  articleId: string | null;
  topic: string;
  status: 'draft' | 'ready';
  sourceLang: string;
  wordCount: number;
  langs: string[];
  prompt: string;
  brief: ArticleBrief;
  terms: string;
  origin: 'new' | 'import';
  createdAt: string;
  updatedAt: string;
}

export interface ArticleListRow extends ArticleRow {
  /** Název v zdrojovém jazyce — v seznamu se ukazuje přednostně */
  title: string;
  versions: { lang: string; state: string; words: number }[];
}

export interface ArticleDetail extends ArticleRow {
  versions: ArticleVersion[];
}

export interface ArticleProgress {
  running: boolean;
  done: number;
  total: number;
  failed: number;
  label: string;
  chars: number;
  errors: string[];
}

export interface ArticleCheckProgress {
  running: boolean;
  done: number;
  total: number;
  broken: number;
  label: string;
}

export interface ArticleLinkCheck {
  id?: number;
  articleId: number;
  articleTitle: string;
  lang: string;
  url: string;
  kind: string;
  status: number | null;
  suggestion: string | null;
  note: string;
  /** Server neodpověděl — o odkazu nevíme nic, není to totéž co rozbitý */
  unverified?: boolean;
}

export interface ArticleUrlPair {
  fromLang: string;
  fromPath: string;
  toLang: string;
  toPath: string;
  kind: string;
  hits: number;
  locked: number;
  updatedAt: string | null;
}

export interface ArticleOverview {
  settings: ArticleSettings;
  summary: { total: number; drafts: number; byLang: { lang: string; n: number }[] };
  running: ArticleProgress | null;
  checking: ArticleCheckProgress | null;
  urlmap: number;
}

export interface ArticleProduct {
  code: string;
  title: string;
  url: string;
  image: string | null;
}
