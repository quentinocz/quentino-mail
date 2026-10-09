/**
 * Zkušební kabina — jak produkty vypadají na modelu.
 *
 * ## Co to je
 *
 * Zákazník si na e-shopu otevře okno, ve kterém stojí postava v obleku, a
 * může si ji přestavět: hubenější, vyšší, starší, dítě, jiná barva vlasů,
 * fousy, přesná barva obleku a košile, vesta ano či ne. Ke každému kusu si
 * vybere skutečný produkt z katalogu, vzhledy si ukládá, srovnává a jedním
 * klikem je dává do košíku.
 *
 * ## Proč se to skládá z vrstev a nekreslí se to AI na vyžádání
 *
 * Nechat obrázek dogenerovat ve chvíli, kdy si zákazník klikne na jinou
 * barvu, znamená čekání v sekundách a platbu za každé zobrazení. To jde
 * přímo proti tomu, k čemu kabina je: aby se dalo rychle zkoušet. Vrstvy
 * se proto vygenerují **jednou dopředu** a prohlížeč je jen skládá na
 * plátno — přebarvení je okamžité a nic se při něm nestahuje.
 *
 * ## Proč je stínová mapa a ne hotová barva
 *
 * „Přesná barva obleku" znamená libovolnou barvu, ne výběr z osmi. Vrstva
 * se proto neukládá obarvená, ale jako **mapa světla**: šedý obrázek, kde
 * polotón je samotná látka, tmavší místa jsou záhyby a světlejší odlesky.
 * Prohlížeč pod ni podloží zvolenou barvu a složí je režimem `hard-light`,
 * u kterého polotón vydá **přesně zvolenou barvu** a záhyby i odlesky
 * zůstanou. Kdyby se násobilo, byla by každá barva tmavší, než jakou si
 * zákazník vybral, a světlé odstíny by vůbec nešly.
 *
 * ## Proč je tenhle soubor ve sdílené části
 *
 * Totéž pořadí vrstev a tytéž výpočty potřebují tři strany: okno aplikace,
 * kde se vizuály schvalují, generování vrstev v hlavním procesu (pořadí
 * vrstev je zároveň pořadí, v jakém se postava dooblékává) a skript na
 * e-shopu. Rozejít se smí jedině tak, že si zákazník uvidí něco jiného,
 * než co bylo schválené.
 */

/* ---------------------------------------------------------------- postavy */

/** Věková skupina. Každá má vlastní kresbu postavy, protože se liší tvarem. */
export type ZkVek = 'kojenec' | 'dite' | 'dospely';

/** Tělesný typ. Taky vlastní kresba — hubeného nejde vyrobit zúžením. */
export type ZkTelo = 'hubeny' | 'bezny' | 'silny';

export const ZK_VEKY: Record<ZkVek, { nazev: string; popis: string; roky: [number, number]; vyska: [number, number] }> = {
  kojenec: { nazev: 'Kojenec', popis: 'Do dvou let — šaty na křtiny a svatby.', roky: [0, 2], vyska: [50, 92] },
  dite: { nazev: 'Dítě', popis: 'Od dvou do patnácti let.', roky: [2, 15], vyska: [86, 175] },
  dospely: { nazev: 'Dospělý', popis: 'Od patnácti let.', roky: [15, 99], vyska: [155, 205] }
};

export const ZK_TELA: Record<ZkTelo, { nazev: string; popis: string }> = {
  hubeny: { nazev: 'Štíhlý', popis: 'Úzká ramena i pas, slim střih sedne.' },
  bezny: { nazev: 'Běžný', popis: 'Nejčastější postava.' },
  silny: { nazev: 'Silnější', popis: 'Širší pas než ramena, sako na dva knoflíky.' }
};

/**
 * Jedna vykreslená postava. Kombinace věku a těla — výška už ne.
 *
 * Výška se dělá **měřítkem**, ne vlastní kresbou: o pět centimetrů vyšší
 * člověk má tytéž proporce, jen je větší, a vygenerovat kvůli každé výšce
 * vlastní sadu vrstev by znamenalo desetkrát tolik obrázků bez rozdílu,
 * který by někdo poznal.
 */
export interface ZkPostava {
  id: string;
  vek: ZkVek;
  telo: ZkTelo;
  /** Výška, pro kterou je kresba udělaná. Od ní se počítá měřítko. */
  vyskaCm: number;
  /** Rozměr plátna v bodech. Všechny vrstvy postavy ho mají stejný. */
  sirka: number;
  vyska: number;
  /** Kde na plátně stojí chodidla a kde je temeno — kvůli měřítku výšky. */
  temeno: number;
  podrazka: number;
  hotovo: boolean;
}

export function postavaId(vek: ZkVek, telo: ZkTelo): string {
  return `${vek}-${telo}`;
}

/**
 * Měřítko pro zvolenou výšku.
 *
 * Postava se zvětší od chodidel, ne od středu plátna — jinak by vyšší
 * model vyrostl i do země. Rozsah je schválně úzký: dvakrát vyšší postava
 * ze stejné kresby vypadá jako karikatura, takže se kraje zkrotí.
 */
export function vyskaMeritko(p: Pick<ZkPostava, 'vyskaCm'>, vyskaCm: number): number {
  const podil = vyskaCm / Math.max(1, p.vyskaCm);
  return Math.max(0.82, Math.min(1.18, podil));
}

/* ---------------------------------------------------------------- vrstvy */

/**
 * Druh vrstvy. Pořadí v `ZK_VRSTVY` je zároveň pořadí odspodu nahoru —
 * a zároveň pořadí, v jakém se postava při generování dooblékává.
 */
