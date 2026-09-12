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
  /** Model na rozbor v AI Přehledu — tam jde o uvažování, ne o formulaci */
  insightModel: string;
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
  /**
   * Poznámka zákazníka k objednávce („zvoňte na Nováka").
   *
   * Ve feedu je `CUSTOMER_NOTE`. Do vývozu dopravcům se dostane jen tehdy,
   * když se na to člověk podívá a schválí to — je to text od zákazníka
   * a jde na štítek, který uvidí kurýr.
   */
  note: string;
  /**
   * Výdejní místo.
   *
   * `pickupId` je číslo, kterým ho zná dopravce — bez něj se u Zásilkovny
   * zásilka založit nedá, protože jejich API chce číslo místa, ne adresu.
   * `pickupName` je jeho název; podle něj se místo pozná i tehdy, když
   * číslo ve feedu není.
   */
  pickupId: string;
  pickupName: string;
  /** Váha celé objednávky v gramech, jak ji spočítal e-shop */
  weight: number;
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
  /**
   * Poznámka zákazníka k objednávce.
   *
   * Při balení je to to nejdůležitější, co se dá přehlédnout: „pošlete až
   * po 20.“, „přidejte dárkové balení“. V potvrzovacím e-mailu nebývá,
   * takže se dotahuje z feedu podle čísla objednávky.
   */
  note?: string | null;
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
 * Zkratky dopravy a platby dohledané rovnou podle čísla z předmětu.
 *
 * Celý odznak (`orders:badge`) se ptá e-shopu na stav a dopravce na zásilku
 * a než se vrátí, ukazuje řádek jen číslo s částkou z předmětu. Na telefonu
 * je to ale právě to, co se nahradit mělo — proto tahle krátká cesta: jeden
 * dotaz do databáze, žádná síť.
 */
/* ---------- AI Přehled ---------- */

/**
 * Tržba se nesčítá přes měny.
 *
 * E-shop prodává na víc trhů a součet korun s eury by nedal ani jedno.
 * Drží se proto částka ke každé měně zvlášť; převažující měna je první.
 */
export interface DigestMoney {
  currency: string;
  amount: number;
}

/** Souhrn za období — den, měsíc, srovnávané období */
export interface DigestTotals {
  orders: number;
  /** Stornované se nepočítají do tržby, ale je potřeba o nich vědět */
  cancelled: number;
  /** Nezaplacené (dobírka, nedoplacený převod) */
  unpaid: number;
  revenue: DigestMoney[];
  /** Kusů zboží celkem */
  items: number;
}

/** Řez daty — země, dopravce, platba */
export interface DigestSlice {
  key: string;
  label: string;
  orders: number;
  revenue: number;
  /**
   * Rozpad uvnitř řádku — u dopravce podle platby.
   *
   * „Zásilkovna 44×" je půl odpovědi; jestli se u ní platí kartou nebo
   * dobírkou, rozhoduje o penězích i o práci na výdejně. Ukazuje se po
   * najetí myší, aby to nezabralo místo těm, koho to nezajímá.
   */
  split?: { label: string; orders: number }[];
}

export interface DigestProduct {
  /** Kód **produktu**, ne varianty — 110 a 120 cm jsou tytéž šle */
  code: string;
  title: string;
  qty: number;
  orders: number;
  revenue: number;
  /**
   * Tržba je dopočítaná z ceníku.
   *
   * Feed u některých položek cenu nenese (dárek, sada, starší objednávka).
   * Vypsat u nich nulu vypadalo jako chyba, tak se vezme cena z katalogu —
   * ale musí být poznat, že je to odhad.
   */
  estimated: boolean;
  /**
   * Odkud se cena vzala.
   *
   * `feed` = z objednávky, `ceník` = z katalogu, `jinde` = z ceny, za kterou
   * se totéž prodalo v jiné objednávce, `jiná měna` = prodalo se, ale jen na
   * jiném trhu (částka je v `revenueAll`), `neznámá` = nedá se zjistit. Bez
   * tohohle se „0 Kč" u kapesníčku nedalo odlišit od skutečné nuly — a
   * v postřezích se z toho stalo tvrzení, že se zboží prodává zadarmo.
   */
  priceSource: 'feed' | 'ceník' | 'jinde' | 'jiná měna' | 'neznámá';
  /**
   * Tržba ve **všech** měnách, ve kterých se zboží prodalo.
   *
   * `revenue` je jen převažující měna — podle ní se řadí a kreslí pruhy.
   * Zboží, které jde hlavně do zahraničí, by v ní ale mělo nulu, a z nuly
   * se v postřezích stalo „prodává se zadarmo". Tady je vidět celá pravda:
   * 350 Kč + 14 €.
   */
  revenueAll: DigestMoney[];
  /** Obrázek z katalogu — v seznamu se zboží pozná dřív očima než čtením */
  image?: string | null;
  /** Kam se prodávalo — první tři země podle kusů */
  countries?: { key: string; label: string; qty: number }[];
  /** Kusů za předchozí stejně dlouhé období — z toho je vidět pohyb */
  prevQty?: number;
  /** Průměrná cena za kus v převažující měně; 0 = neznáme */
  unit?: number;
  /**
   * Věta, proč to tady je.
   *
   * Číslo bez výkladu se čte deset vteřin a stejně z něj nic nevyplyne.
   * Tahle věta se **počítá v kódu** z týchž čísel, co jsou vedle — není to
   * odhad od AI a dá se ověřit.
   */
  note?: string;
  /** Které varianty se pod produktem prodaly — 110 cm 4×, 120 cm 2× */
  variants: { label: string; qty: number }[];
}

