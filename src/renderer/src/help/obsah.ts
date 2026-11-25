import type { HelpTopic } from './types';

/*
 * Nápověda ke komunikaci, obsahu webu a nastavení.
 * Stejná pravidla jako v obchod.ts: první postup je běžný den.
 */

export const MAIL: HelpTopic = {
  id: 'mail',
  title: 'Pošta',
  icon: 'mail',
  color: '#7c5cff',
  intro: 'E-maily ze všech schránek na jednom místě. U zprávy od zákazníka je hned vidět jeho objednávka '
    + 'a stav zásilky; odpověď navrhne AI podle vlákna, firemních znalostí a předešlých odpovědí.',
  areas: [
    { id: 'side', label: 'Schránky, složky, Nastavení', x: 0, y: 0, w: 2, h: 8, target: '.sidebar' },
    { id: 'list', label: 'Seznam zpráv', x: 2, y: 0, w: 4, h: 8 },
    { id: 'view', label: 'Zpráva a odpověď', x: 6, y: 0, w: 6, h: 8 }
  ],
  guides: [
    {
      title: 'Odpovědět zákazníkovi',
      steps: [
        { text: 'Otevři zprávu. Odznak u řádku ukazuje číslo objednávky, dopravu a platbu.', area: 'list' },
        { text: 'Klikni na [Navrhnout] — AI napíše odpověď podle vlákna a firemních znalostí. Nebo [Odpovědět] a piš sám.', area: 'view' },
        { text: 'V okně odpovědi přepni jazyk e-mailu (CZ/SK/EN) — podle něj se volí odkazy na produkty i jazyk AI.', area: 'view' },
        { text: 'Produkt vložíš tlačítkem v liště nástrojů na místo kurzoru, dárkový poukaz tlačítkem [Poukaz].', area: 'view' },
        { text: 'Odešli, nebo [Naplánovat] na později. Naplánované najdeš v [K odeslání].', area: 'side' }
      ]
    },
    {
      title: 'Zjistit, co zákazník objednal',
      steps: [
        { text: 'U zprávy otevři celou komunikaci se zákazníkem — vidíš všechny jeho e-maily i objednávky.', area: 'view' },
        { text: 'Ve složce [K objednávkám] jsou zprávy, které se objednávek týkají.', area: 'side' }
      ]
    }
  ],
  tips: [
    'Odeslání se dá ještě pár vteřin vzít zpět.',
    'Když schránka na serveru dochází, klikni na ukazatel obsazení — nabídne úklid.',
    'Firemní znalosti (reklamační řád, doprava…) se nastavují v [Nastavení] → Znalosti; AI z nich čerpá.'
  ]
};

export const CHAT: HelpTopic = {
  id: 'chat',
  title: 'Chat',
  icon: 'chat',
  color: '#2f9e8f',
  intro: 'Zprávy z chatovacího okénka na e-shopu. Odpovídáš odsud a zákazník to vidí hned na webu.',
  areas: [
    { id: 'list', label: 'Konverzace (Otevřené / Vše)', x: 0, y: 0, w: 4, h: 8, target: '.sidebar' },
    { id: 'thread', label: 'Vlákno a odpověď', x: 4, y: 0, w: 8, h: 8 }
  ],
  guides: [
    {
      title: 'Odpovědět v chatu',
      steps: [
        { text: 'Vlevo v [Otevřené] jsou konverzace, které čekají na odpověď.', area: 'list' },
        { text: 'Napiš odpověď dole. Tlačítkem [Produkt] vložíš odkaz na produkt s obrázkem.', area: 'thread' },
        { text: 'Když zákazník nechal e-mail, [Napsat e-mail] přenese konverzaci do pošty.', area: 'thread' }
      ]
    },
    {
      title: 'Nastavit chat poprvé',
      steps: [
        { text: '[Nastavení chatu]: adresa projektu Supabase, veřejný klíč a adresa nasazeného chatu.', area: 'list' },
        { text: 'Vyplň, kdo odpovídá a jak se podepisuje. [Vyzkoušet spojení] a [Uložit].', area: 'list' }
      ]
    }
  ],
  tips: ['Nepřečtené konverzace ukazuje číslo u záložky Chat v přepínači nahoře.']
};

