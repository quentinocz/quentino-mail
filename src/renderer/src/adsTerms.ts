/**
 * Slovníček modulu Reklamy.
 *
 * PPC je plné zkratek (PNO, ROAS, PMax…) a v okně se s nimi nedá úplně
 * obejít — jsou to slova, která člověk potkává v Google Ads. Každý takový
 * pojem má proto po najetí myší vysvětlení obyčejnou řečí, s příkladem
 * v korunách. Texty jsou tady na jednom místě, aby se vysvětlovalo všude
 * stejně.
 */
export const ADS_TERMS: Record<string, string> = {
  pno: 'PNO = podíl nákladů na obratu. Kolik ze 100 Kč tržby (bez DPH) spolkne reklama. '
    + 'PNO 10 % = za každých 100 Kč tržby dáme 10 Kč za reklamu. Čím nižší, tím lepší.',
  shopPno: 'PNO e-shopu = všechny náklady na reklamu / obrat ze všech objednávek (i těch, které přišly bez reklamy). '
    + 'Ukazuje, kolik z celkových tržeb stojí reklama.',
  targetPno: 'Cílové PNO = nejvyšší PNO, při kterém ještě splníš svůj cíl zisku. Počítá se jako marže minus '
    + 'požadovaný podíl zisku: marže 65 % − cíl 50 % = cílové PNO 15 %.',
  breakEven: 'Bod zlomu = PNO, při kterém produkt na reklamě vydělá přesně nulu. Je to jeho marže: když reklama '
    + 'spolkne víc, než na kuse vyděláme, prodáváme se ztrátou.',
  margin: 'Marže = kolik z ceny bez DPH zůstane po odečtení nákupní ceny. Kravata za 500 Kč bez DPH s nákupní cenou '
    + '150 Kč má marži 70 %. Hvězdička = nákupní cena chybí, marže je odhad podle kategorie.',
  profitAfterAds: 'Zisk po reklamě = co objednávky opravdu vydělaly (marže + doprava, kterou zaplatil zákazník, '
    + '− doprava, kterou platíme my) minus všechno, co stála reklama. Tohle číslo má růst.',
  profitShare: 'Podíl zisku z obratu = zisk po reklamě / obrat bez DPH. Cíl 50 % znamená, že ze 100 Kč tržby '
    + 'má po zaplacení zboží, dopravy a reklamy zůstat aspoň 50 Kč.',
  roas: 'ROAS = kolik korun tržby přinese 1 Kč reklamy, v procentech. ROAS 500 % = z 1 Kč reklamy 5 Kč tržby. '
    + 'Je to obrácené PNO: ROAS 500 % je PNO 20 %. Google ho počítá z hodnoty s DPH.',
  troas: 'Cílové ROAS = pokyn pro Google, kolik tržby má přinést každá koruna reklamy. Vyšší cíl = Google je '
    + 'vybíravější, utratí méně a platí jen za jistější kliky. Nižší cíl = utratí víc a ukáže reklamu víc lidem.',
  conversions: 'Konverze = nákup, který si reklama připsala (zákazník klikl na reklamu a pak nakoupil). '
    + 'Reklamní systémy si je připisují velkoryse, proto modul počítá zisk ze skutečných objednávek.',
  value: 'Hodnota konverzí = tržba z nákupů, které si reklama připsala. Tady vždy bez DPH.',
  cost: 'Útrata = kolik reklama stála (bez DPH, v korunách — účet v eurech se přepočte).',
  clicks: 'Kliky = kolikrát lidé na reklamu klikli. Za každý klik se platí.',
  impressions: 'Zobrazení = kolikrát se reklama ukázala. Za zobrazení se u těchto kampaní neplatí.',
  sold: 'Prodáno = kusy ze všech objednávek v období, nejen z těch od reklamy.',
  budget: 'Denní rozpočet = kolik smí kampaň utratit za den (Google ho občas o kus přetáhne a jiný den dorovná).',
  limited: 'Brzdí ho rozpočet = Google by reklamu ukazoval častěji, ale denní rozpočet dojde dřív, než den skončí.',
  bidding: 'Nabízení = jak Google rozhoduje, kolik zaplatí za klik. „Max. hodnota" = co nejvyšší tržby za rozpočet, '
    + '„cílové ROAS" = tržby s danou návratností, „ruční CPC" = cenu za klik nastavuje člověk.',
  cpc: 'CPC = cena za proklik. Kolik stojí jeden klik na reklamu.',
  pmax: 'Performance Max = kampaň, ve které Google sám rozhoduje, kde reklamu ukáže (vyhledávání, Nákupy, YouTube, '
    + 'Gmail…). Prodává hlavně produkty z feedu.',
  shopping: 'Nákupy = reklamy s fotkou, cenou a názvem produktu nad výsledky hledání.',
  search: 'Vyhledávání = textové reklamy, které se ukážou, když někdo hledá určitá slova.',
  negative: 'Vylučující slovo = slovo, při kterém se reklama nemá ukázat. Frázová shoda: reklama se neukáže, '
    + 'kdykoli hledání obsahuje to slovo (např. „bazar").',
  confidence: 'Jistota = kolik dat za návrhem stojí. Jedna tečka = málo dat, odhad je hrubý. Čtyři tečky = hodně dat, '
    + 'odhad je spolehlivý.',
  impact: 'Odhad = o kolik korun se změní zisk po reklamě za 30 dní, když návrh použiješ. Je to odhad z dosavadních '
    + 'čísel; po 14 dnech se ukáže, jestli vyšel.',
  holdsTarget: 'Drží cíl = návrh trochu sníží zisk v korunách, ale udrží podíl zisku z obratu na cíli, který jsi '
    + 'nastavil. Když má mít přednost zisk v korunách, sniž cíl v Nastavení.',
  customLabel: 'custom_label = vlastní štítek produktu, který aplikace posílá Googlu v doplňkovém feedu. Podle něj '
    + 'jde v kampani produkty rozdělit — třeba hvězdám dát vlastní rozpočet.',
  feed: 'Doplňkový feed = malý soubor, který k produktům v Google Merchant Center přidá štítky (segment, pásmo marže, '
    + 'vyřazení). Google si ho jednou denně stáhne sám.',
  market: 'Trh = web, ze kterého objednávka přišla (CZ, SK, .com). Každý trh má svůj účet Google Ads, svou měnu, DPH '
    + 'a podle své marže i vlastní cílové PNO.'
};

/** Co znamená který segment — do bublin u štítků a do legendy mapy */
export const SEGMENT_HELP: Record<string, string> = {
  hvezdy: 'Hvězdy = produkty s nejvyšším ziskem po reklamě (horních 20 %). Zaslouží si přednost v rozpočtu.',
  pracanti: 'Pracanti = prodávají se se ziskem, i když nejsou nejlepší. Běžná kampaň jim stačí.',
  zrouti: 'Žrouti = na reklamě prodělávají: buď mají spoustu kliků a žádný prodej (víc, než by mohla být náhoda), '
    + 'nebo reklama stojí víc, než kolik jejich prodej vydělá.',
  spici: 'Spící = reklama je skoro neukazuje, takže o nich nejsou data. Může jít o skryté talenty.',
  novinky: 'Novinky = v katalogu méně než 30 dní. Nesoudí se podle prázdných čísel — mají ochrannou dobu.',
  doprodej: 'Doprodej = skladem méně než 3 kusy. Brzy dojdou, nemá smysl na ně přidávat peníze.',
  vyprodano: 'Vyprodáno = není skladem. Reklama za ně nemá platit kliky.'
};
