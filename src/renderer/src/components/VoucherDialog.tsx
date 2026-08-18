import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MailLang, VoucherSpec, VoucherTemplate } from '@shared/types';
import { api } from '../api';
import { useToast } from '../toast';
import Icon from './Icon';

/**
 * Dárkové poukazy do přílohy.
 *
 * Nejčastější případ je „pošli poukaz podle šablony", proto dialog začíná
 * seznamem šablon a jedno kliknutí poukaz vysází i přiloží. Ruční poukaz
 * a správa šablon jsou o krok dál — vzácnější věci nemají zdržovat tu častou.
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

function valueLabel(t: { unit: VoucherSpec['unit']; value: string; lang: MailLang }): string {
  if (t.unit === 'shipping') return SHIPPING_TEXT[t.lang];
  if (t.unit === 'percent') return `${t.value || '0'} %`;
  return `${t.value || '0'} ${t.unit === 'EUR' ? '€' : 'Kč'}`;
}

function dateLabel(iso: string, lang: MailLang): string {
  if (!iso) return 'bez omezení';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(lang === 'en' ? 'en-GB' : 'cs-CZ');
}

interface Props {
  onClose: () => void;
  onCreated: (files: string[]) => void;
  /** Komu se poukaz posílá — zapíše se ke spotřebovanému kódu */
  recipient?: string;
  /** Jazyk rozepsaného e-mailu; předvyplní jazyk ručního poukazu */
  lang?: MailLang;
}