export const INSTAGRAM: HelpTopic = {
  id: 'instagram',
  title: 'Sociální sítě',
  icon: 'camera',
  color: '#c2417a',
  intro: 'Příspěvky na Instagram a Facebook pro všechny trhy. Z příspěvku na hlavním účtu udělá verze '
    + 'pro další trhy, naplánuje je a sám publikuje; u videa přidá a přeloží titulky.',
  areas: [
    { id: 'side', label: 'Feed · Příspěvky · Fronta · Video · Nastavení', x: 0, y: 0, w: 2, h: 8, target: '.sidebar' },
    { id: 'main', label: 'Obsah vybrané části', x: 2, y: 0, w: 10, h: 8, target: '.ig-main' }
  ],
  guides: [
    {
      title: 'Naplánovat měsíc příspěvků',
      steps: [
        { text: 'V [Příspěvky] nastav, kolik příspěvků měsíčně chceš, ve které dny a v kolik hodin.', area: 'side' },
        { text: '[Navrhnout měsíc] — AI navrhne témata. Co se ti líbí, [Zařadit mezi příspěvky]; zbytek [Zahodit].', area: 'main' },
        { text: 'U každého příspěvku doplň média a popisky a zvol, kam publikovat (Instagram, Facebook, oboje).', area: 'main' }
      ]
    },
    {
      title: 'Přenést příspěvek na další trhy',
      steps: [
        { text: 'V [Feed] jsou příspěvky z hlavního účtu. Filtr **Chybí trhy** ukáže, co ještě jinde nevyšlo.', area: 'side' },
        { text: 'Otevři příspěvek — popisky pro ostatní trhy napíše AI podle hlasu značky; uprav je.', area: 'main' },
        { text: '[Naplánovat na] konkrétní čas, nebo publikovat hned. Stav uvidíš ve [Fronta a plán].', area: 'main' }
      ]
    },
    {
      title: 'Video s titulky pro každý trh',
      steps: [
        { text: 'V [Video s titulky] přidej záběry a ořízni je na časové ose.', area: 'side' },
        { text: 'Napiš titulky (nebo je nadiktuj) a [Přeložit všechny trhy].', area: 'main' },
        { text: 'Vykresli a publikuj — každý trh dostane video se svými titulky.', area: 'main' }
      ]
    }
  ],
  tips: [
    'Hlas značky, trhy a hashtagy se nastavují v [Značka a trhy] — AI se jimi řídí u všech popisků.',
    'Účty se připojují v [Účty a připojení]; když tam svítí upozornění, chybí oprávnění.',
    'Na vykreslení videa je potřeba ffmpeg.'
  ]
};

export const SHOOT: HelpTopic = {
  id: 'shoot',
  title: 'Focení',
  icon: 'eye',
  color: '#2f9e8f',
  intro: 'Živý náhled z fotoaparátu s vodítky, průsvitkou předchozí fotky a seznamem záběrů. Fotky se '
    + 'ukládají samy do zvolené složky — tlačítko „Uložit" není potřeba.',
  areas: [
    { id: 'top', label: 'Název focení, Hotovo, Nové focení', x: 0, y: 0, w: 12, h: 1, target: '.sh-top' },
    { id: 'view', label: 'Živý náhled', x: 0, y: 1, w: 9, h: 7 },
    { id: 'panel', label: 'Průsvitka, záběry, vodítka, korekce', x: 9, y: 1, w: 3, h: 7 }
  ],
  guides: [
    {
      title: 'Nafotit sérii produktů',
      steps: [
        { text: 'Připoj fotoaparát (nebo použij webkameru) a vyber složku, kam se fotí.', area: 'panel' },
        { text: 'V **Korekce** klikni [Kliknout na bílou] a ťukni do bílého pozadí — srovná barvy.', area: 'panel' },
        { text: '**Průsvitka** přes náhled ukáže předchozí fotku: produkty pak leží na stejném místě.', area: 'panel' },
        { text: '**Záběry v sérii** — co se u každého kusu fotí. Po snímku se seznam sám posune na další '
            + 'nenafocený záběr.', area: 'panel' },
        { text: 'Hotovo? [Hotovo] nahoře řekne, kam se fotky uložily, a nabídne převod do WebP.', area: 'top' }
      ]
    }
  ],
  tips: [
    '[Velká obrazovka] otevře náhled ve vlastním okně — na monitor u stolu.',
    'Vodítka (mřížku, rámeček) přidáš v panelu vpravo.'
  ]
};

