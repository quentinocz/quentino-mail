import { useEffect, useRef, useState } from 'react';
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
 *
 * ## Proč stránka přichází adresou, a ne jako text
 *
 * Kód vložený přímo ve stránce okno aplikace spustit nesmí — má
 * `script-src 'self'` a to platí i pro rámeček vložený přes `srcdoc`,
 * protože ten dědí pravidla svého rodiče. Náhled proto zůstával prázdný
 * v aplikaci, zatímco na webu bannery běžely. Stránku teď vydává hlavní
 * proces na vlastní adrese (`qbnahled://…`), která si nese svá pravidla.
 */

export type PreviewDevice = 'pc' | 'tablet' | 'phone';

const WIDTHS: Record<PreviewDevice, number> = { pc: 1240, tablet: 820, phone: 390 };

export default function BannerPreview({ set, device, lang }: {
  set: BannerSet;
  device: PreviewDevice;
  lang: 'cz' | 'sk' | 'en';
}) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [height, setHeight] = useState(460);
  const [room, setRoom] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);

  /*
   * Stránka se nepřestavuje po každém písmenu. Sestavit ji znamená projít
   * celou sadu v hlavním procesu a rámeček se pak celý načte znovu — při
   * psaní nadpisu by to blikalo tolikrát, kolik je v něm písmen.
   */
  const stamp = JSON.stringify(set);
  useEffect(() => {
    const timer = setTimeout(() => {
      api.banners.preview(set, lang)
        .then(one => { setUrl(one); setError(''); })
        .catch(e => setError(String(e?.message ?? e)));
    }, 320);
    return () => clearTimeout(timer);
  }, [stamp, lang]);

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
      if (Number.isFinite(value) && value > 40) setHeight(Math.min(1600, value));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const width = WIDTHS[device];
  // Zmenšuje se jen dolů: náhled telefonu v širokém okně nemá co zvětšovat
  const scale = room > 0 ? Math.min(1, room / width) : 1;

  return (
    <div className="bn-preview" ref={box}>
      {url && !error ? (
        <div className="bn-stage" style={{ height: Math.round(height * scale) }}>
          <iframe
            ref={frame}
            className="bn-frame"
            title="Náhled bannerů"
            /*
             * Skript uvnitř je náš vlastní, ale na aplikaci dosáhnout nemá.
             * `allow-same-origin` tu schází schválně — stránka si vystačí
             * sama a bez něj se k oknu aplikace nedostane.
             */
            sandbox="allow-scripts"
            src={url}
            style={{
              width,
              height,
              transform: `scale(${scale})`,
              transformOrigin: 'top left'
            }}
          />
        </div>
      ) : (
        <div className="bn-stage empty">
          <span className="desc">{error || 'Náhled se připravuje…'}</span>
        </div>
      )}
      <p className="desc bn-scale">
        {device === 'pc' ? 'Počítač' : device === 'tablet' ? 'Tablet' : 'Telefon'} · {width} px
        {scale < 1 ? ` · zmenšeno na ${Math.round(scale * 100)} %` : ''}
      </p>
    </div>
  );
}
