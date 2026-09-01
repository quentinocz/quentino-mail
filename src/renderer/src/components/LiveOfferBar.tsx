import { useEffect, useState } from 'react';
import type { LiveOffer } from '@shared/types';
import { api } from '../api';
import Icon from './Icon';

/**
 * Proužek s rozdělanou prací z druhého zařízení.
 *
 * Když se u regálu začne naskladňovat nebo balit, počítač o tom má vědět —
 * ale **vnucovat se nesmí**. Na obrazovce může být rozepsaná odpověď
 * zákazníkovi nebo běžící překlad a vyskočit přes to celým oknem jen proto,
 * že někdo pípnul čtečkou, by bylo horší než nic; a když je počítačů víc,
 * vyskočilo by to na všech naráz.
 *
 * Proto je to nabídka, ne příkaz: data už jsou uložená, proužek jen říká,
 * že se dá pokračovat tady, a otevře se, teprve když na něj někdo klepne.
 * Vypadá schválně stejně jako proužek běžícího překladu — je to totéž
 * sdělení („na pozadí se něco děje") a učit se dvě podoby téhož by bylo
 * zbytečné.
 *
 * Zavřít se dá i bez otevření. Nabídka se pak vrátí, až přijde další změna
 * — kdo naskladňuje dál, o proužek nepřijde, kdo skončil, má klid.
 */
export default function LiveOfferBar({ hidden, onOpen }: {
  /** Když je příslušné okno otevřené, proužek nemá co nabízet */
  hidden?: boolean;
  onOpen: (offer: LiveOffer) => void;
}) {
  const [offers, setOffers] = useState<LiveOffer[]>([]);

  useEffect(() => {
    // Aplikace mohla naskočit doprostřed práce — stav se zjistí dotazem
    api.live.offers().then(setOffers).catch(() => {});
    return api.on('live:offers', (list: LiveOffer[]) => setOffers(list ?? []));
  }, []);

  // Ukazuje se jen ta nejčerstvější. Dvě věci naráz se u regálu nedělají
  // a dva proužky nad sebou by braly místo obsahu.
  const one = offers[0];
  if (!one || hidden) return null;

  return (
    <div className="pt-statusbar live-offer">
      <span className="pt-status-ico">
        <Icon name={one.kind === 'stockin' ? 'bag' : 'truck'} size={14} />
      </span>
      <div className="pt-status-text">
        <b>{one.title}</b>
        <small>{one.detail}{one.from ? ` · ${one.from}` : ''}</small>
      </div>
      <span style={{ flex: 1 }} />
      <button className="btn primary" onClick={() => { api.live.dismiss(one.key); onOpen(one); }}>
        <Icon name="expand" size={13} /> Pokračovat tady
      </button>
      <button className="btn ghost" onClick={() => api.live.dismiss(one.key).then(setOffers)}>
        <Icon name="x" size={12} /> Skrýt
      </button>
    </div>
  );
}
