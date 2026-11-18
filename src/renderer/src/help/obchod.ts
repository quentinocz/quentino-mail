import type { HelpTopic } from './types';

/*
 * Nápověda k modulům, které pracují s produkty a objednávkami.
 *
 * Postupy jsou seřazené podle toho, co člověk v modulu dělá nejčastěji —
 * ne podle toho, jak jdou tlačítka na obrazovce. První postup je vždycky
 * „běžný den"; výjimky a nastavení jsou až za ním.
 */

export const PTRANS: HelpTopic = {
  id: 'ptrans',
  title: 'Produkty a překlady',
  icon: 'globe',
  color: '#5f3fe8',
  intro: 'Překládá texty produktů do slovenštiny, angličtiny a dalších jazyků, doplňuje SEO a texty '
    + 'pro Google a hotové posílá do e-shopu. Pracuje se vždycky stejně: vybrat → přeložit → zkontrolovat → '
    + 'poslat do administrace.',
  areas: [
    { id: 'head', label: 'Záložky a načtení feedu', x: 0, y: 0, w: 12, h: 1, target: '.pt-modal .modal-head' },
    { id: 'filters', label: 'Hledání a filtry', x: 0, y: 1, w: 12, h: 1, target: '.pt-filters' },
    { id: 'list', label: 'Seznam produktů', x: 0, y: 2, w: 3, h: 5, target: '.pt-list' },
    { id: 'detail', label: 'Detail: čeština a vedle ní jazyky', x: 3, y: 2, w: 9, h: 5, target: '.pt-detail' },
    { id: 'foot', label: 'Akce s vybranými', x: 0, y: 7, w: 12, h: 1, target: '.pt-foot' }
  ],
  guides: [
    {
      title: 'Přeložit produkty a poslat je do e-shopu',
      when: 'Běžný postup — nové produkty, nové jazyky, nebo když se změnila čeština.',
      steps: [
        { text: 'Nahoře klikni na [Načíst aktuální feed]. Stáhne nejnovější data z e-shopu. **Překlady, které '
            + 'ještě nejsou v Upgates, zůstanou** — nic se neztratí.', area: 'head', target: '.pt-feedbtn' },
        { text: 'Ve filtru **Stav** nech „Čeká na překlad". Štítky u produktu říkají stav jazyka: červený chybí, '
            + 'oranžový je zastaralý (čeština se změnila), zelený s fajfkou je hotový.', area: 'filters' },
        { text: 'Zaškrtni produkty, které chceš přeložit — nebo nahoře [Vybrat všech …].', area: 'list' },
        { text: 'Dole klikni na [Přeložit vybrané]. V okně uvidíš odhad času a ceny; spusť. Průběh je vidět '
            + 'nahoře a okno můžeš zavřít — překlad běží dál na pozadí.', area: 'foot' },
        { text: 'Projdi hotové produkty v detailu. Co přišlo z paměti (stejná věta už byla přeložená), '
            + 'je podbarvené. Cokoli můžeš rovnou přepsat.', area: 'detail' },
        { text: 'Klikni na [Exportovat do administrace]. Otevře se import v Upgates se vloženým souborem — '
            + 'pokračuj podle postupu „Import v administraci" níž.', area: 'foot', target: '.pt-toadmin' }
      ]
    },
    {
      title: 'Import v administraci (po exportu)',
      when: 'Okno Upgates se otevřelo samo a soubor je vložený.',
      steps: [
        { text: 'Aplikace sama vybere **Upgates XML → aktualizovat stávající → jednorázově**. Zkontroluj to '
            + 'a klikni na „Vytvořit import" — to je jediné kliknutí, které musíš udělat ty.' },
        { text: 'Otevře se okno s nastavením importu. Aplikace v něm nechá „Úprava" **jen u toho, co soubor '
            + 'nese** (názvy, popisy, SEO, vlastní pole) a všechno ostatní přepne na „Nezpracovávat". Ceny, sklad, '
            + 'kategorie ani obrázky se tak změnit nemůžou.' },
        { text: 'Nahoře v okně je modrý rámeček, co aplikace nastavila. Zkontroluj a klikni na „Uložit".' },
        { text: 'Pole, která někdo mezitím upravil přímo v e-shopu, export **nepřepíše** a vypíše je '
            + 'v hlášce jako „ponecháno". Když chceš poslat svoji verzi, uprav pole v aplikaci ručně.' }
      ]
    },
    {
      title: 'Opravit jeden text ručně',
      when: 'Překlad se nepovedl nebo chceš jiné slovo.',
      steps: [
        { text: 'Klikni na produkt v seznamu.', area: 'list' },
        { text: 'V detailu je vlevo čeština a vedle ní každý jazyk. Přepiš text přímo v poli — uloží se, '
            + 'jakmile z pole odejdeš. Aplikace se z opravy učí a příště ji použije sama.', area: 'detail' },
        { text: 'Kruhová šipka v rohu pole přeloží znovu **jen to jedno pole**.', area: 'detail' },
        { text: 'Přepínač [Texty] / [Google a SEO] nahoře v detailu přepne na titulky a popisy pro vyhledávače '
            + 'a Google Nákupy.', area: 'detail' },
        { text: 'Hotovo pošli do e-shopu přes [Exportovat do administrace].', area: 'foot' }
      ]
    },
    {
      title: 'Doplnit údaje pro Google Nákupy',
      when: 'Google hlásí chybějící barvu, pohlaví nebo věk, nebo chybí titulky.',
      steps: [
        { text: 'Vyber produkty v seznamu.', area: 'list' },
        { text: 'Dole otevři [Úpravy vybraných] a zvol **Doplnit Google atributy**. Barva, pohlaví, věk, stav '
            + 'a „set" se spočítají z parametrů a kategorií — bez modelu, okamžitě.', area: 'foot' },
        { text: 'Ve stejné nabídce **Titulky pro Google ze šablony** poskládá titulky podle šablony '
            + 'z [Nastavení].', area: 'foot' },
        { text: 'Pošli do e-shopu přes [Exportovat do administrace].', area: 'foot' }
      ]
    },
    {
      title: 'Co je v dalších záložkách',
      steps: [
        { text: '[Nový produkt] — založení produktu od nuly, s texty, překlady a importem. Má vlastní nápovědu.', area: 'head' },
        { text: '[Kvalita] — kde feed kulhá: chybějící barvy, sety, nejčastější vady. Kliknutím na produkt '
            + 'se otevře rovnou jeho detail.', area: 'head' },
        { text: '[Jednotnost] — názvy, které se vymykají ostatním v kategorii, s návrhem srovnání.', area: 'head' },
        { text: '[Paměť] — přeložené odstavce a věty. Čím víc jich je, tím míň se platí za překlad '
            + 'a tím jednotnější jsou texty.', area: 'head' },
        { text: '[Nastavení] — jazyky, co se překládá, slovníček pojmů a šablony pro Google.', area: 'head' }
      ]
    }
  ],
  tips: [
    '**Načtení feedu nikdy nesmaže tvoje překlady**, které ještě nejsou v e-shopu. Přepíše jen to, co v e-shopu je.',
    'Export posílá **jen změny** — co v e-shopu už je, znovu nepíše.',
    'Stejná věta se modelu neposílá dvakrát: z paměti se vezme hotový překlad. Podobné věty dostane model jako vzor.',
    'Během překladu můžeš okno zavřít; průběh se ukazuje dole v hlavním okně.',
    'Další způsoby načtení (jen nové produkty, soubor XML) jsou pod třemi tečkami vedle [Načíst aktuální feed].'
  ],
  warnings: [
    '**Vrátit na stav z e-shopu** (v nabídce Úpravy vybraných) zahodí všechno, co aplikace u vybraných napsala '
      + 'a ještě není v e-shopu. Zeptá se předem, ale pak už to vrátit nejde.'
  ]
};

