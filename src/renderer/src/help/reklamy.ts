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
    + 'cenami z katalogu. Zatím jen čte — v účtech nic nemění. Návrhy změn přijdou, až se na datech ukáže, že čísla sedí.',
  areas: [
    { id: 'tabs', label: 'Záložky a období', x: 0, y: 0, w: 12, h: 1, target: '.ad-tabs' },
    { id: 'status', label: 'Stav nočního běhu', x: 0, y: 1, w: 12, h: 1, target: '.ad-status' },
    { id: 'kpis', label: 'Zisk po reklamě, obrat, náklady, PNO', x: 0, y: 2, w: 8, h: 2, target: '.ad-kpis' },
    { id: 'systems', label: 'Google, Sklik, Meta', x: 0, y: 4, w: 8, h: 2, target: '.ad-systems' },
    { id: 'chart', label: 'Den po dni', x: 0, y: 6, w: 8, h: 2, target: '.ad-chart' },
    { id: 'side', label: 'Upozornění a brána k návrhům', x: 8, y: 2, w: 4, h: 6, target: '.ad-side' }
  ],
  guides: [
    {
      title: 'První připojení Google Ads',
      when: 'Jednou — stačí na jednom Macu, ostatní si data vezmou ze sdílené složky.',
      steps: [
        { text: 'Otevři záložku [Nastavení]. Postup v Google Cloudu je tam po bodech: zapnout Google Ads API, '
            + 'požádat o přístup **Explorer** a vytvořit klienta OAuth typu **Desktop app**.', area: 'tabs' },
        { text: 'Vlož ID klienta a tajný klíč a klikni na [Přihlásit Google]. Otevře se prohlížeč; po přihlášení '
            + 'se vrať do aplikace.', area: 'tabs' },
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
    'V [Nastavení] doplň, kolik stojí jednotlivé dopravy; odhady aplikace jsou označené.'
  ],
  warnings: [
    'Zisk se počítá ze **všech** objednávek, nejen z těch, které si připsala reklama — reklamní systémy si konverze přivlastňují velkoryse.'
  ]
};
