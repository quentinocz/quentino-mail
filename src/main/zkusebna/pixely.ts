import { Obraz, novyObraz } from './png';
import { hardLight, barvaPodMapu } from '../../shared/zkusebna';

/**
 * Výpočty nad body obrázku — čistě, bez Electronu a bez sítě.
 *
 * ## K čemu to je
 *
 * Vrstvy pro kabinu nevznikají tak, že by model nakreslil „sako na
 * průhledném pozadí". To by nikdy nesedlo na postavu: rukáv by končil
 * jinde než ruka. Místo toho se **ta samá postava postupně dooblékává** a
 * každá vrstva se spočítá jako **rozdíl mezi dvěma kroky**:
 *
 *   1. postava → 2. v košili → 3. v košili a vestě → 4. ještě v saku
 *
 * Co se mezi krokem 3 a 4 změnilo, je přesně sako — a je na svém místě na
 * bod přesně, protože je to pořád tentýž obrázek. Tahle cesta má jediný
 * háček: model obrázek mezi kroky nepatrně posune nebo překreslí něco, co
 * nemá. Proto se každý krok nejdřív **zarovná** podle hlavy a výsledek se
 * **změří** — maska, která zabírá půlku plátna nebo leží u nohou, když má
 * být sako, se pozná sama a nabídne se k přegenerování.
 */