export const NEWPRODUCT: HelpTopic = {
  id: 'newproduct',
  title: 'Nový produkt',
  icon: 'plus',
  color: '#5f3fe8',
  intro: 'Založí produkt od nuly: základ, texty, kategorie, obrázky a parametry, pak SEO, texty pro Google '
    + 'a překlady — a nakonec ho pošle do e-shopu importem. Vpravo je pořád vidět, co ještě chybí.',
  areas: [
    { id: 'main', label: 'Formulář: základ, texty, kategorie, obrázky, parametry', x: 0, y: 0, w: 8, h: 8, target: '.np-main' },
    { id: 'gaps', label: 'Co ještě chybí', x: 8, y: 0, w: 4, h: 4, target: '.np-gaps' },
    { id: 'steps', label: 'Tři kroky do e-shopu', x: 8, y: 4, w: 4, h: 4, target: '.np-steps' }
  ],
  guides: [
    {
      title: 'Založit produkt a dostat ho do e-shopu',
      steps: [
        { text: 'Začni **předlohou** — podobným produktem z e-shopu. Převezme se z něj kategorie, parametry '
            + 'a stavba textu, takže nový produkt sedí k ostatním.', area: 'main' },
        { text: 'V části **Základ** vyplň kód (aplikace hned řekne, jestli je volný), cenu a případně EAN.', area: 'main' },
        { text: 'Napiš český název a popisy, vyber kategorii, přidej obrázky a parametry.', area: 'main' },
        { text: 'Vpravo v **Co ještě chybí** klikni na položku — formulář na ni skočí. Červené brání uložení.', area: 'gaps' },
        { text: 'Krok 1: [Uložit do katalogu].', area: 'steps' },
        { text: 'Krok 2: [Dopsat SEO, Google a překlady] — doplní SEO titulek a popis, texty pro Google '
            + 'a přeloží do všech jazyků.', area: 'steps' },
        { text: 'Krok 3: [Do administrace] — otevře import v Upgates se vloženým souborem. Import spustíš ty.', area: 'steps' }
      ]
    },
    {
      title: 'Přepsat část textu modelem',
      steps: [
        { text: 'V popisu označ myší větu nebo odstavec.', area: 'main' },
        { text: 'Zadej, co s ním (zkrátit, víc o materiálu…), a návrh potvrď [Použít] nebo zahoď [Nechat].', area: 'main' }
      ]
    }
  ],
  tips: [
    'Rozdělaný produkt se ukládá průběžně — zavřít okno nevadí.',
    'Tlačítko [XML] uloží celý produkt do souboru, kdybys ho chtěl importovat ručně.',
    'Odkazy v popisu se při překladu samy přepíšou na slovenské a anglické adresy, pokud je aplikace zná.'
  ]
};

