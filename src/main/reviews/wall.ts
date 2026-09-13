/**
 * Skript pro e-shop — zeď s fotkami zákazníků a jejich recenzemi.
 *
 * ## Proč je to psané jako funkce, a ne jako text
 *
 * Skript se do stránky vkládá jako text, ale **napsaný je jako obyčejná
 * funkce** a do textu se převede až `String(wall)`. Důvod je prostý: v kódu
 * jsou zpětné apostrofy (šablonové řetězce pro CSS) a ty by se v textové
 * šabloně musely escapovat — a jeden přehlédnutý by rozbil celou zeď.
 * Takhle ho kontroluje překladač jako každý jiný kód.
 *
 * ## Odkud se berou data
 *
 * Z Supabase. Zeď si je stáhne při načtení stránky, takže se recenze mění
 * publikováním z aplikace a ne úpravou skriptu na e-shopu. Kdyby Supabase
 * nebylo k dispozici, **vykreslí se záložní kopie**, která je ve skriptu
 * zapečená při vystavení — zeď bez fotek vypadá jako rozbitá stránka
 * a recenze jsou to poslední, co má shodit e-shop.
 *
 * Čeká se krátce a jen jednou: zeď bývá pod ohybem stránky, takže vteřina
 * a půl nikomu nevadí, a je to lepší než překreslit ji před očima. Fotky
 * se totiž míchají náhodně a druhé vykreslení by je přeskládalo.
 */

export interface WallItem {
  img: string;
  w: number;
  h: number;
  [lang: string]: any;
}

export interface WallConfig {
  maxCards: number;
  initialRows: number;
  colsDesktop: number;
  colsMobile: number;
  containerId: string;
  /** Doména → jazyk; `.sk` na `sk`, `.com` na `en` */
  langMap: Record<string, string>;
  defaultLang: string;
  labels: Record<string, { showMore: string; collapse: string }>;
  /** Jak dlouho se čeká na Supabase, než se vezme záložní kopie (ms) */
  timeoutMs: number;
}

export const DEFAULT_WALL: WallConfig = {
  maxCards: 32,
  initialRows: 2,
  colsDesktop: 4,
  colsMobile: 2,
  containerId: 'q-wall',
  langMap: { '.sk': 'sk', '.com': 'en' },
  defaultLang: 'cz',
  labels: {
    cz: { showMore: 'Zobrazit více fotek', collapse: 'Zobrazit méně' },
    sk: { showMore: 'Zobraziť viac fotiek', collapse: 'Zobraziť menej' },
    en: { showMore: 'Show more photos', collapse: 'Show less' }
  },
  timeoutMs: 1500
};

/**
 * Celá zeď. Běží na e-shopu, takže uvnitř nesmí být nic z aplikace —
 * dostane jen adresu dat, záložní kopii a nastavení.
 */