export type ZkVrstvaTyp =
  | 'postava' | 'vlasy' | 'fousy' | 'boty' | 'kalhoty' | 'kosile'
  | 'pasek' | 'ksandy' | 'kravata' | 'vesta' | 'sako' | 'kapesnicek';

export interface ZkVrstvaDef {
  typ: ZkVrstvaTyp;
  nazev: string;
  /** Jedna věta pro zákazníka. */
  popis: string;
  /**
   * Barví se stínovou mapou (`true`), nebo se kreslí, jak je (`false`).
   *
   * Postava se nebarví: pleť, oči a rysy nejsou jedna barva.
   */
  barvitelna: boolean;
  /** Bez téhle vrstvy se obejde — vesta, kšandy, kapesníček. */
  nepovinna: boolean;
  /**
   * Varianty, které se generují zvlášť. Každá vzniká z téže předchozí
   * vrstvy, takže se dají mezi sebou přepínat bez dalšího generování.
   */
  varianty: { id: string; nazev: string }[];
  /**
   * Je to **naše zboží**, nebo jen kulisa?
   *
   * Quentino prodává doplňky: kravaty, motýlky, kšandy, kapesníčky.
   * Oblek, košili a kalhoty neprodává — zákazník si je v kabině nastaví
   * jen přibližně podle toho, co má doma, aby viděl, na čem ten doplněk
   * bude. Je to rozdíl, který se táhne celou kabinou: u kulisy se vybírá
   * **barva**, u zboží se vybírá **konkrétní kus** i se svým vzorem.
   * Vybírat motýlka jako odstín by znamenalo ukázat zákazníkovi něco,
   * co si nemůže koupit.
   *
   * Vrstva, která je zboží, ale nemá v katalogu jediný produkt, se chová
   * jako kulisa — jinak by se nedala nastavit vůbec.
   */
  zbozi: boolean;
  /**
   * Podle čeho se k vrstvě hledá produkt v katalogu. Slova se porovnávají
   * s názvem a kategorií — přiřazení pak ještě potvrzuje člověk. U kulisy
   * je seznam prázdný: produkt se k ní přiřadit nemá jak.
   */
  slova: string[];
  /**
   * Kde na postavě kus leží a kolik jí zabírá.
   *
   * Je to **mez na nepovedené generování**, ne kosmetika. Vrstva vzniká
   * jako rozdíl dvou kroků, a když model mezi kroky překreslí ruku nebo
   * posune stín, vyjde z toho maska u kolen, přestože se oblékalo sako.
   * Okem na malém náhledu to projde; tady to nemá kudy. Hodnoty jsou
   * díly výšky a plochy postavy, takže platí pro dospělého i pro dítě.
   */
  kontrola: { odY: number; doY: number; podilOd: number; podilDo: number };
  /**
   * Komu se tenhle kus negeneruje.
   *
   * Plnovous na kojenci není vtip, je to tři zaplacené obrázky k ničemu —
   * a v nabídce pro zákazníka volba, která nemá co udělat.
   */
  nePro?: ZkVek[];
}

