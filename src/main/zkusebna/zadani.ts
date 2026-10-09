import { getSetting } from '../db';
import { ZK_KRESLICI_SLOVY, ZkTelo, ZkVek, ZkVrstvaTyp } from '../../shared/zkusebna';

/**
 * Zadání pro kreslení — co se modelu říká.
 *
 * ## Proč je zadání anglicky, když je všechno ostatní česky
 *
 * Obrázkové modely jsou na anglických popiscích vycvičené a česky je to
 * znát: „sako na dva knoflíky" vyjde jako sako na tři a „stojáček" jako
 * nic. Zadání je jediné místo v aplikaci, kde se tím pravidlo o češtině
 * poruší — a je to kvůli výsledku, ne kvůli pohodlí.
 *
 * ## Proč se zadání dá přepsat v okně
 *
 * Tohle je ta část, u které se nedá předem vědět, jak vyjde. Žádná
 * zkouška neověří, že model nakreslí sako, které sedne na ramena; pozná
 * se to jedině tím, že se obrázek nakreslí a je vidět. Proto je výchozí
 * zadání v kódu, uložené v nastavení a kdykoli přepsatelné: u nepovedené
 * vrstvy se dá doladit věta a zkusit to znovu, bez nové verze aplikace.
 *
 * ## Proč má každý kus jinou barvu, když se stejně přebarví
 *
 * Z obrázku se bere jen mapa světla a barva se zahodí — tak proč tedy
 * modelu barvu diktovat? Protože vrstva vzniká jako **rozdíl dvou
 * kroků**: kdyby bylo sako stejně šedé jako košile pod ním, v místě, kde
 * ji překrývá, by rozdíl nebyl žádný a ze saka by zbyl lem bez rukávů.
 * Přišlo se na to na ukázkové kresbě, kde sako vyšlo na 17 % postavy
 * místo čekaných 55 %. Barva je proto u každého kusu jiná a výrazná.
 *
 * ## Co se v zadání opakuje a proč
 *
 * U každého dooblečení se znovu vypisuje, co **se nesmí změnit** — tvář,
 * postoj, ruce, výřez, světlo. Návod k modelu na to upozorňuje výslovně:
 * při opakovaných úpravách obrázek ujíždí, a stačí, aby se postava mezi
 * dvěma kroky o kousek pootočila, a vrstva spočítaná z rozdílu je duch
 * se dvěma rukávy.
 */

const KDO: Record<ZkVek, string> = {
  dospely: 'adult man in his thirties',
  dite: 'boy about eight years old',
  kojenec: 'baby about one year old, standing with support'
};

const TELA: Record<ZkTelo, string> = {
  hubeny: 'slim, narrow shoulders and narrow waist',
  bezny: 'average build',
  silny: 'heavier build, waist wider than the shoulders'
};

const SPODEK: Record<ZkVek, string> = {
  dospely: 'a plain white short-sleeve undershirt and plain light grey briefs',
  dite: 'a plain white short-sleeve undershirt and plain light grey shorts',
  kojenec: 'a plain white short-sleeve bodysuit'
};

/** Co platí pro každý obrázek: výřez, světlo, pozadí. */
const SPOLECNE = [
  'Even soft frontal studio lighting, no harsh shadows.',
  'Isolated subject on a fully transparent background: no floor, no backdrop,',
  'no shadow cast on the ground, no checkerboard pattern.',
  'Photographic and true to life, no stylisation, no illustration.',
  'The whole body from the top of the head to the soles of the feet must be',
  'inside the frame with a small margin above and below.'
].join(' ');

export function zadaniPostavy(vek: ZkVek, telo: ZkTelo): string {
  return [
    `Full-body studio photograph of a ${KDO[vek]}, ${TELA[telo]},`,
    'standing straight and facing the camera, arms relaxed at the sides,',
    'feet together, neutral friendly expression.',
    'Completely bald with a shaved head and no facial hair at all.',
    `Wearing only ${SPODEK[vek]}, barefoot.`,
    SPOLECNE
  ].join(' ');
}