function wall(SOURCE: string, FALLBACK: WallItem[], CONFIG: WallConfig): void {
  'use strict';

  function detectLanguage(): string {
    const h = (location.hostname || '').toLowerCase();
    for (const s of Object.keys(CONFIG.langMap)) {
      if (h.endsWith(s)) return CONFIG.langMap[s];
    }
    return CONFIG.defaultLang;
  }

  function shuffleArray<T>(arr: T[]): T[] {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function getCols(): number {
    return window.innerWidth <= 600 ? CONFIG.colsMobile : CONFIG.colsDesktop;
  }

  function getPageBg(): string {
    const els = [document.body, document.documentElement];
    for (let i = 0; i < els.length; i++) {
      const bg = window.getComputedStyle(els[i]).backgroundColor;
      if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg;
    }
    return '#ffffff';
  }

  function injectStyles(): void {
    if (document.getElementById('q-gs-v5')) return;
    const s = document.createElement('style');
    s.id = 'q-gs-v5';
    s.textContent = [
      '#q-wall-wrap { position: relative; }',
      '#q-wall { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px;',
      '  background: transparent; overflow: hidden;',
      '  transition: max-height 0.7s cubic-bezier(0.4,0,0.2,1); }',
      '@media (max-width: 600px) { #q-wall { grid-template-columns: repeat(2,1fr); gap: 8px; } }',
      '.q-card-v5 { background: #fff; display: block; animation: qFadeUp5 0.4s ease both; }',
      '.q-card-v5 img { width: 100%; height: auto; display: block; aspect-ratio: 1/1; object-fit: cover; }',
      '@keyframes qFadeUp5 { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }',
      '#q-fo-v5 { position: absolute; bottom: 0; left: 0; right: 0; pointer-events: none; z-index: 2;',
      '  transition: opacity 0.35s ease; display: flex; align-items: flex-end; justify-content: center; }',
      '#q-fo-v5.q-exp { opacity: 0; pointer-events: none !important; }',
      '#q-btn-sm5 { pointer-events: auto; position: absolute; left: 50%; transform: translateX(-50%);',
      '  padding: 13px 36px; background: #111 !important; color: #fff !important; border: none !important;',
      '  border-radius: 2px; font-family: inherit; font-size: 12px; letter-spacing: 0.12em;',
      '  text-transform: uppercase; cursor: pointer; white-space: nowrap;',
      '  -webkit-appearance: none; appearance: none; transition: background 0.2s; }',
      '#q-btn-sm5:hover { background: #333 !important; }',
      '#q-btn-col5 { display: none; margin: 20px auto 0; padding: 13px 36px;',
      '  background: #111 !important; color: #fff !important; border: none !important;',
      '  border-radius: 2px; font-family: inherit; font-size: 12px; letter-spacing: 0.12em;',
      '  text-transform: uppercase; cursor: pointer; white-space: nowrap;',
      '  -webkit-appearance: none; appearance: none; transition: background 0.2s; }',
      '#q-btn-col5:hover { background: #333 !important; }',
      '#q-btn-col5.q-vis { display: block; }'
    ].join('\n');
    document.head.appendChild(s);
  }

  let DATA: WallItem[] = FALLBACK;
  let expanded = false;
  let initialized = false;

  function renderGallery(): void {
    const container = document.getElementById(CONFIG.containerId);
    if (!container) return;
    // Rozbalenou zeď nemá smysl překreslovat — zamíchala by se před očima
    if (initialized && expanded) return;

    initialized = true;
    expanded = false;

    const lang = detectLanguage();
    const labels = CONFIG.labels[lang] || CONFIG.labels[CONFIG.defaultLang];
    const items = shuffleArray(DATA).slice(0, CONFIG.maxCards);
    const initialCount = CONFIG.initialRows * getCols();
    const hasMore = items.length > initialCount;

    let wrap = document.getElementById('q-wall-wrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'q-wall-wrap';
      container.parentNode!.insertBefore(wrap, container);
      wrap.appendChild(container);
    }

    const frag = document.createDocumentFragment();
    items.forEach(function (item, i) {
      const t = item[lang] || item[CONFIG.defaultLang] || {};
      const card = document.createElement('div');
      card.className = 'q-card-v5';
      card.style.animationDelay = (Math.min(i, initialCount - 1) * 0.04) + 's';

      const img = document.createElement('img');
      img.loading = 'lazy';
      img.decoding = 'async';
      img.src = item.img;
      img.alt = item.alt || '';
      if (item.w) img.width = item.w;
      if (item.h) img.height = item.h;
      card.appendChild(img);

      const cap = document.createElement('p');
      cap.className = 'q-cap';
      cap.innerHTML = t.captionHtml || '';
      card.appendChild(cap);

      if (t.reviewText && t.reviewName) {
        const rev = document.createElement('div');
        rev.className = 'q-review';
        const rt = document.createElement('p');
        rt.className = 'q-review-text';
        rt.textContent = t.reviewText;
        const rn = document.createElement('p');
        rn.className = 'q-review-name';
        rn.textContent = t.reviewName;
        rev.appendChild(rt);
        rev.appendChild(rn);
        card.appendChild(rev);
      }
      frag.appendChild(card);
    });

    container.innerHTML = '';
    container.appendChild(frag);

    if (!hasMore) return;

    let overlay = document.getElementById('q-fo-v5');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'q-fo-v5';
      wrap.appendChild(overlay);
    }
    overlay.classList.remove('q-exp');
    overlay.innerHTML = '';

    const showBtn = document.createElement('button');
    showBtn.id = 'q-btn-sm5';
    showBtn.type = 'button';
    showBtn.textContent = labels.showMore;
    overlay.appendChild(showBtn);

    let colBtn = document.getElementById('q-btn-col5') as HTMLButtonElement | null;
    if (!colBtn) {
      colBtn = document.createElement('button');
      colBtn.id = 'q-btn-col5';
      colBtn.type = 'button';
      wrap.parentNode!.insertBefore(colBtn, wrap.nextSibling);
    }
    colBtn.textContent = labels.collapse;
    colBtn.classList.remove('q-vis');

    function applyCollapsed(): void {
      const cards = container!.querySelectorAll('.q-card-v5');
      if (!cards.length) return;

      const cols = getCols();
      const ic = CONFIG.initialRows * cols;
      const lastCard = cards[Math.min(ic, cards.length) - 1];
      const wrapRect = wrap!.getBoundingClientRect();
      const lastRect = lastCard.getBoundingClientRect();
      const collapsedH = lastRect.bottom - wrapRect.top;

      const firstImg = cards[0].querySelector('img');
      const rowH = firstImg ? firstImg.getBoundingClientRect().height : lastRect.height * 0.7;

      // Závoj přes poslední řadu: začíná uprostřed fotky, dole je plná barva stránky
      const overlayH = Math.round(rowH * (window.innerWidth <= 600 ? 2.15 : 1.5));
      overlay!.style.height = overlayH + 'px';
      overlay!.style.background = 'linear-gradient(to bottom, transparent 0%, ' + getPageBg() + ' 50%)';

      showBtn.style.top = 'auto';
      showBtn.style.bottom = '110px';

      container!.style.maxHeight = collapsedH + 'px';
    }

    requestAnimationFrame(function () { requestAnimationFrame(applyCollapsed); });

    showBtn.onclick = function () {
      if (expanded) return;
      expanded = true;
      container.style.maxHeight = container.scrollHeight + 'px';
      overlay!.classList.add('q-exp');
      colBtn!.classList.add('q-vis');
      container.addEventListener('transitionend', function onEnd(e) {
        if (e.target !== container) return;
        container.removeEventListener('transitionend', onEnd);
        container.style.maxHeight = 'none';
      });
    };

    colBtn.onclick = function () {
      if (!expanded) return;
      expanded = false;
      colBtn!.classList.remove('q-vis');
      container.style.maxHeight = container.scrollHeight + 'px';
      requestAnimationFrame(function () {
        overlay!.classList.remove('q-exp');
        applyCollapsed();
      });
      wrap!.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };

    let resizeTimer: any;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () { if (!expanded) applyCollapsed(); }, 200);
    });

    if (!('loading' in HTMLImageElement.prototype)) {
      const lazy = container.querySelectorAll('img[loading="lazy"]');
      for (let i = 0; i < lazy.length; i++) lazy[i].removeAttribute('loading');
    }
  }

  /**
   * Recenze ze Supabase.
   *
   * Poslední úspěšně stažená sada se schovává do `localStorage`. Když
   * Supabase vypadne, je pořád čerstvější než kopie zapečená ve skriptu —
   * a hlavně na ni nemá vliv, jak dávno se skript na e-shop vkládal.
   */
  function load(): Promise<WallItem[]> {
    const CACHE = 'q-wall-cache';
    const cached = (function () {
      try {
        const raw = localStorage.getItem(CACHE);
        const parsed = raw ? JSON.parse(raw) : null;
        return parsed && Array.isArray(parsed.items) && parsed.items.length ? parsed.items : null;
      } catch (e) { return null; }
    })();

    if (!SOURCE) return Promise.resolve(cached || FALLBACK);

    const timeout = new Promise<WallItem[] | null>(function (done) {
      setTimeout(function () { done(null); }, CONFIG.timeoutMs);
    });

    const fresh = fetch(SOURCE, { credentials: 'omit' })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data || !Array.isArray(data.items) || data.items.length === 0) return null;
        try { localStorage.setItem(CACHE, JSON.stringify({ items: data.items })); } catch (e) { /* plná paměť */ }
        return data.items as WallItem[];
      })
      .catch(function () { return null; });

    return Promise.race([fresh, timeout]).then(function (items) {
      return items || cached || FALLBACK;
    });
  }

  function init(): void {
    injectStyles();
    load().then(function (items) {
      DATA = items;
      renderGallery();
      (window as any).__qCollageRender = renderGallery;
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // Návrat tlačítkem zpět: znovu se vykresluje jen sbalená zeď
  window.addEventListener('pageshow', function (e) {
    if (e.persisted && !expanded) {
      initialized = false;
      renderGallery();
    }
  });
}

/**
 * Složí skript pro vložení do e-shopu.
 *
 * Data se **nevkládají jako hlavní zdroj**, jen jako záloha: skript si je
 * stáhne ze Supabase, takže změna recenze znamená publikovat z aplikace,
 * ne znovu přepisovat skript na e-shopu.
 *
 * `</` v datech se rozděluje schválně — jinak by libovolné `</script>`
 * v textu recenze ukončilo celý blok dřív, než začne.
 */
export function reviewsScript(source: string, fallback: WallItem[], config = DEFAULT_WALL): string {
  const data = JSON.stringify(fallback).replace(/<\//g, '<\\/');
  return [
    '<script defer>',
    '(' + String(wall) + ')(',
    JSON.stringify(source) + ',',
    data + ',',
    JSON.stringify(config),
    ');',
    '<\/script>'
  ].join('\n');
}

export const __test = { wall, reviewsScript };