export const ZK_VRSTVY: ZkVrstvaDef[] = [
  {
    typ: 'postava', nazev: 'Postava', popis: 'Model, na kterém se zkouší.',
    barvitelna: false, nepovinna: false, zbozi: false, slova: [],
    kontrola: { odY: 0, doY: 1, podilOd: 0.1, podilDo: 0.8 },
    varianty: [{ id: 'zaklad', nazev: 'Základ' }]
  },
  {
    typ: 'vlasy', nazev: 'Vlasy', popis: 'Barvu si zákazník vybere přesně.',
    barvitelna: true, nepovinna: false, zbozi: false, slova: [],
    kontrola: { odY: 0, doY: 0.2, podilOd: 0.004, podilDo: 0.1 },
    varianty: [
      { id: 'kratke', nazev: 'Krátké' },
      { id: 'delsi', nazev: 'Delší' },
      { id: 'dozadu', nazev: 'Sčesané dozadu' }
    ]
  },
  {
    typ: 'fousy', nazev: 'Fousy', popis: 'Od ničeho po plnovous.',
    barvitelna: true, nepovinna: true, zbozi: false, slova: [], nePro: ['kojenec', 'dite'],
    kontrola: { odY: 0.03, doY: 0.22, podilOd: 0.001, podilDo: 0.09 },
    varianty: [
      { id: 'knir', nazev: 'Knír' },
      { id: 'strniste', nazev: 'Strniště' },
      { id: 'kozi', nazev: 'Kozí bradka' },
      { id: 'plnovous', nazev: 'Plnovous' }
    ]
  },
  {
    typ: 'boty', nazev: 'Boty', popis: 'Nastav přibližně podle svých bot.',
    barvitelna: true, nepovinna: true, zbozi: false, slova: [],
    kontrola: { odY: 0.84, doY: 1.01, podilOd: 0.006, podilDo: 0.14 },
    varianty: [{ id: 'spolecenske', nazev: 'Společenské' }]
  },
  {
    typ: 'kalhoty', nazev: 'Kalhoty', popis: 'Nastav přibližně podle svých kalhot.',
    barvitelna: true, nepovinna: false, zbozi: false, slova: [],
    kontrola: { odY: 0.4, doY: 1.01, podilOd: 0.18, podilDo: 0.64 },
    varianty: [{ id: 'oblekove', nazev: 'Oblekové' }]
  },
  {
    typ: 'kosile', nazev: 'Košile', popis: 'Nastav přibližně podle své košile.',
    barvitelna: true, nepovinna: false, zbozi: false, slova: [],
    kontrola: { odY: 0.1, doY: 0.7, podilOd: 0.18, podilDo: 0.7 },
    varianty: [
      { id: 'klasicka', nazev: 'Klasický límec' },
      { id: 'stojacek', nazev: 'Stojáček' }
    ]
  },
  {
    typ: 'pasek', nazev: 'Pásek', popis: 'Vyber si konkrétní pásek.',
    barvitelna: true, nepovinna: true, zbozi: true, slova: ['pás', 'pas', 'opasek', 'belt', 'gürtel'],
    kontrola: { odY: 0.38, doY: 0.62, podilOd: 0.001, podilDo: 0.07 },
    varianty: [{ id: 'kozeny', nazev: 'Kožený' }]
  },
  {
    typ: 'ksandy', nazev: 'Kšandy', popis: 'Vyber si konkrétní kšandy.',
    barvitelna: true, nepovinna: true, zbozi: true, slova: ['kšand', 'ksand', 'šle', 'sle', 'suspender', 'brace', 'hosenträger'],
    kontrola: { odY: 0.13, doY: 0.6, podilOd: 0.004, podilDo: 0.22 },
    varianty: [
      { id: 'uzke', nazev: 'Úzké' },
      { id: 'siroke', nazev: 'Široké' }
    ]
  },
  {
    typ: 'kravata', nazev: 'Kravata nebo motýlek', popis: 'Vyber si konkrétní kravatu, motýlka nebo regatu.',
    barvitelna: true, nepovinna: true, zbozi: true, slova: ['kravat', 'motýl', 'motyl', 'tie', 'krawatte', 'regat'],
    kontrola: { odY: 0.11, doY: 0.52, podilOd: 0.001, podilDo: 0.09 },
    varianty: [
      { id: 'kravata', nazev: 'Kravata' },
      { id: 'motylek', nazev: 'Motýlek' },
      { id: 'regata', nazev: 'Regata' }
    ]
  },
  {
    typ: 'vesta', nazev: 'Vesta', popis: 'Nastav přibližně podle své vesty, nebo ji nech být.',
    barvitelna: true, nepovinna: true, zbozi: false, slova: [],
    kontrola: { odY: 0.14, doY: 0.64, podilOd: 0.045, podilDo: 0.44 },
    varianty: [{ id: 'klasicka', nazev: 'Klasická' }]
  },
  {
    typ: 'sako', nazev: 'Sako', popis: 'Nastav přibližně podle svého saka.',
    barvitelna: true, nepovinna: true, zbozi: false, slova: [],
    kontrola: { odY: 0.08, doY: 0.76, podilOd: 0.22, podilDo: 0.86 },
    varianty: [
      { id: 'jednoradove', nazev: 'Jednořadové' },
      { id: 'dvouradove', nazev: 'Dvouřadové' }
    ]
  },
  {
    typ: 'kapesnicek', nazev: 'Kapesníček', popis: 'Vyber si konkrétní kapesníček.',
    barvitelna: true, nepovinna: true, zbozi: true, slova: ['kapesní', 'kapesni', 'pochette', 'pocket square', 'einstecktuch'],
    kontrola: { odY: 0.18, doY: 0.46, podilOd: 0.0003, podilDo: 0.035 },
    varianty: [{ id: 'spicka', nazev: 'Do špičky' }]
  }
];

export function vrstvaDef(typ: ZkVrstvaTyp): ZkVrstvaDef {
  const found = ZK_VRSTVY.find(one => one.typ === typ);
  if (!found) throw new Error(`Neznámá vrstva ${typ}`);
  return found;
}

/** Pořadí odspodu nahoru. Je to totéž pořadí, v jakém se postava oblékala. */
export const ZK_PORADI: ZkVrstvaTyp[] = ZK_VRSTVY.map(one => one.typ);

/**
 * Jedna hotová vrstva: obrázek pro jednu postavu, jeden druh a jednu variantu.
 *
 * `soubor` je PNG, kde barva je buď skutečná (postava), nebo mapa světla
 * (všechno barvitelné) a průhlednost říká, kde kus látky je.
 */
export interface ZkVrstva {
  postava: string;
  typ: ZkVrstvaTyp;
  varianta: string;
  soubor: string;
  /** Veřejná adresa, odkud si ji vezme e-shop. Prázdná, dokud se nenahraje. */
  url: string;
  sirka: number;
  vyska: number;
  /** Kolik plátna vrstva zabírá — podle toho se pozná nepovedené generování. */
  podil: number;
  /** Obdélník, ve kterém vrstva leží. Kvůli kontrole, že kus sedí, kam patří. */
  okraje: { x: number; y: number; w: number; h: number };
  stav: 'ceka' | 'hotovo' | 'nesedi' | 'schvaleno';
  /** Co se na vrstvě nepovedlo, česky. */
  potiz: string;
  zadani: string;
  kdy: string;
}

/* ---------------------------------------------------------------- barvy */

/**
 * Nabídka barev. Je to **nabídka**, ne omezení: zákazník si může vybrat
 * i přesnou barvu, tahle je jen pro ty, kdo nechtějí ladit kolečkem.
 */
