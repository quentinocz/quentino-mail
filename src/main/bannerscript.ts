/**
 * Skript, který na e-shopu kreslí bannery na úvodní stránce.
 *
 * ## Proč je to tady, a ne jako soubor na webu
 *
 * Do šablony Upgates se nedá sáhnout; jediné, co jde, je vložit kus kódu
 * na konec `<head>`. Ten kód ale potřebuje vědět **adresu plánu** a nést
 * **záložní sadu**, a obojí je u každého nastavení jiné. Kdyby se vozil
 * zvlášť, musel by se po každé změně přepsat ručně a nikdo by nepoznal, že
 * ten na webu je starý. Takhle ho aplikace vypíše hotový a jen se zkopíruje.
 *
 * ## Proč se bannery nekreslí, dokud není co
 *
 * Původní karusel se **neschová hned**, ale až ve chvíli, kdy máme čím ho
 * nahradit. Se záložní sadou je to hned v hlavičce, tedy ještě před prvním
 * vykreslením a bez jediného posunu stránky. Bez ní se počká na plán a do
 * té doby je na stránce to, co tam bylo — prázdné místo by bylo horší než
 * starý banner.
 *
 * ## Proč má každá dlaždice pevný poměr stran
 *
 * Zadání znělo „nesmí to škaredě poskakovat". Obrázek, který doteče později,
 * mění výšku dlaždice, a s ní skočí celá stránka pod ní. Poměr stran je
 * proto daný rozvržením, fotka se ořízne a výška je známá dřív, než se
 * cokoli stáhne. Ze stejného důvodu se při rotaci **prolíná**, a nejede se
 * do strany: všechny stránky bannerů leží v téže buňce mřížky, takže výška
 * je pořád ta nejvyšší z nich.
 */
/** Kam se ve skriptu doplní adresa plánu, platnost kopie a záložní sada. */
const URL_MARK = '__QUENTINO_BANNERS_URL__';
const TTL_MARK = '__QUENTINO_BANNERS_TTL__';
const FALLBACK_MARK = '"__QUENTINO_BANNERS_FALLBACK__"';
/*
 * Pozor při úpravách: text níž je `String.raw`, takže se v něm nesmí objevit
 * zpětný apostrof ani `${`. Skript je proto psaný bez šablonových řetězců —
 * spojuje se plusem. Kdyby se tohle porušilo, překlad spadne na TS1005.
 */