/** Světlost bodu podle oka. Stejné váhy jako v prohlížeči. */
export function svetlostBodu(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/* --------------------------------------------------------------- zarovnání */

export interface Posun { dx: number; dy: number; chyba: number }

/**
 * O kolik se druhý obrázek posunul proti prvnímu.
 *
 * Měří se **na kusu, který se neměl měnit** — u oblékání hlava. Prohledá
 * se jen malé okolí: větší posun už není posun, ale jiný obrázek, a ten
 * se má zahodit, ne lepit.
 */
export function zarovnej(
  a: Obraz,
  b: Obraz,
  oblast: { x: number; y: number; w: number; h: number },
  rozsah = 6
): Posun {
  /*
   * Dvojí hledání: nejdřív nahrubo po třech bodech přes celý rozsah,
   * pak najemno bod po bodu kolem nalezeného posunu.
   *
   * Jedním průchodem to nejde. Po třech bodech se posun o jeden bod
   * **nedá poznat** — vzorky padnou doprostřed a vyjde táž chyba pro
   * posun o jedna i o tři. Zrovna ten jeden bod ale dělá ve vrstvě
   * tenký obrys postavy. Bod po bodu přes celý rozsah by zase bylo
   * stotřicetkrát tolik počítání, a to u každé z dvaadvaceti vrstev.
   */
  const nahrubo = hledejPosun(a, b, oblast, -rozsah, rozsah, -rozsah, rozsah, 3);
  return hledejPosun(
    a, b, oblast,
    nahrubo.dx - 2, nahrubo.dx + 2,
    nahrubo.dy - 2, nahrubo.dy + 2,
    1
  );
}

function hledejPosun(
  a: Obraz,
  b: Obraz,
  oblast: { x: number; y: number; w: number; h: number },
  odX: number, doX: number,
  odY: number, doY: number,
  krok: number
): Posun {
  let nej: Posun = { dx: 0, dy: 0, chyba: Number.POSITIVE_INFINITY };
  for (let dy = odY; dy <= doY; dy++) {
    for (let dx = odX; dx <= doX; dx++) {
      let soucet = 0;
      let kusu = 0;
      for (let y = oblast.y; y < oblast.y + oblast.h; y += krok) {
        const yb = y + dy;
        if (yb < 0 || yb >= b.vyska) continue;
        for (let x = oblast.x; x < oblast.x + oblast.w; x += krok) {
          const xb = x + dx;
          if (xb < 0 || xb >= b.sirka) continue;
          const ia = (y * a.sirka + x) * 4;
          const ib = (yb * b.sirka + xb) * 4;
          soucet += Math.abs(a.body[ia] - b.body[ib])
            + Math.abs(a.body[ia + 1] - b.body[ib + 1])
            + Math.abs(a.body[ia + 2] - b.body[ib + 2])
            + Math.abs(a.body[ia + 3] - b.body[ib + 3]);
          kusu += 1;
        }
      }
      if (!kusu) continue;
      const chyba = soucet / kusu;
      /*
       * Na shodu se posun **nemění**. Kotva může být skoro jednolitá —
       * hladké tričko, klidné pozadí — a pak sedí každý posun stejně
       * dobře. Dřív vyhrál ten, na který se narazilo první, tedy kraj
       * rozsahu: na zkoušce vyšel posun o šest bodů při nulové chybě a
       * celá postava se tím odnesla stranou. Z rozdílu dvou kroků byl
       * pak obrys postavy místo kusu látky — ten „duch".
       *
       * Proto se bere menší posun, dokud je rozdíl v chybě v šumu
       * (půl stupně jasu na bod, nebo pět procent). Když se obrázek
       * opravdu posunul, je rozdíl v chybě o řády větší a vyhraje.
       */
      const sum = Math.max(0.5, chyba * 0.05);
      const bliz = Math.abs(dx) + Math.abs(dy) < Math.abs(nej.dx) + Math.abs(nej.dy);
      if (chyba < nej.chyba - sum || (bliz && chyba < nej.chyba + sum)) nej = { dx, dy, chyba };
    }
  }
  return nej.chyba === Number.POSITIVE_INFINITY ? { dx: 0, dy: 0, chyba: 0 } : nej;
}



/* ---------------------------------------------------------- výřezy */

export interface Obdelnik { x: number; y: number; w: number; h: number }

/** Kus obrázku jako samostatný obrázek. */
export function vyrizniObdelnik(obraz: Obraz, kde: Obdelnik): Obraz {
  const out = novyObraz(kde.w, kde.h);
  for (let y = 0; y < kde.h; y++) {
    const zy = kde.y + y;
    if (zy < 0 || zy >= obraz.vyska) continue;
    for (let x = 0; x < kde.w; x++) {
      const zx = kde.x + x;
      if (zx < 0 || zx >= obraz.sirka) continue;
      const zi = (zy * obraz.sirka + zx) * 4;
      const ci = (y * kde.w + x) * 4;
      out.body[ci] = obraz.body[zi];
      out.body[ci + 1] = obraz.body[zi + 1];
      out.body[ci + 2] = obraz.body[zi + 2];
      out.body[ci + 3] = obraz.body[zi + 3];
    }
  }
  return out;
}

/**
 * Vloží upravený výřez zpátky do celého obrázku.
 *
 * Mimo výřez zůstane původní obrázek **bod po bodu**. Tím se celá otázka
 * „nepřekreslil model i něco jiného?" scvrkne na jediný výřez — mimo něj
 * to není možné.
 */
export function vlozObdelnik(zaklad: Obraz, kus: Obraz, kde: Obdelnik): Obraz {
  const out = novyObraz(zaklad.sirka, zaklad.vyska);
  out.body.set(zaklad.body);
  for (let y = 0; y < kus.vyska; y++) {
    const cy = kde.y + y;
    if (cy < 0 || cy >= zaklad.vyska) continue;
    for (let x = 0; x < kus.sirka; x++) {
      const cx = kde.x + x;
      if (cx < 0 || cx >= zaklad.sirka) continue;
      const ci = (cy * zaklad.sirka + cx) * 4;
      const zi = (y * kus.sirka + x) * 4;
      out.body[ci] = kus.body[zi];
      out.body[ci + 1] = kus.body[zi + 1];
      out.body[ci + 2] = kus.body[zi + 2];
      out.body[ci + 3] = kus.body[zi + 3];
    }
  }
  return out;
}

/* ------------------------------------------------- srovnání dvou kroků */

/**
 * Srovná celkový tón nového kroku podle toho starého.
 *
 * ## Proč to vůbec je
 *
 * Model obrázek nevrací beze změny ani tam, kam neměl sáhnout: celek
 * vyjde o kousek světlejší nebo teplejší. Člověk to nepozná, ale rozdíl
 * dvou kroků ano — a pak se jako „kus látky" označí celá postava.
 * Přesně takhle vyšly krátké vlasy na 23 % postavy místo tří procent.
 *
 * ## Jak se to měří
 *
 * Posun se bere **mimo pruh**, kde se kreslit nemělo, takže ho nemůže
 * zkreslit samotný kus látky. Z rozdílů se bere medián, ne průměr:
 * průměr by utáhlo pár bodů, kde se opravdu něco změnilo.
 */
export function srovnejTon(
  pred: Obraz,
  po: Obraz,
  pruh: { od: number; do: number },
  /*
   * Kde se smí odečítat. Při práci s výřezem jsou totiž body mimo něj
   * shodné z principu — kdyby se počítaly, medián by vyšel nula a
   * srovnání by se nikdy neprovedlo.
   */
  oblast?: Obdelnik
): Obraz {
  const vzorky: number[][] = [[], [], []];
  const odY = oblast ? Math.max(0, oblast.y) : 0;
  const doY = oblast ? Math.min(pred.vyska, oblast.y + oblast.h) : pred.vyska;
  const odX = oblast ? Math.max(0, oblast.x) : 0;
  const doX = oblast ? Math.min(pred.sirka, oblast.x + oblast.w) : pred.sirka;
  for (let y = odY; y < doY; y++) {
    if (y >= pruh.od && y <= pruh.do) continue;
    for (let x = odX; x < doX; x += 2) {
      const i = (y * pred.sirka + x) * 4;
      /* Průhledné pozadí nic neříká — počítá se jen tam, kde je postava */
      if (pred.body[i + 3] < 200 || po.body[i + 3] < 200) continue;
      for (let k = 0; k < 3; k++) vzorky[k].push(po.body[i + k] - pred.body[i + k]);
    }
  }
  const posun = vzorky.map(one => {
    if (one.length < 64) return 0;
    const serazene = one.slice().sort((a, b) => a - b);
    return serazene[Math.floor(serazene.length / 2)];
  });
  if (posun.every(one => one === 0)) return po;

  const out = novyObraz(po.sirka, po.vyska);
  for (let i = 0; i < po.body.length; i += 4) {
    for (let k = 0; k < 3; k++) {
      out.body[i + k] = Math.max(0, Math.min(255, po.body[i + k] - posun[k]));
    }
    out.body[i + 3] = po.body[i + 3];
  }
  return out;
}

/**
 * Rozšíří masku o `r` bodů do všech stran.
 *
 * Na rozdíl od `zmekci` to není rozostření: tady jde o dosah, ne o
 * měkký okraj, a dělá se to dvěma průchody přes vzdálenost k nejbližšímu
 * bodu masky (vodorovně, pak svisle). Rozostřením by se rozšíření o
 * padesát bodů počítalo padesátkrát přes celé plátno — tohle je jednou
 * tam a jednou zpátky, ať je dosah jakkoli velký.
 */
export function rozsir(maska: Uint8Array, sirka: number, vyska: number, r: number): Uint8Array {
  if (r <= 0) return Uint8Array.from(maska);
  const DALEKO = 1 << 30;
  const vodorovne = new Uint8Array(maska.length);
  const vzdalenost = new Int32Array(Math.max(sirka, vyska));
  for (let y = 0; y < vyska; y++) {
    const radek = y * sirka;
    let posledni = -DALEKO;
    for (let x = 0; x < sirka; x++) {
      if (maska[radek + x]) posledni = x;
      vzdalenost[x] = x - posledni;
    }
    let dalsi = DALEKO;
    for (let x = sirka - 1; x >= 0; x--) {
      if (maska[radek + x]) dalsi = x;
      vodorovne[radek + x] = Math.min(vzdalenost[x], dalsi - x) <= r ? 255 : 0;
    }
  }
  const out = new Uint8Array(maska.length);
  for (let x = 0; x < sirka; x++) {
    let posledni = -DALEKO;
    for (let y = 0; y < vyska; y++) {
      if (vodorovne[y * sirka + x]) posledni = y;
      vzdalenost[y] = y - posledni;
    }
    let dalsi = DALEKO;
    for (let y = vyska - 1; y >= 0; y--) {
      if (vodorovne[y * sirka + x]) dalsi = y;
      out[y * sirka + x] = Math.min(vzdalenost[y], dalsi - y) <= r ? 255 : 0;
    }
  }
  return out;
}

/**
 * Z nového kroku vezme jen pruh, kde se kreslit mělo; zbytek je původní.
 *
 * ## Proč se to slepuje
 *
 * Maska modelu říká, kam smí kreslit, ale nezaručuje, že zbytek vrátí
 * **bod po bodu stejný** — vrací překreslený obrázek, který se jinde jen
 * velmi podobá. Při dvaadvaceti krocích se ty drobné odchylky sčítají a
 * postava se postupně mění: po deseti krocích má jiný odstín pleti než
 * na začátku a vrstvy přestanou sedět.
 *
 * Slepením se to zastaví úplně: co je mimo pruh, je pořád ten první
 * obrázek, bod po bodu. Model tedy nemůže ujet jinam než tam, kde se
 * zrovna obléká — a rozdíl dvou kroků pak nemůže obsahovat nic jiného
 * než ten kus látky.
 *
 * ## Proč nestačí pruh
 *
 * Pruh je vodorovný a jde přes celé plátno, takže v něm vedle postavy
 * zbývá **prázdné pozadí**. Model do něj kreslí: u vlasů přišel zpátky
 * výřez, kde hlava zůstala holá a zaplnilo se okolí krku a ramen — a
 * z rozdílu vyšel kus „látky", ze kterého na postavě leželo osm
 * procent. Proto se dá předat `kde`: co je mimo postavu a její těsné
 * okolí, se bere taky z prvního obrázku. Kus oblečení je na člověku,
 * ne dvě stě bodů vedle něj.
 */
export function slep(
  pred: Obraz,
  po: Obraz,
  pruh: { od: number; do: number },
  /** Kam model vůbec smí sáhnout. Nic = celá šířka pruhu. */
  kde?: Uint8Array
): Obraz {
  const out = novyObraz(pred.sirka, pred.vyska);
  for (let y = 0; y < pred.vyska; y++) {
    const vPruhu = y >= pruh.od && y <= pruh.do;
    for (let x = 0; x < pred.sirka; x++) {
      const i = (y * pred.sirka + x) * 4;
      const zNoveho = vPruhu && (!kde || kde[y * pred.sirka + x] !== 0);
      const zdroj = zNoveho ? po : pred;
      out.body[i] = zdroj.body[i];
      out.body[i + 1] = zdroj.body[i + 1];
      out.body[i + 2] = zdroj.body[i + 2];
      out.body[i + 3] = zdroj.body[i + 3];
    }
  }
  return out;
}

/* ------------------------------------------------------------------ maska */

/** Jakým dílem síly skutečné změny se řídí práh, a kam až smí vystoupat. */
const DIL_PRAHU = 0.3;
const STROP_PRAHU = 160;

/**
 * Co se mezi dvěma kroky změnilo.
 *
 * Práh je na součtu odchylek složek i průhlednosti. Nízko by maska
 * pochytala šum komprese, vysoko by se ztratil přechod mezi tmavou
 * látkou a tmavým pozadím za ní.
 */
export function rozdil(
  pred: Obraz,
  po: Obraz,
  posun: Posun = { dx: 0, dy: 0, chyba: 0 },
  prah = 38,
  /* Nula znamená „jen pevný práh" — tak se dá změřit, co přizpůsobení dělá */
  dil = DIL_PRAHU
): Uint8Array {
  const sila = new Uint16Array(pred.sirka * pred.vyska);
  for (let y = 0; y < pred.vyska; y++) {
    const yb = y + posun.dy;
    if (yb < 0 || yb >= po.vyska) continue;
    for (let x = 0; x < pred.sirka; x++) {
      const xb = x + posun.dx;
      if (xb < 0 || xb >= po.sirka) continue;
      const ia = (y * pred.sirka + x) * 4;
      const ib = (yb * po.sirka + xb) * 4;
      /*
       * Kde v novém kroku není nic (průhledno), tam vrstva není, i kdyby
       * se rozdíl zdál velký — zmizelá ruka není kus látky.
       */
      if (po.body[ib + 3] < 24) continue;
      sila[y * pred.sirka + x] = Math.abs(pred.body[ia] - po.body[ib])
        + Math.abs(pred.body[ia + 1] - po.body[ib + 1])
        + Math.abs(pred.body[ia + 2] - po.body[ib + 2])
        + Math.abs(pred.body[ia + 3] - po.body[ib + 3]);
    }
  }

  const prahTed = Math.max(prah, Math.min(STROP_PRAHU, Math.round(silnyRozdil(sila) * dil)));
  const maska = new Uint8Array(sila.length);
  for (let i = 0; i < sila.length; i++) if (sila[i] >= prahTed) maska[i] = 255;
  return maska;
}

/**
 * Práh se přizpůsobí tomu, jak silná je ta skutečná změna.
 *
 * ## Proč pevný práh nestačí
 *
 * Model obrázek nepřekresluje jen tam, kam má. Kolem hlavy a ramen
 * zůstane slabý obrys — pár stupňů rozdílu, pevným prahem projde — a ve
 * vrstvě s vlasy pak visí duch celé postavy. Na modelu by to byl
 * šmouhovitý stín přes obličej.
 *
 * ## Co se místo toho dělá
 *
 * Vlasy proti holé hlavě jsou rozdíl o stovky stupňů, duch o desítky.
 * Práh se proto odvodí od **síly té skutečné změny**: vezme se horní
 * okraj rozdílů (98. percentil, aby ho neutáhlo pár vystřelených bodů)
 * a práh je jeho zlomek. Pevný práh zůstává jako spodní mez pro změny,
 * které jsou slabé celé (bílý kapesníček na bílé košili), a strop brání
 * tomu, aby silná změna vyžrala vlastní okraje.
 */
export function silnyRozdil(sila: Uint16Array): number {
  const histogram = new Uint32Array(1021);
  let kusu = 0;
  for (let i = 0; i < sila.length; i++) {
    if (sila[i] === 0) continue;
    histogram[Math.min(1020, sila[i])] += 1;
    kusu += 1;
  }
  if (kusu === 0) return 0;
  const kam = Math.floor(kusu * 0.98);
  let nasbirano = 0;
  for (let hodnota = 0; hodnota < histogram.length; hodnota++) {
    nasbirano += histogram[hodnota];
    if (nasbirano >= kam) return hodnota;
  }
  return 1020;
}

/** Jedno projetí: bod zůstane, má-li aspoň `kolik` sousedů z osmi. */
function zuz(maska: Uint8Array, sirka: number, vyska: number, kolik: number): Uint8Array {
  const out = new Uint8Array(maska.length);
  for (let y = 0; y < vyska; y++) {
    for (let x = 0; x < sirka; x++) {
      const i = y * sirka + x;
      if (!maska[i]) continue;
      let sousedu = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= sirka || ny >= vyska) continue;
          if (maska[ny * sirka + nx]) sousedu += 1;
        }
      }
      if (sousedu >= kolik) out[i] = 255;
    }
  }
  return out;
}