export const REVIEWS: HelpTopic = {
  id: 'reviews',
  title: 'Recenze zákazníků',
  icon: 'star',
  color: '#d99a1b',
  intro: 'Recenze s fotkami, které se ukazují na e-shopu — ve všech jazycích. Píšou se tady, '
    + 'na web jdou tlačítkem Vystavit.',
  areas: [
    { id: 'list', label: 'Seznam recenzí', x: 0, y: 0, w: 4, h: 8, target: '.rv-list' },
    { id: 'detail', label: 'Recenze: text, fotka, jazyky', x: 4, y: 0, w: 8, h: 8, target: '.rv-detail' }
  ],
  guides: [
    {
      title: 'Přidat recenzi',
      steps: [
        { text: '[Nová recenze]. Přidej fotku z počítače, popisek pod fotku, text recenze a podpis '
            + '(jméno zákazníka).', area: 'list' },
        { text: '[Přeložit do SK a EN] — doplní ostatní jazyky.', area: 'detail' },
        { text: '[Vystavit]. Dokud nevystavíš, je nahoře upozornění, že na webu změny ještě nejsou.', area: 'detail' }
      ]
    },
    {
      title: 'Poprvé: převzít recenze z webu',
      steps: [
        { text: '[Načíst z webu] nebo [Převzít původní recenze] načte ty, které už na e-shopu jsou.', area: 'list' },
        { text: '[Skript pro e-shop] vloží do šablony e-shopu skript, který recenze ukazuje. Stačí jednou.', area: 'list' }
      ]
    }
  ],
  tips: ['Fotky se převedou na WebP a nahrají samy.']
};

export const WEBTEXTS: HelpTopic = {
  id: 'webtexts',
  title: 'Texty na webu',
  icon: 'pen',
  color: '#7a5fc2',
  intro: 'Naplánované změny textů na e-shopu — hlavně o doručení a expedici (dovolená, svátky, Vánoce). '
    + 'Změna se na webu sama zapne a zase vypne.',
  areas: [
    { id: 'tabs', label: 'Plán · Vánoce · Napojení', x: 0, y: 0, w: 12, h: 1 },
    { id: 'list', label: 'Naplánované změny', x: 0, y: 1, w: 4, h: 7, target: '.wt-list' },
    { id: 'edit', label: 'Texty změny a platnost', x: 4, y: 1, w: 8, h: 7, target: '.wt-edit' }
  ],
  guides: [
    {
      title: 'Ohlásit dovolenou nebo pozdější expedici',
      steps: [
        { text: 'V [Plán] klikni na [Nová změna]. Dej název a platnost od–do.', area: 'list' },
        { text: 'Napiš texty. **Expedujeme od** posune i odhad doručení na webu, ať nesedí „doručíme zítra".', area: 'edit' },
        { text: '[Přeložit do SK a EN] doplní jen prázdná políčka.', area: 'edit' },
        { text: 'U odkazů v liště stačí česká adresa. Slovenskou a anglickou aplikace dohledá na té stránce '
            + '(přepínač jazyků) — pod polem vidíš „SK ✓ EN ✓", nebo co chybí.', area: 'edit' },
        { text: '[Uložit a vystavit]. Chybí-li překlad nebo adresa pro jiný trh, aplikace se zastaví a nabídne '
            + 'doplnění. Když se změna překrývá s jinou, nabídne zkrátit tu předchozí.', area: 'edit' }
      ]
    },
    {
      title: 'Vánoční garance doručení',
      steps: [
        { text: 'Záložka [Vánoce]: nastav, od kdy do kdy se garance ukazuje a do kdy platí.', area: 'tabs' },
        { text: 'Ulož a vystav.', area: 'edit' }
      ]
    }
  ],
  tips: ['[Napojení] se vyplňuje jen jednou — kam aplikace texty ukládá a odkud je web čte.']
};

