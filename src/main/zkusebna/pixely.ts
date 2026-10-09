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
  let nej: Posun = { dx: 0, dy: 0, chyba: Number.POSITIVE_INFINITY };
  for (let dy = -rozsah; dy <= rozsah; dy++) {
    for (let dx = -rozsah; dx <= rozsah; dx++) {
      let soucet = 0;
      let kusu = 0;
      // Každý třetí bod stačí: hledá se posun, ne rozdíl v detailu
      for (let y = oblast.y; y < oblast.y + oblast.h; y += 3) {
        const yb = y + dy;
        if (yb < 0 || yb >= b.vyska) continue;
        for (let x = oblast.x; x < oblast.x + oblast.w; x += 3) {
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
      if (chyba < nej.chyba) nej = { dx, dy, chyba };
    }
  }
  return nej.chyba === Number.POSITIVE_INFINITY ? { dx: 0, dy: 0, chyba: 0 } : nej;
}

/* ------------------------------------------------------------------ maska */

/**
 * Co se mezi dvěma kroky změnilo.
 *
 * Práh je na součtu odchylek složek i průhlednosti. Nízko by maska
 * pochytala šum komprese, vysoko by se ztratil přechod mezi tmavou
 * látkou a tmavým pozadím za ní.
 */
export function rozdil(pred: Obraz, po: Obraz, posun: Posun = { dx: 0, dy: 0, chyba: 0 }, prah = 38): Uint8Array {
  const maska = new Uint8Array(pred.sirka * pred.vyska);
  for (let y = 0; y < pred.vyska; y++) {
    const yb = y + posun.dy;
    if (yb < 0 || yb >= po.vyska) continue;
    for (let x = 0; x < pred.sirka; x++) {
      const xb = x + posun.dx;
      if (xb < 0 || xb >= po.sirka) continue;
      const ia = (y * pred.sirka + x) * 4;
      const ib = (yb * po.sirka + xb) * 4;
      const rozd = Math.abs(pred.body[ia] - po.body[ib])
        + Math.abs(pred.body[ia + 1] - po.body[ib + 1])
        + Math.abs(pred.body[ia + 2] - po.body[ib + 2])
        + Math.abs(pred.body[ia + 3] - po.body[ib + 3]);
      /*
       * Kde v novém kroku není nic (průhledno), tam vrstva není, i kdyby
       * se rozdíl zdál velký — zmizelá ruka není kus látky.
       */
      if (po.body[ib + 3] < 24) continue;
      if (rozd >= prah) maska[y * pred.sirka + x] = 255;
    }
  }
  return maska;
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
function rozsir(maska: Uint8Array, sirka: number, vyska: number, kolik: number): Uint8Array {
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

/** Celý úklid masky v jednom: zúžit, rozšířit, zahodit smítka, zjemnit okraj. */
export function uklid(maska: Uint8Array, sirka: number, vyska: number): Uint8Array {
  let out = zuz(maska, sirka, vyska, 4);
  out = rozsir(out, sirka, vyska, 4);
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