/** Jedno projetí opačně: dolije se bod, který má aspoň `kolik` sousedů. */
function dolij(maska: Uint8Array, sirka: number, vyska: number, kolik: number): Uint8Array {
  const out = Uint8Array.from(maska);
  for (let y = 0; y < vyska; y++) {
    for (let x = 0; x < sirka; x++) {
      const i = y * sirka + x;
      if (maska[i]) continue;
      let sousedu = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= sirka || ny >= vyska) continue;
          if (maska[ny * sirka + nx]) sousedu += 1;
        }
      }
      if (sousedu >= kolik) out[i] = 255;
    }
  }
  return out;
}

/**
 * Nechá jen souvislé kusy, které stojí za řeč.
 *
 * Rozdíl dvou kroků má kolem skutečného kusu látky vždycky pár osamělých
 * bodů — tam, kde model posunul stín nebo překreslil vlas. Kdyby zůstaly,
 * zákazník by viděl barevné smítko kdesi u ucha a nikdo by nepoznal proč.
 * Drobné kusy se proto zahodí; práh je **podíl z největšího kusu**, takže
 * to funguje stejně u saka jako u kapesníčku.
 */
export function jenVelke(maska: Uint8Array, sirka: number, vyska: number, podil = 0.08): Uint8Array {
  const kam = new Int32Array(maska.length).fill(-1);
  const velikosti: number[] = [];
  const front = new Int32Array(maska.length);
  for (let start = 0; start < maska.length; start++) {
    if (!maska[start] || kam[start] >= 0) continue;
    const kus = velikosti.length;
    let hlava = 0;
    let konec = 0;
    front[konec++] = start;
    kam[start] = kus;
    let pocet = 0;
    while (hlava < konec) {
      const i = front[hlava++];
      pocet += 1;
      const x = i % sirka;
      const y = (i - x) / sirka;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= sirka || ny >= vyska) continue;
          const j = ny * sirka + nx;
          if (!maska[j] || kam[j] >= 0) continue;
          kam[j] = kus;
          front[konec++] = j;
        }
      }
    }
    velikosti.push(pocet);
  }
  const nejvetsi = velikosti.reduce((a, b) => Math.max(a, b), 0);
  const strop = Math.max(12, nejvetsi * podil);
  const out = new Uint8Array(maska.length);
  for (let i = 0; i < maska.length; i++) {
    if (maska[i] && kam[i] >= 0 && velikosti[kam[i]] >= strop) out[i] = 255;
  }
  return out;
}