export const ZKUSEBNA: HelpTopic = {
  id: 'zkusebna',
  title: 'Zkušební kabina',
  icon: 'user',
  color: '#2f6fc8',
  intro: 'Zákazník si na e-shopu „oblékne" model a zkouší na něm kravaty, motýlky a kšandy. '
    + 'Tady se připravují postavy a vrstvy doplňků a kabina se vystavuje na web.',
  areas: [
    { id: 'tabs', label: 'Kabina · Vizuály · Produkty · Nastavení', x: 0, y: 0, w: 12, h: 1 },
    { id: 'main', label: 'Náhled kabiny / dílna', x: 0, y: 1, w: 12, h: 7 }
  ],
  guides: [
    {
      title: 'Připravit a vystavit kabinu',
      steps: [
        { text: '[Kabina] ukazuje, co uvidí zákazník — proklikej si celou cestu.', area: 'tabs' },
        { text: '[Vizuály]: postavy a vrstvy. Vygenerovaný obrázek [Schválit], nebo vyber jiný.', area: 'main' },
        { text: '[Produkty]: které doplňky jsou v kabině a v jakých barvách.', area: 'main' },
        { text: '[Vystavit na web]. Poprvé ještě [Zkopírovat zavaděč] do šablony e-shopu.', area: 'main', target: '.zk-akce' }
      ]
    },
    {
      title: 'Když generování nejde',
      steps: [
        { text: 'Nad vrstvami zůstane pruh s poslední chybou — přečti, co v ní stojí.', area: 'main' },
        { text: '[Vyzkoušet model]: jeden malý obrázek za cent ověří klíč, model i průhledné pozadí.', area: 'main' },
        { text: 'Hlášení o ověření organizace se řeší na platform.openai.com, ne v aplikaci.', area: 'main' },
        { text: 'Pořád nic? V [Nastavení] vyber jiný model a zkus to znovu.', area: 'tabs' }
      ]
    }
  ],
  tips: [
    'Kreslení postav platí z účtu OpenAI — klíč, model a měsíční strop jsou v [Nastavení].',
    'Model, který průhledné pozadí nevrátí, nevadí: aplikace kreslí na bílém a pozadí vyřízne sama.',
    'Kravaty, motýlky, kšandy a kapesníčky nekreslí model — jsou to šablony v rozměrech z katalogu. '
      + 'Když sedí o kus vedle, posuň v [Vizuály] body límce, pasu, ramene nebo kapsy.',
    'Dokud jsou postavy zástupná kresba, říká to pruh přímo v okně.',
    'Sady a produkty s víc věcmi na fotce čekají v [Produkty] nahoře. U každého kusu [Nahrát fotku] '
      + 'jen té jedné věci a zařazení potvrď fajfkou — do té doby je zákazník v kabině nevidí.',
    'Přepínač [Mobil] v náhledu ukáže kabinu na šířku telefonu, jak ji uvidí většina zákazníků.',
    '[Rozpoznat fotky AI]: AI pozná, co je na fotce (kšandy, motýlek, knoflíčky), a ukáže, kde je '
      + 'rovná látka — vzor se bere ze skutečné fotky. Sady se rozpoznají samy při projití katalogu.',
    'Když v kabině chybí vypínač saka nebo vesty, řekne nad náhledem žlutý pruh, které postavě vrstva chybí.',
    'Nastavení → Revize podkladů → [Exportovat podklady]: ZIP se vším, z čeho se model skládá, k pečlivé '
      + 'kontrole a dotažení. Upravený se vrátí přes [Načíst upravené].',
    'Vizuály → [Realistické šablony]: AI jednou za postavu dokreslí kravaty, motýlky, kšandy a kapesníček '
      + 'realisticky (záhyby, uzel, spony). Vzor každého produktu jde dál z jeho fotky, takže to zlepší všechny '
      + 'produkty naráz. U jedné šablony tlačítko [Realisticky]; zpět na kreslenou [Vrátit kreslenou].',
    'Produkty → Vykreslení na modelu: volitelné doladění vybraných kusů — AI dostane kus už v látce z fotky '
      + 'a jen ho zfotorealističtí. Jeden obrázek na kus, výsledek je vidět vždy; nesedící jde [Přesto použít].'
  ]
};

