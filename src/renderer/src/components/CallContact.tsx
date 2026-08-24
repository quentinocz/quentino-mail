import { useEffect, useState } from 'react';
import type { OrderContact } from '@shared/types';
import { api } from '../api';
import { useIsPhone } from '../mobile';
import Icon from './Icon';
import { useToast } from '../toast';

/**
 * Telefon na zákazníka — a na mobilu rovnou tlačítko, kterým se vytočí.
 *
 * Zákazník píše z e-mailu nebo se v chatu představí číslem objednávky.
 * V obou případech je v feedu objednávek celý kontakt včetně telefonu, jen
 * ho do téhle chvíle nikdo nedohledával — člověk musel přepnout do
 * administrace, najít objednávku a číslo si opsat. Tenhle kousek to udělá
 * sám a na telefonu z toho udělá jedno klepnutí.
 *
 * Proč se to na počítači a na mobilu chová jinak: z počítače se volat nedá,
 * takže tam dává smysl číslo **ukázat** a nabídnout zkopírování. Na telefonu
 * je naopak zbytečné číslo číst — chce se rovnou volat.
 *
 * Hledá se v tomhle pořadí a proto: číslo objednávky je jednoznačné, e-mail
 * skoro vždycky, číslo zmíněné v textu zprávy je poslední záchrana pro
 * případ, kdy zákazník píše z jiné adresy, než na kterou objednával.
 */
/** Číslo po trojicích — přečíst „+420 607 043 067" jde, „+420607043067" ne. */
function pretty(phone: string): string {
  const match = phone.match(/^(\+\d{1,3})(\d+)$/);
  if (!match) return phone;
  return `${match[1]} ${match[2].replace(/(\d{3})(?=\d)/g, '$1 ')}`.trim();
}

export default function CallContact({ email, orderCode, text, compact }: {
  email?: string | null;
  orderCode?: string | null;
  /** Text zprávy — hledá se v něm číslo objednávky, když jinak není za co chytit */
  text?: string | null;
  /** Do řádku mezi ostatní údaje, ne jako samostatný blok */
  compact?: boolean;
}) {
  const phone = useIsPhone();
  const toast = useToast();
  const [contact, setContact] = useState<OrderContact | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!email && !orderCode && !text) { setContact(null); return; }
    api.orders.contact({ email: email ?? undefined, orderCode: orderCode ?? undefined, text: text ?? undefined })
      .then(found => { if (!cancelled) setContact(found); })
      // Chybějící feed objednávek nesmí nic rozbít — kontakt se prostě nezobrazí
      .catch(() => { if (!cancelled) setContact(null); });
    return () => { cancelled = true; };
  }, [email, orderCode, text]);

  if (!contact?.phone) return null;

  const call = () => api.shell.openUrl(`tel:${contact.phone}`);
  const copy = async () => {
    await navigator.clipboard.writeText(contact.phone);
    setCopied(true);
    toast('Číslo zkopírováno');
    setTimeout(() => setCopied(false), 1600);
  };

  // Velké tlačítko patří na telefonu na jedno místo — nahoru k zákazníkovi.
  // Když je karta objednávky pod ním, opakovalo by se to o kus níž znovu
  // a obrazovka by vypadala jako dvě výzvy k témuž. `compact` proto i na
  // telefonu vypíše jen číslo, na které jde klepnout.
  if (phone && !compact) {
    return (
      <button className={`call-btn ${compact ? 'compact' : ''}`} onClick={call}>
        <Icon name="phone" size={15} />
        <span>
          {/* Jen „Zavolat", bez jména — česky by muselo být ve 3. pádě
              („Zavolat Janě") a skloňovat cizí jména strojově se nedá. */}
          <b>Zavolat</b>
          {/* Jméno se do popisku nedává — tam, kde tlačítko stojí, je vidět
              hned nad ním a dvakrát být nemusí. */}
          <small>{pretty(contact.phone)}{contact.via ? ` · ${contact.via}` : ''}</small>
        </span>
      </button>
    );
  }

  return (
    <span className={`call-line ${compact ? 'compact' : ''} ${phone ? 'tappable' : ''}`}>
      <Icon name="phone" size={12} />
      <a href={`tel:${contact.phone}`} onClick={e => { e.preventDefault(); call(); }}>{pretty(contact.phone)}</a>
      {/* Kopírování dává smysl u počítače; na telefonu se rovnou volá */}
      {!phone && (
        <button className="icon-btn" data-tip={copied ? 'Zkopírováno' : 'Kopírovat číslo'} onClick={copy}>
          <Icon name={copied ? 'check' : 'copy'} size={12} />
        </button>
      )}
      {contact.via && !phone && <span className="ig-muted">{contact.via}</span>}
    </span>
  );
}