/**
 * Rozmázne okraj masky do průhlednosti.
 *
 * Tvrdý okraj vypadá na postavě jako vystřižené z papíru — a protože se
 * vrstvy skládají na sebe, sečetlo by se to u každého kusu znovu.
 */
export function zmekci(maska: Uint8Array, sirka: number, vyska: number, sila = 1): Uint8Array {
  let out = Uint8Array.from(maska);
  for (let krok = 0; krok < sila; krok++) {
    const dalsi = Uint8Array.from(out);
    for (let y = 0; y < vyska; y++) {
      for (let x = 0; x < sirka; x++) {
        const i = y * sirka + x;
        let soucet = 0;
        let kusu = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= sirka || ny >= vyska) continue;
            soucet += out[ny * sirka + nx];
            kusu += 1;
          }
        }
        dalsi[i] = Math.round(soucet / Math.max(1, kusu));
      }
    }
    out = dalsi;
  }
  return out;
}

/**
 * Celý úklid masky v jednom: zúžit, rozšířit, zahodit smítka, zjemnit.
 *
 * Zužuje se **dvakrát**, a to je ten rozdíl. Jedno projetí smete
 * osamělé body, ale ne tenký obrys kolem hlavy a ramen, který po sobě
 * model nechá — ten má pár bodů na šířku a každý jeho bod má dost
 * sousedů, aby přežil. Dvě projetí spolknou všechno tenčí než zhruba
 * čtyři body; kus látky je o řád tlustší a rozšíření ho vrátí do
 * původní velikosti.
 */