export const BANNERS: HelpTopic = {
  id: 'banners',
  title: 'Bannery',
  icon: 'banner',
  color: '#c23a3a',
  intro: 'Dlaždice na úvodní stránce e-shopu — s fotkou nebo videem, textem, odpočtem či slevovým kódem. '
    + 'Sady se dají naplánovat dopředu a v náhledu vpravo běží přesně ten skript, který bude na webu.',
  areas: [
    { id: 'status', label: 'Stav vystavení', x: 0, y: 0, w: 12, h: 1, target: '.wt-status' },
    { id: 'sets', label: 'Sady a jejich platnost', x: 0, y: 1, w: 2, h: 7, target: '.wt-list' },
    { id: 'edit', label: 'Úprava: sada, bannery, bloky, odkazy', x: 2, y: 1, w: 4, h: 6, target: '.bn-edit' },
    { id: 'save', label: 'Uložit a vystavit', x: 2, y: 7, w: 4, h: 1, target: '.bn-save' },
    { id: 'preview', label: 'Živý náhled (počítač, tablet, telefon)', x: 6, y: 1, w: 6, h: 7, target: '.bn-right' }
  ],
  guides: [
    {
      title: 'Nová akce na úvodní stránce',
      when: 'Sleva, novinka, svátek — cokoli, co má být na úvodní stránce.',
      steps: [
        { text: 'Vlevo klikni na [Nová sada]. V části [Sada] dej název, **platnost od–do** a rozvržení '
            + '(kolik dlaždic vedle sebe).', area: 'sets' },
        { text: 'V části [Bannery] je pás dlaždic. Plusem přidáš další; nabídne předlohy.', area: 'edit', target: '.bn-strip' },
        { text: 'U vybrané dlaždice v [Obsah] přetáhni fotku nebo video do plochy — převede se a nahraje '
            + 'do e-shopu samo. Pak napiš nadpis, text a tlačítko.', area: 'edit' },
        { text: 'Klikni na [Přeložit tento banner]. Přeloží jen tuhle dlaždici; ostatní nechá být.', area: 'edit' },
        { text: 'Vpravo přepni jazyk a zařízení a zkontroluj, jak to vypadá — hlavně na telefonu.', area: 'preview' },
        { text: '[Uložit a vystavit]. Na webu je to do minuty.', area: 'save' }
      ]
    },
    {
      title: 'Když něco není přeložené',
      when: 'Na dlaždici svítí oranžový štítek „SK a EN" nebo je nad uložením žlutý pruh.',
      steps: [
        { text: 'Oranžový štítek na dlaždici říká, kterému jazyku chybí text.', area: 'edit', target: '.bn-strip' },
        { text: 'Při uložení se aplikace zastaví a vyjmenuje, co chybí. Bez toho by návštěvníci slovenského '
            + 'a anglického webu viděli **češtinu**.', area: 'save' },
        { text: '[Doplnit překlady a uložit] přeloží **jen prázdná políčka** — co už je přeložené nebo ručně '
            + 'upravené, nechá být. Pak sadu uloží.', area: 'save' },
        { text: '[Uložit bez překladu] použij jen tehdy, když to tak opravdu chceš.', area: 'save' }
      ]
    },
    {
      title: 'Naplánovat akci dopředu',
      steps: [
        { text: 'Sadě nastav **platnost od** v budoucnu. V seznamu bude jako „Chystá se" a na web naskočí sama.', area: 'sets' },
        { text: 'Když se překrývá s jinou sadou, aplikace nabídne [Uložit a zkrátit předchozí] — předchozí sada '
            + 'skončí přesně tam, kde nová začne.', area: 'save' },
        { text: 'Jedna dlaždice může mít vlastní termín (třeba „doprava zdarma jen o víkendu") — nemusíš kvůli '
            + 'ní zakládat celou sadu.', area: 'edit' }
      ]
    },
    {
      title: 'Odpočet, slevový kód, efekty',
      steps: [
        { text: 'U dlaždice otevři [Efekty]. Vyber odpočet do data, slevový kód (dá se zkopírovat jedním '
            + 'klepnutím), doručení do Vánoc nebo padající sníh či emoji.', area: 'edit' },
        { text: 'Odpočet se v náhledu hýbe stejně jako na webu.', area: 'preview' }
      ]
    },
    {
      title: 'Opakovat loňskou kampaň',
      steps: [
        { text: 'U hotové sady klikni na [Odložit stranou] — uloží se jako šablona i s texty a efekty.', area: 'save' },
        { text: 'Příště ji najdeš vlevo v [Odložené sady] a jedním kliknutím z ní uděláš novou sadu.', area: 'sets' }
      ]
    }
  ],
  tips: [
    '[Přeložit tento banner] je bezpečnější než [Celou sadu] — celá sada přepíše i ručně doladěné překlady.',
    'Proklikovost (číslo v rohu dlaždice) je z Google Analytics za 28 dní.',
    'Fotka se sama zmenší a převede na WebP; video může být rovnou z telefonu.',
    'Záložka [Kód do e-shopu] má skript do šablony e-shopu — vkládá se jen jednou, při prvním nasazení.'
  ],
  warnings: [
    'Sada se ukládá **rovnou na web**. Před uložením se podívej do náhledu na telefon.'
  ]
};

