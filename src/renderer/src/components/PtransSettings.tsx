import { useEffect, useState } from 'react';
import type { PtransOverview, PtransSettings } from '@shared/types';
import { api } from '../api';
import { useToast } from '../toast';
import Icon from './Icon';

/**
 * Nastavení překladů.
 *
 * Tři věci, které se v praxi mění nejčastěji, jsou nahoře: jazyky, co se
 * překládá a jak. Slovníček a šablona Google titulku jsou dole — nastaví se
 * jednou a pak už se do nich nesahá.
 */

const FIELD_LABELS: [string, string, string][] = [
  ['title', 'Název produktu', 'Krátký text v hlavičce produktu'],
  ['short', 'Krátký popis', 'HTML — značky se zachovají'],
  ['long', 'Dlouhý popis', 'HTML — značky se zachovají'],
  ['seo_title', 'SEO titulek', 'Titulek stránky pro vyhledávače'],
  ['seo_desc', 'SEO popis', 'Meta description'],
  ['seo_url', 'SEO adresa', 'Odvodí se z názvu, model se neptá'],
  ['redirect', 'Přesměrování 301', 'Při změně adresy se stará uloží do redirect_301'],
  ['google_title', 'Google titulek', 'Název pro Google Nákupy'],
  ['google_desc', 'Google popis', 'Popis pro Google Nákupy'],
  ['params', 'Parametry produktu', 'Názvy a hodnoty (Barva → Farba)']
];

const PLACEHOLDERS = ['{title}', '{code}', '{manufacturer}', '{category}', '{availability}',
  '{price}', '{ean}', '{param:Barva}'];

