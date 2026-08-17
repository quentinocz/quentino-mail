import { useState } from 'react';
import type { IgBrand as Brand, IgMarket, IgOverview } from '@shared/types';
import { api } from '../../api';
import { useToast } from '../../toast';
import Icon from '../Icon';

/**
 * Hlas značky a popis trhů. Tohle je jediné místo, které rozhoduje o tom,
 * jak vygenerované texty zní — proto je oddělené od samotného psaní.
 */
export default function IgBrand({ overview, onChanged }: { overview: IgOverview; onChanged: () => void }) {
  const toast = useToast();
  const [b, setB] = useState<Brand>(overview.brand);
  const [markets, setMarkets] = useState<IgMarket[]>(overview.markets);
  const [tone, setTone] = useState('');
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState(false);

  const set = (patch: Partial<Brand>) => setB({ ...b, ...patch });

  const save = async () => {
    setSaving(true);
    try {
      await api.ig.saveBrand(b);
      toast('Uloženo — příští generování už podle toho.');
      onChanged();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const saveMarket = async (m: IgMarket) => {
    try {
      setMarkets(await api.ig.saveMarket(m));
      onChanged();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const removeMarket = async (lang: string) => {
    if (overview.accounts.some(a => a.lang === lang)) {
      toast('Nejdřív odpoj účet, který k trhu patří.', 'error');
      return;
    }
    setMarkets(await api.ig.deleteMarket(lang));
    onChanged();
  };

  return (
    <div className="ig-page">
      <div className="ig-head">
        <h2>Značka a trhy</h2>
        <div className="ig-head-tools">
          <button className="btn primary" onClick={save} disabled={saving}>Uložit</button>
        </div>
      </div>

      <div className="ig-cols">
        <section className="ig-card">
          <h3>Hlas značky</h3>
          <div className="field">
            <label>Kdo je Quentino</label>
            <textarea rows={5} value={b.context} onChange={e => set({ context: e.target.value })} />
            <span className="desc">Čím se zabývá, pro koho tvoří, čím se liší. Tohle model dostane úplně první.</span>
          </div>

          <div className="field">
            <label>Tón</label>
            <div className="ig-tones">
              {b.tones.map(t => (
                <span key={t} className="ig-tone">
                  {t}
                  <button onClick={() => set({ tones: b.tones.filter(x => x !== t) })}><Icon name="x" size={11} /></button>
                </span>
              ))}
              <input
                value={tone}
                placeholder="přidat…"
                onChange={e => setTone(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && tone.trim()) {
                    set({ tones: [...b.tones, tone.trim()] });
                    setTone('');
                  }
                }}
              />
            </div>
          </div>

          <div className="field">
            <label>Nikdy</label>
            <textarea rows={3} value={b.avoid} onChange={e => set({ avoid: e.target.value })} />
            <span className="desc">Fráze a manýry, které v textech nechceš vidět.</span>
          </div>

          <div className="field">
            <label>Pravidla psaní</label>
            <textarea rows={3} value={b.rules} onChange={e => set({ rules: e.target.value })} />
          </div>

          <div className="field">
            <label>
              <input type="checkbox" checked={b.loveOn} onChange={e => set({ loveOn: e.target.checked })} />
              {' '}Přidat vlastní přístup ke značce
            </label>
            {b.loveOn && <textarea rows={4} value={b.love} onChange={e => set({ love: e.target.value })} />}
          </div>

          <div className="field">
            <label>Emoji</label>
            <select value={b.emoji} onChange={e => set({ emoji: e.target.value as Brand['emoji'] })}>
              <option value="none">Vůbec ne</option>
              <option value="sparse">Střídmě — jedno až dvě, když něco přidají</option>
              <option value="free">Volně, ale ne v každé větě</option>
            </select>
          </div>

          <div className="field-grid">
            <div className="field">
              <label>Variant na trh</label>
              <select value={b.variants} onChange={e => set({ variants: Number(e.target.value) })}>
                {[1, 2, 3, 4].map(n => <option key={n} value={n}>{n}</option>)}
              </select>
              <span className="desc">Víc variant = víc na výběr, ale delší generování.</span>
            </div>
            <div className="field">
              <label>Znalostní báze</label>
              <label className="ig-checkline">
                <input type="checkbox" checked={b.useKnowledge} onChange={e => set({ useKnowledge: e.target.checked })} />
                {' '}Přibalit dokumenty z Nastavení
              </label>
              <span className="desc">Stejné podklady, které používá AI v poště.</span>
            </div>
          </div>
        </section>

        <section className="ig-card">
          <h3>Trhy</h3>
          <p className="ig-muted">
            U každého trhu se popisuje, čím je jiný. Model to dostane spolu se zadáním,
            takže španělský text není překlad českého, ale text pro Španěly.
          </p>

          {markets.map(m => (
            <MarketRow
              key={m.lang}
              market={m}
              connected={overview.accounts.some(a => a.lang === m.lang)}
              onSave={saveMarket}
              onDelete={() => removeMarket(m.lang)}
            />
          ))}

          {adding
            ? <MarketRow
                market={{ lang: '', label: '', note: '', tags: '', color: '#7c5cff', enabled: true }}
                connected={false}
                isNew
                onSave={async m => { await saveMarket(m); setAdding(false); }}
                onDelete={() => setAdding(false)}
              />
            : <button className="btn ghost" onClick={() => setAdding(true)}><Icon name="plus" size={13} /> Přidat trh</button>}
        </section>
      </div>
    </div>
  );
}

function MarketRow({ market, connected, isNew, onSave, onDelete }: {
  market: IgMarket; connected: boolean; isNew?: boolean;
  onSave: (m: IgMarket) => void | Promise<void>; onDelete: () => void;
}) {
  const [m, setM] = useState<IgMarket>(market);
  const [open, setOpen] = useState(!!isNew);
  const dirty = JSON.stringify(m) !== JSON.stringify(market);

  return (
    <div className="ig-market">
      <div className="ig-market-head">
        <span className="ig-lang ig-lang-done" style={{ background: m.color, borderColor: m.color }}>{m.lang || '??'}</span>
        <button className="ig-market-name" onClick={() => setOpen(!open)}>
          {m.label || 'nový trh'}
          {connected && <span className="ig-tag-src">účet</span>}
        </button>
        <label className="ig-checkline" title="Nabízet při psaní">
          <input type="checkbox" checked={m.enabled} onChange={e => { const next = { ...m, enabled: e.target.checked }; setM(next); onSave(next); }} />
        </label>
        <button className="icon-btn" onClick={() => setOpen(!open)}><Icon name="chevDown" size={14} /></button>
      </div>

      {open && (
        <div className="ig-market-body">
          <div className="field-grid">
            <div className="field">
              <label>Kód</label>
              <input value={m.lang} disabled={!isNew} maxLength={5}
                onChange={e => setM({ ...m, lang: e.target.value.toUpperCase() })} placeholder="ES" />
            </div>
            <div className="field">
              <label>Název</label>
              <input value={m.label} onChange={e => setM({ ...m, label: e.target.value })} placeholder="Španělština" />
            </div>
          </div>
          <div className="field">
            <label>Čím je trh jiný</label>
            <textarea rows={3} value={m.note} onChange={e => setM({ ...m, note: e.target.value })} />
          </div>
          <div className="field">
            <label>Hashtagy k dispozici</label>
            <textarea rows={2} value={m.tags} onChange={e => setM({ ...m, tags: e.target.value })} placeholder="#quentino #handmade …" />
          </div>
          <div className="ig-actions">
            <div className="field">
              <label>Barva</label>
              <input type="color" value={m.color} onChange={e => setM({ ...m, color: e.target.value })} />
            </div>
            <button className="btn primary" disabled={!dirty || !m.lang} onClick={() => onSave(m)}>Uložit trh</button>
            <button className="btn danger" onClick={onDelete}>{isNew ? 'Zrušit' : 'Smazat'}</button>
          </div>
        </div>
      )}
    </div>
  );
}