export const ZK_BARVY: { id: string; nazev: string; hex: string }[] = [
  { id: 'cerna', nazev: 'Černá', hex: '#1b1b1d' },
  { id: 'antracit', nazev: 'Antracitová', hex: '#3a3d42' },
  { id: 'tmavesira', nazev: 'Tmavě šedá', hex: '#55595f' },
  { id: 'sira', nazev: 'Světle šedá', hex: '#9aa0a6' },
  { id: 'namornicka', nazev: 'Námořnická modrá', hex: '#1f2d4d' },
  { id: 'modra', nazev: 'Modrá', hex: '#2d4a7c' },
  { id: 'svetlemodra', nazev: 'Světle modrá', hex: '#7d9dc4' },
  { id: 'lahvova', nazev: 'Lahvově zelená', hex: '#20402f' },
  { id: 'salvejova', nazev: 'Šalvějová', hex: '#acc2ab' },
  { id: 'burgundska', nazev: 'Burgundská', hex: '#5b1d26' },
  { id: 'cervena', nazev: 'Červená', hex: '#9c2b2b' },
  { id: 'hneda', nazev: 'Hnědá', hex: '#5a4231' },
  { id: 'bezova', nazev: 'Béžová', hex: '#c8b394' },
  { id: 'smetanova', nazev: 'Smetanová', hex: '#efe7d8' },
  { id: 'bila', nazev: 'Bílá', hex: '#f6f6f4' }
];

export const ZK_VLASY: { id: string; nazev: string; hex: string }[] = [
  { id: 'cerne', nazev: 'Černé', hex: '#1d1a19' },
  { id: 'tmavehnede', nazev: 'Tmavě hnědé', hex: '#3b2a20' },
  { id: 'hnede', nazev: 'Hnědé', hex: '#6b4a32' },
  { id: 'svetlehnede', nazev: 'Světle hnědé', hex: '#977257' },
  { id: 'blond', nazev: 'Blond', hex: '#c8a86a' },
  { id: 'ryse', nazev: 'Rusé', hex: '#a9542a' },
  { id: 'sede', nazev: 'Prošedivělé', hex: '#9b9792' },
  { id: 'bile', nazev: 'Bílé', hex: '#ddd9d2' }
];

/** Šestnáctkový zápis barvy na složky. Vrátí null, když to barva není. */
export function hexNaRgb(hex: string): { r: number; g: number; b: number } | null {
  const text = String(hex || '').trim().replace(/^#/, '');
  const full = text.length === 3 ? text.split('').map(one => one + one).join('') : text;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16)
  };
}

