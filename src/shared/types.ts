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
  /** Číslo objednávky z rejstříku, když se ke zprávě podařilo přiřadit */
  orderNumber?: string | null;
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
  /** Hlavička Reply-To, když ji odesílatel poslal */
  replyTo?: string;
  /**
   * Komu doopravdy odpovědět.
   *
   * U zpráv z formuláře na webu je v `From` adresa e-shopu, ne zákazníka —
   * odpověď by skončila u poskytovatele. Skutečný kontakt je v textu zprávy.
   */
  replyTarget?: {
    address: string;
    name: string;
    /** `reply-to` · `formulář` · `odesílatel` — do popisku v rozhraní */
    source: string;
    /** Telefon, který zákazník do formuláře napsal */
    phone: string;
    /** Který formulář to byl */
    form: string;
  };
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
   * Rychlý feed jen se zásobami a cenami. Velký katalog se obnovuje jednou
   * denně, tenhle po dvou hodinách — proto se z něj berou skladová množství.
   */
  stockFeedUrl: string;
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
  /**
   * Upozornění na telefon přes ntfy.
   *
   * Push přímo do vlastní aplikace by znamenal placený účet u Applu, takže
   * notifikace doručuje aplikace ntfy — stačí POST na adresu s tajným názvem
   * tématu. Název tématu je zároveň heslo: kdo ho zná, čte i posílá.
   */
  notifyPhone: boolean;
  /** Adresa serveru ntfy; prázdné = veřejný ntfy.sh */
  notifyServer: string;
  /**
   * Název tématu. Chová se jako heslo — kdo ho zná, notifikace čte i posílá.
   * Ukládá se ale načisto, protože se musí dostat i do telefonu přes sdílenou
   * složku; šifrování klíčem konkrétního počítače by to znemožnilo.
   */
  notifyTopic: string;
  notifyPhoneMail: boolean;
  notifyPhoneChat: boolean;
  /**
   * Upozornit i z telefonu, když si poštu najde sám na pozadí.
   *
   * Když zároveň běží počítač, může upozornění přijít dvakrát — jedno přes
   * ntfy z počítače, druhé rovnou z aplikace. Telefon nemá jak zjistit, že to
   * počítač už ohlásil, takže je to na přepínači, ne na hádání.
   */
  notifyPhoneLocal: boolean;
  /** Vzhled aplikace */
  theme: 'light' | 'dark';
}

/** Na co se upozorňuje — pošta, nebo chat */
export type NotifyKind = 'mail' | 'chat';

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
  /** Kolik volných kódů má zamluvených tohle zařízení (zbytek si drží ostatní) */
  codesMine: number;
  /** Kolik kódů vydala dvě zařízení — mělo by být vždycky 0 */
  codesDup: number;
  updatedAt: string;
}

/** Jeden kód ze zásoby šablony */
export interface VoucherCode {
  code: string;
  usedAt: string | null;
  usedFor: string;
  /** Kdo kód vydal — prázdné u kódů vydaných starší verzí aplikace */
  usedBy: string;
  /** Kód si dopředu zamluvilo jiné zařízení, tohle po něm nesáhne */
  claimedElsewhere: boolean;
  /** Druhé vydání téhož kódu, pokud se na nějaké přišlo */
  duplicate: string;
}