export function uklid(maska: Uint8Array, sirka: number, vyska: number): Uint8Array {
  let out = zuz(maska, sirka, vyska, 4);
  out = zuz(out, sirka, vyska, 4);
  out = dolij(out, sirka, vyska, 4);
  out = dolij(out, sirka, vyska, 4);
  out = jenVelke(out, sirka, vyska);
  return zmekci(out, sirka, vyska, 1);
}

export interface Okraje { x: number; y: number; w: number; h: number; podil: number }

/** Obdélník, ve kterém maska leží, a kolik plátna zabírá. */
export function okraje(maska: Uint8Array, sirka: number, vyska: number): Okraje {
  let x1 = sirka;
  let y1 = vyska;
  let x2 = -1;
  let y2 = -1;
  let kusu = 0;
  for (let y = 0; y < vyska; y++) {
    for (let x = 0; x < sirka; x++) {
      if (maska[y * sirka + x] < 40) continue;
      kusu += 1;
      if (x < x1) x1 = x;
      if (y < y1) y1 = y;
      if (x > x2) x2 = x;
      if (y > y2) y2 = y;
    }
  }
  if (x2 < 0) return { x: 0, y: 0, w: 0, h: 0, podil: 0 };
  return {
    x: x1, y: y1, w: x2 - x1 + 1, h: y2 - y1 + 1,
    podil: kusu / (sirka * vyska)
  };
}