export function rgbNaHex(r: number, g: number, b: number): string {
  const one = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${one(r)}${one(g)}${one(b)}`;
}

/**
 * Jak světlá barva je, s vahami podle oka (zelená svítí nejvíc).
 *
 * Používá se na dvě věci: aby text na barevném kolečku byl čitelný, a aby
 * se poznalo, že si zákazník vybral černou košili k černému obleku —
 * to si zaslouží slovo, ne mlčení.
 */
export function svetlost(hex: string): number {
  const rgb = hexNaRgb(hex);
  if (!rgb) return 0;
  return (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
}

/**
 * Složení jednoho bodu stínové mapy se zvolenou barvou — režim `hard-light`.
 *
 * Polotón (128) vydá **přesně** zvolenou barvu, tmavší místa ztmaví,
 * světlejší vytáhnou k bílé. Přesně to dělá prohlížeč na plátně; tady je
 * to proto, aby se dalo spočítat i mimo něj a ověřit, že se obě strany
 * nerozcházejí.
 */
export function hardLight(barva: number, stin: number): number {
  const c = barva / 255;
  const s = stin / 255;
  const out = s <= 0.5 ? 2 * c * s : 1 - 2 * (1 - c) * (1 - s);
  return Math.max(0, Math.min(255, Math.round(out * 255)));
}

/** Polotón mapy světla. Osm bitů nemá 127,5, tak je to 128. */
export const ZK_POLOTON = 128;

/**
 * Barva, kterou se podloží plátno, aby po složení vyšla **přesně** ta
 * zvolená.
 *
 * Neutrální bod režimu `hard-light` leží na 127,5 a ten se do osmi bitů
 * zapsat nedá — mapa světla má proto polotón 128 a výsledek vychází
 * o jeden stupeň světleji. Jeden stupeň z 255 nikdo nepozná, jenže
 * „přesná barva obleku" je přesně to, k čemu kabina je: zákazník si
 * vybere odstín a čeká ten odstín, ne odstín skoro. Barva se proto
 * o ten stupeň předem posune zpátky; u polotónu pak vyjde na jedničku.
 *
 * Úplně černá se posunout nedá (vyšla by pod nulu), takže z té zbude
 * jednička místo nuly. To je rozdíl, který nemá kde se projevit.
 */
export function barvaPodMapu(hex: string, poloton = ZK_POLOTON): { r: number; g: number; b: number } {
  const rgb = hexNaRgb(hex) ?? { r: 0, g: 0, b: 0 };
  const s = poloton / 255;
  const uprav = (slozka: number) => {
    const t = slozka / 255;
    const c = s <= 0.5
      ? (s > 0 ? t / (2 * s) : t)
      : 1 - (1 - t) / (2 * (1 - s));
    return Math.max(0, Math.min(255, Math.round(c * 255)));
  };
  return { r: uprav(rgb.r), g: uprav(rgb.g), b: uprav(rgb.b) };
}

/* ---------------------------------------------------------------- vzhled */

/** Co má postava na sobě v jednom kusu. */
export interface ZkKus {
  /** Která varianta vrstvy — kravata nebo motýlek. */
  varianta: string;
  /** Barva, kterou si zákazník vybral. */
  hex: string;
  /** Kód produktu z katalogu. Prázdné = jen barva, bez konkrétního produktu. */
  produkt?: string;
}

/** Celý vzhled: postava, nastavení a kusy na ní. */
export interface ZkVzhled {
  id: string;
  nazev: string;
  vek: ZkVek;
  telo: ZkTelo;
  vyskaCm: number;
  vlasyVarianta: string;
  vlasyHex: string;
  fousy: string;
  kusy: Partial<Record<ZkVrstvaTyp, ZkKus>>;
}

/** Výchozí vzhled pro danou věkovou skupinu. */
export function vychoziVzhled(vek: ZkVek = 'dospely'): ZkVzhled {
  const stredniVyska = Math.round((ZK_VEKY[vek].vyska[0] + ZK_VEKY[vek].vyska[1]) / 2);
  return {
    id: '',
    nazev: '',
    vek,
    telo: 'bezny',
    vyskaCm: stredniVyska,
    vlasyVarianta: 'kratke',
    vlasyHex: '#3b2a20',
    fousy: '',
    /*
     * Kulisa se předvyplní, doplněk ne. Je to schválně: prázdné místo po
     * kravatě je to, kvůli čemu zákazník přišel, a rada mu rovnou nabídne
     * konkrétní kus z katalogu. Předvyplněná kravata by vypadala jako
     * hotový vzhled, ve kterém není co dokupovat.
     */
    kusy: {
      kalhoty: { varianta: 'oblekove', hex: '#1f2d4d' },
      kosile: { varianta: 'klasicka', hex: '#f6f6f4' },
      sako: { varianta: 'jednoradove', hex: '#1f2d4d' },
      boty: { varianta: 'spolecenske', hex: '#1b1b1d' }
    }
  };
}

/** Které vrstvy se pro daný vzhled kreslí, odspodu nahoru. */
export function vrstvyVzhledu(v: ZkVzhled): { typ: ZkVrstvaTyp; varianta: string; hex: string }[] {
  const out: { typ: ZkVrstvaTyp; varianta: string; hex: string }[] = [];
  for (const typ of ZK_PORADI) {
    if (typ === 'postava') { out.push({ typ, varianta: 'zaklad', hex: '' }); continue; }
    if (typ === 'vlasy') { out.push({ typ, varianta: v.vlasyVarianta, hex: v.vlasyHex }); continue; }
    if (typ === 'fousy') {
      if (v.fousy) out.push({ typ, varianta: v.fousy, hex: v.vlasyHex });
      continue;
    }
    const kus = v.kusy[typ];
    if (kus) out.push({ typ, varianta: kus.varianta, hex: kus.hex });
  }
  return out;
}

/* ------------------------------------------------------------ doporučení */

/** Produkt, jak ho kabina potřebuje. Z katalogu se bere jen tohle. */
export interface ZkProdukt {
  kod: string;
  nazev: string;
  url: string;
  cena: string;
  cenaCislo: number;
  obrazek: string;
  typ: ZkVrstvaTyp;
  varianta: string;
  /** Barva produktu, spočítaná z fotky nebo zadaná ručně. */
  hex: string;
  /**
   * Kousek látky produktu, vystřižený z jeho fotky.
   *
   * Motýlek s kostkou není jedna barva a vybírat si ho jako odstín by
   * znamenalo ukázat zákazníkovi něco, co si nemůže koupit. Vzorek se
   * proto na modelu **vydláždí** pod mapu světla: vzor zůstane vzorem
   * a sklady a stíny zůstanou sklady a stíny.
   */
  vzorek: string;
  /** Má velikosti? Pak se do košíku nedá hodit naslepo. */
  velikosti: boolean;
  skladem: boolean;
}

/**
 * Co doporučit k tomu, co už na postavě je.
 *
 * ## Proč rady doporučují konkrétní kusy, ne barvy
 *
 * Quentino prodává doplňky. Oblek a košile jsou v kabině **kulisa** —
 * zákazník si je nastaví přibližně podle toho, co má doma, aby viděl, na
 * čem ten doplněk bude. Rada „zkus tmavší odstín" by u kravaty byla rada
 * k ničemu: zákazník si nekupuje odstín, kupuje si tuhle kravatu. Proto
 * rady u zboží ukazují **kus z katalogu**, a u kulisy barvu.
 *
 * ## Proč jsou pravidla krátká
 *
 * Zákazník má u každého doporučení vidět **proč**. Náhodné „tohle se taky
 * kupuje" se v obleku pozná: k námořnickému saku to doporučí hnědý pásek
 * a zákazník přestane radám věřit.
 *
 * Co se hlídá:
 *  1. k nastavenému obleku chybí doplněk, který se k němu hodí,
 *  2. vybraný doplněk je barvou tak blízko obleku nebo košili, že splyne,
 *  3. pásek a kšandy naráz,
 *  4. košile v barvě saka — kulisa, ale bez ní se nedá nic posoudit.
 */
export interface ZkRada {
  /** Čeho se rada týká. */
  typ: ZkVrstvaTyp;
  /** Co říct zákazníkovi. */
  text: string;
  /** Barva, kterou rada navrhuje. Jen u kulisy. */
  hex: string;
  /** Kód produktu, který rada navrhuje. Jen u zboží. */
  produkt?: string;
  /** Jak je to důležité: `chybi` se ukazuje první. */
  druh: 'chybi' | 'ladi' | 'splyva';
}

/** Rozdíl dvou barev v odstínu a světlosti, 0 = stejné. */
export function barevnyRozdil(a: string, b: string): number {
  const x = hexNaRgb(a);
  const y = hexNaRgb(b);
  if (!x || !y) return 1;
  const d = Math.sqrt((x.r - y.r) ** 2 + (x.g - y.g) ** 2 + (x.b - y.b) ** 2);
  return Math.min(1, d / 441.67);
}

/** Nejbližší produkt dané vrstvy k hledané barvě. */
export function nejblizsiProdukt(
  katalog: ZkProdukt[],
  typ: ZkVrstvaTyp,
  hex: string,
  varianta = ''
): ZkProdukt | null {
  const nabidka = produktyKVrstve(katalog, typ, hex, varianta);
  return nabidka[0] ?? null;
}

export function poradce(v: ZkVzhled, katalog: ZkProdukt[] = []): ZkRada[] {
  const rady: ZkRada[] = [];
  const sako = v.kusy.sako;
  const kosile = v.kusy.kosile;
  const kravata = v.kusy.kravata;
  const maProdukty = (typ: ZkVrstvaTyp) => katalog.some(one => one.typ === typ);

  /* Kulisa: bez košile a kalhot se nedá posoudit, jak doplněk vypadá */
  if (!kosile) {
    rady.push({ typ: 'kosile', text: 'Nastav barvu košile — na bílé vypadá motýlek jinak než na modré.', hex: '#f6f6f4', druh: 'chybi' });
  }
  if (!v.kusy.sako && !v.kusy.vesta) {
    rady.push({ typ: 'sako', text: 'Přidej sako nebo vestu, ať je vidět, na čem doplněk bude.', hex: '#1f2d4d', druh: 'chybi' });
  }

  /*
   * A teď to hlavní: k nastavenému obleku chybí doplněk. Navrhne se
   * **konkrétní kus** — ten, co má k obleku barevně nejblíž o odstín
   * tmavší. Tohle je nejčastější první dokoupení k obleku.
   */
  if (!kravata && maProdukty('kravata')) {
    const cil = sako ? ztmav(sako.hex, 0.35) : '#5b1d26';
    const kus = nejblizsiProdukt(katalog, 'kravata', cil);
    if (kus) {
      rady.push({
        typ: 'kravata', produkt: kus.kod, hex: '',
        text: `K tomuhle obleku sedne ${kus.nazev.toLowerCase()}.`,
        druh: 'ladi'
      });
    }
  }
  if (!v.kusy.kapesnicek && (sako || v.kusy.vesta) && maProdukty('kapesnicek')) {
    const cil = kravata ? kravata.hex : (kosile?.hex ?? '#f6f6f4');
    const kus = nejblizsiProdukt(katalog, 'kapesnicek', cil);
    if (kus) {
      rady.push({
        typ: 'kapesnicek', produkt: kus.kod, hex: '',
        text: `Kapesníček je nejlevnější způsob, jak oblek pozvednout — ${kus.nazev.toLowerCase()} ladí.`,
        druh: 'ladi'
      });
    }
  }

  /* Splývání: doplněk, který není vidět, je vyhozená koupě */
  for (const typ of ['kravata', 'kapesnicek', 'ksandy'] as ZkVrstvaTyp[]) {
    const kus = v.kusy[typ];
    if (!kus) continue;
    const vuci = typ === 'ksandy' ? kosile : (sako ?? kosile);
    if (!vuci || barevnyRozdil(kus.hex, vuci.hex) >= 0.1) continue;
    const def = vrstvaDef(typ);
    /*
     * Mluví se o tom, co má zákazník vybrané — „Motýlek", ne „Kravata
     * nebo motýlek". Jméno vrstvy je název řádku v nabídce, ne slovo
     * do věty.
     */
    const jmeno = def.varianty.find(one => one.id === kus.varianta)?.nazev ?? def.nazev;
    const cil = svetlost(vuci.hex) < 0.5 ? '#c8b394' : ztmav(vuci.hex, 0.5);
    const jiny = nejblizsiProdukt(katalog, typ, cil, kus.varianta);
    rady.push({
      typ,
      produkt: jiny?.kod,
      hex: jiny ? '' : cil,
      text: jiny
        ? `${jmeno} v barvě podkladu zmizí. Vedle něj vynikne ${jiny.nazev.toLowerCase()}.`
        : `${jmeno} v barvě podkladu zmizí — zkus výraznější.`,
      druh: 'splyva'
    });
  }

  if (sako && kosile && barevnyRozdil(sako.hex, kosile.hex) < 0.12) {
    rady.push({
      typ: 'kosile',
      text: 'Košile má skoro stejnou barvu jako sako — na takové kulise se doplněk posoudit nedá.',
      hex: svetlost(sako.hex) < 0.5 ? '#f6f6f4' : '#1f2d4d',
      druh: 'splyva'
    });
  }

  if (v.kusy.pasek && v.kusy.ksandy) {
    rady.push({
      typ: 'ksandy',
      text: 'Pásek a kšandy naráz se nenosí. Nech jedno z toho.',
      hex: '', druh: 'splyva'
    });
  }
  return rady;
}

/** Barva o daný díl tmavší. Používá se u doporučení. */
export function ztmav(hex: string, dil: number): string {
  const rgb = hexNaRgb(hex);
  if (!rgb) return hex;
  const k = Math.max(0, 1 - dil);
  return rgbNaHex(rgb.r * k, rgb.g * k, rgb.b * k);
}

/**
 * Produkty, které se k vrstvě hodí — nejdřív ty v barvě nejblíž zvolené.
 *
 * Řadí se podle barvy, ne podle ceny ani abecedy: zákazník, který si
 * naklikal námořnický oblek, hledá námořnický oblek.
 */
export function produktyKVrstve(
  vse: ZkProdukt[],
  typ: ZkVrstvaTyp,
  hex: string,
  varianta = ''
): ZkProdukt[] {
  return vse
    .filter(one => one.typ === typ && (!varianta || !one.varianta || one.varianta === varianta))
    .map(one => ({ one, blizkost: hex ? barevnyRozdil(one.hex, hex) : 0 }))
    .sort((a, b) => a.blizkost - b.blizkost || b.one.cenaCislo - a.one.cenaCislo)
    .map(x => x.one);
}

/** Cena vzhledu dohromady. Kusy bez produktu se nepočítají. */
export function cenaVzhledu(v: ZkVzhled, katalog: ZkProdukt[]): { suma: number; kusu: number; chybi: number } {
  let suma = 0;
  let kusu = 0;
  let chybi = 0;
  for (const [, kus] of Object.entries(v.kusy)) {
    if (!kus) continue;
    const produkt = kus.produkt ? katalog.find(one => one.kod === kus.produkt) : null;
    if (produkt) { suma += produkt.cenaCislo; kusu += 1; } else { chybi += 1; }
  }
  return { suma, kusu, chybi };
}

/* ------------------------------------------------------- sdílení vzhledu */

/**
 * Vzhled jako krátký text do adresy.
 *
 * Potřebují ho dvě věci: odkaz v e-mailu „tenhle vzhled jsem si složil" a
 * uložení v prohlížeči. Proto je to zápis **bez databáze** — co se vejde
 * do adresy, přežije i smazanou historii a dá se poslat komukoli.
 */
export function vzhledDoTextu(v: ZkVzhled): string {
  const kusy = ZK_PORADI
    .filter(typ => typ !== 'postava' && typ !== 'vlasy' && typ !== 'fousy')
    .map(typ => {
      const kus = v.kusy[typ];
      if (!kus) return '';
      return `${typ}:${kus.varianta}:${kus.hex.replace('#', '')}:${kus.produkt ?? ''}`;
    })
    .filter(Boolean);
  const hlava = [
    v.vek, v.telo, String(v.vyskaCm),
    v.vlasyVarianta, v.vlasyHex.replace('#', ''), v.fousy || '-'
  ].join(':');
  return [hlava, ...kusy].join('|');
}

export function vzhledZTextu(text: string): ZkVzhled | null {
  const casti = String(text || '').split('|');
  const hlava = (casti[0] || '').split(':');
  if (hlava.length < 6) return null;
  const vek = hlava[0] as ZkVek;
  const telo = hlava[1] as ZkTelo;
  if (!ZK_VEKY[vek] || !ZK_TELA[telo]) return null;
  const v = vychoziVzhled(vek);
  v.telo = telo;
  v.vyskaCm = Number(hlava[2]) || v.vyskaCm;
  v.vlasyVarianta = hlava[3] || v.vlasyVarianta;
  v.vlasyHex = `#${hlava[4]}`;
  v.fousy = hlava[5] === '-' ? '' : hlava[5];
  v.kusy = {};
  for (const kus of casti.slice(1)) {
    const [typ, varianta, hex, produkt] = kus.split(':');
    if (!ZK_PORADI.includes(typ as ZkVrstvaTyp)) continue;
    v.kusy[typ as ZkVrstvaTyp] = {
      varianta: varianta || '',
      hex: `#${hex || 'ffffff'}`,
      produkt: produkt || undefined
    };
  }
  return v;
}