const TEMPLATE = String.raw`
<style>
/* Quentino — bannery na úvodní stránce. */

/*
 * Původní karusel se schovává až tehdy, když je čím ho nahradit — třídu
 * na <html> přidá skript. Kdyby se schovával rovnou, znamenala by chyba
 * v načtení plánu prázdné místo na hlavní stránce.
 */
/*
 * Šablona má bannerů víc než jeden blok: pod hlavním karuselem je ještě
 * „skupina bannerů" (".bnr-group") — velké fotky bez textu, které nikam
 * nevedou (všechny odkazy jsou "#"). Zůstávaly pod naším blokem a
 * vypadaly jako by se banner vykreslil dvakrát, proto jdou pryč taky.
 */
.qbn-on #banner1,
.qbn-on .bnr-main .carousel,
.qbn-on .bnr-main .cover-bnr,
.qbn-on .bnr-group { display: none !important; }

/*
 * Jeden rozestup pro celý blok.
 *
 * Dřív si každá část držela vlastní čísla a sousední části je sčítaly:
 * pod pruhem odkazů končila sekce banneru (44 px) a hned pod ní začínala
 * sekce bloků dalšími 44 px. Nahoře byl přitom rozestup jen jeden. Zvenku
 * to vypadalo, že je nahoře málo a dole zbytečně moc.
 *
 * Proto se počítá s **polovinou**: každý blok si k okraji sekce nechá
 * půlku, dva bloky nad sebou tak dají dohromady celý rozestup a rytmus
 * je po celé stránce stejný.
 */
.qbn-on {
  --qbn-gap: clamp(18px, 2.2vw, 34px);
  --qbn-gap-half: clamp(9px, 1.1vw, 17px);
  /* Uvnitř bloku (banner → jeho pruh odkazů) stačí míň, patří k sobě */
  --qbn-gap-in: clamp(10px, 1.2vw, 18px);
}

/*
 * Zlom v barvě pozadí.
 *
 * Šablona maluje přes sekci s bannerem ještě teplý 5% přeliv
 * (".bov-ye-o-5"), kdežto sekce s bloky pod ním ho nemá. Dokud v obou
 * sekcích byly fotky přes celou šířku, nebylo to znát; jakmile se mezi
 * nimi objevil holý šedý pruh s odkazy, udělala se na rozhraní sekcí
 * viditelná vodorovná hrana. Zbytek stránky je bez přelivu, tak se
 * srovnává podle něj.
 */
.qbn-on .section.bic-bnr { background-image: none; }

.qbn {
  display: grid;
  width: 100%;
  /*
   * Nahoře celý rozestup, dole půlka. Nad bannerem totiž žádný druhý blok
   * není — je tam hlavička e-shopu, která si nic nepřidá. Pod ním ano, a
   * půlka plus půlka dá dohromady tentýž rozestup. Teprve takhle je to
   * po celé stránce stejné; dřív bylo nahoře 44 a dole 88 bodů.
   */
  margin: var(--qbn-gap) auto var(--qbn-gap-half);
  /* Stránky bannerů leží přes sebe v téže buňce — proto se při rotaci nehne výška */
  position: relative;
  /*
   * Prohlížeč si při změně výšky obsahu drží „kotvu", aby se stránka pod
   * prstem nehýbala. U bloku, který vzniká až po načtení, se ale kotvou
   * stával on sám: při rolování nahoru to na telefonu skočilo rovnou na
   * banner a hlavička e-shopu se nedala uvidět. Tenhle blok kotvou být
   * nesmí.
   */
  overflow-anchor: none;
}
.qbn-page {
  grid-area: 1 / 1;
  display: grid;
  gap: 14px;
  opacity: 0;
  visibility: hidden;
  transition: opacity .55s ease;
}
.qbn-page.qbn-now { opacity: 1; visibility: visible; }

.qbn[data-layout="quad"] .qbn-page { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.qbn[data-layout="wide"] .qbn-page { grid-template-columns: minmax(0, 1fr); }

.qbn-card {
  position: relative;
  display: block;
  overflow: hidden;
  border-radius: var(--qbn-radius, 0);
  background-color: var(--qbn-bg, #000);
  color: var(--qbn-fg, #fff);
  /* Písmo se dědí ze stránky e-shopu, dokud si banner neřekne o vlastní */
  font-family: var(--qbn-font, inherit);
  text-decoration: none;
  /*
   * Zarovnání se naopak dědit **nesmí**. Blok leží v kontejneru šablony,
   * který má "text-align: center" (na e-shopu je to
   * ".container d-flex flex-col ai-c"), takže banner nastavený doleva se
   * na webu kreslil na střed, i když v aplikaci vypadal správně. Karta
   * proto zarovnání vždycky nastaví a odchylky si vynutí sama níž.
   */
  text-align: left;
  /* Ze stejného důvodu: verzálky a kurzíva patří banneru, ne stránce */
  text-transform: none;
  font-style: normal;
  /*
   * Poměr stran drží výšku dřív, než dotečou fotky — bez toho stránka
   * poskakuje. Hodnota v proměnné je volba ze sady; když se nevybere nic,
   * platí to, co dává smysl pro dané rozvržení a šířku obrazovky.
   */
  aspect-ratio: var(--qbn-ar, 3 / 4);
  isolation: isolate;
}
.qbn[data-layout="wide"] .qbn-card { aspect-ratio: var(--qbn-ar, 32 / 11); }

/*
 * Fotka má vlastní vrstvu, ne pozadí dlaždice.
 *
 * Jinak by se nedala při najetí myší zvětšit — pozadí se transformovat
 * nedá a "background-size" se animuje skokem. Takhle je to jedna plynulá
 * proměna, která se navíc dá vypnout systémovým „nechci pohyb".
 */
.qbn-photo {
  position: absolute;
  inset: 0;
  z-index: 0;
  background-image: var(--qbn-img, none);
  background-size: cover;
  background-position: var(--qbn-focus, 50% 50%);
  background-repeat: no-repeat;
  transition: transform .7s cubic-bezier(.2, .7, .3, 1);
  will-change: transform;
}
/*
 * Video leží na fotce a naběhne, teprve až hraje. Fotka pod ním je první
 * snímek i záchrana pro případ, že se video nestáhne — černý obdélník na
 * úvodní stránce vypadá jako rozbitá stránka.
 */
.qbn-video {
  position: absolute;
  inset: 0;
  z-index: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: var(--qbn-focus, 50% 50%);
  opacity: 0;
  transition: opacity .5s ease;
  pointer-events: none;
}
.qbn-video[data-hraje] { opacity: 1; }
a.qbn-card { cursor: pointer; }
a.qbn-card:hover .qbn-photo { transform: scale(1.045); }
a.qbn-card:hover .qbn-btn { transform: translateY(-1px); }
/*
 * Obrys při procházení klávesnicí. Dlaždice je odkaz přes celou plochu
 * a bez tohohle by nebylo poznat, na které z nich se stojí.
 */
a.qbn-card:focus-visible {
  outline: 2px solid var(--qbn-fg, #fff);
  outline-offset: 3px;
}

/*
 * Ztmavení pod textem. Je to jediný důvod, proč je text na fotce čitelný,
 * takže se kreslí vždycky — i když je ztmavení nastavené nízko, zůstává
 * aspoň spád u kraje, kde text leží.
 */
.qbn-shade {
  position: absolute;
  inset: 0;
  z-index: 1;
  pointer-events: none;
  /*
   * Víc zastávek než dvě schválně. Dvoubodový přechod má uprostřed
   * viditelnou hranu — je to ten pruh, podle kterého se na první pohled
   * pozná levně slepený banner. Tyhle hodnoty opisují náběh křivky, takže
   * přechod nemá kde začít.
   */
  background: linear-gradient(to top,
    rgba(0, 0, 0, var(--qbn-shade, .4)) 0%,
    rgba(0, 0, 0, calc(var(--qbn-shade, .4) * .86)) 16%,
    rgba(0, 0, 0, calc(var(--qbn-shade, .4) * .58)) 34%,
    rgba(0, 0, 0, calc(var(--qbn-shade, .4) * .29)) 54%,
    rgba(0, 0, 0, calc(var(--qbn-shade, .4) * .09)) 72%,
    rgba(0, 0, 0, 0) 88%);
}
.qbn-card[data-pos="top"] .qbn-shade { transform: scaleY(-1); }
.qbn-card[data-pos="middle"] .qbn-shade {
  background: rgba(0, 0, 0, var(--qbn-shade, .4));
}

.qbn-body {
  position: absolute;
  inset: 0;
  z-index: 3;
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 18px;
  box-sizing: border-box;
  /* Stín pod písmem je poslední pojistka čitelnosti na světlém místě fotky */
  text-shadow: 0 1px 3px rgba(0, 0, 0, .45);
}
.qbn-card[data-pos="top"] .qbn-body { justify-content: flex-start; }
.qbn-card[data-pos="middle"] .qbn-body { justify-content: center; }
.qbn-card[data-pos="bottom"] .qbn-body { justify-content: flex-end; }
.qbn-card[data-align="left"] .qbn-body { align-items: flex-start; text-align: left; }
.qbn-card[data-align="center"] .qbn-body { align-items: center; text-align: center; }
.qbn-card[data-align="right"] .qbn-body { align-items: flex-end; text-align: right; }

/*
 * Řádek nad nadpisem. Drobně, verzálkami a prostrkaně — nese to, proč se
 * na banner dívat zrovna teď, a nadpis tím nemusí být o třetinu delší.
 */
.qbn-kicker {
  font-size: clamp(9.5px, .62vw, 11.5px);
  font-weight: 600;
  letter-spacing: .14em;
  text-transform: uppercase;
  opacity: .86;
  line-height: 1.2;
}

.qbn-title {
  margin: 0;
  /* Velikost se násobí volbou v aplikaci, ale meze zůstávají — jinak by */
  /* se na telefonu nadpis buď ztratil, nebo přerostl dlaždici */
  font-size: clamp(15px, calc(1.45vw * var(--qbn-ts, 1)), calc(25px * var(--qbn-ts, 1)));
  /* Rajdhani na e-shopu jede s řádkováním 1,0; tady o chlup víc kvůli háčkům */
  line-height: 1.07;
  font-weight: var(--qbn-tw, 400);
  /*
   * Prostrkání podle písma, ne jedno pro všechna. Nadpisy na e-shopu jedou
   * −0,06 em (změřeno), což je pro Rajdhani správně a pro patkové písmo
   * moc — proto si hodnotu nastavuje každé písmo samo.
   */
  letter-spacing: var(--qbn-track, -.055em);
  text-wrap: balance;
}
.qbn[data-layout="wide"] .qbn-title {
  font-size: clamp(20px, calc(2.4vw * var(--qbn-ts, 1)), calc(40px * var(--qbn-ts, 1)));
}
.qbn-card[data-caps="1"] .qbn-title {
  text-transform: uppercase;
  /* Verzálky potřebují vzduch mezi znaky, jinak se slijí do bloku */
  letter-spacing: .04em;
}
.qbn-text {
  margin: 0;
  font-size: clamp(12px, .95vw, 15px);
  font-weight: var(--qbn-bw, 400);
  /* E-shop má u odstavců řádkování 1,6; v dlaždici je to o kousek těsněji */
  line-height: 1.48;
  letter-spacing: -.02em;
  opacity: .92;
  /* Tři řádky a dost: čtvrtý by přerostl dlaždici a vylezl pod fotku */
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.qbn[data-layout="wide"] .qbn-text { font-size: clamp(13px, 1.1vw, 18px); max-width: 46ch; }

/* ---------- tlačítka ---------- */

.qbn-btn {
  display: inline-block;
  align-self: flex-start;
  margin-top: 5px;
  padding: 10px 20px;
  /*
   * Zaoblení má celý banner jedno. Tlačítko s pilulkovým okrajem na
   * hranaté dlaždici je nesoulad, který je vidět na první pohled — a
   * e-shop má hranaté obojí.
   */
  border-radius: var(--qbn-radius, 0);
  font-size: 13.5px;
  font-weight: 500;
  line-height: 1.25;
  letter-spacing: -.02em;
  text-shadow: none;
  transition: transform .18s ease, background-color .18s ease, color .18s ease;
}
.qbn-card[data-align="center"] .qbn-btn { align-self: center; }
.qbn-card[data-align="right"] .qbn-btn { align-self: flex-end; }

.qbn-btn[data-style="fill"] { background: var(--qbn-fg, #fff); color: var(--qbn-bg, #1c1c22); }
.qbn-btn[data-style="outline"] {
  border: 1.5px solid currentColor;
  padding: 8.5px 18.5px;
  background: transparent;
}
a.qbn-card:hover .qbn-btn[data-style="outline"] {
  background: var(--qbn-fg, #fff);
  color: var(--qbn-bg, #1c1c22);
}
/*
 * Tlačítka v barvách e-shopu.
 *
 * Plné a obrysové tlačítko se dosud barvily podle dlaždice (bílá písmem),
 * takže banner nikdy nesáhl po tom, co má e-shop jako kontrastní barvu.
 * Zelená se bere z jeho vlastní proměnné (--gr, ta samá jako u odznaku
 * s počtem kusů v košíku) a text na ní je černý — přesně jak to má ten
 * odznak. Když si web zelenou přebarví, přebarví se i tlačítka.
 */
.qbn-btn[data-style="green"],
.qbn-btn[data-style="greenline"] { --qbn-zel: var(--gr, #acc2ab); }
.qbn-btn[data-style="green"] {
  background: var(--qbn-zel);
  color: var(--pr, #14150f);
  border: 0;
}
a.qbn-card:hover .qbn-btn[data-style="green"] { filter: brightness(1.07); }
.qbn-btn[data-style="greenline"] {
  background: transparent;
  border: 1.5px solid var(--qbn-zel);
  color: var(--qbn-zel);
  padding: 8.5px 18.5px;
}
a.qbn-card:hover .qbn-btn[data-style="greenline"] {
  background: var(--qbn-zel);
  color: var(--pr, #14150f);
}
/*
 * Plné tmavé. Na světlé fotce je bílé plné tlačítko skoro neviditelné —
 * tohle je pro ten případ, a drží se primární barvy e-shopu (černá).
 */
.qbn-btn[data-style="dark"] {
  background: var(--pr, #14150f);
  color: #ffffff;
  border: 0;
}
a.qbn-card:hover .qbn-btn[data-style="dark"] { filter: brightness(1.35); }

/* Prosklené: drží se fotky, ale text na něm zůstane čitelný */
.qbn-btn[data-style="soft"] {
  background: rgba(255, 255, 255, .18);
  backdrop-filter: blur(7px);
  border: 1px solid rgba(255, 255, 255, .3);
  padding: 9px 19px;
}
a.qbn-card:hover .qbn-btn[data-style="soft"] { background: rgba(255, 255, 255, .3); }
/* Odkaz místo tlačítka — na banner, kde má mluvit fotka, ne tlačítko */
.qbn-btn[data-style="link"] {
  padding: 2px 0;
  border-radius: 0;
  border-bottom: 1.5px solid currentColor;
  letter-spacing: .01em;
}
a.qbn-card:hover .qbn-btn[data-style="link"] { transform: translateX(2px); }

/*
 * Tlačítko ze šablony e-shopu. Vlastní vzhled se mu nenastavuje — o to
 * právě jde: má vypadat jako každé jiné tlačítko na webu. Srovnává se
 * jen to, co by mu vnutila dlaždice (stín písma přes celý text) a co by
 * ho roztáhlo přes celou šířku.
 */
.qbn-body .btn {
  align-self: flex-start;
  width: auto;
  max-width: 100%;
  margin-top: 5px;
  text-shadow: none;
}
.qbn-card[data-align="center"] .qbn-body .btn { align-self: center; }
.qbn-card[data-align="right"] .qbn-body .btn { align-self: flex-end; }

.qbn-emoji {
  font-size: 22px;
  line-height: 1;
  text-shadow: none;
}
.qbn-card[data-align="center"] .qbn-emoji { align-self: center; }

/* ---------- chytré bannery ---------- */

.qbn-smart { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.qbn-card[data-align="center"] .qbn-smart { justify-content: center; }
.qbn-card[data-align="right"] .qbn-smart { justify-content: flex-end; }

.qbn-unit {
  min-width: 46px;
  padding: 5px 7px;
  border-radius: 9px;
  background: rgba(0, 0, 0, .42);
  backdrop-filter: blur(3px);
  text-align: center;
  text-shadow: none;
  font-variant-numeric: tabular-nums;
}
.qbn-num { display: block; font-size: 17px; font-weight: 700; line-height: 1.1; }
.qbn-unit small { display: block; font-size: 9.5px; opacity: .82; letter-spacing: .04em; }

.qbn-code {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 7px 12px;
  border-radius: 9px;
  border: 1px dashed currentColor;
  background: rgba(0, 0, 0, .3);
  font-weight: 700;
  letter-spacing: .09em;
  text-shadow: none;
  cursor: copy;
}
.qbn-code small { font-weight: 500; letter-spacing: 0; opacity: .8; }

.qbn-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 11px;
  border-radius: 999px;
  background: rgba(0, 0, 0, .38);
  font-size: 12.5px;
  font-weight: 600;
  text-shadow: none;
}

/* ---------- pruh odkazů pod bannerem ---------- */

/*
 * Banner prodává jednu věc; pruh pod ním říká, co všechno tu je. Na
 * počítači stojí odkazy vedle sebe na střed, na telefonu se **posouvají
 * do strany** — zabalit osm kategorií do dvou řádků by z nich udělalo
 * zeď, přes kterou se člověk nedostane k obsahu stránky.
 */
.qbn-links {
  /*
   * Mřížka stejně širokých sloupců, ne řádek podle délky textu.
   *
   * Dokud se šířka brala z popisku, měly „Kravaty" a „Šle a Motýlek"
   * jiný rozestup, ikonky nesedly pod sebe ani proti sobě a při osmi
   * kategoriích se z toho na počítači stal posuvník. Počet sloupců
   * dodá skript (--qbn-link-n), takže sloupce jsou vždy stejné a pruh
   * zůstane na střed.
   */
  display: grid;
  grid-template-columns: repeat(var(--qbn-link-n, 4), minmax(72px, 132px));
  justify-content: center;
  align-items: start;
  gap: clamp(8px, 1.4vw, 20px);
  margin: var(--qbn-gap-in) auto var(--qbn-gap-half);
  padding: 0 2px 2px;
  overflow-anchor: none;
}
/*
 * Mezi bannerem a jeho pruhem odkazů stačí menší mezera než kolem celého
 * bloku — jinak se z nich stanou dvě nesouvisející věci pod sebou.
 */
.qbn:has(+ .qbn-links) { margin-bottom: 0; }
.qbn-link {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  /* Sloupec už šířku určuje sám — odkaz ji jen vyplní */
  width: 100%;
  min-width: 0;
  color: inherit;
  text-decoration: none;
  font-family: var(--qbn-font, inherit);
}
.qbn-link-ico {
  display: flex;
  align-items: center;
  justify-content: center;
  width: clamp(54px, 5.6vw, 82px);
  height: clamp(54px, 5.6vw, 82px);
  background-color: rgba(0, 0, 0, .04);
  background-image: var(--qbn-link-img, none);
  background-size: cover;
  background-position: center;
  font-size: 26px;
  line-height: 1;
  transition: transform .2s ease;
}
/* Kreslená ikonka sedí uprostřed s okrajem; fotka vyplňuje celé kolečko */
.qbn-link-ico[data-kresba] { background-size: 52%; background-repeat: no-repeat; }
.qbn-links[data-shape="circle"] .qbn-link-ico { border-radius: 50%; }
.qbn-links[data-shape="square"] .qbn-link-ico { border-radius: var(--qbn-radius, 0); }
.qbn-links[data-shape="text"] .qbn-link-ico { display: none; }
/*
 * Bez ikonek to není mřížka, ale řádek štítků — stejně široké sloupce by
 * u dvouslovné kategorie nechaly kolem textu prázdný rámeček.
 */
.qbn-links[data-shape="text"] {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: clamp(10px, 1.6vw, 22px);
}
.qbn-links[data-shape="text"] .qbn-link-text { min-height: 0; }
.qbn-links[data-shape="text"] .qbn-link {
  /* Bez obrázku je to řádek odkazů, ne mřížka — hranice mezi nimi pomůže */
  padding: 7px 14px;
  border: 1px solid currentColor;
  border-radius: var(--qbn-radius, 0);
  max-width: none;
  opacity: .85;
}
.qbn-links[data-shape="text"] .qbn-link:hover { opacity: 1; }
a.qbn-link:hover .qbn-link-ico { transform: translateY(-3px); }
.qbn-link-text {
  font-size: clamp(12px, .85vw, 14px);
  line-height: 1.25;
  letter-spacing: -.02em;
  text-align: center;
  /*
   * Místo na dva řádky se drží i u jednoslovné kategorie. Jinak by pruh
   * s „Kravatami" a „Šlemi a Motýlkem" vedle sebe měl každou dlaždici
   * jinak vysokou a celý řádek by vypadal nakřivo.
   */
  min-height: 2.5em;
}
/* Delší název se zalomí, nerozšíří sloupec ani nepřeteče přes okraj */
.qbn-link-text { overflow-wrap: anywhere; hyphens: auto; }

@media (max-width: 760px) {
  /*
   * Na telefonu se pruh posouvá prstem. Poslední položka smí zůstat
   * napůl za okrajem — právě to říká, že se dá posunout dál.
   */
  .qbn-links {
    /* Sloupce zůstávají stejné, jen se místo zalomení posouvají prstem */
    grid-template-columns: none;
    grid-auto-flow: column;
    grid-auto-columns: 84px;
    /*
     * Když se kategorie na šířku vejdou, stojí na střed; když ne, posouvají
     * se od levého kraje. "safe" je tu kvůli tomu, že u vystředěného
     * posuvníku by se začátek seznamu schoval za levý okraj a nešel by
     * urolovat zpátky. Starší prohlížeč pravidlo zahodí a nechá to vlevo.
     */
    justify-content: flex-start;
    justify-content: safe center;
    overflow-x: auto;
    scroll-snap-type: x proximity;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
    padding-inline: 2px;
  }
  .qbn-links::-webkit-scrollbar { display: none; }
  .qbn-link { scroll-snap-align: start; }
  .qbn-link-ico { width: 62px; height: 62px; font-size: 24px; }
  .qbn-link-text { font-size: 11.5px; }
}

/* ---------- efekty ---------- */

/* Vždy jen uvnitř dlaždice — vrstva je ořezaná jejím okrajem */
.qbn-fx { position: absolute; inset: 0; z-index: 2; pointer-events: none; overflow: hidden; }
/*
 * Padá to odshora dolů přes **celou** dlaždici.
 *
 * Dřív se posouvalo transformací v procentech — a ta se počítá z velikosti
 * samotného emoji, ne z dlaždice. Z patnáctipixelového znaku tak vyšlo
 * pár desítek bodů a sníh padal jen v horním proužku. Procenta u "top" se
 * počítají z výšky rodiče, což je přesně to, co tady chceme; transformace
 * zůstala na úkrok do strany a otáčení.
 */
.qbn-flake {
  position: absolute;
  top: -15%;
  font-size: var(--qbn-flake-size, 15px);
  line-height: 1;
  animation-name: qbn-fall;
  animation-timing-function: linear;
  animation-iteration-count: infinite;
  will-change: top, transform;
}
@keyframes qbn-fall {
  0% { top: -15%; transform: translate3d(0, 0, 0) rotate(0deg); opacity: 0; }
  8% { opacity: 1; }
  92% { opacity: 1; }
  100% { top: 115%; transform: translate3d(14px, 0, 0) rotate(240deg); opacity: 0; }
}
.qbn-fx-shine::after {
  content: "";
  position: absolute;
  top: -40%;
  left: -60%;
  width: 40%;
  height: 180%;
  background: linear-gradient(100deg, rgba(255,255,255,0) 0%, rgba(255,255,255,.38) 50%, rgba(255,255,255,0) 100%);
  transform: skewX(-18deg);
  animation: qbn-shine 4.5s ease-in-out infinite;
}
@keyframes qbn-shine {
  0%, 62% { left: -60%; }
  100% { left: 130%; }
}
.qbn-fx-pulse ~ .qbn-body .qbn-emoji { animation: qbn-pulse 2.2s ease-in-out infinite; }
@keyframes qbn-pulse {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.22); }
}
.qbn-fx-float ~ .qbn-body .qbn-emoji { animation: qbn-float 3.4s ease-in-out infinite; }
@keyframes qbn-float {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-7px); }
}

/* ---------- tablet a telefon ---------- */

@media (max-width: 1000px) {
  .qbn[data-layout="quad"] .qbn-page { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .qbn[data-layout="quad"] .qbn-card { aspect-ratio: var(--qbn-ar, 1 / 1); }
  .qbn[data-layout="wide"] .qbn-card { aspect-ratio: var(--qbn-ar, 2 / 1); }
}
@media (max-width: 620px) {
  .qbn { gap: 10px; }
  .qbn-page { gap: 10px; }
  .qbn[data-phone="grid"] .qbn-page { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  /*
   * Na telefonu rozhoduje vlastní volba; když žádná není, zdědí se ta
   * z počítače — kdo chce dlaždice na výšku, chce je skoro vždycky na
   * výšku i na telefonu. Teprve potom padá na čtverec.
   */
  .qbn[data-phone="grid"] .qbn-card { aspect-ratio: var(--qbn-ar-phone, var(--qbn-ar, 1 / 1)); }
  .qbn[data-phone="wide"] .qbn-page { grid-template-columns: minmax(0, 1fr); }
  .qbn[data-phone="wide"] .qbn-card { aspect-ratio: var(--qbn-ar-phone, var(--qbn-ar, 5 / 3)); }
  .qbn-body { padding: 12px; gap: 5px; }
  .qbn-kicker { font-size: 9px; letter-spacing: .11em; }
  /* Na telefonu rozhoduje šířka dlaždice, ne volba velikosti — */
  /* dvojnásobný nadpis by se tu zalomil na pět řádků */
  .qbn-title { font-size: calc(15px * min(var(--qbn-ts, 1), 1.2)); }
  .qbn-text {
    font-size: 11.5px;
    /* Na dlaždici o straně poloviny displeje se třetí řádek nevejde */
    -webkit-line-clamp: 2;
  }
  .qbn-btn { padding: 7px 13px; font-size: 11.5px; }
  .qbn-btn[data-style="outline"] { padding: 6px 12px; }
  .qbn-body .btn { font-size: 11.5px; }
  /*
   * Odpočet se na půlce telefonu musí vejít na jeden řádek. Zalomený na dva
   * vytlačí tlačítko pod okraj dlaždice a z banneru se pak nedá kliknout
   * tam, kam má.
   */
  .qbn-smart { gap: 4px; }
  .qbn-unit { min-width: 32px; padding: 3px 4px; }
  .qbn-num { font-size: 13px; }
  .qbn-unit small { font-size: 8px; letter-spacing: 0; }
  .qbn-chip { padding: 5px 9px; font-size: 11px; }
  .qbn-code { padding: 5px 9px; letter-spacing: .05em; }
  .qbn-emoji { font-size: 18px; }
}

/* ---------- podoby dlaždice ---------- */

/*
 * Text na fotce je jen jedna z možností a zdaleka ne vždycky ta nejlepší:
 * unese pár slov, potřebuje ztmavení a na světlé fotce látky je i tak na
 * hraně. Proto jsou tu další tři podoby — text pod fotkou (unese odstavec
 * a je klidný), fotka a text vedle sebe (na široké bloky) a text
 * v rámečku, kde fotka zůstane vidět celá.
 */
.qbn-card[data-style="under"], .qbn-card[data-style="side"] {
  /* Výšku dělá obsah, ne poměr stran — text pod fotkou se nesmí ořezat */
  aspect-ratio: auto;
  display: grid;
  isolation: isolate;
}
.qbn-card[data-style="under"] { grid-template-rows: auto minmax(0, 1fr); }
.qbn-card[data-style="side"] { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); align-items: center; }
.qbn-card[data-style="under"] .qbn-photo,
.qbn-card[data-style="side"] .qbn-photo {
  position: relative;
  inset: auto;
  aspect-ratio: var(--qbn-ar, 3 / 4);
  width: 100%;
}
/*
 * Poměr stran se u těchhle podob přesouvá z dlaždice na fotku — a to
 * musí platit i tam, kde poměr dlaždici vnucuje rozvržení. Jinak zůstane
 * dlaždice svázaná výškou, fotka ji celou vyplní a text z ní vypadne
 * ven: v náhledu z toho byl černý obdélník bez písmene.
 */
.qbn[data-layout="quad"] .qbn-card[data-style="under"],
.qbn[data-layout="quad"] .qbn-card[data-style="side"],
.qbn[data-layout="wide"] .qbn-card[data-style="under"],
.qbn[data-layout="wide"] .qbn-card[data-style="side"],
.qbn[data-phone="grid"] .qbn-card[data-style="under"],
.qbn[data-phone="wide"] .qbn-card[data-style="under"],
.qhl .qbn-card[data-style="under"],
.qhl .qbn-card[data-style="side"] { aspect-ratio: auto; }
.qhl .qbn-card[data-style="under"] .qbn-photo,
.qhl .qbn-card[data-style="side"] .qbn-photo { aspect-ratio: var(--qhl-ar, 16 / 9); }
.qbn-card[data-style="under"] .qbn-body,
.qbn-card[data-style="side"] .qbn-body {
  position: relative;
  inset: auto;
  padding: 18px;
  justify-content: flex-start;
  /* Bez fotky pod textem není co ztmavovat a stín pod písmem jen špiní */
  text-shadow: none;
}
.qbn-card[data-style="under"] .qbn-shade,
.qbn-card[data-style="side"] .qbn-shade,
.qbn-card[data-style="frame"] .qbn-shade { display: none; }
.qbn-card[data-style="under"] .qbn-fx,
.qbn-card[data-style="side"] .qbn-fx { inset: 0; }
/* Střídání stran: druhý blok má fotku vpravo, aby řada nebyla jednotvárná */
.qhl[data-layout="stridave"] .qbn-card[data-style="side"]:nth-child(even) .qbn-photo { order: 2; }

.qbn-card[data-style="frame"] .qbn-body { isolation: isolate; padding: 30px; }
.qbn-card[data-style="frame"] .qbn-body::before {
  content: "";
  position: absolute;
  inset: 14px;
  z-index: -1;
  background: rgba(0, 0, 0, var(--qbn-shade, .4));
  border-radius: var(--qbn-radius, 0);
}

/* ---------- posuvník ---------- */

/*
 * Na telefonu je posuvník jediný způsob, jak ukázat čtyři bannery a
 * nemít úvodní obrazovku dlouhou dva metry. Posouvá se prstem (žádná
 * knihovna, jen přichycení při rolování) a tečky pod ním říkají, kolik
 * toho ještě je — bez nich vypadá první dlaždice jako jediná.
 */
.qbn-track {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: 86%;
  gap: 12px;
  overflow-x: auto;
  scroll-snap-type: x mandatory;
  scrollbar-width: none;
  -webkit-overflow-scrolling: touch;
  padding-inline: 2px;
  scroll-padding-inline: 2px;
}
.qbn-track::-webkit-scrollbar { display: none; }
.qbn-track > * { scroll-snap-align: center; }
.qbn-dots {
  display: flex;
  gap: 7px;
  justify-content: center;
  align-items: center;
  margin-top: 12px;
  /*
   * Šalvějová zelená e-shopu. Bere se z jeho vlastní proměnné (--gr,
   * ta samá, co má odznak s počtem kusů v košíku), takže když si ji web
   * někdy přebarví, přebarví se i tečky. Náhradní hodnota je změřená
   * na quentino.cz: rgb(172, 194, 171).
   *
   * Dřív tu bylo "currentColor" — tedy barva textu šablony, což je
   * modrá odkazů. Tečky pak byly jediný modrý prvek na stránce.
   */
  --qbn-dot: var(--gr, #acc2ab);
}
.qbn-dot {
  width: 7px;
  height: 7px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: var(--qbn-dot);
  /*
   * Zelená je světlá a leží na světle šedém pruhu. Při dřívějších .22
   * by nečinná tečka splynula s pozadím — proto se rozdíl mezi činnou
   * a nečinnou nese hlavně velikostí a až potom průhledností.
   */
  opacity: .4;
  cursor: pointer;
  transition: opacity .2s ease, transform .2s ease;
}
.qbn-dot[data-now] { opacity: 1; transform: scale(1.35); }

/* ---------- bloky pod bannerem (highlights) ---------- */

/*
 * Tytéž dlaždice jako banner, jen jiné rozvržení — a hlavně **na víc
 * stránkách**: v šabloně e-shopu je tahle sekce i u kategorií a článků,
 * kde žádný banner není. Proto se kreslí samostatně.
 */
.qhl {
  display: grid;
  gap: clamp(10px, 1.4vw, 18px);
  width: 100%;
  /* Stejná půlka jako u banneru — rytmus stránky drží jedno číslo */
  margin: var(--qbn-gap-half) auto;
  overflow-anchor: none;
}
.qhl[data-layout="mozaika"] { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.qhl[data-layout="pruh"] { grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); }
.qhl[data-layout="stridave"] { grid-template-columns: minmax(0, 1fr); }
.qhl[data-layout="carousel"] { grid-template-columns: minmax(0, 1fr); }
.qhl .qbn-card { aspect-ratio: var(--qhl-ar, 16 / 9); }
.qhl[data-layout="stridave"] .qbn-card { aspect-ratio: var(--qhl-ar, 32 / 11); }

@media (max-width: 760px) {
  .qhl[data-layout="mozaika"], .qhl[data-layout="pruh"], .qhl[data-layout="stridave"] {
    grid-template-columns: minmax(0, 1fr);
  }
  .qhl .qbn-card { aspect-ratio: var(--qhl-ar-phone, var(--qhl-ar, 4 / 3)); }
  /* Vedle sebe se na telefon nevejde nic — obojí pod sebe */
  .qhl .qbn-card[data-style="side"] { grid-template-columns: minmax(0, 1fr); }
  .qhl .qbn-card[data-style="side"] .qbn-photo { order: 0; }
}

/* ---------- další efekty ---------- */

/*
 * Ken Burns: fotka se pomalu přibližuje. Nejnenápadnější způsob, jak
 * dostat do banneru pohyb — nic nepřelétá přes text a na malém displeji
 * to nepůsobí jako reklama z devadesátek.
 */
.qbn-fx-ken ~ .qbn-photo, .qbn-card[data-fx="ken"] .qbn-photo {
  animation: qbn-ken 18s ease-in-out infinite alternate;
}
@keyframes qbn-ken {
  from { transform: scale(1); }
  to { transform: scale(1.09); }
}

/* Přeliv přes nadpis — jemnější než přeleštění celé dlaždice */
.qbn-card[data-fx="shimmer"] .qbn-title {
  background: linear-gradient(100deg,
    currentColor 0%, currentColor 38%,
    rgba(255, 255, 255, .92) 50%,
    currentColor 62%, currentColor 100%);
  background-size: 260% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  animation: qbn-shimmer 4.5s ease-in-out infinite;
}
@keyframes qbn-shimmer {
  0%, 62% { background-position: 180% 0; }
  100% { background-position: -80% 0; }
}

/* Záře kolem tlačítka — tam, kde má člověk kliknout */
.qbn-card[data-fx="glow"] .qbn-btn,
.qbn-card[data-fx="glow"] .qbn-body .btn {
  animation: qbn-glow 2.6s ease-in-out infinite;
}
@keyframes qbn-glow {
  0%, 100% { box-shadow: 0 0 0 0 rgba(255, 255, 255, 0); }
  50% { box-shadow: 0 0 0 6px rgba(255, 255, 255, .18); }
}

/* Stoupání: emoji jde vzhůru jako bublinka. Opak sněžení, sedí na léto */
@keyframes qbn-rise {
  0% { top: 110%; opacity: 0; transform: translateX(0) rotate(0deg); }
  12% { opacity: .85; }
  88% { opacity: .85; }
  100% { top: -15%; opacity: 0; transform: translateX(14px) rotate(8deg); }
}
/* Konfety: padají a přitom se točí kolem své osy */
@keyframes qbn-confetti {
  0% { top: -15%; opacity: 0; transform: rotate(0deg) scale(1); }
  10% { opacity: 1; }
  90% { opacity: 1; }
  100% { top: 115%; opacity: 0; transform: rotate(540deg) scale(.8); }
}

/* Kdo si vypnul pohyb v systému, nemá se na co dívat ani tady */
@media (prefers-reduced-motion: reduce) {
  .qbn-fx-ken ~ .qbn-photo, .qbn-card[data-fx="ken"] .qbn-photo,
  .qbn-card[data-fx="shimmer"] .qbn-title,
  .qbn-card[data-fx="glow"] .qbn-btn,
  .qbn-card[data-fx="glow"] .qbn-body .btn { animation: none; }
  .qbn-card[data-fx="shimmer"] .qbn-title { color: inherit; }
  .qbn-page { transition: none; }
  .qbn-photo { transition: none; }
  a.qbn-card:hover .qbn-photo { transform: none; }
  .qbn-flake, .qbn-fx-shine::after,
  .qbn-fx-pulse ~ .qbn-body .qbn-emoji,
  .qbn-fx-float ~ .qbn-body .qbn-emoji { animation: none; }
  .qbn-flake { display: none; }
}
</style>
<script>
/* Quentino — bannery na úvodní stránce. Plán z aplikace, záloha v tomhle souboru. */
(function () {
  "use strict";
  if (window.__quentinoBanners) return;
  window.__quentinoBanners = true;

  var SOURCE = "__QUENTINO_BANNERS_URL__";
  var TTL_MS = __QUENTINO_BANNERS_TTL__ * 1000;
  var FALLBACK = "__QUENTINO_BANNERS_FALLBACK__";
  var STORE = "quentino-bannery-1";
  /*
   * Jak často se znovu rozhodne, která sada platí. Minuta stačí: sada se
   * plánuje na minuty, ne na vteřiny. Odpočet uvnitř banneru tiká vlastním
   * intervalem po vteřině.
   */
  var TICK_MS = 60000;

  /* ================= jazyk ================= */

  function getLang() {
    /*
     * Náhled v aplikaci běží v rámečku na doméně aplikace, takže by se
     * podle adresy vždycky ukázala čeština. Tohle je jediná cesta, jak
     * v náhledu přepnout na slovenskou a anglickou verzi — na e-shopu
     * proměnná není a rozhoduje doména.
     */
    if (window.__quentinoLang) return window.__quentinoLang;
    var h = (location.hostname || "").toLowerCase();
    if (h.slice(-3) === ".sk") return "sk";
    if (h.slice(-4) === ".com") return "en";
    return "cz";
  }
  var LANG = getLang();

  /* Text je ve všech jazycích; chybí-li ten náš, vezme se český. */
  function pick(value) {
    if (!value) return "";
    if (typeof value === "string") return value.trim();
    var out = value[LANG] || value.cz || "";
    return typeof out === "string" ? out.trim() : "";
  }

  var WORDS = {
    cz: {
      day: ["den", "dny", "dní"], hour: ["hodina", "hodiny", "hodin"],
      min: ["minuta", "minuty", "minut"], sec: ["vteřina", "vteřiny", "vteřin"],
      copied: "Zkopírováno", order: "Objednej do"
    },
    sk: {
      day: ["deň", "dni", "dní"], hour: ["hodina", "hodiny", "hodín"],
      min: ["minúta", "minúty", "minút"], sec: ["sekunda", "sekundy", "sekúnd"],
      copied: "Skopírované", order: "Objednaj do"
    },
    en: {
      day: ["day", "days", "days"], hour: ["hour", "hours", "hours"],
      min: ["minute", "minutes", "minutes"], sec: ["second", "seconds", "seconds"],
      copied: "Copied", order: "Order by"
    }
  };
  var W = WORDS[LANG] || WORDS.cz;

  /*
   * Skloňování počtu. „2 dní" je vidět na každém druhém e-shopu a je to
   * přesně ta drobnost, kvůli které banner vypadá, že ho dělal někdo cizí.
   */
  function plural(n, forms) {
    if (n === 1) return forms[0];
    if (n >= 2 && n <= 4) return forms[1];
    return forms[2];
  }

  function dateText(ms) {
    var locale = LANG === "sk" ? "sk-SK" : (LANG === "en" ? "en-GB" : "cs-CZ");
    try {
      return new Date(ms).toLocaleDateString(locale, { day: "numeric", month: "long" });
    } catch (e) {
      return "";
    }
  }

  /* ================= písmo ================= */

  /*
   * Písmo se stahuje jen tehdy, když si o ně banner řekne.
   *
   * Výchozí „jako e-shop" nenastavuje "font-family" vůbec, takže blok
   * zdědí písmo stránky a nestáhne se nic navíc. Každý vlastní font je
   * soubor navíc na úvodní stránce, a ta se načítá nejčastěji ze všech.
   */
  /*
   * "track" je prostrkání nadpisu. Jedna hodnota pro všechna písma nejde:
   * úzké bezpatkové sneseme stažené (e-shop má −0,06 em), patkové by se
   * tím slepilo a Bebas je stažený už od výroby.
   */
  var FONTS = {
    inter: { css: "Inter:wght@300..900", stack: "'Inter', system-ui, sans-serif", track: "-.025em" },
    jost: { css: "Jost:wght@300..800", stack: "'Jost', system-ui, sans-serif", track: "-.02em" },
    playfair: {
      css: "Playfair+Display:wght@400..900",
      stack: "'Playfair Display', Georgia, serif", track: "-.005em"
    },
    bebas: {
      css: "Bebas+Neue",
      stack: "'Bebas Neue', Haettenschweiler, Impact, sans-serif", track: ".01em"
    }
  };
  var fontsAsked = {};

  function useFont(kind) {
    var font = FONTS[kind];
    if (!font || fontsAsked[kind]) return font || null;
    fontsAsked[kind] = true;
    var link = document.createElement("link");
    link.rel = "stylesheet";
    /*
     * „display=swap" je tu podstatné: bez něj prohlížeč text schová,
     * dokud se písmo nestáhne, a na pomalém telefonu by na úvodní stránce
     * chvíli svítily prázdné dlaždice — přesně to, čemu se celý blok
     * vyhýbá.
     */
    link.href = "https://fonts.googleapis.com/css2?family=" + font.css + "&display=swap";
    (document.head || document.documentElement).appendChild(link);
    return font;
  }

  /* ================= plán ================= */

  function cached() {
    try {
      var raw = localStorage.getItem(STORE);
      if (!raw) return null;
      var saved = JSON.parse(raw);
      return saved && saved.data ? saved : null;
    } catch (e) {
      return null;
    }
  }

  function remember(data) {
    try {
      localStorage.setItem(STORE, JSON.stringify({ at: Date.now(), data: data }));
    } catch (e) {
      /* Zaplněné nebo zakázané úložiště není důvod bannery nevykreslit */
    }
  }

  var plan = null;
  var saved = cached();
  if (saved) plan = saved.data;
  /*
   * Záložní sada platí, dokud nedorazí plán. Tím se kreslí hned v hlavičce
   * a stránka se po dotečení plánu nehne — v naprosté většině návštěv je
   * v plánu tatáž sada.
   */
  if (!plan && FALLBACK) plan = { sets: [FALLBACK] };

  function fetchPlan() {
    if (!SOURCE || SOURCE.indexOf("http") !== 0) return;
    try {
      fetch(SOURCE, { cache: "no-store" })
        .then(function (res) { return res.ok ? res.json() : null; })
        .then(function (data) {
          if (!data || !data.sets) return;
          remember(data);
          plan = data;
          render();
        })
        .catch(function () { /* beze změny — na stránce zůstane, co je */ });
    } catch (e) { /* prohlížeč bez fetch dostane zálohu a nic víc */ }
  }

  /* Která sada zrovna platí. Při překryvu vyhrává ta, co začala později. */
  function activeSet() {
    var sets = (plan && plan.sets) || [];
    var now = Date.now();
    var best = null;
    for (var i = 0; i < sets.length; i++) {
      var one = sets[i];
      if (!one || !one.banners || one.banners.length === 0) continue;
      var from = Number(one.fromMs) || 0;
      var to = Number(one.toMs) || 0;
      if (from > now) continue;
      if (to && to < now) continue;
      if (!best || from >= (Number(best.fromMs) || 0)) best = one;
    }
    if (!best && FALLBACK) return FALLBACK;
    return best;
  }

  /* ================= kreslení ================= */

  function el(tag, cls) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    return node;
  }

  /*
   * Text se vkládá přes textContent, nikdy jako HTML. Je to text z plánu
   * ve veřejném úložišti a i kdyby se k němu někdo dostal, nesmí z něj jít
   * udělat kód běžící na e-shopu.
   */
  function put(parent, tag, cls, value) {
    if (!value) return null;
    var node = el(tag, cls);
    /*
     * Slovo mezi dvěma hvězdičkami je tučně — píše se to tak v poště,
     * v chatu i v naplánovaných textech na webu, takže se to nemusí učit
     * zvlášť. A odpovídá to e-shopu: v jeho vlastním banneru je v odstavci
     * <strong>.
     *
     * Skládá se to z uzlů, ne z HTML: text přichází z veřejného souboru
     * a "innerHTML" by z něj udělal cestu, jak na e-shopu spustit cizí kód.
     */
    var parts = String(value).split("**");
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      if (i % 2) {
        var strong = document.createElement("b");
        strong.textContent = parts[i];
        node.appendChild(strong);
      } else {
        node.appendChild(document.createTextNode(parts[i]));
      }
    }
    parent.appendChild(node);
    return node;
  }

  function unit(box, value, forms) {
    var cell = el("span", "qbn-unit");
    var num = el("span", "qbn-num");
    num.textContent = value < 10 ? "0" + value : String(value);
    cell.appendChild(num);
    var label = el("small");
    label.textContent = plural(value, forms);
    cell.appendChild(label);
    box.appendChild(cell);
  }

  /** Odpočet. Vrací funkci, která ho přepočítá — volá se každou vteřinu. */
  function countdown(body, untilMs) {
    var box = el("div", "qbn-smart");
    body.appendChild(box);
    return function () {
      var left = untilMs - Date.now();
      if (left <= 0) {
        /*
         * Po vypršení odpočet zmizí a zbyde obyčejná dlaždice. Nuly na
         * hodinách by tvrdily, že akce právě teď končí, a to bylo včera.
         */
        box.style.display = "none";
        return;
      }
      box.style.display = "";
      box.textContent = "";
      var s = Math.floor(left / 1000);
      var d = Math.floor(s / 86400);
      var h = Math.floor((s % 86400) / 3600);
      var m = Math.floor((s % 3600) / 60);
      if (d > 0) unit(box, d, W.day);
      unit(box, h, W.hour);
      unit(box, m, W.min);
      /* Vteřiny jen u posledního dne — jinak je to blikání bez významu */
      if (d === 0) unit(box, s % 60, W.sec);
    };
  }

  function codeChip(body, code) {
    var chip = el("span", "qbn-code");
    var value = el("b");
    value.textContent = code;
    chip.appendChild(value);
    var hint = el("small");
    hint.textContent = "⧉";
    chip.appendChild(hint);
    chip.addEventListener("click", function (e) {
      /* Dlaždice je odkaz; kopírování kódu z ní nesmí odejít na jinou stránku */
      e.preventDefault();
      e.stopPropagation();
      try {
        navigator.clipboard.writeText(code);
        hint.textContent = W.copied;
        setTimeout(function () { hint.textContent = "⧉"; }, 1800);
      } catch (err) { /* bez schránky zůstane kód aspoň vidět */ }
    });
    body.appendChild(chip);
  }

  function deliveryChip(body, untilMs) {
    var chip = el("span", "qbn-chip");
    var when = dateText(untilMs);
    var days = Math.max(0, Math.ceil((untilMs - Date.now()) / 86400000));
    /*
     * Krátce. Na dlaždici o straně poloviny telefonu se delší věta zalomí
     * na tři řádky a vytlačí tlačítko — datum a počet dnů řeknou všechno.
     */
    chip.textContent = when
      ? W.order + " " + when + " · " + days + " " + plural(days, W.day)
      : days + " " + plural(days, W.day);
    body.appendChild(chip);
  }

  /*
   * Padající emoji. Kusy se vyrobí jednou; pak už to jede v CSS.
   *
   * Na telefonu se počet krátí na dvě třetiny: dlaždice je tam poloviční
   * a stejný počet z ní udělá neprůhlednou clonu přes text.
   */
  function flakes(fx, smart, druh) {
    var emoji = smart.emoji || "❄️";
    var count = Math.max(2, Math.round(Number(smart.fxCount) || 14));
    if (window.innerWidth < 620) count = Math.max(2, Math.round(count * 0.66));
    var size = Number(smart.fxSize) || 15;
    var speed = Number(smart.fxSpeed) || 8;
    for (var i = 0; i < count; i++) {
      var one = el("span", "qbn-flake");
      one.textContent = emoji;
      /*
       * Tentýž kus, tři různé pohyby. Padání, stoupání i konfety se liší
       * jen průběhem animace — dělat na to tři kusy kódu by znamenalo tři
       * místa, kde se dá zapomenout na vypnutý pohyb v systému.
       */
      if (druh === "rise") one.style.animationName = "qbn-rise";
      else if (druh === "confetti") one.style.animationName = "qbn-confetti";
      /*
       * Rozestup po sloupcích s malým rozhozením. Náhodné rozmístění se
       * na úzké dlaždici umí seskupit do jednoho chuchvalce a vedle něj
       * nechat prázdno — rovnoměrně rozdělené sloupce vypadají líp a
       * pořád ne strojově.
       */
      one.style.left = ((i + 0.5) * (100 / count) + ((i % 3) - 1) * 2.5).toFixed(1) + "%";
      // Rozptyl rychlosti ±25 %, ať nepadají jako jeden kus
      one.style.animationDuration = (speed * (0.75 + (i % 5) * 0.125)).toFixed(1) + "s";
      // Záporné zpoždění: v první vteřině už padá plná dlaždice, ne prázdno
      one.style.animationDelay = "-" + ((i * 0.83) % speed).toFixed(1) + "s";
      one.style.setProperty("--qbn-flake-size", (size * (0.75 + (i % 4) * 0.17)).toFixed(1) + "px");
      one.style.opacity = String(0.6 + (i % 3) * 0.13);
      fx.appendChild(one);
    }
  }

  /** Jedna dlaždice. Vrací i funkci pro odpočet, když ho banner má. */
  function card(one) {
    var href = pick(one.href);
    var node = el(href ? "a" : "div", "qbn-card");
    if (href) {
      node.setAttribute("href", href);
      var label = pick(one.title) || pick(one.text);
      if (label) node.setAttribute("aria-label", label);
    }
    var look = one.look || {};
    node.setAttribute("data-style", look.style || "overlay");
    node.setAttribute("data-align", look.align || "left");
    node.setAttribute("data-pos", look.pos || "bottom");
    if (look.caps) node.setAttribute("data-caps", "1");
    node.style.setProperty("--qbn-bg", look.bg || "#000000");
    node.style.setProperty("--qbn-fg", look.fg || "#ffffff");
    node.style.setProperty("--qbn-focus", look.focus || "50% 50%");
    node.style.setProperty("--qbn-shade", String((Number(look.overlay) || 0) / 100));
    node.style.setProperty("--qbn-radius", (Number(look.radius) >= 0 ? Number(look.radius) : 0) + "px");
    node.style.setProperty("--qbn-tw", String(Number(look.titleWeight) || 400));
    node.style.setProperty("--qbn-bw", String(Number(look.textWeight) || 400));
    node.style.setProperty("--qbn-ts", String((Number(look.titleSize) || 100) / 100));
    // Nic nenastavit znamená zdědit písmo e-shopu — to je výchozí stav
    var font = look.font && look.font !== "shop" ? useFont(look.font) : null;
    if (font) {
      node.style.setProperty("--qbn-font", font.stack);
      node.style.setProperty("--qbn-track", font.track);
    }

    /*
     * Adresa se do stylu vkládá jen tehdy, když v ní není závorka, uvozovka
     * ani mezera — aplikace to hlídá taky, ale plán je veřejný soubor a
     * tohle je to místo, kde by se z něj dal spustit cizí kód.
     */
    var photo = el("div", "qbn-photo");
    var image = String(look.image || "");
    if (image && !/["'()\\\s]/.test(image)
      && (image.indexOf("http") === 0 || image.indexOf("data:image/") === 0)) {
      node.style.setProperty("--qbn-img", "url(" + image + ")");
    }
    node.appendChild(photo);
    video(node, look, image);
    node.appendChild(el("div", "qbn-shade"));

    var smart = one.smart || {};
    var fx = el("div", "qbn-fx");
    if (smart.effect === "shine") fx.className += " qbn-fx-shine";
    if (smart.effect === "pulse") fx.className += " qbn-fx-pulse";
    if (smart.effect === "float") fx.className += " qbn-fx-float";
    if (smart.effect === "snow") flakes(fx, smart, "snow");
    if (smart.effect === "rise") flakes(fx, smart, "rise");
    if (smart.effect === "confetti") flakes(fx, smart, "confetti");
    /*
     * Efekty, které nejsou o létajících znacích, se řeší značkou na
     * dlaždici a zbytek je na stylu — tím se nemusí nic dopočítávat
     * a dá se to celé vypnout jedním pravidlem.
     */
    if (smart.effect === "ken" || smart.effect === "shimmer" || smart.effect === "glow") {
      node.setAttribute("data-fx", smart.effect);
    }
    node.appendChild(fx);

    var body = el("div", "qbn-body");
    if (smart.emoji && smart.effect !== "snow") put(body, "span", "qbn-emoji", smart.emoji);
    put(body, "span", "qbn-kicker", pick(one.kicker));
    put(body, "h3", "qbn-title", pick(one.title));
    put(body, "p", "qbn-text", pick(one.text));

    var tick = null;
    var until = Number(smart.untilMs) || 0;
    if (smart.kind === "countdown" && until > 0) tick = countdown(body, until);
    if (smart.kind === "code" && smart.code) codeChip(body, smart.code);
    if (smart.kind === "delivery" && until > 0) deliveryChip(body, until);

    button(body, pick(one.button), look.button || "shop");
    node.appendChild(body);
    return { node: node, tick: tick };
  }

  /**
   * Posuvník: dlaždice vedle sebe, posouvá se prstem, pod ním tečky.
   *
   * Žádná knihovna. Posouvání dělá prohlížeč sám (přichytávání při
   * rolování), tečky jen ukazují, kde člověk je, a klepnutím se dá skočit.
   * Knihovna by znamenala další stahovaný soubor na úvodní stránce kvůli
   * něčemu, co CSS umí samo.
   */
  function karusel(kam, karty, every) {
    var track = el("div", "qbn-track");
    for (var i = 0; i < karty.length; i++) track.appendChild(karty[i]);
    kam.appendChild(track);

    if (karty.length < 2) return;

    var dots = el("div", "qbn-dots");
    var tecky = [];
    for (var d = 0; d < karty.length; d++) {
      var dot = document.createElement("button");
      dot.className = "qbn-dot";
      dot.setAttribute("type", "button");
      dot.setAttribute("aria-label", "Banner " + (d + 1));
      (function (at) {
        dot.addEventListener("click", function () {
          var cil = track.children[at];
          if (cil) track.scrollTo({ left: cil.offsetLeft - track.offsetLeft, behavior: "smooth" });
        });
      })(d);
      dots.appendChild(dot);
      tecky.push(dot);
    }
    kam.appendChild(dots);

    var ukaz = function () {
      var stred = track.scrollLeft + track.clientWidth / 2;
      var nej = 0;
      var nejlepsi = Infinity;
      for (var k = 0; k < track.children.length; k++) {
        var one = track.children[k];
        var mid = one.offsetLeft - track.offsetLeft + one.offsetWidth / 2;
        var vzdal = Math.abs(mid - stred);
        if (vzdal < nejlepsi) { nejlepsi = vzdal; nej = k; }
      }
      for (var t = 0; t < tecky.length; t++) {
        if (t === nej) tecky[t].setAttribute("data-now", "1");
        else tecky[t].removeAttribute("data-now");
      }
      return nej;
    };
    var cekam = null;
    track.addEventListener("scroll", function () {
      if (cekam) return;
      cekam = setTimeout(function () { cekam = null; ukaz(); }, 120);
    }, { passive: true });
    ukaz();

    /*
     * Samočinné přetáčení se zastaví, jakmile se člověk dotkne. Posuvník,
     * který uhne pod prstem, je horší než posuvník, co stojí.
     */
    var kazdych = Number(every) || 0;
    var still = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (kazdych > 0 && !still) {
      var timer = setInterval(function () {
        if (!track.isConnected) { clearInterval(timer); return; }
        var at = (ukaz() + 1) % track.children.length;
        var cil = track.children[at];
        if (cil) track.scrollTo({ left: cil.offsetLeft - track.offsetLeft, behavior: "smooth" });
      }, Math.max(2, kazdych) * 1000);
      var stop = function () { clearInterval(timer); };
      track.addEventListener("touchstart", stop, { passive: true });
      track.addEventListener("mousedown", stop);
    }
  }

  /**
   * Video na pozadí dlaždice.
   *
   * Pravidla, bez kterých by to na telefonu nehrálo vůbec: **bez zvuku**
   * (se zvukem prohlížeč přehrávání nespustí), playsinline (jinak iPhone
   * otevře video přes celou obrazovku) a loop, protože banner nemá konec.
   * Fotka zůstává jako poster - je vidět hned, kdežto video se ještě
   * stahuje, a bez ní by dlaždice na okamžik zčernala.
   *
   * Kdo má v systému vypnuté animace, dostane jen fotku. Není to detail
   * přístupnosti pro pár lidí: na tom nastavení bývá i úsporný režim.
   */
  function video(node, look, image) {
    var src = String(look.video || "");
    if (!src || /["'()\\\s<>]/.test(src) || src.indexOf("http") !== 0) return;
    if (!/\.(webm|mp4)(\?|#|$)/i.test(src)) return;
    try {
      if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    } catch (e) { /* stará prohlížečka to nezná — video se pustí */ }

    var vid = document.createElement("video");
    vid.className = "qbn-video";
    vid.muted = true;
    vid.defaultMuted = true;
    vid.autoplay = true;
    vid.loop = true;
    vid.playsInline = true;
    vid.setAttribute("muted", "");
    vid.setAttribute("playsinline", "");
    vid.setAttribute("preload", "metadata");
    vid.setAttribute("aria-hidden", "true");
    vid.setAttribute("tabindex", "-1");
    if (image && image.indexOf("http") === 0) vid.setAttribute("poster", image);
    vid.src = src;
    /*
     * Dokud video nehraje, je průhledné a je vidět fotka pod ním. Bez toho
     * problikne černý obdélník mezi prvním vykreslením a prvním snímkem —
     * a když se video nestáhne vůbec, zůstal by černý natrvalo.
     */
    vid.addEventListener("playing", function () { vid.setAttribute("data-hraje", "1"); });
    var slib = vid.play();
    if (slib && slib.catch) slib.catch(function () { /* nepustilo se: zůstane fotka */ });
    node.appendChild(vid);
  }

  /**
   * Tlačítko.
   *
   * Podoba „shop" je výchozí a znamená třídu ".btn" ze šablony e-shopu —
   * tedy přesně to tlačítko, jaké je na webu všude jinde. Vlastního vzhledu
   * se mu schválně nedává žádný.
   */
  /*
   * Třídy, kterými je psané tlačítko v původním banneru e-shopu (změřeno
   * na quentino.cz 22. 9. 2026): černé pozadí, bílý text, hranaté rohy,
   * odsazení 16/32. Holá třída "btn" sama o sobě je průhledná s černým
   * písmem — na fotce by z ní nezbylo nic.
   */
  var SHOP_BTN = "btn fg bg-pr pt-3 pr-5 pb-3 pl-5 fs-4";

  function button(body, label, style) {
    if (!label) return;
    var node = el("span", style === "shop" ? SHOP_BTN : "qbn-btn");
    if (style !== "shop") node.setAttribute("data-style", style);
    node.textContent = label;
    body.appendChild(node);
    if (style !== "shop") return;
    /*
     * Pojistka, kdyby šablona třídu ".btn" neměla nebo ji přejmenovala.
     * Tlačítko by pak bylo holý text uprostřed fotky a vypadalo by to jako
     * chyba sazby. Změří se proto, jestli mu šablona vůbec něco dala —
     * pozadí nebo rámeček — a když ne, dostane naši výplň.
     */
    setTimeout(function () {
      try {
        var css = getComputedStyle(node);
        var plne = css.backgroundColor && css.backgroundColor.indexOf("rgba(0, 0, 0, 0)") < 0
          && css.backgroundColor !== "transparent";
        var ramecek = parseFloat(css.borderTopWidth) > 0;
        if (!plne && !ramecek) {
          node.className = "qbn-btn";
          node.setAttribute("data-style", "fill");
        }
      } catch (e) { /* bez změřeného stylu zůstane tlačítko, jak je */ }
    }, 0);
  }

  /*
   * Tvary dlaždic. Nevybraný tvar proměnnou **nenastaví** — teprve pak se
   * v CSS uplatní náhradní hodnota, která je jiná pro každé rozvržení
   * i pro každou šířku obrazovky.
   */
  var RATIOS = {
    "1:1": "1 / 1", "4:5": "4 / 5", "3:4": "3 / 4", "2:3": "2 / 3",
    "4:3": "4 / 3", "16:9": "16 / 9", "2:1": "2 / 1", "3:1": "3 / 1"
  };

  function tvar(node, name, value) {
    if (RATIOS[value]) node.style.setProperty(name, RATIOS[value]);
    else node.style.removeProperty(name);
  }

  var linkBox = null;

  /*
   * Pruh odkazů pod bannerem.
   *
   * Kreslí se vedle mřížky, ne do ní: rotace vyměňuje stránky bannerů a
   * odkazy na kategorie s ní nemají co dělat — musí zůstat, i když se
   * banner nad nimi přetočí.
   */
  function odkazy(set) {
    var data = set.links;
    if (linkBox && linkBox.parentNode) linkBox.parentNode.removeChild(linkBox);
    linkBox = null;
    if (!data || !data.items || data.items.length === 0 || !box || !box.parentNode) return;

    var wrap = el("div", "qbn-links");
    wrap.setAttribute("data-shape", data.shape || "circle");
    /*
     * Kolik je sloupců, ví jen tenhle kód — a mřížka to potřebuje, aby
     * byly všechny stejně široké. Dokud se šířka brala z délky popisku,
     * měla každá kategorie jiný rozestup a při osmi se z pruhu stal na
     * počítači posuvník.
     */
    wrap.style.setProperty("--qbn-link-n", String(data.items.length));
    for (var i = 0; i < data.items.length; i++) {
      var one = data.items[i];
      var href = pick(one.href);
      var node = el(href ? "a" : "div", "qbn-link");
      if (href) node.setAttribute("href", href);

      /*
       * Rámeček se kreslí jen tehdy, když je do něj co dát. Prázdný šedý
       * čtverec vypadá jako nenačtený obrázek, a to je horší než samotný
       * text — ten je čitelný vždycky.
       */
      var image = String(one.image || "");
      var maObrazek = image && !/["'()\\\s]/.test(image)
        && (image.indexOf("http") === 0 || image.indexOf("data:image/") === 0);
      if (maObrazek || one.emoji) {
        var ico = el("span", "qbn-link-ico");
        if (maObrazek) {
          ico.style.setProperty("--qbn-link-img", "url(" + image + ")");
          /*
           * Nakreslená ikonka není fotka. Fotka se roztáhne přes celé
           * kolečko, kdežto obrys kravaty přes celou plochu vypadá jako
           * chyba — sedí doprostřed a kolem něj má být vzduch.
           */
          if (image.indexOf("data:image/svg") === 0) ico.setAttribute("data-kresba", "1");
        } else ico.textContent = one.emoji;
        node.appendChild(ico);
      }
      put(node, "span", "qbn-link-text", pick(one.text));
      wrap.appendChild(node);
    }
    box.parentNode.insertBefore(wrap, box.nextSibling);
    linkBox = wrap;
  }

  /*
   * Původní karusel se nejdřív schová stylem (okamžitě, ještě než se sem
   * kód dostane) a pak se **zahodí úplně**. Dva důvody, obojí z provozu:
   *
   *  1. Schovaný karusel si dál stahoval své fotky — několik set kilobajtů
   *     na úvodní stránce za obrázky, které nikdo neuvidí. Proto se
   *     obrázkům nejdřív sebere adresa (to rozdělané stahování ukončí)
   *     a teprve pak jde celý blok pryč.
   *  2. Karusel šablony si sám přetáčí snímky a sahá na rolování stránky.
   *     Na schovaném prvku běžel dál a na telefonu kvůli tomu stránka
   *     při rolování nahoru přeskakovala.
   */
  function zhasniObrazky(spot) {
    var obrazky = spot.querySelectorAll ? spot.querySelectorAll("img, source") : [];
    for (var i = 0; i < obrazky.length; i++) {
      try {
        obrazky[i].removeAttribute("srcset");
        obrazky[i].setAttribute("src", "data:image/gif;base64,R0lGODlhAQABAAAAACw=");
      } catch (e) { /* jeden obrázek navíc nic nezkazí */ }
    }
  }

  function odstranPuvodni(spot) {
    zhasniObrazky(spot);
    if (spot.parentNode) spot.parentNode.removeChild(spot);
  }

  /*
   * Vyprázdní obal, ale nechá ho stát. Používá se tam, kde si od šablony
   * bereme jen obsah a pozadí s odsazením si necháváme — u bloků pod
   * bannerem. Obrázkům se nejdřív sebere adresa, ať se nedotahují.
   */
  function vyprazdni(obal) {
    zhasniObrazky(obal);
    while (obal.firstChild) obal.removeChild(obal.firstChild);
  }

  /*
   * Sekce si necháváme kvůli pozadí, jenže šablona na ní má třídu "anim":
   * obsah je do příjezdu do obrazu průhledný a teprve skript šablony ho
   * odkryje. Ten ale sleduje svoje původní děti, ne naše — a kdyby se
   * nespustil, zůstaly by bloky neviditelné a nikdo by nevěděl proč.
   * Odkrytí si proto uděláme sami a animaci šablony necháme být.
   */
  function odkryj(node) {
    try {
      node.className = String(node.className || "").replace(/\banim[\w-]*\b/g, " ");
      node.style.opacity = "1";
      node.style.visibility = "visible";
      node.style.transform = "none";
    } catch (e) { /* bez odkrytí to může být v pořádku — nechat být */ }
  }

  var box = null;
  var rotor = null;
  var ticker = null;
  var shownId = "";

  /* Kam blok patří. Od nejužšího vodítka k nejširšímu, ať přežije přejmenování. */
  var SPOTS = ["#banner1", ".bnr-main .carousel", ".bnr-main", ".bic-bnr"];

  function findSpot() {
    for (var i = 0; i < SPOTS.length; i++) {
      var found = document.querySelector(SPOTS[i]);
      if (found && found.parentNode) return found;
    }
    return null;
  }

  /* ---------- bloky pod bannerem ---------- */

  var hlBox = null;
  var hlShown = "";

  /*
   * Kde v šabloně e-shopu ty bloky jsou. Sekce bic-hdln je nese na
   * úvodní stránce **i na kategoriích a v článcích** — proto se hledá
   * všude, ne jen pod bannerem.
   */
  var HL_SPOTS = [".bic-hdln", ".section.hdln"];

  function hlSpot() {
    for (var i = 0; i < HL_SPOTS.length; i++) {
      var found = document.querySelector(HL_SPOTS[i]);
      if (found && found.parentNode) return found;
    }
    /* Sekce na stránce není — u prvního bloku se vezme jeho rodičovská sekce */
    var clanek = document.querySelector("article.hl-cover");
    if (clanek) {
      var sekce = clanek.closest ? clanek.closest(".section") : null;
      if (sekce && sekce.parentNode) return sekce;
    }
    return null;
  }

  /** Je tohle úvodní stránka? Jazyková mutace má vlastní kořen. */
  function jeUvodni() {
    var cesta = String(location.pathname || "/");
    return cesta === "/" || /^\/(cz|sk|en|de)\/?$/i.test(cesta);
  }

  /**
   * Vykreslí bloky pod bannerem.
   *
   * Je to samostatná část: na kategorii ani v článku žádný banner není,
   * zato sekce s bloky ano — a právě tam nese kampaň, kterou jinak není
   * kam dát. Kreslí se proto nezávisle na banneru a i tehdy, když se
   * banner na stránce vůbec neobjeví.
   */
  function drawHighlights(set) {
    var data = set && set.highlights;
    if (!data || !data.banners || data.banners.length === 0) return false;
    if (data.where === "home" && !jeUvodni()) return false;

    if (!hlBox) {
      var spot = hlSpot();
      if (!spot) return false;
      hlBox = el("div", "qhl");
      /*
       * Sekce zůstává na místě, vyprázdní se jen její obsah.
       *
       * Nese totiž pozadí a odsazení ze šablony — na úvodní stránce je
       * lehce šedé, stejně jako u banneru. Když se odstraňovala celá,
       * spadly bloky na bílé pozadí obsahu stránky a v místě, kde
       * předtím nic nesvítilo, vznikl bílý pruh.
       *
       * Vkládá se do nejvnitřnějšího obalu, protože ten drží šířku —
       * napřímo do sekce by se bloky roztáhly přes celou stránku.
       */
      var vnitrek = spot.querySelector ? (spot.querySelector(".max") || spot.querySelector(".container")) : null;
      if (!vnitrek) vnitrek = spot;
      vyprazdni(vnitrek);
      odkryj(spot);
      vnitrek.appendChild(hlBox);
    }

    var rozvrzeni = data.layout || "mozaika";
    var naTelefonu = window.innerWidth <= 760;
    if (naTelefonu && data.phone) rozvrzeni = data.phone;
    hlBox.setAttribute("data-layout", rozvrzeni);
    tvar(hlBox, "--qhl-ar", data.ratio);
    tvar(hlBox, "--qhl-ar-phone", data.phoneRatio);
    hlBox.textContent = "";

    var karty = [];
    var ticks = [];
    for (var i = 0; i < data.banners.length; i++) {
      var built = card(data.banners[i]);
      karty.push(built.node);
      if (built.tick) ticks.push(built.tick);
    }

    if (rozvrzeni === "carousel") {
      karusel(hlBox, karty, data.rotate);
    } else {
      for (var k = 0; k < karty.length; k++) hlBox.appendChild(karty[k]);
    }

    if (ticks.length > 0) {
      var run = function () { for (var t = 0; t < ticks.length; t++) ticks[t](); };
      run();
      setInterval(run, 1000);
    }
    return true;
  }

  function draw(set) {
    /*
     * Místo se hledá **jen napoprvé**. Původní karusel se totiž hned nato
     * ze stránky zahodí, takže při druhém kreslení (sada se vymění poté,
     * co doteče plán) už by se nenašel a blok by zmizel i s ním.
     */
    if (!box) {
      var spot = findSpot();
      if (!spot) return false;
      box = el("div", "qbn");
      spot.parentNode.insertBefore(box, spot);
      document.documentElement.classList.add("qbn-on");
      odstranPuvodni(spot);
      /*
       * Druhý blok bannerů ze šablony. Schovat nestačí — stejně jako
       * u karuselu by si dál stahoval své fotky.
       */
      var skupina = document.querySelectorAll(".bnr-group");
      for (var g = 0; g < skupina.length; g++) odstranPuvodni(skupina[g]);
    }
    box.setAttribute("data-layout", set.layout === "wide" ? "wide" : "quad");
    /*
     * Posuvník je volba pro telefon, na počítači se nepoužívá: tam se
     * čtyři dlaždice vedle sebe vejdou a posouvat je myší je otrava.
     */
    var naTelefonu = window.innerWidth <= 760;
    var posuvnik = set.phone === "carousel" && naTelefonu;
    box.setAttribute("data-phone", posuvnik ? "carousel"
      : (set.phone === "wide" ? "wide" : "grid"));
    tvar(box, "--qbn-ar", set.ratio);
    tvar(box, "--qbn-ar-phone", set.phoneRatio);
    box.textContent = "";

    /*
     * Stránkuje se po čtyřech u mřížky a po jednom u širokého banneru —
     * tedy přesně po tom, co se na obrazovku vejde. Víc bannerů než jedna
     * stránka znamená rotaci, míň znamená, že se nic nepřetáčí.
     */
    var perPage = set.layout === "wide" ? 1 : 4;
    var banners = set.banners || [];
    var ticks = [];
    var pages = [];

    /*
     * Posuvník nestránkuje: dlaždice leží vedle sebe v jedné řadě a
     * prst rozhoduje, která je vidět. Rotace se v něm dělá posunem, ne
     * prolnutím — proto se tahle větev vyřizuje zvlášť a dřív.
     */
    if (posuvnik) {
      var karty = [];
      for (var c = 0; c < banners.length; c++) {
        var jedna = card(banners[c]);
        karty.push(jedna.node);
        if (jedna.tick) ticks.push(jedna.tick);
      }
      karusel(box, karty, set.rotate);
      odkazy(set);
      if (ticker) { clearInterval(ticker); ticker = null; }
      if (ticks.length > 0) {
        var tik = function () { for (var t = 0; t < ticks.length; t++) ticks[t](); };
        tik();
        ticker = setInterval(tik, 1000);
      }
      if (rotor) { clearInterval(rotor); rotor = null; }
      return true;
    }
    for (var i = 0; i < banners.length; i += perPage) {
      var page = el("div", "qbn-page");
      for (var j = i; j < Math.min(i + perPage, banners.length); j++) {
        var built = card(banners[j]);
        page.appendChild(built.node);
        if (built.tick) ticks.push(built.tick);
      }
      /*
       * Poslední stránka se dorovná prázdnými místy, aby čtvrtý banner
       * nebyl dvakrát tak široký jako ostatní. Prázdné místo je opravdu
       * prázdné, ne šedá dlaždice — ta by vypadala jako chyba.
       */
      if (set.layout !== "wide") {
        var missing = perPage - (Math.min(i + perPage, banners.length) - i);
        for (var k = 0; k < missing; k++) {
          var hole = el("div");
          hole.style.visibility = "hidden";
          page.appendChild(hole);
        }
      }
      box.appendChild(page);
      pages.push(page);
    }
    if (pages.length > 0) pages[0].className = "qbn-page qbn-now";

    odkazy(set);

    if (ticker) { clearInterval(ticker); ticker = null; }
    if (ticks.length > 0) {
      var run = function () { for (var t = 0; t < ticks.length; t++) ticks[t](); };
      run();
      ticker = setInterval(run, 1000);
    }

    if (rotor) { clearInterval(rotor); rotor = null; }
    var every = Number(set.rotate) || 0;
    var still = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (pages.length > 1 && every > 0 && !still) {
      var at = 0;
      rotor = setInterval(function () {
        pages[at].className = "qbn-page";
        at = (at + 1) % pages.length;
        pages[at].className = "qbn-page qbn-now";
      }, Math.max(2, every) * 1000);
    }
    return true;
  }

  function render() {
    var set = activeSet();
    if (!set) return;
    /*
     * Překreslí se jen při změně sady. Bez toho by se blok přestavoval
     * každou minutu a rotace i odpočet by se pokaždé vrátily na začátek.
     */
    var stamp = String(set.id) + "|" + String(set.rotate) + "|" + String(set.layout)
      + "|" + String(set.phone) + "|" + String(set.ratio) + "|" + String(set.phoneRatio)
      // Otočení telefonu mění rozvržení, takže se musí překreslit
      + "|" + (window.innerWidth <= 760 ? "t" : "p")
      + "|" + (set.banners || []).length
      + "|" + ((set.links && set.links.items) ? set.links.items.length : 0)
      + "|" + ((set.links && set.links.shape) || "");
    /*
     * Bloky se kreslí **vždycky**, i když se banner nevykreslil: na
     * kategorii ani v článku žádný banner není, zato sekce s bloky ano.
     */
    var hlStamp = String(set.id) + "|" + ((set.highlights && set.highlights.banners) || []).length
      + "|" + ((set.highlights && set.highlights.layout) || "")
      + "|" + ((set.highlights && set.highlights.phone) || "")
      + "|" + (window.innerWidth <= 760 ? "t" : "p");
    if (hlStamp !== hlShown && drawHighlights(set)) hlShown = hlStamp;

    if (stamp === shownId && box) return;
    if (draw(set)) shownId = stamp;
  }

  /*
   * Na místo banneru se čeká pozorovatelem, ne až na DOMContentLoaded.
   * Skript běží v hlavičce, takže v tu chvíli ještě žádný banner na stránce
   * není — a čekat na celý dokument by znamenalo, že se starý karusel na
   * okamžik ukáže a pak zmizí.
   */
  function watch() {
    if (!document.body && !document.documentElement) return;
    render();
    /*
     * Čeká se na **obojí** — na banner i na bloky pod ním. Dřív stačilo
     * najít banner a pozorovatel se vypnul; sekce s bloky se přitom
     * dokresluje později a na kategorii, kde banner vůbec není, by se
     * nečekalo na nic.
     */
    if (shownId && hlShown) return;
    var seen = new MutationObserver(function () {
      render();
      if (shownId && hlShown) seen.disconnect();
    });
    seen.observe(document.documentElement, { childList: true, subtree: true });
    /* Po deseti vteřinách je jasné, že na téhle stránce banner není */
    setTimeout(function () { seen.disconnect(); }, 10000);
  }

  watch();
  document.addEventListener("DOMContentLoaded", render);
  /*
   * Otočení telefonu mění rozvržení (posuvník proti mřížce), takže se
   * překresluje i při změně šířky okna. Počká se, až se přestane hýbat —
   * během otáčení chodí událostí desítky.
   */
  var znovu = null;
  window.addEventListener("resize", function () {
    if (znovu) clearTimeout(znovu);
    znovu = setTimeout(function () {
      znovu = null;
      render();
    }, 250);
  }, { passive: true });
  fetchPlan();
  setInterval(render, TICK_MS);
})();
</script>
`;
/**
 * Odstraní ze skriptu komentáře.
 *
 * Ve zdroji zůstávají — vysvětlují, proč je co tak, jak je, a bez nich by
 * se v tom za půl roku nikdo nevyznal. Do e-shopu ale odchází jedno velké
 * pole v administraci a to má svůj strop: s komentáři měl skript přes
 * 61 000 znaků a **nešel v Upgates uložit**. Komentáře přitom tvořily
 * skoro třetinu.
 *
 * Maže se jen to, co je bezpečné poznat na začátku řádku: blokový
 * komentář a řádkový komentář dvěma lomítky. Adresy typu „https://…"
 * uprostřed řádku se tím nedotknou — a kdyby se přesto něco ukrojilo,
 * pozná se to hned, protože zkouška skript spouští v náhledu.
 */
