/**
 * Nástroje, které mají vlastní okno aplikace.
 *
 * ## Proč okna a ne překryvy
 *
 * Nástroje z nabídky Funkce se otevíraly přes celé okno aplikace a pod nimi
 * zůstala schovaná pošta. Katalog u regálu, balení objednávek a překlady
 * běží každý klidně hodinu — a po celou tu dobu se do pošty nedalo. Přepínat
 * se dalo jen tak, že se nástroj zavřel; u rozdělané práce to znamenalo
 * začít znovu.
 *
 * Focení to mělo vyřešené první a ukázalo se, že to je správná cesta pro
 * všechno ostatní. Okno je pořád tentýž balík skriptů i tentýž preload,
 * pozná se jen podle textu za mřížkou v adrese.
 *
 * ## Proč je seznam tady a ne v hlavním procesu
 *
 * Adresu okna otevírá hlavní proces, ale rozhodnutí „co se v něm vykreslí"
 * padne v okně samotném. Kdyby byl seznam dvakrát, stačilo by přepsat jméno
 * na jednom místě a okno by se otevřelo prázdné.
 */

export type ToolWindowId =
  | 'shoot' | 'packing' | 'catalog' | 'ptrans' | 'articles'
  | 'webtexts' | 'media' | 'reviews' | 'digest';

export type ToolWindowDef = {
  id: ToolWindowId;
  /** Text za mřížkou v adrese okna */
  hash: string;
  /**
   * Jméno okna. Vidí se v doku, v nabídce Okno a v přepínači úloh — proto
   * je rozlišující část první: v doku se jména ořezávají zprava.
   */
  title: string;
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  /**
   * Tmavé pozadí okna. Jen focení: světlost okolo náhledu mění, jak se
   * barva na fotce jeví.
   */
  dark?: boolean;
  /**
   * Okno si horní pruh kreslí samo (macOS „hiddenInset").
   *
   * Zase jen focení — má vlastní tmavou lištu s tlačítky a semafor se do ní
   * schová. Ostatní nástroje mají nahoře svou hlavičku s názvem a ta by se
   * se semaforem překryla; dostávají proto normální rám okna. Vedlejší
   * užitek: v rámu je vidět jméno okna, což je to, proč okna vznikla.
   */
  ownTitleBar?: boolean;
};

export const TOOL_WINDOWS: ToolWindowDef[] = [
  { id: 'shoot', hash: 'foceni', title: 'Focení — Quentino App',
    width: 1280, height: 860, minWidth: 900, minHeight: 620, dark: true, ownTitleBar: true },
  { id: 'packing', hash: 'baleni', title: 'Balení objednávek — Quentino App',
    width: 1180, height: 820, minWidth: 820, minHeight: 560 },
  { id: 'catalog', hash: 'katalog', title: 'Katalog a naskladnění — Quentino App',
    width: 1280, height: 860, minWidth: 860, minHeight: 600 },
  { id: 'ptrans', hash: 'produkty', title: 'Produkty a překlady — Quentino App',
    width: 1320, height: 880, minWidth: 900, minHeight: 620 },
  { id: 'articles', hash: 'clanky', title: 'Články — Quentino App',
    width: 1280, height: 880, minWidth: 860, minHeight: 620 },
  { id: 'webtexts', hash: 'texty', title: 'Texty na webu — Quentino App',
    width: 1100, height: 800, minWidth: 780, minHeight: 560 },
  { id: 'media', hash: 'media', title: 'Konvertor médií — Quentino App',
    width: 1180, height: 820, minWidth: 820, minHeight: 580 },
  { id: 'reviews', hash: 'recenze', title: 'Recenze zákazníků — Quentino App',
    width: 1280, height: 860, minWidth: 860, minHeight: 600 },
  { id: 'digest', hash: 'prehled', title: 'AI Přehled — Quentino App',
    width: 1140, height: 860, minWidth: 780, minHeight: 600 }
];

export function toolWindow(id: string): ToolWindowDef | undefined {
  return TOOL_WINDOWS.find(one => one.id === id);
}

export function toolWindowByHash(hash: string): ToolWindowDef | undefined {
  return TOOL_WINDOWS.find(one => one.hash === hash);
}