/**
 * Adresa, která produkt přidá do košíku.
 *
 * Upgates to umí přímo v adrese produktu (`?addtocart=1`), takže k tomu
 * není potřeba žádné rozhraní ani přihlášení. Produkt s velikostmi se tak
 * ale přidat nedá — velikost se v adrese nepředává a přidal by se jiný
 * kus, než zákazník chtěl. U těch se proto otevře detail produktu, kde si
 * velikost vybere.
 */
export function doKosikuUrl(p: ZkProdukt, pocet = 1): { url: string; rovnou: boolean } {
  const zaklad = p.url || '';
  if (!zaklad) return { url: '', rovnou: false };
  const spojka = zaklad.includes('?') ? '&' : '?';
  if (p.velikosti) return { url: zaklad, rovnou: false };
  return {
    url: `${zaklad}${spojka}addtocart=1&quantity=${Math.max(1, Math.round(pocet))}&return=back`,
    rovnou: true
  };
}

/* ------------------------------------------------- barva při generování */

/**
 * Barva, ve které se každý kus **kreslí** (ne ve které se pak zobrazuje).
 *
 * Tohle je drobnost, na které celé skládání stojí nebo padá. Vrstva
 * vzniká jako rozdíl dvou kroků — a když se sako nakreslí tou samou
 * střední šedou jako košile pod ním, rozdíl v místě, kde sako košili
 * překrývá, **není**. Z pětasedmdesátiprocentního saka pak zbude lem
 * kolem košile a na postavě to vypadá, že sako nemá rukávy. Přišlo se na
 * to na ukázkové kresbě: sako vyšlo na 17 % postavy místo čekaných 55 %.
 *
 * Každý kus se proto kreslí ve **výrazně jiné barvě** než ten pod ním.
 * Nic to nestojí: z obrázku se bere jen mapa světla, barva se zahodí a
 * zákazník si ji volí sám. Zbude z ní jedině to, že rozdíl mezi dvěma
 * kroky je nepřehlédnutelný.
 */
