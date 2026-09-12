import { useEffect, useState } from 'react';
import type { ArticleOverview, ArticleSettings } from '@shared/types';
import { api } from '../api';
import { useToast } from '../toast';
import Icon from './Icon';

/**
 * Nastavení článků.
 *
 * Trhy jsou nahoře, protože bez správné domény vzniknou v článku odkazy, které
 * nikam nevedou. Styl článků je dole — nastaví se jednou a je to nejdelší
 * text v celé aplikaci.
 */
export default function ArticleSettingsPanel({ overview, onSaved }: {
  overview: ArticleOverview | null;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState<ArticleSettings | null>(overview?.settings ?? null);
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (overview?.settings) setDraft(overview.settings); }, [overview]);
  if (!draft) return <div className="modal-body ig-muted">Načítám…</div>;

  const patch = (part: Partial<ArticleSettings>) => setDraft(prev => (prev ? { ...prev, ...part } : prev));

  const save = async () => {
    setSaving(true);
    try {
      await api.articles.saveSettings(draft);
      toast('Nastavení uloženo');
      onSaved();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const restorePrompt = async () => {
    try { patch({ prompt: await api.articles.defaultPrompt() }); }
    catch (e: any) { toast(e.message, 'error'); }
  };

  return (
    <>
      <div className="modal-body pt-settings">
        <section>
          <h3>Trhy</h3>
          <p className="ig-muted">
            Doména se používá při skládání odkazů v článku. Bez ní by článek na
            slovenském trhu odkazoval na český e-shop.
          </p>
          <div className="pt-langs">
            {draft.languages.map((lang, index) => (
              <div key={index} className="ar-lang-row">
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
                <input value={lang.domain} placeholder="https://www.quentino.sk"
                  onChange={e => {
                    const next = [...draft.languages];
                    next[index] = { ...lang, domain: e.target.value.trim() };
                    patch({ languages: next });
                  }} />
                <button className="icon-btn" data-tip="Odebrat trh"
                  onClick={() => patch({ languages: draft.languages.filter((_, i) => i !== index) })}>
                  <Icon name="trash" size={14} />
                </button>
              </div>
            ))}
            <button className="btn ghost"
              onClick={() => patch({ languages: [...draft.languages, { code: '', label: '', enabled: true, domain: '' }] })}>
              <Icon name="plus" size={13} /> Přidat trh
            </button>
          </div>

          <div className="field-grid">
            <label>
              <span>Zdrojový jazyk</span>
              <input value={draft.sourceLang} onChange={e => patch({ sourceLang: e.target.value.trim() })} />
              <small>V něm se píše první verze, z ní se překládá</small>
            </label>
            <label>
              <span>Výchozí délka</span>
              <input type="number" min={150} step={50} value={draft.wordCount}
                onChange={e => patch({ wordCount: Number(e.target.value) || 600 })} />
              <small>Počet viditelných slov</small>
            </label>
          </div>

          <div className="field-grid">
            <label>
              <span>Cesta k produktu</span>
              <input value={draft.productPrefix} onChange={e => patch({ productPrefix: e.target.value })} />
              <small>V Upgates „/p/"</small>
            </label>
            <label>
              <span>Cesta k článku</span>
              <input value={draft.articlePrefix} onChange={e => patch({ articlePrefix: e.target.value })} />
              <small>V Upgates „/a/"</small>
            </label>
          </div>

          {/*
            Import zpátky do e-shopu. Exportovat a pak v administraci hledat,
            který ze stažených souborů je ten poslední, je krok navíc — a
            zrovna u něj se dá snadno sáhnout po starém souboru.
          */}
          <label className="pt-check">
            <input type="checkbox" checked={draft.openImport !== false}
              onChange={e => patch({ openImport: e.target.checked })} />
            <span>
              <b>Po exportu rovnou otevřít import v administraci</b>
              <small>Soubor se do něj vloží sám; spuštění importu zůstává na tobě.</small>
            </span>
          </label>
          {/*
            Kategorie při importu. Bez nich se článek naimportuje „nikam"
            a musí se v administraci zařazovat ručně u každého kusu.
          */}
          <div className="pt-block">
            <span>Kategorie při importu</span>
            {(draft.categories ?? []).map((cat, index) => (
              <div className="ar-cat-row" key={index}>
                <input value={cat.code} placeholder="Kód (K00035)"
                  onChange={e => patch({
                    categories: draft.categories.map((c, i) =>
                      (i === index ? { ...c, code: e.target.value.trim() } : c))
                  })} />
                <input value={cat.name} placeholder="Název kategorie"
                  onChange={e => patch({
                    categories: draft.categories.map((c, i) =>
                      (i === index ? { ...c, name: e.target.value } : c))
                  })} />
                <label className="pt-check">
                  <input type="radio" name="artPrimaryCat" checked={!!cat.primary}
                    onChange={() => patch({
                      categories: draft.categories.map((c, i) => ({ ...c, primary: i === index }))
                    })} />
                  <span>Hlavní</span>
                </label>
                <button className="icon-btn"
                  onClick={() => patch({
                    categories: draft.categories.filter((_, i) => i !== index)
                  })}>
                  <Icon name="trash" size={14} />
                </button>
              </div>
            ))}
            <button className="btn ghost" onClick={() => patch({
              categories: [...(draft.categories ?? []), { code: '', name: '', primary: false }]
            })}>
              <Icon name="plus" size={13} /> Přidat kategorii
            </button>
            <small>
              Kód je nepovinný — Upgates ho u „Homepage" neposílá. Hlavní kategorie může být
              jen jedna; u ostatních zůstane příznak prázdný, přesně jak to e-shop vyváží.
            </small>
          </div>

          <label>
            <span>Stránka importu textů</span>
            <input value={draft.importUrl} placeholder="prázdné = složí se z adresy administrace"
              onChange={e => patch({ importUrl: e.target.value })} />
            <small>
              V adrese je číslo serveru e-shopu, proto se nedá zapsat napevno —
              například https://quentino.admin.s19.upgates.com/setup/export-import/default/guide/texts/
            </small>
          </label>
        </section>

        <section>
          <h3>Jak psát</h3>
          <label className="pt-check">
            <input type="checkbox" checked={draft.researchTerms}
              onChange={e => patch({ researchTerms: e.target.checked })} />
            <span>
              <b>Před psaním najít vyhledávané výrazy</b>
              <small>
                Model nejdřív navrhne, jak se lidé na téma ptají — hlavní výraz jde do
                názvu, otázky do FAQ. Stojí to jedno krátké volání navíc.
              </small>
            </span>
          </label>
          <label className="pt-block">
            <span>Model</span>
            <input value={draft.model} onChange={e => patch({ model: e.target.value.trim() })}
              placeholder="prázdné = model pro koncepty z Nastavení → AI" />
          </label>
        </section>

        <section>
          <div className="ar-sec-head">
            <h3>Styl článků</h3>
            <button className="btn ghost" onClick={restorePrompt}>
              <Icon name="refresh" size={13} /> Vrátit původní
            </button>
          </div>
          <p className="ig-muted">
            Systémový pokyn pro psaní: tón značky, HTML komponenty, pravidla délky.
            U jednotlivého článku se dá přepsat v jeho zadání.
          </p>
          <textarea className="ar-prompt" rows={24} value={draft.prompt}
            onChange={e => patch({ prompt: e.target.value })} spellCheck={false} />
        </section>
      </div>

      <div className="modal-foot">
        <span className="ig-muted">
          {overview?.summary.byLang.map(item => `${item.lang.toUpperCase()}: ${item.n}`).join(' · ')}
        </span>
        <span style={{ flex: 1 }} />
        <button className="btn primary" onClick={save} disabled={saving}>
          {saving ? <span className="spinner-inline" /> : <Icon name="save" size={13} />} Uložit nastavení
        </button>
      </div>
    </>
  );
}
