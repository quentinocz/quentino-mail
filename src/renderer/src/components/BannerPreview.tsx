import { useEffect, useMemo, useRef, useState } from 'react';
import type { BannerSet } from '@shared/types';
import { api } from '../api';

/**
 * Živý náhled bannerů.
 *
 * ## Proč to není vykreslené v Reactu
 *
 * Náhled, který kreslí něco jiného než web, je horší než žádný — člověk
 * podle něj rozhodne a na e-shopu to vypadá jinak. Tenhle proto **spouští
 * tentýž skript**, jaký se vkládá do šablony e-shopu, jen se mu místo
 * adresy plánu podstrčí rozepsaná sada. Odpočet tiká, rotace se točí,
 * emoji padají — a hlavně platí tytéž body zlomu a tytéž poměry stran.
 *
 * ## Proč rámeček, a ne jen úzký sloupec
 *
 * Rozvržení se přepíná mediálními dotazy, a ty se ptají na šířku **okna**,
 * ne prvku. Kdyby se náhled jen zúžil, ukazoval by pořád verzi pro počítač.
 * V rámečku je šířka skutečná: telefon je opravdu 390 px široký a zmenší
 * se až obrazem, takže je vidět přesně to, co uvidí zákazník.
 */

export type PreviewDevice = 'pc' | 'tablet' | 'phone';

const WIDTHS: Record<PreviewDevice, number> = { pc: 1240, tablet: 820, phone: 390 };

/**
 * Stránka kolem náhledu.
 *
 * Je tam schválně i prázdné `#banner1`: skript hledá místo původního
 * karuselu a schovává ho. Kdyby v náhledu nebylo, zkoušelo by se něco
 * jiného, než co poběží na webu — a nepoznalo by se, že vodítko přestalo
 * platit.
 */
function page(script: string, lang: string): string {
  return [
    '<!doctype html><html lang="cs"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<style>',
    'html,body{margin:0;background:#fff;color:#16161a;',
    "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif}",
    '.wrap{padding:18px}',
    '#banner1{padding:26px;border:1px dashed #d4d4d8;border-radius:12px;',
    'color:#9b9ba3;font-size:13px;text-align:center}',
    '</style>',
    `<script>window.__quentinoLang=${JSON.stringify(lang)}</script>`,
    script,
    '</head><body><div class="wrap"><div id="banner1">P&#367;vodn&#237; karusel Upgates</div></div>',
    /*
     * Výšku hlásí stránka sama. Hádat ji zvenčí nejde: mění se s počtem
     * bannerů, se zalomením textu i s tím, jestli se odpočet vejde na
     * jeden řádek — a špatný odhad by udělal v okně pruh prázdna.
     */
    '<script>(function(){function s(){try{parent.postMessage({qbn:document.documentElement.scrollHeight},"*")}catch(e){}}',
    'if(window.ResizeObserver)new ResizeObserver(s).observe(document.documentElement);',
    'setTimeout(s,60);setTimeout(s,450);setTimeout(s,1200);})()</script>',
    '</body></html>'
  ].join('');
}

export default function BannerPreview({ set, device, lang }: {
  set: BannerSet;
  device: PreviewDevice;
  lang: 'cz' | 'sk' | 'en';
}) {
  const [script, setScript] = useState('');
  const [height, setHeight] = useState(420);
  const [room, setRoom] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);

  /*
   * Skript se nepřekresluje po každém písmenu. Sestavit ho znamená projít
   * celou sadu v hlavním procesu a rámeček se pak celý nasadí znovu —
   * při psaní nadpisu by to blikalo tolikrát, kolik je v něm písmen.
   */
  const stamp = JSON.stringify(set);
  useEffect(() => {
    const timer = setTimeout(() => {
      api.banners.preview(set).then(setScript).catch(() => setScript(''));
    }, 320);
    return () => clearTimeout(timer);
  }, [stamp]);

  // Kolik je v okně místa — podle toho se náhled zmenší, ne ořízne
  useEffect(() => {
    const node = box.current;
    if (!node) return;
    const watch = new ResizeObserver(() => setRoom(node.clientWidth));
    watch.observe(node);
    setRoom(node.clientWidth);
    return () => watch.disconnect();
  }, []);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow) return;
      const value = Number((e.data as any)?.qbn);
      if (Number.isFinite(value) && value > 40) setHeight(Math.min(1400, value));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const width = WIDTHS[device];
  const srcDoc = useMemo(() => (script ? page(script, lang) : ''), [script, lang]);
  // Zmenšuje se jen dolů: náhled telefonu v širokém okně nemá co zvětšovat
  const scale = room > 0 ? Math.min(1, room / width) : 1;

  return (
    <div className="bn-preview" ref={box}>
      {srcDoc ? (
        <div className="bn-stage" style={{ height: Math.round(height * scale) }}>
          <iframe
            ref={frame}
            className="bn-frame"
            title="Náhled bannerů"
            // Skript uvnitř je náš vlastní, ale rámeček nemá mít nic jiného
            sandbox="allow-scripts"
            srcDoc={srcDoc}
            style={{
              width,
              height,
              transform: `scale(${scale})`,
              transformOrigin: 'top left'
            }}
          />
        </div>
      ) : (
        <div className="bn-stage empty"><span className="desc">Náhled se připravuje…</span></div>
      )}
      <p className="desc bn-scale">
        {device === 'pc' ? 'Počítač' : device === 'tablet' ? 'Tablet' : 'Telefon'} · {width} px
        {scale < 1 ? ` · zmenšeno na ${Math.round(scale * 100)} %` : ''}
      </p>
    </div>
  );
}
