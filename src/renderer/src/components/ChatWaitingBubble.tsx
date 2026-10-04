import { useEffect, useState } from 'react';
import type { ChatWaiting } from '@shared/types';
import Icon from './Icon';

/**
 * Upozornění, že zákazník čeká na odpověď.
 *
 * ## Proč nestačí odznak s nepřečtenými
 *
 * Odznak počítá **nepřečtené** zprávy. Jenže zprávu stačí otevřít a
 * nechat ji ležet — odznak zhasne a od té chvíle nic nepřipomíná, že
 * na druhé straně pořád někdo čeká. Tohle počítá něco jiného:
 * **otevřené rozhovory, kde poslední slovo má zákazník**. Zhasne to
 * teprve odpovědí nebo uzavřením rozhovoru, ne přečtením.
 *
 * ## Proč bublina a ne jen číslo
 *
 * Číslo u tlačítka se dá přehlédnout a nic neříká o tom, jak dlouho se
 * čeká. Hodina ticha u dotazu na dostupnost je ztracená objednávka, a
 * právě tohle má být vidět bez hledání. Bublina se dá zavřít, ale
 * vrátí se, jakmile přibude další čekající nebo se čekání prodlouží
 * o dalšího půl hodiny — není to oznámení, které se jednou odbude.
 */
export default function ChatWaitingBubble({ ceka, onOpen }: {
  ceka: ChatWaiting | null;
  onOpen: () => void;
}) {
  const [skryto, setSkryto] = useState<{ pocet: number; minut: number } | null>(null);

  const pocet = ceka?.pocet ?? 0;
  const minut = ceka?.minut ?? 0;

  /* Vrátí se, když přibude čekající nebo čekání vydrží o půl hodiny dýl */
  useEffect(() => {
    if (!skryto) return;
    if (pocet > skryto.pocet || minut >= skryto.minut + 30) setSkryto(null);
  }, [pocet, minut, skryto]);

  if (pocet === 0 || skryto) return null;

  const kdo = (ceka?.jmena ?? []).filter(Boolean);
  const dobu = minut < 1 ? 'právě teď'
    : minut < 60 ? `${minut} min`
      : `${Math.floor(minut / 60)} h ${minut % 60} min`;

  return (
    <div className={`chw ${minut >= 30 ? 'dlouho' : ''}`} role="status">
      <span className="chw-tecka" aria-hidden="true" />
      <div className="chw-text">
        <b>
          {pocet === 1 ? 'Zákazník čeká na odpověď' : `${pocet} zákazníci čekají na odpověď`}
        </b>
        <span>
          {pocet === 1 && kdo[0] ? `${kdo[0]} — ` : ''}
          {minut < 1 ? 'nová zpráva' : `nejdéle ${dobu}`}
        </span>
      </div>
      <button className="chw-open" onClick={onOpen}>Odpovědět</button>
      <button className="chw-x" onClick={() => setSkryto({ pocet, minut })}
        aria-label="Skrýt upozornění" data-tip="Skrýt — vrátí se, až přibude další nebo se čekání protáhne">
        <Icon name="x" size={12} />
      </button>
    </div>
  );
}