export default function VoucherDialog({ onClose, onCreated, recipient, lang: mailLang }: Props) {
  const toast = useToast();
  const [view, setView] = useState<'pick' | 'custom' | 'manage'>('pick');
  const [templates, setTemplates] = useState<VoucherTemplate[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setTemplates(await api.vouchers.list());
    } catch (e: any) {
      toast(e.message, 'error');
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  /** Jedno kliknutí: odebrat kód, vysázet PDF, přiložit, zavřít. */
  const useTemplate = async (t: VoucherTemplate) => {
    setBusy(t.id);
    try {
      const res = await api.vouchers.use(t.id, recipient ?? '');
      onCreated(res.files);
      toast(res.remaining >= 0
        ? `Poukaz ${res.code} přiložen — v zásobě zbývá ${res.remaining}.`
        : `Poukaz ${res.code} přiložen.`);
      onClose();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(null);
    }
  };

  /** Náhled zásobu kódů nespotřebuje — vysází se ukázkový kód. */
  const previewTemplate = async (t: VoucherTemplate) => {
    setBusy(`p-${t.id}`);
    try {
      const files = await api.voucher.create({
        codes: [t.codeMode === 'fixed' && t.fixedCode ? t.fixedCode : 'NÁHLED'],
        value: t.value, unit: t.unit, validUntil: t.validUntil, lang: t.lang, note: t.note
      });
      if (files[0]) await api.files.openAttachment(files[0]);
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal" style={{ width: 'min(620px, 94vw)' }}>
        <div className="modal-head">
          <span className="modal-title">
            <Icon name="card" size={15} />
            {view === 'manage' ? ' Šablony poukazů' : view === 'custom' ? ' Vlastní poukaz' : ' Dárkový poukaz'}
          </span>
          <button className="icon-btn" onClick={onClose} disabled={!!busy}><Icon name="x" size={16} /></button>
        </div>

        {view === 'pick' && (
          <>
            <div className="modal-body">
              {templates.length === 0 ? (
                <div className="empty-state" style={{ padding: '28px 10px' }}>
                  <div className="big">🎁</div>
                  <p>Zatím tu není žádná šablona.</p>
                  <p className="desc">Šablona si pamatuje hodnotu, platnost i kódy — pak stačí jedno kliknutí.</p>
                </div>
              ) : (
                <div className="vch-list">
                  {templates.map(t => {
                    const empty = t.codeMode === 'unique' && t.codesFree === 0;
                    return (
                      <div key={t.id} className={`vch-tpl ${empty ? 'empty' : ''}`}>
                        <button
                          className="vch-tpl-main"
                          disabled={!!busy || empty}
                          onClick={() => useTemplate(t)}
                          data-tip={empty ? 'Zásoba kódů je prázdná' : 'Vysází poukaz a přiloží ho k e-mailu'}
                        >
                          <span className="vch-tpl-value">{valueLabel(t)}</span>
                          <span className="vch-tpl-body">
                            <span className="vch-tpl-name">{t.name}</span>
                            <span className="vch-tpl-meta">
                              platí do {dateLabel(t.validUntil, t.lang)} · {LANGS.find(l => l.id === t.lang)?.label}
                              {t.codeMode === 'unique'
                                ? ` · ${t.codesFree} z ${t.codesTotal} kódů volných`
                                : ` · kód ${t.fixedCode || '—'}`}
                            </span>
                          </span>
                          {busy === t.id
                            ? <span className="spinner-inline" />
                            : <span className="vch-tpl-cta">Přiložit</span>}
                        </button>
                        <button className="icon-btn" disabled={!!busy} onClick={() => previewTemplate(t)}
                          data-tip="Náhled PDF — zásobu kódů nespotřebuje">
                          {busy === `p-${t.id}` ? <span className="spinner-inline" /> : <Icon name="eye" size={15} />}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="modal-foot">
              <button className="btn ghost" onClick={() => setView('manage')}>
                <Icon name="settings" size={13} /> Spravovat šablony
              </button>
              <span style={{ flex: 1 }} />
              <button className="btn ghost" onClick={onClose}>Zrušit</button>
              <button className="btn primary" onClick={() => setView('custom')}>
                <Icon name="pen" size={13} /> Vlastní poukaz
              </button>
            </div>
          </>
        )}

        {view === 'custom' && (
          <CustomVoucher
            lang={mailLang ?? 'cz'}
            onBack={() => setView('pick')}
            onClose={onClose}
            onCreated={onCreated}
          />
        )}

        {view === 'manage' && (
          <TemplateManager
            templates={templates}
            onChanged={setTemplates}
            onBack={() => { load(); setView('pick'); }}
          />
        )}
      </div>
    </div>
  );
}

/* ---------- Ruční poukaz ---------- */

function CustomVoucher({ lang: initialLang, onBack, onClose, onCreated }: {
  lang: MailLang;
  onBack: () => void;
  onClose: () => void;
  onCreated: (files: string[]) => void;
}) {
  const toast = useToast();
  const [codes, setCodes] = useState('');
  const [value, setValue] = useState('1000');
  const [unit, setUnit] = useState<VoucherSpec['unit']>('CZK');
  const [validUntil, setValidUntil] = useState(defaultValidity());
  const [lang, setLang] = useState<MailLang>(initialLang);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'create' | 'preview' | null>(null);

  const codeList = useMemo(
    () => codes.split(/[\s,;]+/).map(c => c.trim()).filter(Boolean),
    [codes]
  );

  const spec = (): VoucherSpec => ({ codes: codeList, value, unit, validUntil, lang, note });

  const validate = () => {
    if (codeList.length === 0) { toast('Zadej alespoň jeden kód poukazu.', 'error'); return false; }
    if (unit !== 'shipping' && !value.trim()) { toast('Zadej hodnotu poukazu.', 'error'); return false; }
    return true;
  };

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

  const shownValue = valueLabel({ unit, value, lang });

  return (
    <>
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
              {validUntil ? `${lang === 'en' ? 'Valid until' : 'Platný do'} ${dateLabel(validUntil, lang)}` : ''}
            </span>
            <span>{LANGS.find(l => l.id === lang)!.domain}</span>
          </div>
        </div>
      </div>

      <div className="modal-foot">
        <button className="btn ghost" onClick={onBack} disabled={!!busy}>Zpět</button>
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
    </>
  );
}

/* ---------- Správa šablon ---------- */

const EMPTY: Partial<VoucherTemplate> & { name: string } = {
  name: '', value: '1000', unit: 'CZK', validUntil: defaultValidity(),
  note: '', lang: 'cz', codeMode: 'fixed', fixedCode: ''
};

function TemplateManager({ templates, onChanged, onBack }: {
  templates: VoucherTemplate[];
  onChanged: (list: VoucherTemplate[]) => void;
  onBack: () => void;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState<(Partial<VoucherTemplate> & { name: string }) | null>(null);

  const save = async () => {
    if (!editing?.name.trim()) { toast('Vyplň interní název šablony.', 'error'); return; }
    if (editing.codeMode === 'fixed' && !editing.fixedCode?.trim()) {
      toast('U pevného kódu vyplň, jaký kód se má posílat.', 'error');
      return;
    }
    try {
      onChanged(await api.vouchers.save(editing));
      setEditing(null);
      toast('Šablona uložena.');
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const remove = async (t: VoucherTemplate) => {
    try {
      onChanged(await api.vouchers.delete(t.id));
      if (editing?.id === t.id) setEditing(null);
      toast(`Šablona „${t.name}" smazána.`);
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  return (
    <>
      <div className="modal-body">
        {!editing && (
          <>
            <div className="desc">
              Šablony i zásoba kódů se synchronizují mezi zařízeními — co nastavíš tady,
              použiješ i na druhém počítači, a spotřebovaný kód se nikde nenabídne podruhé.
            </div>
            {templates.map(t => (
              <div key={t.id} className="vch-tpl">
                <button className="vch-tpl-main" onClick={() => setEditing({ ...t })}>
                  <span className="vch-tpl-value">{valueLabel(t)}</span>
                  <span className="vch-tpl-body">
                    <span className="vch-tpl-name">{t.name}</span>
                    <span className="vch-tpl-meta">
                      {t.codeMode === 'unique'
                        ? `${t.codesFree} z ${t.codesTotal} kódů volných`
                        : `pevný kód ${t.fixedCode || '—'}`}
                      {' · '}platí do {dateLabel(t.validUntil, t.lang)}
                    </span>
                  </span>
                  <span className="vch-tpl-cta">Upravit</span>
                </button>
                <button className="icon-btn" onClick={() => remove(t)} data-tip="Smazat šablonu">
                  <Icon name="trash" size={15} />
                </button>
              </div>
            ))}
            <button className="btn ghost" onClick={() => setEditing({ ...EMPTY })}>
              <Icon name="plus" size={13} /> Nová šablona
            </button>
          </>
        )}

        {editing && <TemplateForm value={editing} onChange={setEditing} />}
      </div>

      <div className="modal-foot">
        <button className="btn ghost" onClick={() => (editing ? setEditing(null) : onBack())}>
          {editing ? 'Zpět na seznam' : 'Hotovo'}
        </button>
        <span style={{ flex: 1 }} />
        {editing && <button className="btn primary" onClick={save}>Uložit šablonu</button>}
      </div>
    </>
  );
}

function TemplateForm({ value: t, onChange }: {
  value: Partial<VoucherTemplate> & { name: string };
  onChange: (v: Partial<VoucherTemplate> & { name: string }) => void;
}) {
  const toast = useToast();
  const [codes, setCodes] = useState<{ code: string; usedAt: string | null; usedFor: string }[]>([]);
  const [paste, setPaste] = useState('');
  const set = (patch: Partial<VoucherTemplate>) => onChange({ ...t, ...patch } as any);

  useEffect(() => {
    if (!t.id) { setCodes([]); return; }
    api.vouchers.codes(t.id).then(setCodes).catch(() => {});
  }, [t.id]);

  const addCodes = async () => {
    if (!t.id) { toast('Nejdřív šablonu ulož, pak do ní půjde vložit kódy.', 'error'); return; }
    try {
      const res = await api.vouchers.addCodes(t.id, paste);
      setPaste('');
      setCodes(await api.vouchers.codes(t.id));
      toast(res.skipped ? `Přidáno ${res.added} kódů, ${res.skipped} už tam bylo.` : `Přidáno ${res.added} kódů.`);
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const free = codes.filter(c => !c.usedAt).length;

  return (
    <>
      <div className="field">
        <label>Interní název</label>
        <input value={t.name} onChange={e => set({ name: e.target.value })}
          placeholder="např. Omluva za zpožděnou zásilku 300 Kč" autoFocus />
        <span className="desc">Vidíš jen ty — na poukaz se netiskne.</span>
      </div>

      <div className="field-grid">
        <div className="field">
          <label>Hodnota</label>
          <div style={{ display: 'flex', gap: 6 }}>
            <input value={t.unit === 'shipping' ? SHIPPING_TEXT[(t.lang ?? 'cz') as MailLang] : (t.value ?? '')}
              onChange={e => set({ value: e.target.value })}
              disabled={t.unit === 'shipping'} inputMode="decimal" />
            <div className="lang-switch" style={{ flexShrink: 0 }}>
              {UNITS.map(u => (
                <button key={u.id} className={`lang-btn ${t.unit === u.id ? 'active' : ''}`}
                  onClick={() => set({ unit: u.id })}>{u.label}</button>
              ))}
            </div>
          </div>
        </div>
        <div className="field">
          <label>Platnost do</label>
          <input type="date" value={t.validUntil ?? ''} onChange={e => set({ validUntil: e.target.value })} />
        </div>
      </div>

      <div className="field">
        <label>Jazyk poukazu</label>
        <div className="lang-switch" style={{ alignSelf: 'flex-start' }}>
          {LANGS.map(l => (
            <button key={l.id} className={`lang-btn ${t.lang === l.id ? 'active' : ''}`}
              onClick={() => set({ lang: l.id })}>{l.label}</button>
          ))}
        </div>
      </div>

      <div className="field">
        <label>Poznámka na poukazu (nepovinné)</label>
        <input value={t.note ?? ''} onChange={e => set({ note: e.target.value })}
          placeholder="např. Platí při nákupu nad 1 500 Kč" />
      </div>

      <div className="field">
        <label>Kódy</label>
        <div className="lang-switch" style={{ alignSelf: 'flex-start' }}>
          <button className={`lang-btn ${t.codeMode !== 'unique' ? 'active' : ''}`}
            onClick={() => set({ codeMode: 'fixed' })}>Pořád stejný</button>
          <button className={`lang-btn ${t.codeMode === 'unique' ? 'active' : ''}`}
            onClick={() => set({ codeMode: 'unique' })}>Ze seznamu unikátních</button>
        </div>
      </div>

      {t.codeMode !== 'unique' ? (
        <div className="field">
          <label>Kód</label>
          <input value={t.fixedCode ?? ''} onChange={e => set({ fixedCode: e.target.value })}
            placeholder="DEKUJEME300" />
          <span className="desc">Stejný kód dostane každý, komu poukaz pošleš.</span>
        </div>
      ) : (
        <div className="field">
          <label>Zásoba kódů {t.id ? `(${free} volných z ${codes.length})` : ''}</label>
          <textarea rows={3} value={paste} onChange={e => setPaste(e.target.value)}
            placeholder="Vlož kódy — každý na řádek, nebo oddělené čárkou" />
          <div className="ig-actions">
            <button className="btn ghost" onClick={addCodes} disabled={!paste.trim()}>
              <Icon name="plus" size={13} /> Přidat do zásoby
            </button>
            <span className="desc">Při vložení poukazu se odebere nejstarší volný kód.</span>
          </div>
          {codes.length > 0 && (
            <div className="vch-codes">
              {codes.slice(0, 60).map(c => (
                <span key={c.code} className={`vch-code ${c.usedAt ? 'used' : ''}`}
                  data-tip={c.usedAt ? `Použito ${new Date(c.usedAt).toLocaleDateString('cs-CZ')}${c.usedFor ? ` · ${c.usedFor}` : ''}` : 'Volný kód'}>
                  {c.code}
                  {!c.usedAt && t.id && (
                    <button onClick={async () => setCodes(await api.vouchers.deleteCode(t.id!, c.code))}>
                      <Icon name="x" size={10} />
                    </button>
                  )}
                </span>
              ))}
              {codes.length > 60 && <span className="desc">…a dalších {codes.length - 60}</span>}
            </div>
          )}
        </div>
      )}
    </>
  );
}