export const ZK_KRESLICI: Record<ZkVrstvaTyp, string> = {
  postava: '',
  vlasy: '#6e4e38',
  fousy: '#6e4e38',
  boty: '#6a4a1f',
  kalhoty: '#1f7a3a',
  kosile: '#c43a8a',
  pasek: '#c8a21f',
  ksandy: '#2f6fc8',
  kravata: '#c8511f',
  vesta: '#7a2fc8',
  sako: '#1f9ec8',
  kapesnicek: '#c81f3a'
};

/** Jak se barva řekne modelu, ať nehádá, co je „azurová". */
export const ZK_KRESLICI_SLOVY: Record<ZkVrstvaTyp, string> = {
  postava: '',
  vlasy: 'plain medium brown',
  fousy: 'plain medium brown',
  boty: 'plain mid-brown leather',
  kalhoty: 'plain mid-green (#1f7a3a)',
  kosile: 'plain mid-magenta (#c43a8a)',
  pasek: 'plain mustard yellow (#c8a21f)',
  ksandy: 'plain mid-blue (#2f6fc8)',
  kravata: 'plain mid-orange (#c8511f)',
  vesta: 'plain mid-violet (#7a2fc8)',
  sako: 'plain mid-cyan (#1f9ec8)',
  kapesnicek: 'plain mid-red (#c81f3a)'
};