export const PACKING: HelpTopic = {
  id: 'packing',
  title: 'Balení objednávek',
  icon: 'bag',
  color: '#c2683a',
  intro: 'Fronta objednávek k zabalení a u každé odškrtávací seznam kusů. Zvýrazní, co se plete — '
    + 'víc kusů než jeden, varianty, dobírku, zahraničí. Odškrtnutí se ukládá, takže přerušené balení '
    + 'se dá kdykoli dobrat i z telefonu.',
  areas: [
    { id: 'find', label: 'Hledání, fáze a doprava', x: 0, y: 0, w: 12, h: 1 },
    { id: 'list', label: 'Fronta objednávek', x: 0, y: 1, w: 4, h: 7, target: '.pk-list' },
    { id: 'order', label: 'Objednávka k odškrtání', x: 4, y: 1, w: 8, h: 7, target: '.pk-panels' }
  ],
  guides: [
    {
      title: 'Zabalit objednávky',
      when: 'Každý den u balicího stolu.',
      steps: [
        { text: 'Nahoře je vidět fáze objednávek: čeká na platbu → k zabalení → zabaleno → odesláno. '
            + 'Ve frontě vlevo jsou barevně odlišené.', area: 'find' },
        { text: 'Načti čtečkou **číslo faktury** z papíru, nebo ho napiš do hledání — otevře se ta objednávka.', area: 'find' },
        { text: 'Vpravo odškrtávej kusy, jak je dáváš do krabice. Množství větší než 1 a varianta (délka, šířka) '
            + 'jsou zvýrazněné.', area: 'order' },
        { text: 'Poznámka zákazníka je ve výrazném rámečku nad dopravou — přečti ji před zalepením.', area: 'order' },
        { text: 'Dole klikni na [Zabaleno]. Dokud něco chybí, tlačítko říká, kolik kusů zbývá. Omyl vrátíš '
            + 'tlačítkem [Zabaleno — vrátit zpět].', area: 'order' }
      ]
    },
    {
      title: 'Faktury a štítky dopravců',
      steps: [
        { text: '[Faktury] stáhne faktury k zobrazeným objednávkám do jednoho PDF k tisku.', area: 'find', target: '.pk-ship' },
        { text: '[PPL] sestaví soubor a otevře import v administraci PPL; [Štítky PPL] tě pak dovede '
            + 'k seznamu zásilek, odkud se štítky tisknou.', area: 'find', target: '.pk-ship' },
        { text: '[Balíkovna] vloží soubor do Podání Online, [Zásilkovna] zásilky rovnou založí a stáhne arch štítků.', area: 'find', target: '.pk-ship' },
        { text: 'Mají-li objednávky poznámku pro dopravce, aplikace se předem zeptá, **kterou** poslat — '
            + 'každou schvaluješ zvlášť.', area: 'find' }
      ]
    }
  ],
  tips: [
    'Rozdělané balení na počítači uvidíš i na telefonu a naopak.',
    'Odeslání na dopravce (Odeslat, Podat) vždycky potvrzuješ ty — aplikace jen připraví soubor.',
    'Ikona se šipkou vedle faktur zahodí stažené faktury, když se po opravě adresy změnily.'
  ]
};