/**
 * Jak se prodávají velikosti — **uvnitř kategorie**.
 *
 * Napříč celým e-shopem to nedávalo smysl: kšandy se měří v centimetrech
 * délky, kravaty v šířce, pásky v obvodu pasu. Sečíst je dohromady znamená
 * sečíst různé věci. Uvnitř kategorie je to naopak přesně ta otázka, která
 * rozhoduje o skladu: kterou délku kšand držet ve všech barvách.
 */
export interface DigestSizeGroup {
  /** Kategorie z katalogu — „Kšandy", „Pásky" */
  category: string;
  /** Kolik kusů z kategorie mělo vůbec velikost */
  qty: number;
  sizes: DigestSize[];
}

export interface DigestSize {
  label: string;
  qty: number;
  /** U kolika různých produktů se ta velikost objevila */
  products: number;
}

/** Měsíční souhrn pro dlouhodobý graf */
export interface DigestMonth {
  month: string;
  orders: number;
  cancelled: number;
  revenue: number;
  currency: string;
  items: number;
  customers: number;
  complete: boolean;
}

/**
 * Zasazení okna do delší historie.
 *
 * Bez tohohle je „113 objednávek" číslo bez váhy: v lednu je to hodně,
 * v prosinci málo. Sezóny se počítají z vlastních dat e-shopu, ne z kalendáře.
 */
export interface DigestHistory {
  months: DigestMonth[];
  /** Kolik měsíců feed pokrývá */
  coverage: number;
  /** Stejných 30 dní loni; null = data tak daleko nesahají */
  lastYear: { orders: number; revenue: number } | null;
  /** Kolik z uzavřených měsíců bylo slabších než současné okno */
  rank: { better: number; of: number } | null;
  /** Ta nejbližší; celý seznam je v `seasons` */
  season: DigestSeason | null;
  /**
   * Všechny sezóny na půl roku dopředu (nejvýš tři).
   *
   * Leden může být silnější než prosinec — kdo se chystá jen na tu
   * nejbližší, druhou vlnu prošvihne. `season` je první z nich.
   */
  seasons?: DigestSeason[];
  /**
   * Proč sezóna není.
   *
   * Prázdné místo je nejhorší odpověď — z ničeho se nepozná, jestli se
   * nepočítalo, nebo jestli fakt žádná sezóna nepřichází. Tohle se ukáže
   * vždycky, když `season` chybí.
   */
  seasonNote?: string;
}

/** Sezóna spočítaná z vlastních dat — i s tím, co se v ní prodávalo */
export interface DigestSeason {
  /** `YYYY-MM` měsíce, o kterém je řeč */
  month: string;
  label: string;
  /** „vánoční sezóna", „svatební sezóna" — jméno, ne výpočet */
  name: string;
  index: number;
  startBy: string;
  /** Za kolik dní začíná; 0 = už běží */
  inDays: number;
  text: string;
  basis: string;
  /** Co se v ní historicky prodávalo nejvíc — i s obrázkem z katalogu */
  products: { code: string; title: string; qty: number; image?: string | null }[];
  /** Příspěvky, které v tom období fungovaly — podklad pro chystanou kampaň */
  posts: DigestPost[];
}

/** Příspěvek na sítích — lajky a komentáře jsou vždy z Instagramu */
export interface DigestPost {
  at: string;
  caption: string;
  likes: number;
  comments: number;
  permalink: string;
  markets: number;
  marketLabels?: string[];
  /** „IG" nebo „IG + FB" */
  channels?: string;
  /** Placený dosah; `null` = Instagram to u tohohle napojení nehlásí */
  boosted?: boolean | null;
  /** O kolik % víc objednávek chodilo kolem vydání; null = nedá se spočítat */
  lift?: number | null;
  /** Proč je tenhle příspěvek v seznamu — počítáno z čísel vedle */
  why?: string;
}