/* ------------------------------------------------------- kontrola vrstvy */

export interface ZkMery {
  okraje: { x: number; y: number; w: number; h: number };
  /** Kolik plochy postavy vrstva zabírá. */
  podil: number;
}

/**
 * Sedí vrstva tam, kam patří?
 *
 * Vrací prázdno, když je všechno v pořádku, a jinak **česky to, co je
 * špatně** — ne kód chyby. Tahle věta je totiž jediné, co pak v okně
 * stojí u nepovedené vrstvy, a rozhoduje o tom, jestli člověk pochopí,
 * že má přegenerovat sako, nebo bude hledat chybu v aplikaci.
 *
 * Měří se v dílech postavy, ne v bodech: dětská postava má jiné rozměry
 * než dospělá, a oblékají se stejně.
 */
export function zkontrolujVrstvu(
  typ: ZkVrstvaTyp,
  mery: ZkMery,
  postava: { y: number; h: number }
): string {
  const def = vrstvaDef(typ);
  const k = def.kontrola;
  if (mery.podil <= 0 || mery.okraje.w === 0) {
    return 'Mezi krokem před a po se nezměnilo nic — model nic nepřikreslil.';
  }
  if (mery.podil < k.podilOd) {
    return `Vrstva zabírá jen ${(mery.podil * 100).toFixed(1)} % postavy, čekalo se aspoň ${(k.podilOd * 100).toFixed(1)} %.`
      + ' Buď model kus nedokreslil, nebo z něj zbyl jen cíp.';
  }
  if (mery.podil > k.podilDo) {
    return `Vrstva zabírá ${(mery.podil * 100).toFixed(0)} % postavy, víc než ${(k.podilDo * 100).toFixed(0)} %.`
      + ' Model nejspíš překreslil i to, co měl nechat.';
  }
  const vyska = Math.max(1, postava.h);
  const od = (mery.okraje.y - postava.y) / vyska;
  const doKam = (mery.okraje.y + mery.okraje.h - postava.y) / vyska;
  if (od < k.odY - 0.05 || doKam > k.doY + 0.05) {
    const procent = (hodnota: number) => `${Math.round(hodnota * 100)} %`;
    return `Vrstva leží mezi ${procent(od)} a ${procent(doKam)} výšky postavy;`
      + ` ${def.nazev.toLowerCase()} má být mezi ${procent(k.odY)} a ${procent(k.doY)}.`;
  }
  return '';
}

/* --------------------------------------------- co vidí okno aplikace */

export interface ZkPostavaStav {
  id: string;
  vek: string;
  telo: string;
  nazev: string;
  hotovo: boolean;
  vrstev: number;
  chystanych: number;
  nesedi: number;
  schvalenych: number;
}

export interface ZkObrazkovyModel {
  id: string;
  nazev: string;
  popis: string;
  verny: 'vzdy' | 'navolbu' | 'ne';
  cena: number;
}

export interface ZkPrehled {
  postavy: ZkPostavaStav[];
  maKlic: boolean;
  model: string;
  modely: ZkObrazkovyModel[];
  utrata: { mesic: string; usd: number; kusu: number; strop: number };
  produkty: { zarazenych: number; sBarvou: number; schvalenych: number };
  /** Postavy jsou zatím zástupná kresba, ne vygenerované fotky. */
  ukazkove: boolean;
}

export interface ZkVrstvaProOkno extends ZkVrstva {
  nazev: string;
  variantaNazev: string;
  barvitelna: boolean;
  /** Zmenšený obrázek jako `data:` — vrstva samotná má přes megabajt. */
  nahled: string;
}

export interface ZkKrokProOkno {
  poradi: number;
  typ: string;
  nahled: string;
}

export interface ZkNastaveni {
  maKlic: boolean;
  model: string;
  kvalita: string;
  maska: boolean;
  strop: number;
  kontakt: { text: string; telefon: string; mail: string };
}

export interface ZkProduktRadek {
  kod: string;
  typ: ZkVrstvaTyp | '';
  varianta: string;
  hex: string;
  /** Kousek látky z fotky — tohle se vydláždí na modelu. */
  vzorek: string;
  rucne: boolean;
  velikosti: boolean;
  schvaleno: boolean;
  nazev: string;
  obrazek: string;
  cena: string;
  vKabine: boolean;
}

export interface ZkNahled {
  url: string;
  velikost: { seznamKb: number; postav: number; vrstev: number; produktu: number };
}