export const CATALOG: HelpTopic = {
  id: 'catalog',
  title: 'Katalog a naskladnění',
  icon: 'layers',
  color: '#3a7bc2',
  intro: 'Co máme a kolik toho je, příjem nového zboží a štítky s QR kódem. Tři záložky nad jedním '
    + 'seznamem produktů. Naskladnění se dá začít u regálu na telefonu a dokončit na počítači.',
  areas: [
    { id: 'tabs', label: 'Produkty · Naskladnění · Štítky', x: 0, y: 0, w: 12, h: 1, target: '.kat-tabs' },
    { id: 'main', label: 'Seznam / rozpracované naskladnění', x: 0, y: 1, w: 8, h: 7 },
    { id: 'side', label: 'Detail s variantami a sklady', x: 8, y: 1, w: 4, h: 7 }
  ],
  guides: [
    {
      title: 'Naskladnit nové zboží',
      when: 'Přišla dodávka.',
      steps: [
        { text: 'Otevři záložku [Naskladnění] a klikni na [Nové naskladnění].', area: 'tabs' },
        { text: 'Do pole nahoře načítej čtečkou QR kódy ze štítků — nebo piš kód či název (diakritika nevadí). '
            + 'U produktu s variantami vyber konkrétní délku nebo velikost.', area: 'main', target: '.kat-scanbar' },
        { text: 'Počty u řádků uprav šipkami nebo přepsáním.', area: 'main' },
        { text: '[Zkontrolovat] ukáže, co se zapíše. Aplikace otevře Upgates (Sklad → Naskladňování) a položky '
            + 'do formuláře vloží sama.', area: 'main' },
        { text: 'V Upgates klikni na uložit, pak v aplikaci potvrď [Uložil jsem to]. Teprve tím je naskladnění zapsané.', area: 'main' }
      ]
    },
    {
      title: 'Vytisknout štítky s QR',
      steps: [
        { text: 'Záložka [Štítky]. Vyber arch (koupené archy A4 nebo tiskárna Zebra).', area: 'tabs' },
        { text: '**Pevný počet** dá stejný počet štítků každému produktu, **Podle skladu** tolik, kolik je kusů na skladě.', area: 'main' },
        { text: 'Rovnou z rozpracovaného naskladnění tlačítkem [Štítky] — dostaneš štítky na právě přijaté zboží.', area: 'main' },
        { text: 'Poprvé vytiskni arch na obyčejný papír, přilož proti světlu na koupený arch a posun srovnej '
            + 'poli „Posun →" a „Posun ↓".', area: 'main' }
      ]
    },
    {
      title: 'Najít, kolik čeho je',
      steps: [
        { text: 'Záložka [Produkty]: hledej názvem, kódem nebo EANem; filtruj kategorií nebo jen skladem.', area: 'tabs' },
        { text: 'Klikni na produkt — vpravo uvidíš varianty a sklad každé z nich.', area: 'side' }
      ]
    }
  ],
  tips: [
    'Zásoby se berou z rychlého skladového feedu — obnovuje se každé dvě hodiny.',
    'Kód produktu má přednost před EANem: čtečka nikdy nenaskladní jiný produkt se stejným EANem.',
    'Rozpracované naskladnění se slučuje mezi telefonem a počítačem — nic se nesčítá dvakrát.'
  ]
};

