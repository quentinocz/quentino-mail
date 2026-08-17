import { useEffect, useMemo, useState } from 'react';
import type { VoucherSpec, MailLang } from '@shared/types';
import { api } from '../api';
import { useToast } from '../toast';
import Icon from './Icon';

/**
 * Vytvoření dárkových poukazů do přílohy.
 *
 * Kódy se zadávají jako seznam — na každý vznikne samostatné PDF se stejnou
 * hodnotou, protože poukazy se běžně rozdávají po několika najednou. Jazyk
 * určuje i doménu vytištěnou na poukazu, aby slovenský zákazník nedostal
 * odkaz na českou verzi obchodu.
 */

const LANGS: { id: MailLang; label: string; domain: string }[] = [
  { id: 'cz', label: 'Česky', domain: 'quentino.cz' },
  { id: 'sk', label: 'Slovensky', domain: 'quentino.sk' },
  { id: 'en', label: 'English', domain: 'wearquentino.com' }
];

const UNITS: { id: VoucherSpec['unit']; label: string }[] = [
  { id: 'CZK', label: 'Kč' },
  { id: 'EUR', label: '€' },
  { id: 'percent', label: '%' },
  { id: 'shipping', label: 'doprava' }
];

const SHIPPING_TEXT: Record<MailLang, string> = {
  cz: 'Doprava zdarma', sk: 'Doprava zadarmo', en: 'Free shipping'
};