/** Co se dělo na sociálních sítích — a jestli to bylo v dnech s objednávkami */
export interface DigestSocial {
  posts: number;
  likes: number;
  comments: number;
  best: DigestPost | null;
  daysWithPost: number;
  ordersWithPost: number;
  ordersWithout: number;
  prevPosts: number;
  /**
   * Nejúspěšnější příspěvky **z poslední doby** (půl roku).
   *
   * Hlavní pohled je na to, co funguje teď — podle toho se rozhoduje, co
   * postnout příští týden. Starší úspěchy jsou zvlášť v `bestOlder`.
   */
  bestEver: DigestPost[];
  /** Co fungovalo dávno — připomenutí, ne měřítko */
  bestOlder?: DigestPost[];
  /**
   * Čerstvé neplacené příspěvky, kterým by rozpočet mohl pomoct.
   *
   * Úspěch placeného příspěvku je koupený; přidávat rozpočet má smysl tam,
   * kde už něco zabralo samo. U každého je i to, jak se kolem vydání hnuly
   * objednávky — souvislost, ne důkaz.
   */
  candidates?: DigestPost[];
  /** Hlásí Instagram propagaci? Bez toho se placené od neplaceného nepozná */
  boostKnown?: boolean;
}

/** Řádek v seznamu starších přehledů */
export interface DigestArchiveRow {
  at: string;
  headline: string;
  orders: number | null;
  revenue: number | null;
  currency: string;
}

/** Nastavení napojení na Google Analytics přes Sequel */
export interface Ga4Config {
  enabled: boolean;
  hasKey: boolean;
  endpoint: string;
  /**
   * Který zdroj v Sequelu se má ptát.
   *
   * Pod jedním klíčem jich bývá víc (GA4, databáze, HubSpot…) a dotaz bez
   * něj skončí hláškou „app_id is required". Jediný zdroj se doplní sám.
   */
  appId: string;
  /** Co se v Sequelu našlo — na výběr v nastavení */
  apps: { id: string; name: string }[];
  lastAt: string | null;
  lastError: string | null;
  ready: boolean;
}

/** Návštěvnost z Google Analytics (přes Sequel) */
export interface DigestGa4 {
  at: string;
  /** Který web ta čísla měří — zatím jen český, objednávky jsou ze všech trhů */
  scope?: string;
  window: { sessions: number | null; users: number | null; purchases: number | null; revenue: number | null };
  prevWindow: { sessions: number | null; users: number | null; purchases: number | null; revenue: number | null };
  sources: { name: string; sessions: number }[];
  conversion: number | null;
  prevConversion: number | null;
  text: string;
  error: string | null;
}

/** Jeden měsíc návštěvnosti — na graf dlouhodobého vývoje */
export interface Ga4Month {
  /** `YYYYMM` z GA4, převedené na `YYYY-MM` */
  month: string;
  sessions: number;
  users: number;
  purchases: number;
  revenue: number;
}

/** Kanál, stránka nebo zařízení — všechno má stejný tvar */
export interface Ga4Slice {
  name: string;
  sessions: number;
  users: number;
  purchases: number;
  revenue: number;
  /** Konverzní poměr v procentech; null = nedá se spočítat */
  conversion: number | null;
  /** Průměrná útrata na návštěvu — podle ní se pozná drahý kanál */
  perSession: number | null;
}

/**
 * Cesta k nákupu.
 *
 * GA4 umí spočítat, kolik návštěv skončilo košíkem, kolik pokladnou a kolik
 * nákupem. Tři čísla stačí na to, aby bylo vidět, kde se lidé ztrácejí —
 * a to je otázka, kterou samotná konverze nezodpoví.
 */
export interface Ga4Funnel {
  sessions: number;
  addToCarts: number;
  checkouts: number;
  purchases: number;
}

/**
 * Hlubší rozbor návštěvnosti.
 *
 * Denní snímek odpovídá na „kolik jich přišlo". Tohle odpovídá na „odkud,
 * kudy a co z toho bylo" — a dá se dívat až dva roky zpátky, protože
 * u sezónního zboží je roční pohled to jediné, co má smysl.
 */
export interface Ga4Deep {
  at: string;
  /** Za kolik dní zpátky se to počítalo */
  days: number;
  scope: string;
  /** Měsíční řada za celé období — na graf */
  months: Ga4Month[];
  /** Odkud lidé chodí (`sessionSourceMedium`) */
  channels: Ga4Slice[];
  /** Kde přistávají — nejčastější vstupní stránky */
  landings: Ga4Slice[];
  /** Které stránky se čtou nejvíc — články, kategorie, produkty */
  pages: Ga4Slice[];
  /** Mobil, počítač, tablet */
  devices: Ga4Slice[];
  /** Země návštěvníků — proti zemím objednávek je vidět, kde se neprodává */
  countries: Ga4Slice[];
  funnel: Ga4Funnel;
  error: string | null;
}

export interface DigestDay {
  /** YYYY-MM-DD */
  day: string;
  orders: number;
  revenue: number;
}

/**
 * Čísla přehledu. Počítají se z feedu objednávek při každém otevření —
 * je to jen několik dotazů do databáze, žádná AI a žádná síť.
 */