export const ARTICLES: HelpTopic = {
  id: 'articles',
  title: 'Články',
  icon: 'fileText',
  color: '#2f9e6e',
  intro: 'Píše články do blogu podle zadání — s produkty, obrázky a odkazy — a překládá je do ostatních '
    + 'jazyků. Hlídá i odkazy ve starších článcích.',
  areas: [
    { id: 'tabs', label: 'Články · Odkazy · Mapa adres · Nastavení', x: 0, y: 0, w: 12, h: 1 },
    { id: 'list', label: 'Seznam článků', x: 0, y: 1, w: 4, h: 7, target: '.ar-list' },
    { id: 'detail', label: 'Zadání · Text · Statistika', x: 4, y: 1, w: 8, h: 7, target: '.ar-detail' }
  ],
  guides: [
    {
      title: 'Napsat nový článek',
      steps: [
        { text: 'Klikni na [Nový] a vyplň **téma**. AI ti může název vylepšit.', area: 'list' },
        { text: 'V zadání přidej produkty z feedu, obrázky (nahrát z počítače — převedou se a nahrají), '
            + 'videa a interní odkazy. Vyber jazyky a délku.', area: 'detail' },
        { text: 'Do **Vyhledávaných výrazů** napiš, co lidé hledají; do **Pokynů pro AI** cokoli dalšího.', area: 'detail' },
        { text: '[Uložit zadání] a nech článek napsat. V záložce [Text] ho uvidíš v náhledu i v HTML.', area: 'detail' },
        { text: 'Jazyky vybrané v zadání se píšou rovnou. Jazyk, který text ještě nemá, přeložíš tlačítkem '
            + '[Přeložit do SK] (EN…) — hotový jazyk jde přeložit znovu tlačítkem [Přeložit znovu].', area: 'detail' }
      ]
    },
    {
      title: 'Opravit vadné odkazy',
      steps: [
        { text: 'Záložka [Odkazy] → [Zkontrolovat]. Najde odkazy, které vedou na smazanou nebo přesunutou stránku.', area: 'tabs' },
        { text: 'U každého navrhne náhradu; [Opravit] ji použije, [Je v pořádku] odkaz nechá.', area: 'detail' },
        { text: '[Mapa adres] říká, která česká stránka odpovídá které slovenské a anglické — podle ní se '
            + 'odkazy překládají.', area: 'tabs' }
      ]
    }
  ],
  tips: [
    'Statistika ukazuje návštěvnost článku z Google Analytics.',
    'Odkaz, pro který se nenajde překlad, zůstane český — rozbitý odkaz by byl horší.'
  ]
};