/** Datum o rok dopředu jako rozumný výchozí stav */
function defaultValidity(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

interface Props {
  onClose: () => void;
  onCreated: (files: string[]) => void;
}

export default function VoucherDialog({ onClose, onCreated }: Props) {
  const toast = useToast();
  const [codes, setCodes] = useState('');
  const [value, setValue] = useState('1000');
  const [unit, setUnit] = useState<VoucherSpec['unit']>('CZK');
  const [validUntil, setValidUntil] = useState(defaultValidity());
  const [lang, setLang] = useState<MailLang>('cz');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'create' | 'preview' | null>(null);

  const codeList = useMemo(
    () => codes.split(/[\s,;]+/).map(c => c.trim()).filter(Boolean),
    [codes]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const validate = () => {
    if (codeList.length === 0) { toast('Zadej alespoň jeden kód poukazu.', 'error'); return false; }
    if (unit !== 'shipping' && !value.trim()) { toast('Zadej hodnotu poukazu.', 'error'); return false; }
    return true;
  };

  const spec = (): VoucherSpec => ({ codes: codeList, value, unit, validUntil, lang, note });

  const create = async () => {
    if (!validate()) return;
    setBusy('create');
    try {
      const files = await api.voucher.create(spec());
      onCreated(files);
      toast(files.length === 1 ? 'Poukaz přiložen.' : `${files.length} poukazů přiloženo.`);
      onClose();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(null);
    }
  };

  /** Vysází první kód a otevře PDF v prohlížeči — kontrola před přiložením. */
  const preview = async () => {
    if (!validate()) return;
    setBusy('preview');
    try {
      const files = await api.voucher.create({ ...spec(), codes: [codeList[0]] });
      if (files[0]) await api.files.openAttachment(files[0]);
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const shownValue = unit === 'shipping'
    ? SHIPPING_TEXT[lang]
    : unit === 'percent'
      ? `${value || '0'} %`
      : `${value || '0'} ${unit === 'EUR' ? '€' : 'Kč'}`;

  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal" style={{ width: 'min(560px, 94vw)' }}>
        <div className="modal-head">
          <span className="modal-title"><Icon name="card" size={15} /> Dárkový poukaz</span>
          <button className="icon-btn" onClick={onClose} disabled={!!busy}><Icon name="x" size={16} /></button>
        </div>

        <div className="modal-body">
          <div className="field">
            <label>Kódy poukazů</label>
            <textarea rows={3} value={codes} onChange={e => setCodes(e.target.value)}
              placeholder="6ds6myr7zx&#10;nebo více kódů oddělených mezerou, čárkou či na samostatných řádcích" />
            <div className="desc">
              {codeList.length === 0
                ? 'Na každý kód vznikne samostatné PDF se stejnou hodnotou.'
                : `Vytvoří se ${codeList.length} ${codeList.length === 1 ? 'poukaz' : codeList.length < 5 ? 'poukazy' : 'poukazů'}: ${codeList.join(', ')}`}
            </div>
          </div>

          <div className="field-grid">
            <div className="field">
              <label>Hodnota</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <input value={unit === 'shipping' ? SHIPPING_TEXT[lang] : value}
                  onChange={e => setValue(e.target.value)}
                  disabled={unit === 'shipping'} inputMode="decimal" />
                <div className="lang-switch" style={{ flexShrink: 0 }}>
                  {UNITS.map(u => (
                    <button key={u.id} className={`lang-btn ${unit === u.id ? 'active' : ''}`}
                      onClick={() => setUnit(u.id)}>{u.label}</button>
                  ))}
                </div>
              </div>
            </div>
            <div className="field">
              <label>Platnost do</label>
              <input type="date" value={validUntil} onChange={e => setValidUntil(e.target.value)} />
            </div>
          </div>

          <div className="field">
            <label>Jazyk poukazu</label>
            <div className="lang-switch" style={{ alignSelf: 'flex-start' }}>
              {LANGS.map(l => (
                <button key={l.id} className={`lang-btn ${lang === l.id ? 'active' : ''}`}
                  onClick={() => setLang(l.id)}>{l.label}</button>
              ))}
            </div>
            <div className="desc">Na poukaz se vytiskne odpovídající doména — {LANGS.find(l => l.id === lang)!.domain}.</div>
          </div>

          <div className="field">
            <label>Poznámka na poukazu (nepovinné)</label>
            <input value={note} onChange={e => setNote(e.target.value)}
              placeholder="např. Platí při nákupu nad 1 500 Kč, nelze směnit za hotovost" />
          </div>

          <div className="vch-preview">
            <div className="vch-pv-eyebrow">
              {lang === 'en' ? 'Premium men’s accessories' : 'Prémiové pánské doplňky'}
              <span>Quentino</span>
            </div>
            <div className="vch-pv-title">
              {lang === 'sk' ? 'Darčekový poukaz' : lang === 'en' ? 'Gift voucher' : 'Dárkový poukaz'}
            </div>
            <div className="vch-pv-row">
              <div className="vch-pv-value" style={unit === 'shipping' ? { fontSize: 21, lineHeight: 1.1 } : undefined}>{shownValue}</div>
              <div className="vch-pv-code">{codeList[0] ?? 'KÓD'}</div>
            </div>
            <div className="vch-pv-foot">
              <span style={{ letterSpacing: '0.06em', color: 'rgba(255,255,255,0.62)' }}>
                {validUntil ? `${lang === 'en' ? 'Valid until' : 'Platný do'} ${new Date(validUntil).toLocaleDateString(lang === 'en' ? 'en-GB' : 'cs-CZ')}` : ''}
              </span>
              <span>{LANGS.find(l => l.id === lang)!.domain}</span>
            </div>
          </div>
        </div>

        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose} disabled={!!busy}>Zrušit</button>
          <span style={{ flex: 1 }} />
          <button className="btn ghost" onClick={preview} disabled={!!busy || codeList.length === 0}
            data-tip="Vysází první kód a otevře PDF, aniž by se přiložilo k e-mailu">
            {busy === 'preview' ? <span className="spinner-inline" /> : <Icon name="eye" size={13} />} Náhled PDF
          </button>
          <button className="btn primary" onClick={create} disabled={!!busy || codeList.length === 0}>
            {busy === 'create' ? <span className="spinner-inline" /> : <Icon name="paperclip" size={13} />}
            {codeList.length > 1 ? ` Vytvořit a přiložit (${codeList.length})` : ' Vytvořit a přiložit'}
          </button>
        </div>
      </div>
    </div>
  );
}