export default function PtransSettingsPanel({ overview, sampleCode, onSaved }: {
  overview: PtransOverview | null;
  /** Produkt, na kterém se ukazuje náhled šablony */
  sampleCode: string;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState<PtransSettings | null>(overview?.settings ?? null);
  const [preview, setPreview] = useState('');
  const [previewLang, setPreviewLang] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (overview?.settings) {
      setDraft(overview.settings);
      setPreviewLang(prev => prev || overview.settings.languages.find(l => l.enabled)?.code || '');
    }
  }, [overview]);

  if (!draft) return <div className="modal-body ig-muted">Načítám…</div>;

  const patch = (part: Partial<PtransSettings>) => setDraft(prev => (prev ? { ...prev, ...part } : prev));

  const save = async () => {
    setSaving(true);
    try {
      await api.ptrans.saveSettings(draft);
      toast('Nastavení uloženo');
      onSaved();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const showPreview = async () => {
    if (!sampleCode) { toast('Nejdřív načti feed.', 'error'); return; }
    try {
      const template = draft.googleTitle[previewLang] ?? '';
      setPreview(await api.ptrans.templatePreview(template, sampleCode, previewLang));
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  return (
    <>
      <div className="modal-body pt-settings">
        <section>
          <h3>Jazyky</h3>
          <p className="ig-muted">
            Překládá se ze zdrojového jazyka do zapnutých. Nový trh stačí přidat sem —
            ve feedu ještě být nemusí, export si jazykovou část vytvoří.
          </p>
          <div className="pt-langs">
            {draft.languages.map((lang, index) => (
              <div key={index} className="pt-lang-row">
                <label className="pt-switch">
                  <input type="checkbox" checked={lang.enabled}
                    onChange={e => {
                      const next = [...draft.languages];
                      next[index] = { ...lang, enabled: e.target.checked };
                      patch({ languages: next });
                    }} />
                  <span />
                </label>
                <input className="pt-lang-code" value={lang.code} placeholder="sk"
                  onChange={e => {
                    const next = [...draft.languages];
                    next[index] = { ...lang, code: e.target.value.trim().toLowerCase() };
                    patch({ languages: next });
                  }} />
                <input value={lang.label} placeholder="Slovenština"
                  onChange={e => {
                    const next = [...draft.languages];
                    next[index] = { ...lang, label: e.target.value };
                    patch({ languages: next });
                  }} />
                <button className="icon-btn" data-tip="Odebrat jazyk"
                  onClick={() => patch({ languages: draft.languages.filter((_, i) => i !== index) })}>
                  <Icon name="trash" size={14} />
                </button>
              </div>
            ))}
            <button className="btn ghost"
              onClick={() => patch({ languages: [...draft.languages, { code: '', label: '', enabled: true }] })}>
              <Icon name="plus" size={13} /> Přidat jazyk
            </button>
          </div>

          <div className="field-grid">
            <label>
              <span>Zdrojový jazyk</span>
              <input value={draft.sourceLang} onChange={e => patch({ sourceLang: e.target.value.trim() })} />
              <small>Ve feedu jazyk s pořádnými texty — u Quentina „cz"</small>
            </label>
            <label>
              <span>Souběžných překladů</span>
              <input type="number" min={1} max={6} value={draft.concurrency}
                onChange={e => patch({ concurrency: Math.max(1, Math.min(6, Number(e.target.value) || 1)) })} />
              <small>Víc = rychleji, ale větší šance narazit na limit API</small>
            </label>
          </div>
        </section>

        <section>
          <h3>Co překládat</h3>
          <div className="pt-fieldgrid">
            {FIELD_LABELS.map(([key, label, hint]) => (
              <label key={key} className={`pt-fieldpick ${draft.fields[key] ? 'on' : ''}`}>
                <input type="checkbox" checked={!!draft.fields[key]}
                  onChange={e => patch({ fields: { ...draft.fields, [key]: e.target.checked } })} />
                <span>
                  <b>{label}</b>
                  <small>{hint}</small>
                </span>
              </label>
            ))}
          </div>
        </section>

        <section>
          <h3>Jak překládat</h3>
          <label className="pt-block">
            <span>Vlastní pokyny k překladu</span>
            <textarea rows={4} value={draft.prompt} onChange={e => patch({ prompt: e.target.value })}
              placeholder={'Např.: Piš vykáním. Kšandy jsou v SK „traky“. Nepoužívej zdrobněliny.'} />
            <small>
              Přidá se k systémovému pokynu. Popis značky z Nastavení → AI se použije taky.
            </small>
          </label>

          <label className="pt-block">
            <span>Model</span>
            <input value={draft.model} onChange={e => patch({ model: e.target.value.trim() })}
              placeholder="prázdné = model pro koncepty z Nastavení → AI" />
          </label>

          <div className="field-grid">
            <label>
              <span>Délka SEO titulku</span>
              <input type="number" value={draft.limits.seoTitle}
                onChange={e => patch({ limits: { ...draft.limits, seoTitle: Number(e.target.value) || 70 } })} />
            </label>
            <label>
              <span>Délka SEO popisu</span>
              <input type="number" value={draft.limits.seoDesc}
                onChange={e => patch({ limits: { ...draft.limits, seoDesc: Number(e.target.value) || 155 } })} />
            </label>
          </div>
        </section>

        <section>
          <h3>Slovníček</h3>
          <p className="ig-muted">
            Termíny, které mají v každém jazyce znít vždycky stejně. Model je dostane
            jako závazné zadání.
          </p>
          <div className="pt-glossary">
            {draft.glossary.map((entry, index) => (
              <div key={index} className="pt-gloss-row">
                <input value={entry.source} placeholder="kšandy"
                  onChange={e => {
                    const next = [...draft.glossary];
                    next[index] = { ...entry, source: e.target.value };
                    patch({ glossary: next });
                  }} />
                <Icon name="chevRight" size={12} />
                {draft.languages.filter(l => l.enabled).map(lang => (
                  <input key={lang.code} value={entry.targets[lang.code] ?? ''}
                    placeholder={lang.code}
                    onChange={e => {
                      const next = [...draft.glossary];
                      next[index] = { ...entry, targets: { ...entry.targets, [lang.code]: e.target.value } };
                      patch({ glossary: next });
                    }} />
                ))}
                <button className="icon-btn"
                  onClick={() => patch({ glossary: draft.glossary.filter((_, i) => i !== index) })}>
                  <Icon name="trash" size={14} />
                </button>
              </div>
            ))}
            <button className="btn ghost"
              onClick={() => patch({ glossary: [...draft.glossary, { source: '', targets: {} }] })}>
              <Icon name="plus" size={13} /> Přidat termín
            </button>
          </div>
        </section>

        <section>
          <h3>Google Nákupy</h3>
          <p className="ig-muted">
            Titulek se skládá ze šablony — je to okamžité a předvídatelné. Do šablony
            se dají vložit parametry produktu; název parametru se píše česky, hodnota
            se vezme v cílovém jazyce.
          </p>
          <div className="pt-placeholders">
            {PLACEHOLDERS.map(item => <code key={item}>{item}</code>)}
          </div>
          {draft.languages.filter(l => l.enabled).map(lang => (
            <label key={lang.code} className="pt-block">
              <span>{lang.label} ({lang.code})</span>
              <input value={draft.googleTitle[lang.code] ?? ''}
                placeholder="{title} {param:Barva} {param:Šířka} | Quentino"
                onChange={e => patch({ googleTitle: { ...draft.googleTitle, [lang.code]: e.target.value } })} />
            </label>
          ))}
          <div className="pt-preview-row">
            <select value={previewLang} onChange={e => setPreviewLang(e.target.value)}>
              {draft.languages.filter(l => l.enabled).map(lang => (
                <option key={lang.code} value={lang.code}>{lang.label}</option>
              ))}
            </select>
            <button className="btn ghost" onClick={showPreview}>
              <Icon name="eye" size={13} /> Ukázat na produktu
            </button>
            {preview && <span className="pt-preview">{preview}</span>}
          </div>
        </section>
      </div>

      <div className="modal-foot">
        <span className="ig-muted">
          Naměřená rychlost: {draft.secondsPerUnit} s na produkt a jazyk
        </span>
        <span style={{ flex: 1 }} />
        <button className="btn primary" onClick={save} disabled={saving}>
          {saving ? <span className="spinner-inline" /> : <Icon name="save" size={13} />} Uložit nastavení
        </button>
      </div>
    </>
  );
}