export interface DigestFacts {
  /** Převažující měna; v ní jsou hodnoty v grafech a v průměru */
  currency: string;
  today: DigestTotals;
  yesterday: DigestTotals;
  /**
   * Posledních 30 dní — hlavní okno přehledu.
   *
   * Kalendářní měsíc je na začátku měsíce k ničemu: druhého září se dvěma
   * dny srovnávanými proti dvěma dnům srpna vychází cokoli a AI z toho pak
   * píše nesmysly. Klouzavých třicet dní je stejně dlouhé pořád, takže se
   * z něj počítá zboží, země, doprava, platby i průměrná objednávka.
   */
  window: DigestTotals;
  /** Třicet dní před tím — s čím se okno srovnává */
  prevWindow: DigestTotals;
  /**
   * Kalendářní měsíc. Zůstává, protože „jak jsme na tom v září" je otázka,
   * kterou si člověk stejně klade — jen se z něj nedělají závěry.
   */
  month: DigestTotals;
  /** Stejný počet dní minulého měsíce — jinak by se 3. září srovnávalo s celým srpnem */
  prevMonth: DigestTotals;
  monthLabel: string;
  /** Kolikátý den měsíce to je — podle toho se pozná, že je měsíc krátký */
  monthDays: number;
  /** Posledních 30 kalendářních dnů na graf */
  days: DigestDay[];
  countries: DigestSlice[];
  shipments: DigestSlice[];
  payments: DigestSlice[];
  /** Nejprodávanější zboží za posledních 30 dní */
  products: DigestProduct[];
  /** Kolik objednávek z posledních 30 dní je od zákazníků, kteří u nás už nakoupili */
  returning: number;
  /** Průměrná objednávka za posledních 30 dní v převažující měně */
  average: number;
  /** Zjištění spočítaná v kódu — podklad pro postřehy i samostatná karta */
  signals: DigestSignal[];
  /** Stavy objednávek v okně — kolik čeká na platbu, kolik je vyřízených */
  statuses: DigestSlice[];
  /**
   * Nákupy, ne objednávky.
   *
   * Když zákazníkovi neprojde platba nebo si něco přikoupí, založí druhou
   * objednávku. Pro tržbu jsou to dvě, pro otázku „kolik lidí u nás nakoupilo"
   * jedna — proto se objednávky téhož e-mailu do dvou dnů slučují.
   */
  purchases: number;
  /** Kolik objednávek se do nákupů slilo (druhé pokusy, dokupy) */
  duplicates: number;
  /** Velikosti po kategoriích — délka kšand a šířka kravaty se nesčítají */
  sizes: DigestSizeGroup[];
  /** Dlouhodobý kontext — rok zpátky, loňské okno, sezóny */
  history: DigestHistory;
  /** Sociální sítě; null = Instagram v téhle instalaci není */
  social: DigestSocial | null;
  /** Kdy naposledy dorazil feed — ať se pozná, že čísla nejsou čerstvá */
  feedAt: string | null;
  /** Kolik objednávek feed vůbec zná (prázdný přehled se má umět vysvětlit) */
  known: number;
}

/**
 * Co čeká na vyřízení.
 *
 * Nestačí příznak „zodpovězeno" ze serveru: odpověď odeslaná odjinud ho
 * nenastaví a přehled pak dokola připomíná něco, co je dávno hotové. Bere
 * se proto celé vlákno — když v něm po zprávě něco odešlo, je vyřízeno.
 */
export interface DigestTask {
  kind: 'mail' | 'chat';
  /** ID zprávy nebo konverzace — přehled na ni umí rovnou skočit */
  id: string;
  who: string;
  subject: string;
  preview: string;
  at: string;
  /** Reklamace, nedoručená zásilka, naštvaný zákazník — nahoru a zvýraznit */
  urgent: boolean;
  /** Proč to tady je */
  reason: string;
}

/**
 * Signál — hotové zjištění spočítané **v kódu**, bez AI.
 *
 * Srovnávat dvě čísla umí kód líp než model: nespočítá se špatně a nikdy
 * si nic nepřimyslí. Signály jsou proto to, co se ukazuje jako fakt, a taky
 * to jediné, o co se smí opřít postřeh od AI.
 */
export interface DigestSignal {
  /** up = roste, down = klesá, watch = k pohlídání, info = jen údaj */
  kind: 'up' | 'down' | 'watch' | 'info';
  text: string;
  /** Čísla, ze kterých to plyne — v rozhraní pod větou, ať jde ověřit */
  basis: string;
}

/**
 * Jeden postřeh.
 *
 * `basis` není ozdoba: bez ní se nedá poznat, jestli za radou stojí čísla,
 * nebo jestli si model jen musel něco vymyslet. Právě proto se vypisuje —
 * tvrzení, pod kterým není konkrétní číslo, se pozná na první pohled.
 */
export interface DigestNote {
  /** trend = co se děje s čísly, napad = návrh, pozor = riziko */
  kind: 'trend' | 'napad' | 'pozor';
  text: string;
  /** Čísla, ze kterých to plyne */
  basis: string | null;
  /** U návrhu: podle čeho se pozná, že zabral */
  check: string | null;
}