export const MEDIA: HelpTopic = {
  id: 'media',
  title: 'Konvertor médií',
  icon: 'image',
  color: '#3a9ec2',
  intro: 'Převádí fotky do WebP a videa do WebM — ručně, hromadně, z produktů v e-shopu, nebo samo ze '
    + 'hlídané složky. Originály nikdy nepřepisuje.',
  areas: [
    { id: 'tabs', label: 'Soubory · Produkty · Hlídané složky · Nastavení', x: 0, y: 0, w: 12, h: 1 },
    { id: 'main', label: 'Soubory k převodu a výsledky', x: 0, y: 1, w: 12, h: 7, target: '.md-main' }
  ],
  guides: [
    {
      title: 'Převést pár fotek',
      steps: [
        { text: 'V [Soubory] klikni na [Vybrat soubory] nebo je přetáhni do okna.', area: 'main' },
        { text: 'Pro ořez klikni na fotku — vyber poměr stran (třeba čtverec) a posuň rámeček.', area: 'main' },
        { text: '[Převést]. Výsledky jsou ve složce z [Kam ukládat].', area: 'main' }
      ]
    },
    {
      title: 'Fotky produktů do WebP přímo v e-shopu',
      steps: [
        { text: 'Záložka [Produkty], filtr **Chybí WebP**.', area: 'tabs' },
        { text: 'Vyber produkt — předvybrané jsou fotky, které ještě nejsou WebP. Tlačítkem Porovnat uvidíš '
            + 'originál a výsledek vedle sebe se společnou lupou.', area: 'main' },
        { text: '**Převést a nahrát** otevře produkt v administraci a fotky do něj vloží. Staré fotky smažeš '
            + 'a produkt uložíš sám.', area: 'main' }
      ]
    },
    {
      title: 'Focení rovnou do WebP (hlídaná složka)',
      steps: [
        { text: 'V [Hlídané složky] klikni na [Přidat složku] a vyber složku, kam fotíš.', area: 'tabs' },
        { text: 'Ořez nastav jednou podle první fotky — použije se na všechny další.', area: 'main' },
        { text: 'Co do složky přibude, se samo převede do podsložky. Funguje i se zavřeným oknem konvertoru.', area: 'main' }
      ]
    }
  ],
  tips: [
    'Videa převádí ffmpeg. Když chybí, aplikace řekne, jak ho nainstalovat ([Nastavení] → Ověřit).',
    'Kvalitu a rozlišení jde nastavit pro jednotlivý produkt — látka s jemnou strukturou snese míň komprese.'
  ]
};
