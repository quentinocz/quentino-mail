import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ArticleDetail, ArticleBrief, PtransProduct, ArticleProduct } from '@shared/types';

/** Článek vykreslený pro ruční kontrolu odkazů. */
interface ArticleReview {
  title: string;
  html: string;
  links: {
    index: number; url: string; text: string; kind: string; status: number | null;
    note: string; suggestion: string | null; unverified: boolean;
  }[];
}
import { api } from '../api';
import { useToast } from '../toast';
import Icon from './Icon';

/**
 * Editor jednoho článku — tři panely.
 *
 * **Zadání** je to, z čeho článek vzniká: téma, produkty, obrázky, délka.
 * Zůstává uložené, takže se dá kdykoli přegenerovat.
 * **Text** je výsledek po jazycích. Vedle sebe je text a náhled, protože
 * článek je HTML a bez náhledu se nedá posoudit.
 * **Odkazy** ukazují, kam článek odkazuje, a co se z toho na jiných trzích
 * nenajde.
 */

type Lang = { code: string; label: string };

/* ==================== Zadání ==================== */

export function ArticleBriefPanel({ article, langs, lengths, busy, onChanged, onGenerated }: {
  article: ArticleDetail;
  langs: Lang[];
  lengths: { label: string; words: number }[];
  busy: boolean;
  onChanged: () => void;
  onGenerated: () => void;
}) {
  const toast = useToast();
  const [topic, setTopic] = useState(article.topic);
  const [title, setTitle] = useState(article.brief.title);
  const [titleFixed, setTitleFixed] = useState(article.brief.titleFixed);
  const [wordCount, setWordCount] = useState(article.wordCount);
  const [pick, setPick] = useState<string[]>(article.langs);
  // Jak vzniknou jazykové mutace. Výchozí je překlad: články pak mají stejnou
  // stavbu i odkazy a stojí zlomek toho, co psát každý jazyk zvlášť.
  const [mode, setMode] = useState<'translate' | 'each'>('translate');
  const [brief, setBrief] = useState<ArticleBrief>(article.brief);
  const [terms, setTerms] = useState(article.terms);
  const [prompt, setPrompt] = useState(article.prompt);
  const [showPrompt, setShowPrompt] = useState(false);
  const [picker, setPicker] = useState(false);
  const [products, setProducts] = useState<ArticleProduct[]>([]);
  const [working, setWorking] = useState('');

  useEffect(() => {
    setTopic(article.topic);
    setTitle(article.brief.title);
    setTitleFixed(article.brief.titleFixed);
    setWordCount(article.wordCount);
    setPick(article.langs);
    setBrief(article.brief);
    setTerms(article.terms);
    setPrompt(article.prompt);
  }, [article.id]);

  // Názvy vybraných produktů — v zadání se ukazuje, co se do článku dostane
  useEffect(() => {
    if (brief.products.length === 0) { setProducts([]); return; }
    api.articles.products(brief.products, article.sourceLang).then(setProducts).catch(() => {});
  }, [brief.products, article.sourceLang]);

  const patchBrief = (part: Partial<ArticleBrief>) => setBrief(prev => ({ ...prev, ...part }));

  const save = useCallback(async (extra: Record<string, unknown> = {}) => {
    await api.articles.save({
      id: article.id, topic, wordCount, langs: pick, prompt,
      brief: { ...brief, title, titleFixed }, terms, ...extra
    });
    onChanged();
  }, [article.id, topic, wordCount, pick, prompt, brief, title, titleFixed, terms, onChanged]);

  const saveOnly = async () => {
    try { await save(); toast('Zadání uloženo'); }
    catch (e: any) { toast(e.message, 'error'); }
  };

  const analyse = async () => {
    if (!topic.trim()) { toast('Nejdřív napiš, o čem má článek být.', 'error'); return; }
    setWorking('terms');
    try {
      const result = await api.articles.terms(topic, article.sourceLang, title);
      setTerms(result);
      await save({ terms: result });
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setWorking('');
    }
  };

  const generate = async (force: boolean) => {
    if (!topic.trim() && !title.trim()) { toast('Doplň název nebo téma.', 'error'); return; }
    if (pick.length === 0) { toast('Vyber aspoň jeden jazyk.', 'error'); return; }
    setWorking('generate');
    try {
      await save();
      const result = await api.articles.generate({
        articleId: article.id, topic, title, titleFixed, langs: pick, wordCount, mode,
        brief: { ...brief, title, titleFixed }, prompt, force
      });
      if (result.errors.length) toast(result.errors.join(' · '), 'error');
      else toast(`Hotovo: ${result.langs.map(l => l.toUpperCase()).join(', ')}`);
      onChanged();
      onGenerated();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setWorking('');
    }
  };

  const translate = async () => {
    const missing = pick.filter(lang => !article.versions.find(v => v.lang === lang && v.long));
    if (missing.length === 0) { toast('Všechny vybrané jazyky už text mají.'); return; }
    setWorking('translate');
    try {
      const result = await api.articles.translate(article.id, missing);
      if (result.unresolved.length) {
        toast(`Přeloženo, ale ${result.unresolved.length} odkazů se nepodařilo převést — najdeš je v záložce Odkazy.`, 'error');
      } else if (result.errors.length) {
        toast(result.errors.join(' · '), 'error');
      } else {
        toast(`Přeloženo do ${result.langs.map(l => l.toUpperCase()).join(', ')}`);
      }
      onChanged();
      onGenerated();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setWorking('');
    }
  };

  const hasText = article.versions.some(v => v.long);

  return (
    <>
      <div className="modal-body ar-brief">
        <div className="ar-cols">
          <div className="ar-col">
            <section>
              <h3>Téma</h3>
              <label className="pt-block">
                <span>Název článku</span>
                <input value={title} onChange={e => setTitle(e.target.value)}
                  placeholder="Např. Jak vybrat motýlka na svatbu" />
              </label>
              <label className="pt-check">
                <input type="checkbox" checked={!titleFixed}
                  onChange={e => setTitleFixed(!e.target.checked)} />
                <span>
                  <b>AI může název vylepšit</b>
                  <small>Vypnuté = název se jen přeloží, doslova</small>
                </span>
              </label>
              <label className="pt-block">
                <span>O čem má článek být</span>
                <textarea rows={6} value={topic} onChange={e => setTopic(e.target.value)}
                  placeholder="Cílová skupina, příležitost, na co se zaměřit, čemu se vyhnout…" />
              </label>
            </section>

            <section>
              <div className="ar-sec-head">
                <h3>Produkty</h3>
                <button className="btn ghost" onClick={() => setPicker(true)}>
                  <Icon name="plus" size={13} /> Vybrat z feedu
                </button>
              </div>
              <p className="ig-muted">
                Vybrané produkty se do článku vloží jako odkaz — v každém jazyce ten
                správný, protože adresa se bere z produktové databáze.
              </p>
              {products.length === 0 && <div className="ig-muted">Zatím žádné produkty.</div>}
              <div className="ar-prods">
                {products.map(p => (
                  <div key={p.code} className="ar-prod">
                    {p.image
                      ? <img src={p.image} alt="" />
                      : <span className="ar-prod-noimg"><Icon name="bag" size={14} /></span>}
                    <div className="ar-prod-main">
                      <b>{p.title}</b>
                      <small className="ig-muted">{p.code}</small>
                    </div>
                    <button className="icon-btn" data-tip="Odebrat"
                      onClick={() => patchBrief({ products: brief.products.filter(c => c !== p.code) })}>
                      <Icon name="x" size={14} />
                    </button>
                  </div>
                ))}
              </div>
              {products.length > 0 && (
                <div className="ar-prod-opts">
                  <label className="pt-check">
                    <input type="checkbox" checked={brief.includeProductImages}
                      onChange={e => patchBrief({ includeProductImages: e.target.checked })} />
                    <span>Vložit i fotky produktů</span>
                  </label>
                  <label>
                    <span>Velikost</span>
                    <select value={brief.productSize}
                      onChange={e => patchBrief({ productSize: e.target.value as any })}>
                      <option value="small">Malá</option>
                      <option value="medium">Střední</option>
                      <option value="large">Velká</option>
                    </select>
                  </label>
                  <label>
                    <span>Rozložení</span>
                    <select value={brief.productLayout}
                      onChange={e => patchBrief({ productLayout: e.target.value as any })}>
                      <option value="block">Na střed</option>
                      <option value="left">Obtékání vlevo</option>
                      <option value="right">Obtékání vpravo</option>
                    </select>
                  </label>
                </div>
              )}
            </section>

            <section>
              <div className="ar-sec-head">
                <h3>Obrázky z CDN</h3>
                <button className="btn ghost" onClick={() => patchBrief({
                  images: [...brief.images, { url: '', description: '', size: 'auto', layout: 'block' }]
                })}>
                  <Icon name="plus" size={13} /> Přidat
                </button>
              </div>
              <p className="ig-muted">
                Adresa obrázku nahraného na e-shop. První označený jako listingový se
                do těla článku nedá — je to náhled v seznamu.
              </p>
              {brief.images.map((img, index) => (
                <div key={index} className="ar-img">
                  {img.url ? <img src={img.url} alt="" /> : <span className="ar-prod-noimg"><Icon name="image" size={14} /></span>}
                  <div className="ar-img-fields">
                    <input value={img.url} placeholder="https://…cdn-upgates.com/…"
                      onChange={e => {
                        const next = [...brief.images];
                        next[index] = { ...img, url: e.target.value.trim() };
                        patchBrief({ images: next });
                      }} />
                    <input value={img.description} placeholder="Co na obrázku je (popisek a alt)"
                      onChange={e => {
                        const next = [...brief.images];
                        next[index] = { ...img, description: e.target.value };
                        patchBrief({ images: next });
                      }} />
                    <div className="ar-img-opts">
                      <select value={img.size} onChange={e => {
                        const next = [...brief.images];
                        next[index] = { ...img, size: e.target.value as any };
                        patchBrief({ images: next });
                      }}>
                        <option value="auto">Podle kontextu</option>
                        <option value="small">Malý</option>
                        <option value="medium">Střední</option>
                        <option value="full">Celá šířka</option>
                      </select>
                      <select value={img.layout} onChange={e => {
                        const next = [...brief.images];
                        next[index] = { ...img, layout: e.target.value as any };
                        patchBrief({ images: next });
                      }}>
                        <option value="block">Na střed</option>
                        <option value="left">Vlevo</option>
                        <option value="right">Vpravo</option>
                      </select>
                      <label className="pt-check">
                        <input type="radio" name="listing" checked={!!img.isListing}
                          onChange={() => patchBrief({
                            images: brief.images.map((it, i) => ({ ...it, isListing: i === index }))
                          })} />
                        <span>Listingový</span>
                      </label>
                      <button className="icon-btn"
                        onClick={() => patchBrief({ images: brief.images.filter((_, i) => i !== index) })}>
                        <Icon name="trash" size={14} />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </section>

            <section>
              <div className="ar-sec-head">
                <h3>Interní odkazy</h3>
                <button className="btn ghost" onClick={() => patchBrief({
                  links: [...brief.links, { name: '', urls: {} }]
                })}>
                  <Icon name="plus" size={13} /> Přidat
                </button>
              </div>
              <p className="ig-muted">
                Kategorie nebo jiné stránky, na které má článek odkazovat. Stačí zadat
                českou adresu — ostatní trhy se dohledají v mapě adres.
              </p>
              {brief.links.map((link, index) => (
                <div key={index} className="ar-link-row">
                  <input value={link.name} placeholder="Popis odkazu"
                    onChange={e => {
                      const next = [...brief.links];
                      next[index] = { ...link, name: e.target.value };
                      patchBrief({ links: next });
                    }} />
                  {langs.map(lang => (
                    <input key={lang.code} value={link.urls[lang.code] ?? ''}
                      placeholder={`${lang.code.toUpperCase()} adresa`}
                      onChange={e => {
                        const next = [...brief.links];
                        next[index] = { ...link, urls: { ...link.urls, [lang.code]: e.target.value.trim() } };
                        patchBrief({ links: next });
                      }} />
                  ))}
                  <button className="icon-btn"
                    onClick={() => patchBrief({ links: brief.links.filter((_, i) => i !== index) })}>
                    <Icon name="trash" size={14} />
                  </button>
                </div>
              ))}
            </section>
          </div>

          <div className="ar-side">
            <section className="ar-card">
              <h3>Jazyky</h3>
              {langs.map(lang => (
                <label key={lang.code} className="pt-check">
                  <input type="checkbox" checked={pick.includes(lang.code)}
                    onChange={e => setPick(prev => e.target.checked
                      ? [...prev, lang.code]
                      : prev.filter(c => c !== lang.code))} />
                  <span>{lang.label} ({lang.code.toUpperCase()})</span>
                </label>
              ))}

              {pick.length > 1 && (
                <div className="ar-mode">
                  {([
                    { id: 'translate' as const, label: 'Napsat jednou a přeložit',
                      hint: 'Stejná stavba i odkazy ve všech jazycích, zlomek ceny' },
                    { id: 'each' as const, label: 'Každý jazyk zvlášť',
                      hint: 'Text psaný na míru trhu, ale články si nejsou podobné' }
                  ]).map(item => (
                    <label key={item.id} className={`ar-mode-pick ${mode === item.id ? 'on' : ''}`}>
                      <input type="radio" name="ar-mode" checked={mode === item.id}
                        onChange={() => setMode(item.id)} />
                      <span>
                        <b>{item.label}</b>
                        <small>{item.hint}</small>
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </section>

            <section className="ar-card">
              <h3>Délka</h3>
              <div className="ar-lengths">
                {lengths.map(item => (
                  <button key={item.words}
                    className={`ar-len ${wordCount === item.words ? 'on' : ''}`}
                    onClick={() => setWordCount(item.words)}>
                    <b>{item.label}</b>
                    <small>~{item.words} slov</small>
                  </button>
                ))}
              </div>
              <label className="ar-custom">
                <span>Vlastní</span>
                <input type="number" min={150} max={4000} step={50} value={wordCount}
                  onChange={e => setWordCount(Math.max(150, Number(e.target.value) || 600))} />
                <small>slov</small>
              </label>
              <p className="ig-muted ar-len-note">
                Délka se po napsání změří a text se podle potřeby zkrátí nebo dopíše.
              </p>
            </section>

            <section className="ar-card">
              <div className="ar-sec-head">
                <h3>Vyhledávané výrazy</h3>
                <button className="btn ghost" onClick={analyse} disabled={!!working}>
                  {working === 'terms' ? <span className="spinner-inline" /> : <Icon name="search" size={13} />}
                  Najít
                </button>
              </div>
              <p className="ig-muted">
                Hlavní výraz patří do názvu a prvního odstavce, otázky do FAQ na konci.
                Dá se přepsat — model se drží toho, co je tady.
              </p>
              <textarea rows={terms ? 9 : 3} value={terms} onChange={e => setTerms(e.target.value)}
                placeholder="Zatím nic — tlačítko Najít nechá model navrhnout výrazy k tématu." />
            </section>

            <section className="ar-card">
              <div className="ar-sec-head">
                <h3>Pokyny pro AI</h3>
                <button className="btn ghost" onClick={() => setShowPrompt(v => !v)}>
                  <Icon name={showPrompt ? 'chevDown' : 'chevRight'} size={13} />
                  {showPrompt ? 'Skrýt' : 'Upravit'}
                </button>
              </div>
              {showPrompt ? (
                <textarea rows={10} value={prompt} onChange={e => setPrompt(e.target.value)}
                  placeholder="Prázdné = styl článků z Nastavení" />
              ) : (
                <p className="ig-muted">
                  {prompt ? 'Tento článek má vlastní pokyny.' : 'Použije se styl článků z Nastavení.'}
                </p>
              )}
            </section>
          </div>
        </div>
      </div>

      <div className="modal-foot">
        <button className="btn ghost" onClick={saveOnly}>
          <Icon name="save" size={13} /> Uložit zadání
        </button>
        <span style={{ flex: 1 }} />
        {hasText && (
          <>
            <button className="btn ghost" onClick={translate} disabled={busy || !!working}>
              {working === 'translate' ? <span className="spinner-inline" /> : <Icon name="globe" size={13} />}
              Přeložit do chybějících
            </button>
            <button className="btn ghost" onClick={() => generate(true)} disabled={busy || !!working}>
              <Icon name="refresh" size={13} /> Napsat znovu
            </button>
          </>
        )}
        <button className="btn primary" onClick={() => generate(false)} disabled={busy || !!working}>
          {working === 'generate' ? <span className="spinner-inline" /> : <Icon name="sparkles" size={14} />}
          {hasText ? 'Dopsat chybějící jazyky' : 'Napsat článek'}
        </button>
      </div>

      {picker && (
        <ProductPicker
          selected={brief.products}
          onClose={() => setPicker(false)}
          onChange={codes => patchBrief({ products: codes })}
        />
      )}
    </>
  );
}

/* ==================== Výběr produktů ==================== */

/** Hledání v produktové databázi — stejná data, ze kterých se překládá. */
function ProductPicker({ selected, onChange, onClose }: {
  selected: string[];
  onChange: (codes: string[]) => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<PtransProduct[]>([]);
  const [loading, setLoading] = useState(false);
  const [picked, setPicked] = useState<string[]>(selected);

  useEffect(() => {
    setLoading(true);
    const timer = setTimeout(() => {
      api.ptrans.list({ search: query.trim() || undefined, state: 'all', limit: 40, offset: 0 })
        .then(page => setRows(page.rows))
        .catch(e => toast(e.message, 'error'))
        .finally(() => setLoading(false));
    }, 280);
    return () => clearTimeout(timer);
  }, [query, toast]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal ar-picker">
        <div className="modal-head">
          <div className="modal-title"><Icon name="bag" size={16} /> Produkty do článku</div>
          <span style={{ flex: 1 }} />
          <button className="icon-btn" onClick={onClose}><Icon name="x" size={16} /></button>
        </div>
        <div className="pt-filters">
          <div className="ig-search">
            <Icon name="search" size={14} />
            <input autoFocus value={query} onChange={e => setQuery(e.target.value)}
              placeholder="Hledat název nebo kód" />
          </div>
          <span className="ig-muted">Vybráno {picked.length}</span>
        </div>
        <div className="modal-body ar-picker-body">
          {loading && rows.length === 0 && <div className="ig-muted">Načítám…</div>}
          {rows.map(row => {
            const on = picked.includes(row.code);
            return (
              <button key={row.code} className={`ar-pick ${on ? 'on' : ''}`}
                onClick={() => setPicked(prev => on ? prev.filter(c => c !== row.code) : [...prev, row.code])}>
                {row.image ? <img src={row.image} alt="" /> : <span className="ar-prod-noimg"><Icon name="bag" size={14} /></span>}
                <div className="ar-prod-main">
                  <b>{row.title}</b>
                  <small className="ig-muted">{row.code} · {row.category}</small>
                </div>
                {on && <Icon name="check" size={15} />}
              </button>
            );
          })}
        </div>
        <div className="modal-foot">
          <span style={{ flex: 1 }} />
          <button className="btn ghost" onClick={onClose}>Zrušit</button>
          <button className="btn primary" onClick={() => { onChange(picked); onClose(); }}>
            <Icon name="check" size={13} /> Použít ({picked.length})
          </button>
        </div>
      </div>
    </div>
  );
}

/* ==================== Text ==================== */

/**
 * Text článku po jazycích.
 *
 * Vlevo náhled, vpravo pole. Náhled je iframe se `sandbox`, protože článek
 * obsahuje inline styly a skripty se strukturovanými daty — a ty do rozhraní
 * aplikace nesmí zasahovat.
 */
export function ArticleTextPanel({ article, langs, busy, onChanged }: {
  article: ArticleDetail;
  langs: Lang[];
  busy: boolean;
  onChanged: () => void;
}) {
  const toast = useToast();
  const available = article.versions.filter(v => v.long);
  const [lang, setLang] = useState(available[0]?.lang ?? article.sourceLang);
  const [mode, setMode] = useState<'preview' | 'html'>('preview');
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const first = article.versions.find(v => v.long)?.lang ?? article.sourceLang;
    if (!article.versions.find(v => v.lang === lang && v.long)) setLang(first);
  }, [article.id, article.versions.length]);

  const version = article.versions.find(v => v.lang === lang);
  useEffect(() => { setDraft({}); }, [lang, article.id]);

  const value = (field: string, fallback: string) => draft[field] ?? fallback;
  const dirty = Object.keys(draft).length > 0;

  const save = async () => {
    if (!version) return;
    setSaving(true);
    try {
      await api.articles.editVersion(article.id, lang, draft);
      setDraft({});
      toast('Uloženo');
      onChanged();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const translateHere = async () => {
    try {
      const result = await api.articles.translate(article.id, [lang], true);
      if (result.errors.length) toast(result.errors.join(' · '), 'error');
      else toast('Přeloženo');
      onChanged();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  if (!version || !version.long) {
    return (
      <div className="modal-body">
        <div className="ar-empty">
          <Icon name="pen" size={28} />
          <b>Tenhle jazyk zatím text nemá</b>
          <p className="ig-muted">
            V zadání ho vyber a dej „Napsat článek", nebo článek přelož ze zdrojového jazyka.
          </p>
          {available.length > 0 && (
            <button className="btn primary" onClick={translateHere} disabled={busy}>
              <Icon name="globe" size={13} /> Přeložit do {lang.toUpperCase()}
            </button>
          )}
        </div>
      </div>
    );
  }

  const html = value('long', version.long);
  const words = html.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
  const lengthOff = Math.abs(words - article.wordCount) > article.wordCount * 0.35;

  return (
    <>
      <div className="pt-filters ar-text-bar">
        <div className="ig-seg">
          {langs.map(item => {
            const has = article.versions.find(v => v.lang === item.code && v.long);
            return (
              <button key={item.code} className={lang === item.code ? 'active' : ''}
                onClick={() => setLang(item.code)}
                data-tip={has ? undefined : 'Zatím bez textu'}>
                {item.code.toUpperCase()}{has ? '' : ' ·'}
              </button>
            );
          })}
        </div>
        <div className="ig-seg">
          <button className={mode === 'preview' ? 'active' : ''} onClick={() => setMode('preview')}>Náhled</button>
          <button className={mode === 'html' ? 'active' : ''} onClick={() => setMode('html')}>HTML</button>
        </div>
        <span className={`ar-words ${lengthOff ? 'off' : ''}`}
          data-tip={`Zadaná délka byla ${article.wordCount} slov`}>
          {words} slov
        </span>
        <span style={{ flex: 1 }} />
        <button className="btn ghost" onClick={translateHere} disabled={busy}>
          <Icon name="refresh" size={13} /> Přeložit znovu
        </button>
      </div>

      <div className="modal-body ar-text">
        <div className="ar-text-fields">
          <label className="pt-block">
            <span>Název</span>
            <input value={value('title', version.title)}
              onChange={e => setDraft(d => ({ ...d, title: e.target.value }))} />
          </label>
          <label className="pt-block">
            <span>Krátký popis (do výpisu)</span>
            <textarea rows={2} value={value('short', version.short)}
              onChange={e => setDraft(d => ({ ...d, short: e.target.value }))} />
          </label>
          <div className="field-grid">
            <label>
              <span>SEO titulek</span>
              <input value={value('seo_title', version.seo_title)}
                onChange={e => setDraft(d => ({ ...d, seo_title: e.target.value }))} />
              <small>{value('seo_title', version.seo_title).length} / 60 znaků</small>
            </label>
            <label>
              <span>SEO adresa</span>
              <input value={value('seo_url', version.seo_url)}
                onChange={e => setDraft(d => ({ ...d, seo_url: e.target.value }))} />
              <small>článek bude na /a/{value('seo_url', version.seo_url)}</small>
            </label>
          </div>
          <label className="pt-block">
            <span>SEO popis</span>
            <textarea rows={2} value={value('seo_desc', version.seo_desc)}
              onChange={e => setDraft(d => ({ ...d, seo_desc: e.target.value }))} />
            <small>{value('seo_desc', version.seo_desc).length} / 155 znaků</small>
          </label>
        </div>

        {mode === 'html' ? (
          <textarea className="ar-html" value={html} spellCheck={false}
            onChange={e => setDraft(d => ({ ...d, long: e.target.value }))} />
        ) : (
          <iframe className="ar-preview" title="Náhled článku" sandbox="allow-same-origin"
            srcDoc={`<!doctype html><meta charset="utf-8"><base target="_blank">
              <style>body{margin:0;padding:18px;background:#fff}</style>${html}`} />
        )}
      </div>

      <div className="modal-foot">
        <span className="ig-muted">
          {version.state === 'translated' ? 'Přeloženo ze zdrojového jazyka'
            : version.state === 'imported' ? 'Načteno z e-shopu'
              : version.state === 'manual' ? 'Ručně upraveno' : 'Napsáno AI'}
        </span>
        <span style={{ flex: 1 }} />
        <button className="btn primary" onClick={save} disabled={!dirty || saving}>
          {saving ? <span className="spinner-inline" /> : <Icon name="save" size={13} />} Uložit změny
        </button>
      </div>
    </>
  );
}

/* ==================== Odkazy v článku ==================== */

/**
 * Odkazy v článku — automatická i ruční kontrola.
 *
 * Automatická kontrola umí říct jen to, že adresa nevrací 200. Neumí říct,
 * jestli odkaz míří tam, kam podle textu mířit má; a když e-shop pod náporem
 * dotazů neodpoví, vypadá funkční odkaz jako rozbitý. Proto jsou tu vedle
 * sebe **seznam** a **článek** s očíslovanými odkazy: v článku je vidět
 * souvislost a kliknutím se cíl otevře v prohlížeči, což je nejrychlejší
 * způsob, jak si ověřit, že je to opravdu ten produkt.
 *
 * Stavy jsou tři, ne dva. „Nepodařilo se ověřit" znamená, že o odkazu nevíme
 * nic — ne že je vadný. Automatická oprava se u něj proto nenabízí.
 */
export function ArticleLinksPanel({ article, langs, onChanged }: {
  article: ArticleDetail;
  langs: Lang[];
  onChanged: () => void;
}) {
  const toast = useToast();
  const [lang, setLang] = useState(article.versions.find(v => v.long)?.lang ?? article.sourceLang);
  const [review, setReview] = useState<ArticleReview | null>(null);
  const [mode, setMode] = useState<'list' | 'article'>('list');
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    try { setReview(await api.articles.review(article.id, lang)); }
    catch (e: any) { toast(e.message, 'error'); }
  }, [article.id, lang, toast]);

  useEffect(() => { load(); }, [load]);

  const check = async () => {
    setChecking(true);
    try {
      const rows = await api.articles.check({ articleIds: [article.id], langs: [lang] });
      await load();
      const bad = rows.filter(row => !row.unverified).length;
      const unknown = rows.length - bad;
      toast(bad || unknown
        ? `${bad} vadných${unknown ? `, ${unknown} se nepodařilo ověřit` : ''}`
        : 'Všechny odkazy fungují');
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setChecking(false);
    }
  };

  const fix = async (url: string, to: string) => {
    setBusy(url);
    try {
      await api.articles.fix(article.id, lang, url, to);
      await load();
      onChanged();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const dismiss = async (url: string) => {
    setBusy(url);
    try {
      await api.articles.dismissLink(article.id, lang, url);
      await load();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const links = review?.links ?? [];
  const broken = links.filter(link => link.status !== null && !link.unverified);
  const unknown = links.filter(link => link.unverified);

  return (
    <>
      <div className="pt-filters">
        <div className="ig-seg">
          {langs.map(item => (
            <button key={item.code} className={lang === item.code ? 'active' : ''}
              onClick={() => setLang(item.code)}>{item.code.toUpperCase()}</button>
          ))}
        </div>
        <div className="ig-seg">
          <button className={mode === 'list' ? 'active' : ''} onClick={() => setMode('list')}>Seznam</button>
          <button className={mode === 'article' ? 'active' : ''} onClick={() => setMode('article')}>V článku</button>
        </div>
        <span className="ig-muted">
          {links.length} odkazů
          {broken.length ? ` · ${broken.length} vadných` : ''}
          {unknown.length ? ` · ${unknown.length} neověřených` : ''}
        </span>
        <span style={{ flex: 1 }} />
        <button className="btn primary" onClick={check} disabled={checking}>
          {checking ? <span className="spinner-inline" /> : <Icon name="link" size={13} />}
          Zkontrolovat
        </button>
      </div>

      {mode === 'article' ? (
        <div className="modal-body ar-review">
          <p className="ig-muted">
            Odkazy jsou v textu očíslované a obarvené podle poslední kontroly. Kliknutím
            se cíl otevře v prohlížeči — je to nejrychlejší způsob, jak ověřit, že vede
            tam, kam má.
          </p>
          <iframe className="ar-preview" title="Článek s odkazy" sandbox="allow-same-origin allow-popups"
            srcDoc={`<!doctype html><meta charset="utf-8"><base target="_blank">
              <style>
                body{margin:0;padding:18px;background:#fff;font-family:-apple-system,system-ui,sans-serif}
                a[data-tone]{border-bottom:2px solid transparent}
                a[data-tone="ok"]{border-color:#2f9e6e}
                a[data-tone="bad"]{border-color:#e5484d;background:rgba(229,72,77,0.08)}
                a[data-tone="unknown"]{border-color:#d99a1b;background:rgba(217,154,27,0.10)}
                sup.lnk{font-size:10px;padding:0 3px;color:#666;font-weight:700}
              </style>${review?.html ?? ''}`} />
        </div>
      ) : (
        <div className="modal-body ar-links">
          {links.length === 0 && <div className="ig-muted">Článek zatím neodkazuje nikam.</div>}
          {links.map(link => {
            const tone = link.unverified ? 'unknown' : link.status !== null ? 'bad' : 'ok';
            return (
              <div key={link.index} className={`ar-link ${tone === 'ok' ? '' : tone}`}>
                <span className="ar-linknum">{link.index}</span>
                {tone === 'ok'
                  ? <span className="ar-status ok"><Icon name="check" size={12} /></span>
                  : <span className={`ar-status ${tone === 'unknown' ? 'warn' : 'bad'}`}>
                      {link.status ?? '?'}
                    </span>}
                <div className="ar-broken-main">
                  <div className="ar-broken-url">{link.url}</div>
                  <div className="ig-muted">
                    {link.text ? `„${link.text}"` : 'bez textu'}
                    {link.note ? ` · ${link.note}` : ''}
                  </div>
                  {link.suggestion && (
                    <div className="ar-fix"><Icon name="chevRight" size={12} /> <code>{link.suggestion}</code></div>
                  )}
                </div>
                {link.suggestion && (
                  <button className="btn ghost" disabled={busy === link.url}
                    onClick={() => fix(link.url, link.suggestion!)}>
                    <Icon name="check" size={13} /> Opravit
                  </button>
                )}
                {tone !== 'ok' && (
                  <button className="btn ghost" disabled={busy === link.url}
                    data-tip="Odkaz je ve skutečnosti v pořádku — vyřadit ho z hlášení"
                    onClick={() => dismiss(link.url)}>
                    <Icon name="x" size={13} /> Je v pořádku
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