/**
 * Postřehy od AI.
 *
 * Jediná část přehledu, která stojí peníze a čas, a proto se dělá nejvýš
 * jednou za 24 hodin. Předchozí postřehy i čísla, ze kterých vznikly, se
 * ukládají — AI tak vidí, co navrhla minule a jak to dopadlo.
 */
export interface DigestInsight {
  at: string;
  headline: string;
  notes: DigestNote[];
  /** Navázání na minulý přehled — co se z něj potvrdilo nebo nepotvrdilo */
  followUp: string | null;
  /**
   * Na co se podívat příště.
   *
   * Vlastní poznámka AI pro sebe: jde do zadání dalšího přehledu, takže si
   * může říct „zítra ověřím, jestli propad ve čtvrtek byl svátek" a druhý den
   * na to navázat. Je vidět i v okně, takže se dá přečíst i přepsat.
   */
  focus: string | null;
  /** Otázky, na které se podle AI vyplatí doptat — kliknutím se pošlou */
  questions: string[];
  model: string;
}

/** Jedna otázka a odpověď v doptávání nad přehledem */
export interface DigestTurn {
  role: 'user' | 'ai';
  text: string;
}

/**
 * Souhrn rozdělané práce.
 *
 * Vypisovat každou objednávku a zprávu zvlášť nemá ráno smysl — jde o to,
 * jestli něco leží, ne který kus to je. Detail se dá rozbalit.
 */
export interface DigestPending {
  /** Objednávky, které ještě nikam neodešly (a nejsou stornované) */
  unshipped: number;
  /** Z nich ty, co čekají na zaplacení déle než tři dny */
  unpaidOld: number;
  /** Kolik dní čeká ta nejstarší neodeslaná */
  oldestDays: number | null;
  /** Zprávy bez odpovědi a z nich naléhavé */
  mails: number;
  urgentMails: number;
  /** Chaty, kde poslední slovo má zákazník */
  chats: number;
}

export interface DigestReport {
  facts: DigestFacts;
  /** Návštěvnost z GA4; null = není zapnutá */
  ga4: DigestGa4 | null;
  /** Souhrn — to se ukazuje; jednotlivé řádky jsou až pod rozbalením */
  pending: DigestPending;
  tasks: DigestTask[];
  insight: DigestInsight | null;
  /** Kdy se postřehy smějí dělat znovu (do té doby se ukazují uložené) */
  nextInsightAt: string | null;
  /** Proč postřehy nejsou — chybí klíč, spadla síť, ještě se nedělaly */
  insightError: string | null;
  /** Chat se ptá po síti; když nevyjde, přehled kvůli tomu nepadá */
  chatError: string | null;
}

export interface CodeShorthand {
  /** Číslo objednávky ve feedu — u faktury je jiné než hledané číslo */
  code: string;
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
  /**
   * Kusy skladem z feedu; `null`, když je feed neuvádí.
   *
   * Ukazuje se při výběru produktů do článku: článek se píše na týdny
   * dopředu a odkazovat v něm na vyprodaný kus znamená posílat čtenáře na
   * stránku, kde si nic nekoupí.
   */
  stock: number | null;
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
  /**
   * Stránka importu textů v administraci e-shopu.
   *
   * V adrese je číslo serveru, na kterém e-shop běží, takže se nedá zapsat
   * napevno; prázdné se složí z adresy administrace, kterou aplikace zná
   * kvůli fakturám.
   */
  importUrl: string;
  /** Otevřít import hned po exportu a vložit do něj soubor */
  openImport: boolean;
}