/* -------------------------------------------------------- mapa světla */

/**
 * Z obrázku a masky udělá vrstvu k barvení.
 *
 * Barva se zahodí a nechá se jen **světlo**: kde je látka přesvětlená,
 * kde ji stíní záhyb. Prostřední hodnota se posune na 128, protože právě
 * 128 vydá v režimu `hard-light` přesně tu barvu, kterou si zákazník
 * vybral. Kdyby se nechala tak, jak přišla od modelu, byl by každý oblek
 * tmavší nebo světlejší podle toho, jakou barvu měl model chuť nakreslit —
 * a „přesná barva" by nebyla přesná.
 *
 * Posouvá se mocninou, ne přičtením: tak zůstane černá černá a bílá bílá
 * a nic se neodřízne.
 */
export function stinovaMapa(obraz: Obraz, maska: Uint8Array): Obraz {
  const svetla: number[] = [];
  for (let i = 0; i < maska.length; i++) {
    if (maska[i] < 160) continue;
    const k = i * 4;
    svetla.push(svetlostBodu(obraz.body[k], obraz.body[k + 1], obraz.body[k + 2]));
  }
  const out = novyObraz(obraz.sirka, obraz.vyska);
  if (svetla.length === 0) return out;
  svetla.sort((a, b) => a - b);
  const stred = svetla[Math.floor(svetla.length / 2)];
  /*
   * Mocnina, která prostřední hodnotu posadí na 128. U úplně černé nebo
   * bílé látky by vyšla nekonečná, proto se hodnota zkrotí do rozsahu,
   * ve kterém je výsledek ještě k něčemu.
   */
  const podil = Math.max(0.04, Math.min(0.96, stred / 255));
  const mocnina = Math.log(0.5) / Math.log(podil);
  const tabulka = new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    tabulka[v] = Math.max(0, Math.min(255, Math.round(255 * Math.pow(v / 255, mocnina))));
  }
  for (let i = 0; i < maska.length; i++) {
    const k = i * 4;
    if (!maska[i]) continue;
    const l = Math.round(svetlostBodu(obraz.body[k], obraz.body[k + 1], obraz.body[k + 2]));
    const stin = tabulka[Math.max(0, Math.min(255, l))];
    out.body[k] = out.body[k + 1] = out.body[k + 2] = stin;
    out.body[k + 3] = maska[i];
  }
  return out;
}

/** Z obrázku a masky udělá vrstvu, která se nebarví — zůstane, jak je. */
export function vyrizni(obraz: Obraz, maska: Uint8Array): Obraz {
  const out = novyObraz(obraz.sirka, obraz.vyska);
  for (let i = 0; i < maska.length; i++) {
    if (!maska[i]) continue;
    const k = i * 4;
    out.body[k] = obraz.body[k];
    out.body[k + 1] = obraz.body[k + 1];
    out.body[k + 2] = obraz.body[k + 2];
    out.body[k + 3] = Math.min(maska[i], obraz.body[k + 3] || 255);
  }
  return out;
}

/* ------------------------------------------------------------- skládání */

/**
 * Složí vrstvy na sebe — totéž, co dělá prohlížeč na plátně.
 *
 * Je to tady proto, aby se dalo ověřit, že obě strany počítají stejně.
 * Kdyby se rozešly, zákazník by viděl jinou barvu, než jaká se schválila,
 * a nikdo by neměl jak to poznat než okem na dvou obrazovkách.
 */