export const DIGEST: HelpTopic = {
  id: 'digest',
  title: 'AI Přehled',
  icon: 'sunrise',
  color: '#c29a3a',
  intro: 'Prodeje, návštěvnost a sítě v číslech — a k nim postřehy, co z toho plyne. Na čísla se dá '
    + 'rovnou doptat otázkou.',
  areas: [
    { id: 'head', label: 'Dnešní / starší přehledy, události, PDF', x: 0, y: 0, w: 12, h: 1 },
    { id: 'tiles', label: 'Čísla, co stojí za pozornost', x: 0, y: 1, w: 12, h: 2, target: '.dg-tiles' },
    { id: 'cards', label: 'Nejprodávanější, návštěvnost, cesta k nákupu, sítě…', x: 0, y: 3, w: 8, h: 5 },
    { id: 'ai', label: 'Postřehy a otázky', x: 8, y: 3, w: 4, h: 5 }
  ],
  guides: [
    {
      title: 'Ranní kontrola',
      steps: [
        { text: 'Nahoře jsou čísla, která se proti běžnému stavu pohnula.', area: 'tiles' },
        { text: '**Postřehy** a **Co z toho plyne** shrnují, čeho si všimnout a co udělat.', area: 'ai' },
        { text: 'V **Doptat se na čísla** se zeptej na cokoli: „Proč klesly kšandy?" — odpověď vychází '
            + 'z těchto čísel.', area: 'ai' }
      ]
    },
    {
      title: 'Zapsat událost',
      steps: [
        { text: 'Akce, dovolená, inventura — zapiš ji v **Události** v hlavičce.', area: 'head' },
        { text: 'Za rok se pak u čísel pozná, proč byla jinak.', area: 'cards' }
      ]
    }
  ],
  tips: ['Přehled se dá uložit do PDF tlačítkem v hlavičce.']
};

export const SETTINGS: HelpTopic = {
  id: 'settings',
  title: 'Nastavení',
  icon: 'settings',
  color: '#6b6579',
  intro: 'Účty, podpisy, napojení na e-shop a AI. Většina se vyplňuje jednou.',
  areas: [
    { id: 'tabs', label: 'Účty · Osoby · AI · Znalosti · Třídění · Sync · Telefon', x: 0, y: 0, w: 12, h: 1 },
    { id: 'main', label: 'Obsah záložky', x: 0, y: 1, w: 12, h: 7 }
  ],
  guides: [
    {
      title: 'Kde co najít',
      steps: [
        { text: '**Účty a podpisy** — e-mailové schránky (IMAP/SMTP), podpis značky a barva účtu.', area: 'tabs' },
        { text: '**Osoby** — kdo odpovídá a jak se podepisuje.', area: 'tabs' },
        { text: '**AI** — hlas značky, modely, Upgates API, feedy produktů a objednávek, logo na poukazy.', area: 'tabs' },
        { text: '**Znalosti** — dokumenty (reklamační řád, doprava…), ze kterých AI čerpá při odpovědích.', area: 'tabs' },
        { text: '**Třídění** — pravidla, kam se zprávy samy zařadí.', area: 'tabs' },
        { text: '**Sync** a **Telefon** — sdílená složka mezi počítačem a telefonem a záloha.', area: 'tabs' }
      ]
    }
  ],
  tips: ['Klíče a hesla se ukládají šifrovaně v systémové klíčence.']
};