/** Kód, který podle synchronizace vydala dvě zařízení naráz */
export interface VoucherClash {
  templateId: string;
  templateName: string;
  code: string;
  /** Vydání, které platí (dřívější) */
  used: string;
  usedFor: string;
  /** To druhé, „zařízení@čas“ */
  duplicate: string;
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

/* ---------- objednávky z feedu e-shopu ---------- */

export interface ShopOrderItem {
  title: string;
  code: string;
  quantity: number;
  price: number;
}

/** Adresa z exportu objednávek */
export interface ShopAddress {
  /** Jméno příjemce; u firmy zůstává i tak, protože balík přebírá člověk */
  name: string;
  company: string;
  street: string;
  city: string;
  zip: string;
  /** Kód země, jak ho vede e-shop („CZ", „SK") */
  country: string;
  /** Kraj nebo stát — u nás bývá prázdné, u zahraničních zásilek ne */
  state: string;
}

export interface ShopOrder {
  code: string;
  /** cz | sk | en — čísla objednávek se mezi trhy opakují */
  market: string;
  status: string;
  paid: boolean;
  paidDate: string;
  resolved: boolean;
  invoice: string;
  createdAt: string;
  updatedAt: string;
  currency: string;
  total: number;
  tracking: string;
  customerId: string;
  name: string;
  email: string;
  /** Už v mezinárodním tvaru, takže na něj jde rovnou zavolat */
  phone: string;
  shipment: string;
  payment: string;
  items: ShopOrderItem[];
  /**
   * Fakturační a doručovací adresa.
   *
   * Doručovací nemusí být vyplněná — pak se doručuje na fakturační. U výdejních
   * míst je v ní adresa toho místa, ne zákazníka, což je při balení to, co se
   * čte.
   */
  billing: ShopAddress | null;
  postal: ShopAddress | null;
}

export interface OrderFeed {
  id: string;
  label: string;
  /** Obsahuje tajný klíč — ukládá se šifrovaně */
  url: string;
  market: string;
  everyMinutes: number;
  /** Feed jen s posledními 24 h — tahá se často, ale nepokrývá historii */
  recent: boolean;
  enabled: boolean;
}

/** Feed pro rozhraní: bez celé adresy, zato se stavem posledního stažení. */
export interface OrderFeedStatus {
  id: string;
  label: string;
  market: string;
  recent: boolean;
  enabled: boolean;
  everyMinutes: number;
  urlHint: string;
  orders: number;
  newest: string;
  lastSync: string;
  lastError: string;
}

/**
 * Projekt Supabase a jak dlouho je od něj ticho.
 *
 * Bezplatný tarif projekt po několika dnech bez jediného dotazu uspí.
 * Aplikace jich používá víc a můžou být i společné — proto se sledují podle
 * hostitele a `uses` říká, k čemu všemu ten který slouží.
 */
export interface SupabaseStatus {
  host: string;
  uses: string[];
  lastSeen: string;
  /** -1 = projekt se zatím neozval */
  idleDays: number;
  warn: boolean;
}

export interface OrderStats {
  total: number;
  withPhone: number;
  markets: { market: string; n: number }[];
}

/** Kontakt dohledaný k e-mailu nebo číslu objednávky. */
export interface OrderContact {
  phone: string;
  name: string;
  order: ShopOrder | null;
  orders: number;
  /** Podle čeho se to našlo — do rozhraní, ať je vidět, odkud číslo je */
  via: string;
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
  /** Indexy položek, které už jsou odškrtnuté celé */
  packed: number[];
  /**
   * Index položky → kolik kusů z ní už je v krabici.
   *
   * U „3 ks" nestačí zaškrtávátko: dokud se počítalo po položkách, nešlo
   * poznat, jestli v krabici leží jeden kus, nebo všechny tři.
   */
  counts: Record<string, number>;
  /** Objednávka označená jako zabalená */
  done: boolean;
  doneAt: string | null;
  /** Stav z feedu e-shopu — u starších objednávek to jediné aktuální */
  shop?: PackingShopState | null;
  /**
   * Odkud jsou podklady: `mail` = potvrzovací e-mail (má navíc adresu),
   * `feed` = objednávka z feedu e-shopu, ke které mail nemáme.
   */
  source?: 'mail' | 'feed';
}

/** Výsledek hledání objednávky podle čísla z faktury */
export type PackingLookup =
  | { ok: true; order: PackingOrder }
  | {
      ok: false;
      /** Kde to skončilo: číslo ve feedu není, nebo k němu nejsou položky */
      reason: 'noNumber' | 'notInFeed' | 'noItems';
      message: string;
    };

/** Stav odškrtání jedné objednávky */
export interface PackingState {
  packed: number[];
  counts: Record<string, number>;
  done: boolean;
  doneAt: string | null;
}

/** Výsledek načtení kódu při balení — co se odškrtlo a co ještě chybí */
export interface PackingHit {
  ok: boolean;
  /** Proč se nic nepřičetlo: kód není v objednávce, nebo už je vše odškrtnuté */
  reason?: 'empty' | 'noOrder' | 'notInOrder' | 'already';
  index?: number;
  code?: string | null;
  title?: string;
  /** Kolik kusů položky je v krabici po tomhle načtení */
  count?: number;
  qty?: number;
  /** Kolik kusů téže položky ještě chybí — kvůli upozornění */
  needMore?: number;
  message: string;
}

/**
 * Stav objednávky z feedu e-shopu.
 *
 * U starší objednávky je feed to jediné, co je aktuální — potvrzovací mail
 * říká, co si zákazník objednal, ale ne že je zásilka dávno doručená.
 */
export interface PackingShopState {
  /** Číslo objednávky, jak ho vede e-shop */
  code: string;
  /** Číslo faktury — na faktuře je jiné než číslo objednávky */
  invoice: string;
  status: string;
  /** Kdy se objednávka naposledy změnila (z feedu), pokud je to známo */
  at: string | null;
  /** Konečný stav: doručeno, storno, vráceno… */
  final: boolean;
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
  /**
   * Doprava a platba ve zkratce — „Zásilkovna", „Dobírka".
   *
   * Na telefonu je to to jediné, co se na odznak vejde, a taky to jediné,
   * co se z něj ráno čte: jestli balík jde na výdejnu nebo domů a jestli je
   * zaplaceno, nebo se bude vybírat dobírka. Zkratky se dají doladit
   * v nastavení; bez toho platí odhad.
   */
  shipmentShort: string | null;
  paymentShort: string | null;
}

/**
 * Slovník zkratek i s tím, z čeho se sestavil.
 *
 * Kdyby zůstal prázdný, `scope` je jediné, co řekne proč: jestli nejsou
 * stažené objednávky, nebo jestli stažené jsou, ale doprava v nich chybí.
 */
export interface ShorthandView {
  rows: ShorthandRow[];
  scope: { orders: number; withShipment: number; withPayment: number };
}

/**
 * Řádek slovníku — jeden **dopravce nebo způsob platby**, ne jeden název.
 *
 * Ve feedu není „Zásilkovna", ale konkrétní výdejna („PPL ParcelBox - ABOX
 * BRN Kounicova (Billa)"). Názvů jsou stovky, jeden na pobočku, a na odznaku
 * má stát „PPL", ať je to kterákoli — proto se slučují do rodin.
 */
export interface ShorthandRow {
  kind: 'shipment' | 'payment';
  /** Jméno rodiny — „PPL", „Zásilkovna", „Dobírka" */
  name: string;
  /** Zadaná zkratka; prázdné = platí jméno rodiny */
  short: string;
  guess: string;
  /** U kolika objednávek se rodina vyskytla */
  count: number;
  /** Kolik různých názvů do ní spadá — u dopravy desítky poboček */
  distinct: number;
  /** Pár názvů na ukázku, aby bylo vidět, co se slilo dohromady */
  samples: string[];
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
  /**
   * Varianty i se zásobou, rovnou u karty v seznamu.
   *
   * Souhrn na produktu sečítá všechny délky dohromady, takže „14 ks" nic
   * neříká o tom, jestli je na regálu ta jedna délka, která zrovna došla —
   * a kvůli tomu se dřív musela otevírat karta u každého produktu zvlášť.
   */
  variants?: ProductHitVariant[];
}

/** Varianta ve výpisu katalogu — jen to, co se vejde na kartu */
export interface ProductHitVariant {
  code: string;
  /** „Délka: 120cm" */
  label: string;
  stock: number | null;
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
  /**
   * Kolik variant katalog zná. Nula u neprázdného katalogu znamená, že se
   * feed stahoval starší verzí aplikace — varianty se tehdy neukládaly.
   */
  variants?: number;
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
  /**
   * Kdy se naposledy povedlo projekt oťukat.
   *
   * Bezplatný tarif Supabase projekt po několika dnech bez jediného dotazu
   * uspí a chat na webu přestane fungovat. Aplikace ho drží vzhůru, ale jen
   * když sama běží — proto je to vidět v nastavení.
   */
  lastSeen: string;
  /** Kolik dní je projekt bez ozvání; -1 = zatím se neozval nikdy */
  idleDays: number;
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
  /** Odkaz do e-shopu, ať jde produkt otevřít a podívat se, jak vypadá */
  url: string;
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
  /** Naplnění pruhu 0–1. Počítá se i z rozjetých volání, aby se pruh hýbal
   *  plynule a ne skokem po celých produktech. */
  bar: number;
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
  /** `messy` = produkty s balastem v HTML popisu (obal z chatu, prázdné `<div>`) */
  state?: PtransState | 'todo' | 'messy' | 'all';
  field?: string;
  onlyActive?: boolean;
  /** `file` = pracovat jen s tím, co bylo nahráno ze souboru */
  origin?: 'all' | 'feed' | 'file';
  /** Jen tyhle kódy — pro dotažení čerstvého stavu konkrétních produktů */
  codes?: string[];
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

/** Návrh, jak vybočující název srovnat. Nic se nepřepisuje bez potvrzení. */
export interface PtransFixProposal {
  code: string;
  lang: string;
  category: string;
  current: string;
  suggested: string;
  pattern: string;
  /** Čím se návrh liší — pořadí slov, velká písmena, jiný tvar */
  note: string;
}

/** Dvojice variant k porovnání — jedna otázka na kategorii, jazyk a druh textu. */
export interface PtransTrial {
  id: number;
  code: string;
  lang: string;
  field: string;
  category: string;
  variantA: string;
  variantB: string;
  chosen: string;
  createdAt: string;
  title?: string;
}

/** Tvar, který si uživatel pro kategorii vybral. */
export interface PtransStyle {
  lang: string;
  category: string;
  kind: string;
  example: string;
  rejected: string;
  hits: number;
  updatedAt: string;
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

/* ---------- Úklid schránky na serveru ---------- */

/** Jedna zpráva, kterou by šlo stáhnout k sobě a uvolnit tím místo na serveru. */
export interface CleanupItem {
  folder: string;
  uid: number;
  subject: string;
  from: string;
  date: string;
  /** Velikost na serveru v bajtech — podle ní se řadí, co uvolní nejvíc */
  size: number;
  attachments: boolean;
}

export interface CleanupScan {
  /** Největší napřed; delší seznamy se ořezávají, `count` platí za všechny */
  items: CleanupItem[];
  count: number;
  bytes: number;
  folders: string[];
  /** Koš se neuklízí, ale vysypat ho je uvolnění zadarmo */
  trash: { folder: string; count: number } | null;
}

export interface CleanupProgress {
  phase: 'scan' | 'save' | 'delete' | 'done';
  folder?: string;
  done?: number;
  total?: number;
  subject?: string;
}

/* ---------- Katalog: varianty, sklad, čtečka ---------- */

/** Varianta produktu — vlastní kód, vlastní zásoba. */
export interface ProductVariant {
  code: string;
  productCode: string;
  /** „Délka: 120cm" — z parametrů, které variantu odlišují */
  label: string;
  ean: string;
  availability: string;
  stock: number | null;
  price: string;
  main: boolean;
}

export interface ProductDetail extends ProductHit {
  ean: string;
  /** Kdy dorazila zásoba z rychlého feedu (ne kdy se načetl katalog) */
  stockAt: string | null;
  variants: ProductVariant[];
}

/** Napovídání do naskladnění: produkt i s variantami, aby šlo vybrat konkrétní. */
export interface CatalogSuggestion {
  code: string;
  title: string;
  image: string | null;
  stock: number | null;
  price: string;
  variants: ProductVariant[];
}

/** Co se našlo pod načteným kódem — produkt, nebo konkrétní varianta. */
export interface ScanHit {
  code: string;
  productCode: string;
  title: string;
  label: string;
  image: string | null;
  stock: number | null;
  availability: string;
  isVariant: boolean;
}

/* ---------- Naskladnění (naskladnění) ---------- */

export interface StockinSession {
  id: string;
  title: string;
  note: string;
  /** Zařízení, na kterém naskladnění vznikla — u regálu se hodí vědět */
  device: string;
  state: 'open' | 'sent';
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
  /** Kolik různých položek a kolik kusů celkem */
  lines: number;
  pieces: number;
}

export interface StockinItem {
  code: string;
  productCode: string;
  title: string;
  label: string;
  qty: number;
  /** Zásoba v okamžiku načtení — podle ní se pozná, že se mezitím prodalo */
  stockBefore: number | null;
  addedAt: string;
}

/** Řádek připravený k zápisu do e-shopu. */
export interface StockinPlanRow {
  code: string;
  title: string;
  label: string;
  qty: number;
  /** Vnitřní čísla z feedu — bez nich Upgates zápis nepřijme */
  productId: string;
  variantId: string;
  stockNow: number | null;
  stockBefore: number | null;
  /** Zásoba se od načtení změnila */
  moved: boolean;
}

/**
 * Řádek, který se do formuláře v administraci nedostal — a proč.
 *
 * Bez důvodu byla jediná zpětná vazba „3 se nepodařilo" a nedalo se poznat,
 * jestli chybí vnitřní číslo z feedu, nebo se nenašla varianta. Jsou to dvě
 * úplně jiné opravy: první se spraví stažením feedu, druhá ručním dodáním.
 */
export interface SkippedRow extends StockinPlanRow {
  reason: string;
}

/**
 * Nastavení pro štítkovou tiskárnu (role, ne archy).
 *
 * Rozměr je v milimetrech a rozlišení v dpi, protože právě tak to má
 * tiskárna napsané na krabici — přepočet na body si udělá aplikace.
 */
export interface RollLabel {
  widthMm: number;
  heightMm: number;
  /** 203 dpi je běžná, 300 dpi mívají dražší modely */
  dpi: 203 | 300;
  /** Velikost QR v milimetrech; zbytek štítku patří textu */
  qrMm: number;
  /** Výška písma pod kódem v milimetrech */
  textMm: number;
  /** Tisknout i název produktu */
  withTitle: boolean;
}

/** Do čeho se štítky vyvezou. */
export type LabelFormat = 'pdf' | 'zpl' | 'csv';

/**
 * Co se na štítek z role vejde a kam se to položí.
 *
 * Jeden výpočet pro rozhraní i pro sazbu — rozhraní ukazuje `qrMm` dopředu,
 * sazba používá souřadnice. Dvě kopie by se rozešly a text by přetekl.
 */
export interface ZplPlan {
  /** Zvětšení QR modulu; ZPL bere 1 až 10 */
  magnification: number;
  /** Jak velké QR z toho doopravdy vyjde */
  qrMm: number;
  qrDots: number;
  widthDots: number;
  heightDots: number;
  qrX: number;
  qrY: number;
  codeY: number;
  codeH: number;
  nameY: number;
  nameH: number;
  /** QR i s textem se do štítku nevešly a muselo se zmenšit */
  shrunk: boolean;
  /** Ani po zmenšení není QR na co číst */
  tooSmall: boolean;
}

/** Nastavení tisku štítků s kódem. */
export interface LabelLayout {
  /** Sloupců a řádků na stránku A4 */
  cols: number;
  rows: number;
  /** Okraje stránky v milimetrech */
  marginTop: number;
  marginSide: number;
  /** Vodorovná mezera mezi štítky v milimetrech */
  gap: number;
  /**
   * Svislá mezera. Chybí-li, platí `gap` — u archů, kde na sebe řady
   * navazují bez mezery, se ale musí dát nastavit zvlášť.
   */
  gapY?: number;
  /**
   * Tvar štítku. U kulatých se obsah musí vejít do kruhu, ne do políčka —
   * do rohů by se tisklo mimo štítek.
   */
  shape?: 'rect' | 'round';
  /**
   * Volný okraj uvnitř štítku v milimetrech.
   *
   * Rezerva na nepřesnost tisku: papír se do tiskárny nikdy nezavede na
   * desetinu milimetru přesně a u kulatých štítků se odchylka pozná hned.
   */
  safe?: number;
  /**
   * Posun celého archu v milimetrech — když konkrétní tiskárna tiskne
   * soustavně o kousek vedle, srovná se to tady místo přesouvání papíru.
   */
  offsetX?: number;
  offsetY?: number;
  /** Z jaké šablony rozvržení vzniklo (kvůli výběru v rozhraní) */
  template?: string;
  /** Velikost QR kódu v milimetrech */
  qr: number;
  /** Velikost textu pod kódem v bodech */
  fontSize: number;
  /** Tisknout i název produktu, ne jen kód */
  withTitle: boolean;
  /** Tenká linka kolem každého štítku — pomůcka při stříhání */
  cutLines: boolean;
}

/* ---------- živé propojení telefonu a počítače ---------- */

/** Stav spojení se Supabase Realtime */
export interface LiveStatus {
  enabled: boolean;
  channel: string;
  connected: boolean;
  error: string | null;
}

/**
 * Rozdělaná práce z druhého zařízení, nabídnutá proužkem dole.
 *
 * Nabídka, ne příkaz: data se uloží hned, ale okno se otevře, teprve když
 * na proužek někdo klepne. Vyskočit přes rozepsanou odpověď zákazníkovi jen
 * proto, že někdo u regálu pípnul čtečkou, by bylo horší než nic.
 */
export interface LiveOffer {
  /** `stockin:<id>` nebo `packing:<číslo objednávky>` */
  key: string;
  kind: 'stockin' | 'packing';
  /** Co otevřít: id naskladnění, u balení číslo objednávky */
  id: string;
  /** Odkud to přišlo, do hlášky */
  from: string;
  title: string;
  detail: string;
  at: string;
}
