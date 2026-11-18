/**
 * Nápověda k modulům — tvar obsahu.
 *
 * Obsah je data, ne JSX: jedna komponenta ho vykreslí pro všechny moduly
 * stejně a zkouška (`tools/help-test.cjs`) nad ním ověří, že každá
 * „ukázka na obrazovce" míří na prvek, který v okně opravdu je.
 *
 * Značky v textu kroků:
 *  - `[Popisek]` — tlačítko nebo záložka tak, jak je vidět v aplikaci
 *    (vykreslí se jako malá kopie tlačítka, ať se dá najít očima),
 *  - `**tučně**` — to podstatné ve větě.
 */

export interface HelpArea {
  id: string;
  /** Popisek v mapě okna */
  label: string;
  /** Poloha v mřížce 12 × 8 */
  x: number; y: number; w: number; h: number;
  /** Prvek v okně, který se při „Ukázat" zvýrazní */
  target?: string;
}

export interface HelpStep {
  text: string;
  /** Část mapy okna, které se krok týká */
  area?: string;
  /** Prvek v okně, který krok ukáže (přebíjí `target` oblasti) */
  target?: string;
}

export interface HelpGuide {
  title: string;
  /** Kdy to člověk dělá — jedna věta */
  when?: string;
  steps: HelpStep[];
}

export interface HelpTopic {
  id: string;
  title: string;
  icon: string;
  color: string;
  /** K čemu modul je — dvě věty nahoře */
  intro: string;
  /** Mapa okna — z čeho se obrazovka skládá */
  areas: HelpArea[];
  guides: HelpGuide[];
  tips: string[];
  /** Na co si dát pozor — žlutý rámeček */
  warnings?: string[];
}
