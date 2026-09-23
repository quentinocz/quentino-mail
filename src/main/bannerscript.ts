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
.qbn-on #banner1,
.qbn-on .bnr-main .carousel,
.qbn-on .bnr-main .cover-bnr { display: none !important; }

.qbn {
  display: grid;
  width: 100%;
  /*
   * Vzduch nad i pod. Bez něj se blok lepil na hlavičku a na to, co je
   * pod ním, a celá úvodní stránka vypadala nedodělaně — banner je
   * samostatný celek, ne další řádek textu.
   */
  margin: clamp(20px, 2.6vw, 44px) auto;
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
  /* Poměr stran drží výšku dřív, než dotečou fotky — bez toho stránka poskakuje */
  aspect-ratio: 3 / 4;
  isolation: isolate;
}
.qbn[data-layout="wide"] .qbn-card { aspect-ratio: 32 / 11; }

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
  display: flex;
  justify-content: center;
  gap: clamp(12px, 2vw, 30px);
  margin: clamp(14px, 2vw, 26px) auto 0;
  padding: 0 2px 2px;
  overflow-anchor: none;
}
.qbn-link {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
  max-width: 120px;
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
.qbn-links[data-shape="circle"] .qbn-link-ico { border-radius: 50%; }
.qbn-links[data-shape="square"] .qbn-link-ico { border-radius: var(--qbn-radius, 0); }
.qbn-links[data-shape="text"] .qbn-link-ico { display: none; }
.qbn-links[data-shape="text"] { gap: clamp(10px, 1.6vw, 22px); }
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
}

@media (max-width: 760px) {
  /*
   * Na telefonu se pruh posouvá prstem. Poslední položka smí zůstat
   * napůl za okrajem — právě to říká, že se dá posunout dál.
   */
  .qbn-links {
    justify-content: flex-start;
    overflow-x: auto;
    scroll-snap-type: x proximity;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
    padding-inline: 2px;
  }
  .qbn-links::-webkit-scrollbar { display: none; }
  .qbn-link { scroll-snap-align: start; max-width: 96px; }
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
  .qbn[data-layout="quad"] .qbn-card { aspect-ratio: 1 / 1; }
  .qbn[data-layout="wide"] .qbn-card { aspect-ratio: 2 / 1; }
}
@media (max-width: 620px) {
  .qbn { gap: 10px; }
  .qbn-page { gap: 10px; }
  .qbn[data-phone="grid"] .qbn-page { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .qbn[data-phone="grid"] .qbn-card { aspect-ratio: 1 / 1; }
  .qbn[data-phone="wide"] .qbn-page { grid-template-columns: minmax(0, 1fr); }
  .qbn[data-phone="wide"] .qbn-card { aspect-ratio: 5 / 3; }
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

/* Kdo si vypnul pohyb v systému, nemá se na co dívat ani tady */
@media (prefers-reduced-motion: reduce) {
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
  function flakes(fx, smart) {
    var emoji = smart.emoji || "❄️";
    var count = Math.max(2, Math.round(Number(smart.fxCount) || 14));
    if (window.innerWidth < 620) count = Math.max(2, Math.round(count * 0.66));
    var size = Number(smart.fxSize) || 15;
    var speed = Number(smart.fxSpeed) || 8;
    for (var i = 0; i < count; i++) {
      var one = el("span", "qbn-flake");
      one.textContent = emoji;
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
    if (image && !/["'()\\\s]/.test(image) && image.indexOf("http") === 0) {
      node.style.setProperty("--qbn-img", "url(" + image + ")");
    }
    node.appendChild(photo);
    node.appendChild(el("div", "qbn-shade"));

    var smart = one.smart || {};
    var fx = el("div", "qbn-fx");
    if (smart.effect === "shine") fx.className += " qbn-fx-shine";
    if (smart.effect === "pulse") fx.className += " qbn-fx-pulse";
    if (smart.effect === "float") fx.className += " qbn-fx-float";
    if (smart.effect === "snow") flakes(fx, smart);
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
    for (var i = 0; i < data.items.length; i++) {
      var one = data.items[i];
      var href = pick(one.href);
      var node = el(href ? "a" : "div", "qbn-link");
      if (href) node.setAttribute("href", href);

      var ico = el("span", "qbn-link-ico");
      var image = String(one.image || "");
      if (image && !/["'()\\\s]/.test(image) && image.indexOf("http") === 0) {
        ico.style.setProperty("--qbn-link-img", "url(" + image + ")");
      } else if (one.emoji) {
        ico.textContent = one.emoji;
      }
      node.appendChild(ico);
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
  function odstranPuvodni(spot) {
    var obrazky = spot.querySelectorAll ? spot.querySelectorAll("img, source") : [];
    for (var i = 0; i < obrazky.length; i++) {
      try {
        obrazky[i].removeAttribute("srcset");
        obrazky[i].setAttribute("src", "data:image/gif;base64,R0lGODlhAQABAAAAACw=");
      } catch (e) { /* jeden obrázek navíc nic nezkazí */ }
    }
    if (spot.parentNode) spot.parentNode.removeChild(spot);
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
    }
    box.setAttribute("data-layout", set.layout === "wide" ? "wide" : "quad");
    box.setAttribute("data-phone", set.phone === "wide" ? "wide" : "grid");
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
      + "|" + String(set.phone) + "|" + (set.banners || []).length
      + "|" + ((set.links && set.links.items) ? set.links.items.length : 0)
      + "|" + ((set.links && set.links.shape) || "");
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
    if (shownId) return;
    var seen = new MutationObserver(function () {
      render();
      if (shownId) seen.disconnect();
    });
    seen.observe(document.documentElement, { childList: true, subtree: true });
    /* Po deseti vteřinách je jasné, že na téhle stránce banner není */
    setTimeout(function () { seen.disconnect(); }, 10000);
  }

  watch();
  document.addEventListener("DOMContentLoaded", render);
  fetchPlan();
  setInterval(render, TICK_MS);
})();
</script>
`;
export function bannerScript(input: { url: string; ttl: number; fallback: any }): string {
  const url = String(input.url ?? '').trim();
  const ttl = Math.max(5, Math.min(3600, Math.round(Number(input.ttl)) || 300));
  /*
   * Záložní sada se do skriptu vkládá jako JSON na místo řetězce v uvozovkách
   * — proto se nahrazuje i s nimi. Bez sady zůstane prázdný řetězec, který
   * je ve skriptu nepravdivý, takže se záloha prostě nepoužije.
   */
  const fallback = input.fallback ? JSON.stringify(input.fallback) : '""';
  return TEMPLATE
      .split(FALLBACK_MARK).join(fallback)
      .split(URL_MARK).join(url)
      .split(TTL_MARK).join(String(ttl))
      .trim();
}
export const __test = { URL_MARK, TTL_MARK, FALLBACK_MARK };
