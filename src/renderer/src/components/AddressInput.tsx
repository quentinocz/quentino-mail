import { useEffect, useRef, useState } from 'react';
import type { ContactHit } from '@shared/types';
import { api } from '../api';

interface Props {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}

/**
 * Pole pro adresy s našeptávačem známých kontaktů (historie přijaté i odeslané pošty).
 * Podporuje více adres oddělených čárkou — napovídá vždy k poslední rozepsané.
 */
export default function AddressInput({ value, onChange, placeholder }: Props) {
  const [sug, setSug] = useState<ContactHit[]>([]);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const lastToken = (v: string) => v.split(',').pop()!.trim();

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const token = lastToken(value);
    if (token.length < 1) { setOpen(false); return; }
    timer.current = setTimeout(async () => {
      try {
        const hits = await api.contacts.search(token);
        // nenabízet adresy, které už v poli jsou
        const used = value.toLowerCase();
        const fresh = hits.filter(h => !used.includes(h.email.toLowerCase()) || lastToken(value).toLowerCase() === h.email.toLowerCase());
        setSug(fresh);
        setHi(0);
        setOpen(fresh.length > 0 && fresh[0].email !== token.toLowerCase());
      } catch {
        setOpen(false);
      }
    }, 150);
  }, [value]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const pick = (c: ContactHit) => {
    const parts = value.split(',');
    parts[parts.length - 1] = ` ${c.email}`;
    onChange(parts.join(',').replace(/^ /, ''));
    setOpen(false);
  };

  return (
    <div className="addr-wrap" ref={wrapRef}>
      <input
        value={value}
        placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => {
          if (!open) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); setHi(h => Math.min(h + 1, sug.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(h => Math.max(h - 1, 0)); }
          else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(sug[hi]); }
          else if (e.key === 'Escape') setOpen(false);
        }}
      />
      {open && (
        <div className="addr-sug">
          {sug.map((c, i) => (
            <button key={c.email} className={`addr-item ${i === hi ? 'hi' : ''}`}
              onMouseEnter={() => setHi(i)} onClick={() => pick(c)}>
              <span className="addr-name">{c.name || c.email}</span>
              {c.name && <span className="addr-mail">{c.email}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
