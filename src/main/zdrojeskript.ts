/**
 * Měřicí skript na e-shop — odkud přišel zákazník, který nakoupil.
 *
 * ## Proč vlastní, když je Analytics
 *
 * Patrik (25. 11.): „detekce a párování objednávky se zdrojem — organic,
 * google, facebook, případně přes proklik i konkrétní kampaň". Analytics
 * to umí jen pro český web (napojený je jen ten) a jen tak, jak si to
 * spočítá sám. Skript zapíše přímo proklik: `gclid` (podle něj se v Google
 * Ads dohledá přesná kampaň, sestava a klíčové slovo), `fbclid`, `sznclid`,
 * UTM parametry a odkazující web — na všech trzích, první i poslední zdroj.
 *
 * ## Co ukládá a co ne
 *
 * Jen zdroj návštěvy a číslo objednávky. Žádné jméno, e-mail ani adresu —
 * ty jsou v e-shopu a aplikace je k objednávce přiřadí sama. Řídí se
 * souhlasem s cookies (Consent Mode): když zákazník měření odmítne, nic se
 * neukládá ani neodesílá.
 *
 * ## Jak pozná nákup
 *
 * E-shop při dokončení objednávky posílá do `dataLayer` událost `purchase`
 * s číslem objednávky (`transaction_id`) — přesně tu, ze které počítá
 * Analytics. Skript ji přečte (i když přijde později, `push` se hlídá)
 * a jednou pošle záznam do Supabase. Zápis smí jen vkládat; číst ho může
 * jen aplikace s tajným klíčem.
 *
 * Pozor při úpravách: text níž je `String.raw` — nesmí v něm být zpětný
 * apostrof ani dolar se složenou závorkou.
 */

export const TABULKA_ZDROJU = 'quentino_zdroje';