export function slozeni(
  vrstvy: { obraz: Obraz; hex?: string }[],
  sirka: number,
  vyska: number
): Obraz {
  const out = novyObraz(sirka, vyska);
  for (const vrstva of vrstvy) {
    /* Barva se předem posune, aby polotón mapy vydal přesně ji */
    const barva = vrstva.hex ? barvaPodMapu(vrstva.hex) : null;
    for (let i = 0, n = sirka * vyska; i < n; i++) {
      const k = i * 4;
      const a = vrstva.obraz.body[k + 3] / 255;
      if (a <= 0) continue;
      let r = vrstva.obraz.body[k];
      let g = vrstva.obraz.body[k + 1];
      let b = vrstva.obraz.body[k + 2];
      if (barva) {
        /* Mapa světla je šedá, takže stačí jedna složka */
        r = hardLight(barva.r, r);
        g = hardLight(barva.g, g);
        b = hardLight(barva.b, b);
      }
      out.body[k] = Math.round(r * a + out.body[k] * (1 - a));
      out.body[k + 1] = Math.round(g * a + out.body[k + 1] * (1 - a));
      out.body[k + 2] = Math.round(b * a + out.body[k + 2] * (1 - a));
      out.body[k + 3] = Math.round(255 * a + out.body[k + 3] * (1 - a));
    }
  }
  return out;
}

/* ------------------------------------------------- barva z fotky produktu */

/**
 * Pozadí fotky — doplní se od kraje.
 *
 * Produktové fotky mají pozadí bílé nebo světle šedé a kraj obrázku je
 * vždycky pozadí. Doplní se tedy od kraje dovnitř, dokud se barva nemění;
 * co zůstane, je produkt. Odhadovat pozadí „podle bílé" by u bílé košile
 * umazalo košili.
 */
export function pozadiOdKraje(obraz: Obraz, tolerance = 26): Uint8Array {
  const { sirka, vyska, body } = obraz;
  const pozadi = new Uint8Array(sirka * vyska);
  const front = new Int32Array(sirka * vyska);
  let hlava = 0;
  let konec = 0;
  const pridej = (x: number, y: number) => {
    const i = y * sirka + x;
    if (pozadi[i]) return;
    pozadi[i] = 255;
    front[konec++] = i;
  };
  for (let x = 0; x < sirka; x++) { pridej(x, 0); pridej(x, vyska - 1); }
  for (let y = 0; y < vyska; y++) { pridej(0, y); pridej(sirka - 1, y); }

  while (hlava < konec) {
    const i = front[hlava++];
    const x = i % sirka;
    const y = (i - x) / sirka;
    const k = i * 4;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= sirka || ny >= vyska) continue;
        const j = ny * sirka + nx;
        if (pozadi[j]) continue;
        const m = j * 4;
        const rozd = Math.abs(body[k] - body[m]) + Math.abs(body[k + 1] - body[m + 1])
          + Math.abs(body[k + 2] - body[m + 2]);
        if (rozd <= tolerance) { pozadi[j] = 255; front[konec++] = j; }
      }
    }
  }
  return pozadi;
}

/**
 * Nejčastější barva produktu na fotce.
 *
 * Nebere se průměr: průměr šedého saka s bílou košilí a černou kravatou
 * je mdlá šedohnědá, která v kabině nesedí na nic. Bere se **nejčastější
 * barva** z hrubé mřížky, a to jen z toho, co není pozadí — a ze spodních
 * dvou třetin obrázku, protože hlava modelu na fotce není produkt.
 */
export function barvaProduktu(obraz: Obraz): { hex: string; podil: number } {
  const pozadi = pozadiOdKraje(obraz);
  const koseKrok = 24;
  const mrizka = new Map<number, { n: number; r: number; g: number; b: number }>();
  let celkem = 0;
  const odkud = Math.floor(obraz.vyska * 0.12);
  for (let y = odkud; y < obraz.vyska; y++) {
    for (let x = 0; x < obraz.sirka; x++) {
      const i = y * obraz.sirka + x;
      if (pozadi[i]) continue;
      const k = i * 4;
      if (obraz.body[k + 3] < 128) continue;
      const r = obraz.body[k];
      const g = obraz.body[k + 1];
      const b = obraz.body[k + 2];
      const klic = (Math.floor(r / koseKrok) << 16) | (Math.floor(g / koseKrok) << 8) | Math.floor(b / koseKrok);
      const zde = mrizka.get(klic) ?? { n: 0, r: 0, g: 0, b: 0 };
      zde.n += 1; zde.r += r; zde.g += g; zde.b += b;
      mrizka.set(klic, zde);
      celkem += 1;
    }
  }
  if (!celkem) return { hex: '', podil: 0 };
  let nej = { n: 0, r: 0, g: 0, b: 0 };
  for (const zde of mrizka.values()) if (zde.n > nej.n) nej = zde;
  const prumer = (soucet: number) => Math.round(soucet / Math.max(1, nej.n));
  const hex = `#${[prumer(nej.r), prumer(nej.g), prumer(nej.b)]
    .map(one => Math.max(0, Math.min(255, one)).toString(16).padStart(2, '0')).join('')}`;
  return { hex, podil: nej.n / celkem };
}