export interface ArticleBrief {
  products: string[];
  productImages: Record<string, string>;
  includeProductImages: boolean;
  productLayout: 'block' | 'left' | 'right';
  productSize: 'small' | 'medium' | 'large';
  images: { url: string; description: string; size: 'auto' | 'small' | 'medium' | 'full';
    layout: 'block' | 'left' | 'right'; isListing?: boolean }[];
  /**
   * Videa — soubor z CDN (webm/mp4), nebo YouTube.
   *
   * Vkládají se jako hotový kus HTML, ne jako pokyn modelu: `<iframe>` se
   * špatným poměrem stran rozbije stránku na telefonu a `<video>` bez
   * `controls` se nedá pustit.
   */
  videos: { url: string; description: string; layout: 'block' | 'left' | 'right';
    size: 'small' | 'medium' | 'large' }[];
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
  /**
   * Kolikátý průchod modelem běží a kolik jich bude.
   *
   * Psaní, úprava délky i překlady jsou jedna práce, jen v několika
   * krocích — bez tohohle to na ukazateli vypadalo, že se článek píše
   * podruhé od začátku.
   */
  step: number;
  steps: number;
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
  /** Kusy skladem; `null`, když to feed neuvádí */
  stock: number | null;
  /** Dostupnost slovy, jak ji vede e-shop („Skladem", „Není skladem") */
  availability: string;
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
  /** Fotka z katalogu — u regálu se zboží pozná dřív očima než čtením kódu */
  image?: string | null;
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

/* ---------- hromadné stažení faktur ---------- */

/** Objednávka, ke které se shání faktura. */
export interface InvoiceJob {
  code: string;
  market: string;
  invoice: string;
  name: string;
  /** Vnitřní ID v administraci — adresa faktury na něm může stát */
  adminId: number | null;
}

/** Faktura, která se nepovedla — s důvodem, ne jen s křížkem. */
export interface InvoiceOutcome {
  code: string;
  invoice: string;
  ok: boolean;
  pages: number;
  reason?: string;
}

export interface InvoiceRun {
  /** Kam se uložil sloučený PDF; null, když se neuložilo nic */
  file: string | null;
  ok: number;
  pages: number;
  failed: InvoiceOutcome[];
  /** Administrace odpověděla přihlašovací stránkou — je potřeba se přihlásit */
  needsLogin: boolean;
  /** Adresa faktury se ještě nenaučila */
  needsTemplate: boolean;
}

export interface InvoiceSetup {
  /** Naučená adresa se značkami {invoice}, {code}, {id} */
  template: string;
  /** Kde se otevírá administrace, když se adresa faktury učí */
  adminHome: string;
  /**
   * Jak se k faktuře jde.
   *
   * `template` = přímá adresa s dosazeným číslem. `detail` = adresa nese
   * i vnitřní číslo faktury, které se dopočítat nedá, takže se odkaz hledá
   * v detailu objednávky.
   */
  mode: 'template' | 'detail';
  /** Adresa detailu objednávky se značkou {id} nebo {code} */
  detailUrl: string;
  parallel: number;
  openAfter: boolean;
}

/** Závěr k jednomu řádku rozboru návštěvnosti — nebo k celé sestavě. */
export interface Ga4Note {
  /** months | channels | landings | pages | devices | countries | funnel */
  where: string;
  /** Přesný název řádku; null = platí pro celou sestavu */
  row: string | null;
  kind: 'dobré' | 'slabé' | 'zvážit';
  text: string;
}

export interface Ga4Notes {
  at: string;
  /** Datum rozboru, ze kterého závěry vznikly */
  from: string;
  days: number;
  summary: string;
  notes: Ga4Note[];
  error: string | null;
}

/** Stránky do šířky — podklad pro statistiku článků. */
export interface Ga4Pages {
  at: string;
  days: number;
  scope: string;
  /** Návštěvy stránky (kdekoli v cestě) */
  pages: Ga4Slice[];
  /** Návštěvy, kde byla stránka tou první — u ní se počítá i nákup */
  landings: Ga4Slice[];
  months: { path: string; month: string; sessions: number; users: number }[];
  error: string | null;
}

/* ---------- statistika článků ---------- */

export interface ArticleStat {
  id: number;
  title: string;
  path: string;
  status: string;
  updatedAt: string;
  /** Kolikrát se článek otevřel — i lidmi, kteří přišli odjinud z webu */
  views: number;
  readers: number;
  /** Kolikrát byl článek tou první stránkou návštěvy */
  entries: number;
  /** Nákupy připsané těmhle vstupům */
  purchases: number;
  revenue: number;
  /** Našla se stránka v Analytics? */
  found: boolean;
}

export interface ArticleStatsView {
  at: string;
  days: number;
  scope: string;
  rows: ArticleStat[];
  views: number;
  entries: number;
  revenue: number;
  missing: number;
  error: string | null;
}

export interface ArticleStatDetail {
  stat: ArticleStat;
  months: { month: string; sessions: number; users: number }[];
  scope: string;
  days: number;
  /** Věta „co s tím" — spočítaná, ne od AI */
  note: string;
  error: string | null;
}

/* ---------- vývoz zásilek pro PPL ---------- */

export interface PplRow {
  /** Číslo objednávky, ze které řádek vznikl — do souboru nejde, ale hlásí se v přehledu */
  code: string;
  name: string;
  /** U výdejního místa jeho název, jinak firma příjemce */
  company: string;
  street: string;
  /** U výdejního místa i s kódem: „KM10439155 Chýnov" */
  city: string;
  zip: string;
  country: string;
  /** Kolik vybrat na dobírku; 0 u placených předem */
  cod: number;
  currency: string;
  variableSymbol: string;
  phone: string;
  email: string;
  /** 46 = výdejní místo, 14 = adresa */
  type: 46 | 14;
  total: number;
  /** Poznámka zákazníka, zkrácená na to, co se vejde na štítek */
  note: string;
  /** Obsah zásilky složený z položek — „2 kravaty, motýlek" */
  content: string;
}

export interface PplExport {
  file: string | null;
  rows: number;
  skipped: { code: string; reason: string }[];
  content: boolean;
  /** Kolik zásilek nese poznámku zákazníka */
  notes: number;
}

export interface PplSetup {
  /** Podle čeho se pozná, že objednávka jede PPL */
  carrier: string;
  /**
   * Kolik znaků poznámky se vejde na štítek.
   *
   * PPL delší text uřízne **uprostřed slova** — z „Prosím kurýra zavolat
   * před domem" zbylo na štítku „Prosím kurýra zavolat před dom". Zkracuje
   * se proto tady a na hranici slova; hodnota je nastavitelná, protože je
   * jejich a může se změnit.
   */
  noteLimit: number;
  /** Přidat sloupec s obsahem zásilky */
  content: boolean;
  importUrl: string;
  /** Seznam zásilek, odkud se tisknou štítky */
  labelsUrl: string;
  /** Název uložené úlohy v administraci PPL */
  mapping: string;
  /** Co se píše do kolonky `total`: cena zboží, nebo celá objednávka */
  value: 'goods' | 'order';
}

/* ---------- Zásilkovna (Packeta) ---------- */

export interface PacketaSetup {
  hasPassword: boolean;
  /** Označení e-shopu, pod kterým Zásilkovna vede zásilky */
  eshop: string;
  /** Podle čeho se pozná, že objednávka jede Zásilkovnou */
  carrier: string;
  labelFormat: string;
  /** Kolik štítků na archu přeskočit — načatý arch se tím dotiskne */
  labelOffset: number;
  defaultWeight: number;
  /** Kolik znaků poznámky Zásilkovna u zásilky unese */
  noteLimit: number;
}

export interface PacketaPacket {
  code: string;
  packetId: string;
  barcode: string;
  at: string;
}

export interface PacketaResult {
  created: PacketaPacket[];
  failed: { code: string; reason: string }[];
  /** Kolik objednávek se ve feedu vůbec nenašlo */
  skipped: number;
}

/* ---------- Balíkovna (Podání Online České pošty) ---------- */

export interface BalikovnaSetup {
  /** Podle čeho se pozná, že objednávka jede Balíkovnou */
  carrier: string;
  /**
   * Pořadí sloupců, čárkami.
   *
   * Podání Online si mapuje pole na čísla sloupců, takže tohle musí sedět
   * s konfigurací importu — a mění se to v nastavení, ne v kódu.
   */
  order: string;
  /** První řádek s názvy sloupců */
  header: boolean;
  /** Kód produktu České pošty („Typ zásilky") */
  type: string;
  /** Kódy doplňkových služeb, pokud je potřeba */
  services: string;
  portalUrl: string;
  /** Naučená adresa stránky s importem; prázdná, dokud se nenajde */
  importUrl: string;
  /** Co je v „Udané ceně": cena zboží, nebo celá objednávka */
  value: 'goods' | 'order';
  /** Kolik znaků poznámky se vejde na štítek */
  noteLimit: number;
  /**
   * Přidat do souboru poznámku zákazníka.
   *
   * Nastavuje se až u konkrétního vývozu, ne v nastavení: poznámka je text
   * od zákazníka a rozhodnutí, jestli ji dopravce má vidět, patří člověku,
   * který si ji přečetl.
   */
  note?: boolean;
}

export interface BalikovnaExport {
  file: string | null;
  rows: number;
  skipped: { code: string; reason: string }[];
  /** Kolik sloupců soubor má — proti konfiguraci v Podání Online */
  columns: number;
  /** Kolik zásilek nese poznámku zákazníka */
  notes: number;
}

/**
 * Poznámka zákazníka u jedné objednávky — podklad pro dotaz před vývozem.
 *
 * Ukazuje se celá i zkrácená: člověk má vidět, co zákazník napsal, ale na
 * štítek se vejde jen začátek.
 */
export interface OrderNote {
  code: string;
  name: string;
  note: string;
  /** Zkrácená podoba, tak jak by šla dopravci bez ručního přepsání */
  short: string;
}

/**
 * Poznámky k vývozu i s tím, kolik se jich vejde na štítek.
 *
 * Limit je vlastnost dopravce, ne poznámky — a rozhoduje o tom, jestli se
 * text dá poslat celý, nebo se musí přepsat.
 */
export interface OrderNotes {
  limit: number;
  notes: OrderNote[];
}

/** Schválená poznámka: číslo objednávky a text, který má jít dopravci. */
export interface ApprovedNote {
  code: string;
  text: string;
}

/* ---------- přihlášení do cizích administrací ---------- */

export interface PortalLogin {
  /** upgates | ppl | cposta */
  id: string;
  label: string;
  user: string;
  /** Heslo se ven neposílá — jen jestli je uložené */
  hasPassword: boolean;
  /** Vyplnit a rovnou odeslat, nebo jen předvyplnit */
  auto: boolean;
}

/** Co se povedlo naučit z jedné otevřené faktury. */
export interface InvoiceLearned {
  template: string;
  sample: string;
  kind: string;
  matched: string;
  mode: 'template' | 'detail';
  /** Adresa detailu objednávky, když se jede přes něj */
  detail: string;
}

/* ==================== Texty na webu ==================== */

/**
 * Naplánovaná náhrada textů na e-shopu.
 *
 * Skript v hlavičce e-shopu skládá texty o doručení sám podle kalendáře
 * a denní doby. Občas ale platí něco jiného, než co kalendář ví — dovolená,
 * výpadek dopravce, akce. Náhrada se proto plánuje dopředu, na minutu přesně,
 * a to, co se nenastaví, počítá skript dál po svém.
 */
export interface WebText {
  cz: string;
  sk: string;
  en: string;
}

/** Jeden odkaz v horní liště — text i cíl mají svou jazykovou verzi. */
export interface WebLink {
  text: WebText;
  href: WebText;
  /** Otevřít v nové záložce */
  blank: boolean;
}

/** Box u produktu — tři řádky o expedici, doručení a osobním odběru. */
export interface WebProductArea {
  on: boolean;
  /** Místo všech tří řádků jediný náhradní text */
  one: WebText;
  /** Řádek navíc nad boxem */
  above: WebText;
  /** Nadpis boxu; prázdné = původní */
  header: WebText;
  hideHeader: boolean;
  /**
   * Hodnoty tří řádků. Nahrazuje se **jen text za dvojtečkou** — popisek
   * („✅ Expedice:") zůstává, aby v boxu nezůstalo holé datum bez vysvětlení.
   */
  ship: WebText;
  delivery: WebText;
  pickup: WebText;
  /**
   * Datum, odkdy se expeduje („2026-09-21"), nepovinné.
   *
   * Řídí obojí najednou: doplní se do řádku o expedici a **z něj se počítá
   * i odhad doručení**. Bez něj se odhad počítá z dneška, takže by box mohl
   * na jednom řádku hlásit expedici za deset dní a na druhém doručení zítra.
   */
  shipFrom: string;
  /** Řádek neukazovat vůbec */
  hideShip: boolean;
  hideDelivery: boolean;
  hidePickup: boolean;
  /** Řádek navíc pod boxem */
  below: WebText;
}

/** Horní lišta s doručením — jeden text přes celou šířku. */
export interface WebBarArea {
  on: boolean;
  text: WebText;
}

/**
 * Lišta s odkazy.
 *
 * `add` přidá odkazy ke stávajícím (střídají se dokola), `replace` je
 * nahradí a `off` lištu na dobu platnosti schová.
 */
export interface WebLinksArea {
  on: boolean;
  mode: 'add' | 'replace' | 'off';
  items: WebLink[];
}

/** Bublina u tlačítka „Objednávka zavazující k platbě". */
export interface WebButtonArea {
  on: boolean;
  text: WebText;
}

export interface WebPlan {
  id: string;
  /** Jak se změna jmenuje v seznamu — na web se to neposílá */
  name: string;
  /** Platnost od, místní čas v Praze: „2026-09-20T08:00" */
  from: string;
  to: string;
  /** Tytéž časy v milisekundách — podle nich se rozhoduje prohlížeč */
  fromMs: number;
  toMs: number;
  /** Dočasně vypnuto, aniž by se muselo mazat */
  off: boolean;
  product: WebProductArea;
  topbar: WebBarArea;
  links: WebLinksArea;
  button: WebButtonArea;
}

/**
 * Garance doručení do Vánoc.
 *
 * Není to naplánovaná změna, ale nastavení: platí každý rok ve stejném
 * období a mění se u ní nanejvýš datum a znění („při objednání do 18.12.").
 * Proto se zadává dnem a měsícem, bez roku, a nemusí se každý listopad
 * zakládat znovu.
 */
export interface WebSeason {
  on: boolean;
  fromDay: number;
  fromMonth: number;
  toDay: number;
  toMonth: number;
  /** Prázdné = vestavěné znění */
  text: WebText;
}

export interface WebTextsConfig {
  /** Adresa projektu Supabase, do jehož úložiště se plán ukládá */
  url: string;
  hasKey: boolean;
  bucket: string;
  path: string;
  /** Odkud plán čte web — z toho se skládá skript do hlavičky */
  publicUrl: string;
  /** Jak dlouho prohlížeči stačí uložená kopie plánu (sekundy) */
  ttl: number;
  ready: boolean;
}

/** Změna, která se s plánovanou překrývá. */
export interface WebClash {
  id: string;
  name: string;
  from: string;
  to: string;
  /** Dá se zkrátit tak, aby skončila těsně před novou změnou */
  shortenTo: string;
}

export interface WebTextsState {
  config: WebTextsConfig;
  plans: WebPlan[];
  /** Garance doručení do Vánoc — celoroční nastavení vedle plánu */
  season: WebSeason;
  /** Kdy se plán naposledy povedlo vystavit na web */
  publishedAt: string;
  /** Je v aplikaci něco, co na webu ještě není */
  dirty: boolean;
  /** Co se nepovedlo — prázdné, když je vše v pořádku */
  error: string;
  /** Skript k vložení na konec <head> e-shopu, už s adresou plánu */
  script: string;
}