const TEMPLATE = String.raw`
<script>
/* Quentino — zdroj objednávky (UTM, proklik, odkazující web). Nic o zákazníkovi. */
(function () {
  "use strict";
  if (window.__quentinoZdroje) return;
  window.__quentinoZdroje = true;
  var DB = "__QZ_URL__", KLIC = "__QZ_KEY__", TABULKA = "__QZ_TABLE__";
  var STORE = "quentino-zdroje-1", ODESLANO = "quentino-zdroje-odeslano", DNU = 90;
  var CLID = ["gclid", "gbraid", "wbraid", "fbclid", "sznclid", "msclkid", "ttclid"];
  /* Návrat z platební brány nebo z jiného našeho webu není nový zdroj */
  var NE = /quentino|gopay|comgate|thepay|paypal|stripe|gpwebpay|csob|3dsecure|3ds|adyen|payu|twisto|skippay|monet|airbank|mbank|revolut|pay\.google|apple\.com|kb\.cz|rb\.cz|fio\.cz|unicredit|bankid/i;

  function cti(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } }
  function pis(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* plné nebo zakázané úložiště */ } }
  function hostitel(u) { var m = /^https?:\/\/([^\/?#]+)/i.exec(u || ""); return m ? m[1].replace(/^www\./, "").toLowerCase() : ""; }
  function param(p, k) { var m = new RegExp("[?&]" + k + "=([^&#]*)").exec(p); try { return m ? decodeURIComponent(m[1].replace(/\+/g, " ")).slice(0, 200) : ""; } catch (e) { return m ? m[1].slice(0, 200) : ""; } }

  /* Consent Mode: poslední nastavení analytics_storage; bez Consent Mode se měří */
  function souhlas() {
    var dl = window.dataLayer || [], stav = "";
    for (var i = 0; i < dl.length; i++) {
      var a = dl[i];
      if (a && a[0] === "consent" && a[2] && a[2].analytics_storage) stav = a[2].analytics_storage;
    }
    return stav !== "denied";
  }

  function dotek() {
    var q = location.search, d = { kdy: new Date().toISOString(), vstup: location.pathname.slice(0, 120) };
    var utm = ["source", "medium", "campaign", "term", "content"], nazvy = ["zdroj", "medium", "kampan", "klic", "obsah"];
    for (var i = 0; i < utm.length; i++) { var v = param(q, "utm_" + utm[i]); if (v) d[nazvy[i]] = v; }
    for (var j = 0; j < CLID.length; j++) { var c = param(q, CLID[j]); if (c) { d.clid = CLID[j]; d.clidHodnota = c; break; } }
    var ref = hostitel(document.referrer);
    if (ref && ref !== location.hostname.replace(/^www\./, "") && !NE.test(ref)) d.referrer = ref;
    return d.zdroj || d.clid || d.referrer ? d : null;
  }

  var stav = cti(STORE) || { dotyky: [] };
  var hranice = Date.now() - DNU * 86400000;
  stav.dotyky = (stav.dotyky || []).filter(function (one) { return one && Date.parse(one.kdy) > hranice; });
  if (stav.prvni && Date.parse(stav.prvni.kdy) < hranice) stav.prvni = null;
  var novy = dotek();
  if (novy) { stav.dotyky.push(novy); if (stav.dotyky.length > 12) stav.dotyky = stav.dotyky.slice(-12); }
  if (!stav.prvni) stav.prvni = novy || { kdy: new Date().toISOString(), vstup: location.pathname.slice(0, 120), zdroj: "(direct)" };
  var ulozeno = false;
  function uloz() { if (!ulozeno && souhlas()) { pis(STORE, stav); ulozeno = true; } }
  uloz();

  function nakupZ(a) {
    if (!a) return null;
    var e = null;
    if (a.event === "purchase" && a.ecommerce) e = a.ecommerce;
    else if (a[0] === "event" && a[1] === "purchase" && a[2]) e = a[2];
    if (!e || !e.transaction_id) return null;
    return { id: String(e.transaction_id).slice(0, 40), celkem: Number(e.value) || null, mena: String(e.currency || "").slice(0, 8) };
  }

  function odesli(n) {
    if (!souhlas() || !DB || !KLIC) return;
    uloz();
    var hotove = cti(ODESLANO) || [];
    if (hotove.indexOf(n.id) >= 0) return;
    hotove.push(n.id);
    pis(ODESLANO, hotove.slice(-30));
    var posledni = stav.dotyky.length ? stav.dotyky[stav.dotyky.length - 1] : null;
    var telo = {
      objednavka: n.id,
      web: location.hostname.slice(0, 80),
      data: {
        prvni: stav.prvni, posledni: posledni, dotyky: stav.dotyky,
        zarizeni: window.matchMedia && window.matchMedia("(max-width: 767px)").matches ? "mobil" : "pocitac",
        celkem: n.celkem, mena: n.mena, jazyk: (document.documentElement.lang || "").slice(0, 8)
      }
    };
    try {
      fetch(DB + "/rest/v1/" + TABULKA, {
        method: "POST", keepalive: true,
        headers: { apikey: KLIC, Authorization: "Bearer " + KLIC, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify(telo)
      }).catch(function () { /* příště se to nezopakuje — radši jeden chybějící záznam než dvojí */ });
    } catch (e) { /* starý prohlížeč */ }
  }

  function projdi(a) { var n = nakupZ(a); if (n) odesli(n); else if (a && a[0] === "consent") uloz(); }
  var dl = window.dataLayer = window.dataLayer || [];
  for (var i = 0; i < dl.length; i++) projdi(dl[i]);
  var puvodni = dl.push;
  dl.push = function () {
    var vysledek = puvodni.apply(dl, arguments);
    for (var k = 0; k < arguments.length; k++) { try { projdi(arguments[k]); } catch (e) { /* měření nesmí rozbít e-shop */ } }
    return vysledek;
  };
})();
</script>`;

export function zdrojeSkript(url: string, anonKey: string): string {
  return TEMPLATE
    .replace('__QZ_URL__', String(url || '').replace(/["\\<>]/g, '').replace(/\/+$/, ''))
    .replace('__QZ_KEY__', String(anonKey || '').replace(/["\\<>]/g, ''))
    .replace('__QZ_TABLE__', TABULKA_ZDROJU)
    .trim();
}

/**
 * Tabulka v Supabase — spustí se jednou v SQL editoru.
 *
 * E-shop (veřejný klíč) smí jen vkládat, a to s omezenou délkou, ať se
 * tabulka nedá zahltit nesmysly. Číst může jen aplikace s tajným klíčem
 * (service_role obchází pravidla), takže zdroje objednávek nikdo cizí
 * neuvidí.
 */
export const ZDROJE_SQL = `create table if not exists public.${TABULKA_ZDROJU} (
  id bigint generated always as identity primary key,
  objednavka text not null check (char_length(objednavka) between 1 and 40),
  web text not null default '' check (char_length(web) <= 80),
  data jsonb not null default '{}'::jsonb check (pg_column_size(data) < 16000),
  kdy timestamptz not null default now()
);
create index if not exists ${TABULKA_ZDROJU}_kdy on public.${TABULKA_ZDROJU} (kdy);
alter table public.${TABULKA_ZDROJU} enable row level security;
drop policy if exists "e-shop zapisuje" on public.${TABULKA_ZDROJU};
create policy "e-shop zapisuje" on public.${TABULKA_ZDROJU} for insert to anon with check (true);
grant insert on public.${TABULKA_ZDROJU} to anon;`;
