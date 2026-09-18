import { useEffect, useState } from 'react';
import { api } from '../api';
import type { ToolWindowId } from '@shared/windows';
import ShootModal from './ShootModal';
import CatalogModal from './CatalogModal';
import PackingModal from './PackingModal';
import DigestModal from './DigestModal';
import ProductsModal from './ProductsModal';
import ArticlesModal from './ArticlesModal';
import WebTextsModal from './WebTextsModal';
import MediaModal from './MediaModal';
import ReviewsModal from './ReviewsModal';

/**
 * Obsah okna nástroje.
 *
 * Nástroje zůstaly, jak byly — jsou to pořád tytéž překryvy, jen mají místo
 * okna aplikace pod sebou okno vlastní. Přepisovat každý z nich na „okenní"
 * podobu by znamenalo devět velkých zásahů do hotových věcí; takhle se mění
 * jen to, co je kolem: zavření zavře okno a odkaz do pošty přepne do
 * hlavního okna, protože pošta v tomhle okně není.
 *
 * Vzhled dořeší styl `okno-nastroje` na `body`: první překryv v okně se
 * roztáhne přes celou plochu a ztratí ztmavení a stín, protože pod ním
 * není co ztmavovat. Vnořené dialogy uvnitř nástroje zůstávají plovoucí.
 */
export default function ToolWindow({ id }: { id: ToolWindowId }) {
  /** Na co se má okno rovnou podívat — objednávka k zabalení, naskladnění */
  const [arg, setArg] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    document.body.classList.add('okno-nastroje');
    /*
     * Vzhled si nastavuje hlavní okno podle nastavení; tohle okno hlavní
     * část aplikace nevykresluje, takže by v tmavém režimu svítilo bíle.
     */
    api.settings.get()
      .then(one => { document.documentElement.dataset.theme = one?.theme ?? 'light'; })
      .catch(() => {});
    /*
     * Než se nástroj vykreslí, musí být jasné, na co se má dívat. Kdyby se
     * vykreslil hned a číslo objednávky dorazilo až pak, otevřel by se
     * nejdřív seznam a teprve po chvilce by přeskočil — a to vypadá jako
     * překlep v ovládání.
     */
    api.tool.arg(id)
      .then(value => { setArg(value || null); setReady(true); })
      .catch(() => setReady(true));
    // Okno už běží a přišel další požadavek — třeba druhá rozdělaná práce
    return api.on('tool:look', (p: any) => {
      if (p?.id === id && p?.arg) setArg(String(p.arg));
    });
  }, [id]);

  const close = () => window.close();
  /** Zpráva i konverzace jsou v hlavním okně; sem se jen řekne, co otevřít */
  const goto = (kind: 'message' | 'chat', target: string | number) => {
    api.tool.goto(kind, target).catch(() => {});
  };

  if (!ready) return null;

  switch (id) {
    case 'shoot':
      return <ShootModal standalone onClose={close} />;
    case 'catalog':
      return <CatalogModal openStockin={arg} onClose={close} />;
    case 'packing':
      return (
        <PackingModal openOrder={arg} onClose={close}
          onOpenMessage={messageId => goto('message', messageId)} />
      );
    case 'digest':
      return (
        <DigestModal onClose={close}
          onOpenMessage={messageId => goto('message', messageId)}
          onOpenChat={chatId => goto('chat', chatId)} />
      );
    case 'ptrans':
      return <ProductsModal onClose={close} />;
    case 'articles':
      return <ArticlesModal onClose={close} />;
    case 'webtexts':
      return <WebTextsModal onClose={close} />;
    case 'media':
      return <MediaModal onClose={close} />;
    case 'reviews':
      return <ReviewsModal onClose={close} />;
    default:
      return null;
  }
}
