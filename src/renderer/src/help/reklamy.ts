import type { HelpTopic } from './types';

/**
 * Nápověda k Reklamám.
 *
 * Fáze 1 jen čte, takže nápověda vysvětluje hlavně čísla: odkud jsou,
 * co znamená zisk po reklamě a proč má každý produkt jiné PNO. Bez toho
 * se čísla čtou jako v Google Ads (tržba, ROAS) a ztrácí se, proč je
 * modul postavený na zisku.
 */
export const ADS: HelpTopic = {
  id: 'ads',
  title: 'Reklamy',
  icon: 'megaphone',
  color: '#5e8a2f',
  intro: 'Kolik reklama opravdu vydělává: výkon z Google Ads spárovaný s objednávkami z Upgates a nákupními '
    + 'cenami z katalogu. Každou noc spočítá návrhy změn; do účtu se zapíše jen to, co potvrdíš, a každá změna jde vrátit.',
  areas: [
    { id: 'tabs', label: 'Záložky a období', x: 0, y: 0, w: 12, h: 1, target: '.ad-tabs' },
    { id: 'status', label: 'Stav nočního běhu', x: 0, y: 1, w: 12, h: 1, target: '.ad-status' },
    { id: 'kpis', label: 'Zisk po reklamě, obrat, náklady, PNO', x: 0, y: 2, w: 8, h: 2, target: '.ad-kpis' },
    { id: 'systems', label: 'Google, Sklik, Meta', x: 0, y: 4, w: 8, h: 2, target: '.ad-systems' },
    { id: 'chart', label: 'Den po dni', x: 0, y: 6, w: 8, h: 2, target: '.ad-chart' },
    { id: 'side', label: 'Čeká na tebe, upozornění, úspěšnost návrhů', x: 8, y: 2, w: 4, h: 6, target: '.ad-side' }
  ],
  guides: [
    {
      title: 'První připojení Google Ads',
      when: 'Jednou — stačí na jednom Macu, ostatní si data vezmou ze sdílené složky.',
      steps: [
        { text: 'Otevři záložku [Nastavení]. V Google Cloudu (projekt se zapnutým Google Ads API a přístupem **Explorer**) '
            + 'založ servisní účet a stáhni k němu klíč ve formátu JSON — postup je v Nastavení po bodech.', area: 'tabs' },
        { text: 'Klikni na [Nahrát klíč (JSON)] a vyber stažený soubor. Aplikace ukáže e-mail servisního účtu.', area: 'tabs' },
        { text: 'V Google Ads ten e-mail přidej jako uživatele (Správce → Přístup a zabezpečení) s přístupem **Standardní**. '
            + 'Bez přihlašovací obrazovky a bez ověřování aplikace — klíč nevyprší.', area: 'tabs' },
        { text: '[Vybrat účet] ukáže účty, ke kterým máš přístup — klikni na účet Quentina.', area: 'tabs' },
        { text: 'V hlavičce klikni na [Načíst data]. Poprvé se stáhne 90 dní, pak už to běží samo každou noc.', area: 'status' }
      ]
    },
    {
      title: 'Ranní kontrola za minutu',
      when: 'Každý den — nebo kdykoli chceš vědět, jestli reklama vydělává.',
      steps: [
        { text: 'Nahoře zkontroluj, že noční běh proběhl a nesvítí chyba.', area: 'status' },
        { text: 'Vpravo jsou upozornění. Červené (třeba **nefunguje měření**) řeš hned — rozbité měření vypadá '
            + 'jako propad výkonu.', area: 'side' },
        { text: 'První dlaždice je **zisk po reklamě**: zisk z objednávek minus náklady na reklamu. Pod ní je, '
            + 'kolik procent obratu to je proti cíli.', area: 'kpis' },
        { text: 'Dlaždice systémů ukazují útratu, zisk z konverzí a PNO proti cíli.', area: 'systems' }
      ]
    },
    {
      title: 'Projít návrhy změn',
      when: 'Ráno, když u záložky Návrhy svítí číslo.',
      steps: [
        { text: 'Tři nejvýnosnější návrhy jsou rovnou v Dnes vpravo pod **Čeká na tebe**. Všechny jsou v záložce [Návrhy].', area: 'side' },
        { text: 'Každý návrh má odhad v korunách za 30 dní, jistotu (tečky = kolik dat za ním stojí) a přesně vypsané, '
            + 'co se změní — rozpočet z kolika na kolik, která slova se vyloučí.', area: 'tabs' },
        { text: '[Použít] změnu hned zapíše do účtu. Na Macu, který není přihlášený ke Googlu, je místo něj [Schválit] '
            + '— změnu pak do deseti minut provede přihlášený Mac.', area: 'tabs' },
        { text: '[Odložit] ho schová na týden, [Zamítnout] na dva týdny, [Nenavrhovat] už nikdy pro tuhle kampaň.', area: 'tabs' },
        { text: 'Návrh se záporným odhadem a štítkem **drží cíl** stojí trochu zisku, ale drží cíl zisku z obratu. '
            + 'Když chceš spíš víc korun, sniž cíl v [Nastavení].', area: 'tabs' }
      ]
    },
    {
      title: 'Vrátit změnu',
      steps: [
        { text: 'V záložce [Návrhy] vpravo je **Historie změn** ze všech Maců.', area: 'tabs' },
        { text: '[Vrátit] nastaví účet zpět. Když mezitím někdo hodnotu v Google Ads změnil ručně, aplikace nic '
            + 'nepřepíše a řekne, co v účtu je.', area: 'tabs' },
        { text: 'Po 14 dnech se u změny ukáže, jestli **vyšla** — zisk kampaně za den před a po.', area: 'side' }
      ]
    },
    {
      title: 'Najít produkty, které jen utrácejí',
      steps: [
        { text: 'Otevři záložku [Produkty]. Mapa ukazuje útratu a zisk každého produktu, který v reklamách běží.', area: 'tabs' },
        { text: 'Klikni na štítek **Žrouti** — tabulka ukáže jen je. Po najetí na řádek je vidět, proč tam produkt je.', area: 'tabs' },
        { text: 'Sloupec **PNO / zlom**: když je PNO nad bodem zlomu (= marží), produkt na reklamě prodělává.', area: 'tabs' }
      ]
    },
    {
      title: 'Segmenty do Google Merchant Center',
      when: 'Jednou, aby se daly kampaně rozdělit podle segmentů.',
      steps: [
        { text: 'V [Nastavení] je adresa doplňkového feedu. Zkopíruj ji a v Merchant Center ji přidej jako '
            + 'doplňkový feed s denním načítáním.', area: 'tabs' },
        { text: 'Feed nese segment v **custom_label_0** a pásmo marže v **custom_label_1**. V kampani Performance '
            + 'Max nebo Nákupy pak jde dát hvězdám víc a žroutům méně.', area: 'tabs' }
      ]
    }
  ],
  tips: [
    'Období v hlavičce končí včerejškem — dnešek je rozdělaný a srovnával by se celý den s půlkou.',
    'Cílové PNO není jedno pro celý e-shop: je to **marže − požadovaný podíl zisku**. Levné zboží s nižší marží snese méně.',
    'Doplněním nákupních cen v Upgates budou čísla přesnější — u produktů bez ní se marže odhaduje podle kategorie.',
    'V [Nastavení] doplň, kolik stojí jednotlivé dopravy; odhady aplikace jsou označené.',
    'Vyřazení žroutů funguje přes custom_label_2 = vyradit — v kampani tuhle hodnotu jednou vylouč a dál se to řídí feedem.',
    'Vylučující slova se nikdy neberou ze slov, která jsou v názvu nějakého produktu, ani z dotazů, které prodaly.'
  ],
  warnings: [
    '[Použít] mění skutečný účet Google Ads. Před kliknutím si přečti, co přesně se změní — je to vypsané na kartě.',
    'Zisk se počítá ze **všech** objednávek, nejen z těch, které si připsala reklama — reklamní systémy si konverze přivlastňují velkoryse.'
  ]
};