function bezKomentaru(script: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const line of script.split('\n')) {
    const trimmed = line.trim();
    if (inBlock) {
      if (trimmed.includes('*/')) inBlock = false;
      continue;
    }
    if (trimmed.startsWith('/*')) {
      // Jednořádkový blok se zavírá hned, víceřádkový drží příznak
      if (!trimmed.includes('*/')) inBlock = true;
      continue;
    }
    if (trimmed.startsWith('//')) continue;
    if (!trimmed) continue;
    out.push(line);
  }
  return out.join('\n');
}

export function bannerScript(input: { url: string; ttl: number; fallback: any }): string {
  const url = String(input.url ?? '').trim();
  const ttl = Math.max(5, Math.min(3600, Math.round(Number(input.ttl)) || 300));
  /*
   * Záložní sada se do skriptu vkládá jako JSON na místo řetězce v uvozovkách
   * — proto se nahrazuje i s nimi. Bez sady zůstane prázdný řetězec, který
   * je ve skriptu nepravdivý, takže se záloha prostě nepoužije.
   */
  const fallback = input.fallback ? JSON.stringify(input.fallback) : '""';
  /*
   * Komentáře se zahazují až tady, po dosazení. Kdyby se čistilo dřív,
   * musela by se zvlášť ohlídat i záložní sada — a v té jsou uživatelské
   * texty, kde dvě lomítka na začátku řádku klidně být můžou.
   */
  return bezKomentaru(TEMPLATE)
      .split(FALLBACK_MARK).join(fallback)
      .split(URL_MARK).join(url)
      .split(TTL_MARK).join(String(ttl))
      .trim();
}
export const __test = { URL_MARK, TTL_MARK, FALLBACK_MARK };