/** Co se dooblékne — jedna věta za každou variantu. */
const KUSY: Record<string, string> = {
  'vlasy:kratke': 'a short neat haircut in plain medium brown',
  'vlasy:delsi': 'a longer haircut covering the ears, in plain medium brown',
  'vlasy:dozadu': 'hair combed back from the forehead, in plain medium brown',
  'fousy:knir': 'a trimmed moustache in plain medium brown',
  'fousy:strniste': 'short stubble over the chin and cheeks, in plain medium brown',
  'fousy:kozi': 'a goatee on the chin in plain medium brown',
  'fousy:plnovous': 'a full short beard in plain medium brown',
  'boty:spolecenske': `plain lace-up formal leather shoes in ${ZK_KRESLICI_SLOVY.boty}`,
  'kalhoty:oblekove': `plain flat-front suit trousers in ${ZK_KRESLICI_SLOVY.kalhoty}, hemmed at the shoe`,
  'kosile:klasicka': `a plain long-sleeve dress shirt with a classic collar in ${ZK_KRESLICI_SLOVY.kosile}, tucked in, buttoned to the top`,
  'kosile:stojacek': `a plain long-sleeve dress shirt with a band (mandarin) collar in ${ZK_KRESLICI_SLOVY.kosile}, tucked in`,
  'pasek:kozeny': `a plain leather belt with a small rectangular buckle in ${ZK_KRESLICI_SLOVY.pasek}`,
  'ksandy:uzke': `narrow Y-shaped braces (suspenders) over the shirt in ${ZK_KRESLICI_SLOVY.ksandy}`,
  'ksandy:siroke': `wide Y-shaped braces (suspenders) over the shirt in ${ZK_KRESLICI_SLOVY.ksandy}`,
  'kravata:kravata': `a plain necktie in ${ZK_KRESLICI_SLOVY.kravata}, tied in a four-in-hand knot`,
  'kravata:motylek': `a plain bow tie in ${ZK_KRESLICI_SLOVY.kravata}`,
  'kravata:regata': `a plain cravat (ascot tie) in ${ZK_KRESLICI_SLOVY.kravata}`,
  'vesta:klasicka': `a plain five-button waistcoat in ${ZK_KRESLICI_SLOVY.vesta}, worn over the shirt`,
  'sako:jednoradove': `a plain single-breasted two-button suit jacket in ${ZK_KRESLICI_SLOVY.sako}, worn open`,
  'sako:dvouradove': `a plain double-breasted suit jacket in ${ZK_KRESLICI_SLOVY.sako}, buttoned`,
  'kapesnicek:spicka': `a plain pocket square folded to a point in ${ZK_KRESLICI_SLOVY.kapesnicek}, in the breast pocket of the jacket`
};

/**
 * Zadání na dooblečení.
 *
 * Nejdůležitější větou je ta prostřední: co se nesmí změnit. Bez ní model
 * postavu překreslí po svém a rozdíl mezi kroky nevydá kus látky, ale
 * jiného člověka.
 */
export function zadaniKusu(typ: ZkVrstvaTyp, varianta: string): string {
  const co = KUSY[`${typ}:${varianta}`] ?? `plain ${typ} in ${ZK_KRESLICI_SLOVY[typ]}`;
  const vlasy = typ === 'vlasy' || typ === 'fousy';
  return [
    `Image 1 is the subject. ${vlasy ? 'Give the person' : 'Dress the person in'} ${co}.`,
    'Keep the person completely unchanged: identical face, facial features, skin tone,',
    'body shape, pose, hands, framing, scale and lighting.',
    vlasy
      ? 'Change nothing else about the head.'
      : 'Keep every garment already worn exactly as it is, and change nothing else.',
    'The fabric must have clearly visible natural folds, seams and shading,',
    'but no pattern, no stripes, no checks, no logo and no text.',
    'The background must stay fully transparent.',
    'Match the lighting and colour temperature of the original exactly.'
  ].join(' ');
}

/**
 * Zadání, které platí teď — z nastavení, nebo výchozí z kódu.
 *
 * Klíč v nastavení drží i doladěnou verzi, takže se po přegenerování
 * použije ta samá věta, která už jednou vyšla dobře.
 */
export function zadani(klic: string, vychozi: string): string {
  const ulozene = getSetting(`zkZadani:${klic}`, '')!;
  return ulozene || vychozi;
}

export function zadaniPostavyTed(vek: ZkVek, telo: ZkTelo): string {
  return zadani(`postava:${vek}:${telo}`, zadaniPostavy(vek, telo));
}

export function zadaniKusuTed(typ: ZkVrstvaTyp, varianta: string): string {
  return zadani(`${typ}:${varianta}`, zadaniKusu(typ, varianta));
}

export const __test = { KUSY, zadaniPostavy, zadaniKusu };