/** Zmenší obrázek celočíselným dělením — na odhad barvy stačí a je to rychlé. */
export function zmensi(obraz: Obraz, kolikrat: number): Obraz {
  const k = Math.max(1, Math.round(kolikrat));
  if (k === 1) return obraz;
  const sirka = Math.max(1, Math.floor(obraz.sirka / k));
  const vyska = Math.max(1, Math.floor(obraz.vyska / k));
  const out = novyObraz(sirka, vyska);
  for (let y = 0; y < vyska; y++) {
    for (let x = 0; x < sirka; x++) {
      let r = 0; let g = 0; let b = 0; let a = 0; let n = 0;
      for (let dy = 0; dy < k; dy++) {
        for (let dx = 0; dx < k; dx++) {
          const sx = x * k + dx;
          const sy = y * k + dy;
          if (sx >= obraz.sirka || sy >= obraz.vyska) continue;
          const i = (sy * obraz.sirka + sx) * 4;
          r += obraz.body[i]; g += obraz.body[i + 1]; b += obraz.body[i + 2]; a += obraz.body[i + 3];
          n += 1;
        }
      }
      const i = (y * sirka + x) * 4;
      out.body[i] = Math.round(r / n);
      out.body[i + 1] = Math.round(g / n);
      out.body[i + 2] = Math.round(b / n);
      out.body[i + 3] = Math.round(a / n);
    }
  }
  return out;
}

/* ------------------------------------------------------- vzorek látky */

/**
 * Kousek látky vystřižený z fotky produktu.
 *
 * ## Proč nestačí barva
 *
 * Quentino prodává doplňky a zákazník si v kabině nevybírá odstín, ale
 * **konkrétní motýlka**. Ten má kostku, puntíky nebo proužek — a jedna
 * průměrná barva z něj udělá nudný flek, který se neprodává. Vzorek se
 * proto na modelu vydláždí pod mapu světla: vzor zůstane vzorem a sklady
 * zůstanou sklady.
 *
 * ## Jak se vybírá
 *
 * Hledá se čtverec, který je **celý na produktu** (ne na pozadí) a jehož
 * barva je nejblíž té nejčastější. Tím se vyhne hranám, odleskům a
 * stínům, které by se na modelu vydláždily jako mřížka. Když se takový
 * čtverec nenajde (malá fotka, samé pozadí), vrátí se prázdno a kabina
 * si vystačí s barvou.
 */
export function vzorekLatky(obraz: Obraz, velikost = 64): Obraz | null {
  const pozadi = pozadiOdKraje(obraz);
  const cil = barvaProduktu(obraz);
  if (!cil.hex) return null;
  const hledana = {
    r: parseInt(cil.hex.slice(1, 3), 16),
    g: parseInt(cil.hex.slice(3, 5), 16),
    b: parseInt(cil.hex.slice(5, 7), 16)
  };
  const strana = Math.min(velikost, obraz.sirka, obraz.vyska);
  if (strana < 8) return null;

  let nej: { x: number; y: number; chyba: number } | null = null;
  const krok = Math.max(2, Math.round(strana / 6));
  for (let y = 0; y + strana <= obraz.vyska; y += krok) {
    for (let x = 0; x + strana <= obraz.sirka; x += krok) {
      let soucet = 0;
      let kusu = 0;
      let naPozadi = 0;
      /* Čte se každý třetí bod — hledá se místo, ne přesná hodnota */
      for (let dy = 0; dy < strana; dy += 3) {
        for (let dx = 0; dx < strana; dx += 3) {
          const i = (y + dy) * obraz.sirka + (x + dx);
          if (pozadi[i]) { naPozadi += 1; continue; }
          const k = i * 4;
          soucet += Math.abs(obraz.body[k] - hledana.r)
            + Math.abs(obraz.body[k + 1] - hledana.g)
            + Math.abs(obraz.body[k + 2] - hledana.b);
          kusu += 1;
        }
      }
      if (!kusu || naPozadi > kusu * 0.02) continue;
      const chyba = soucet / kusu;
      if (!nej || chyba < nej.chyba) nej = { x, y, chyba };
    }
  }
  if (!nej) return null;

  const out = novyObraz(strana, strana);
  for (let dy = 0; dy < strana; dy++) {
    for (let dx = 0; dx < strana; dx++) {
      const z = ((nej.y + dy) * obraz.sirka + (nej.x + dx)) * 4;
      const k = (dy * strana + dx) * 4;
      out.body[k] = obraz.body[z];
      out.body[k + 1] = obraz.body[z + 1];
      out.body[k + 2] = obraz.body[z + 2];
      out.body[k + 3] = 255;
    }
  }
  return out;
}
