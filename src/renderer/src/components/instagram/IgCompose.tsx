import { useCallback, useEffect, useState } from 'react';
import type { IgOverview, IgPost, IgCaption } from '@shared/types';
import { api } from '../../api';
import { useToast } from '../../toast';
import Icon from '../Icon';
import { captionStats, fmtDate, marketColor, toIso, useFilePreview, useThumb } from './IgShared';

interface Props {
  overview: IgOverview;
  postId: number | null;
  onPostId: (id: number | null) => void;
  onGoQueue: () => void;
}

/**
 * Skládání příspěvku. Zadání a média nahoře, pod tím vygenerované popisky —
 * jeden sloupec na trh, aby šlo texty porovnat vedle sebe a ne po jednom.
 */
export default function IgCompose({ overview, postId, onPostId, onGoQueue }: Props) {
  const toast = useToast();
  const [post, setPost] = useState<IgPost | null>(null);
  const [drafts, setDrafts] = useState<IgPost[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const [brief, setBrief] = useState('');
  const [mediaNote, setMediaNote] = useState('');
  const [langs, setLangs] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [generating, setGenerating] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [when, setWhen] = useState('');
  const [republish, setRepublish] = useState(false);

  const isSourcePost = post?.kind === 'source';

  /** Trhy, na které se dá publikovat — mají připojený účet. */
  const targets = overview.markets.filter(m =>
    m.enabled && overview.accounts.some(a => a.lang === m.lang));

  /**
   * U přepisu se zdrojový trh nepředvybírá — tam příspěvek už vyšel. Zaškrtnout
   * si ho ale jde, když má vyjít znovu.
   */
  const defaultLangs = targets
    .filter(m => !(isSourcePost && overview.accounts.some(a => a.lang === m.lang && a.isSource)))
    .map(m => m.lang);
  const missing = overview.markets.filter(m =>
    m.enabled && m.lang !== 'CS' && !overview.accounts.some(a => a.lang === m.lang));

  const loadPost = useCallback(async (id: number) => {
    try {
      const p = await api.ig.post(id);
      if (!p) { onPostId(null); return; }
      setPost(p);
      setBrief(p.brief);
      setMediaNote(p.mediaNote);
      setFiles(p.media.filter(m => m.path).map(m => m.path));
      setWarnings(await api.ig.warnings(id));
      if (p.captions.length) setLangs(p.captions.map(c => c.lang));
    } catch (e: any) {
      toast(e.message, 'error');
    }
  }, [onPostId, toast]);

  useEffect(() => {
    if (postId == null) {
      setPost(null);
      api.ig.drafts().then(setDrafts).catch(() => {});
      return;
    }
    loadPost(postId);
  }, [postId, loadPost]);

  useEffect(() => api.on('ig:changed', () => {
    if (postId != null) loadPost(postId);
    else api.ig.drafts().then(setDrafts).catch(() => {});
  }), [postId, loadPost]);

  // Výchozí výběr trhů
  useEffect(() => {
    if (langs.length === 0 && defaultLangs.length > 0) setLangs(defaultLangs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overview.markets.length, overview.accounts.length, isSourcePost]);

  const pickFiles = async () => {
    const picked = await api.ig.pickMedia();
    if (picked.length === 0) return;
    const next = [...files, ...picked].slice(0, 10);
    setFiles(next);
    if (post) {
      const updated = await api.ig.updateDraft(post.id, { files: next });
      setPost(updated);
      setWarnings(await api.ig.warnings(post.id));
    }
  };

  const removeFile = async (file: string) => {
    const next = files.filter(f => f !== file);
    setFiles(next);
    if (post) {
      const updated = await api.ig.updateDraft(post.id, { files: next });
      setPost(updated);
      setWarnings(await api.ig.warnings(post.id));
    }
  };

  /** Vrátí příspěvek — buď existující, nebo nově založený z vybraných souborů. */
  const ensurePost = async (): Promise<IgPost> => {
    if (post) {
      const updated = await api.ig.updateDraft(post.id, { brief, mediaNote });
      setPost(updated);
      return updated;
    }
    if (files.length === 0) throw new Error('Vyber aspoň jednu fotku nebo video.');
    const created = await api.ig.createDraft(files, brief, mediaNote);
    setPost(created);
    onPostId(created.id);
    setWarnings(await api.ig.warnings(created.id));
    return created;
  };

  const generate = async () => {
    // Vybrané trhy se prořežou podle toho, co je v tuhle chvíli dostupné —
    // u přepisu například vypadne zdrojový účet
    const chosen = langs.filter(l => targets.some(t => t.lang === l));
    if (chosen.length === 0) { toast('Vyber aspoň jeden trh.', 'error'); return; }
    setGenerating(true);
    try {
      const target = await ensurePost();
      const updated = await api.ig.generate(target.id, chosen);
      setPost(updated);
      toast('Texty jsou hotové — projdi je a uprav, co nesedí.');
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setGenerating(false);
    }
  };

  /** Prázdná pole pro ruční psaní — bez modelu a bez čekání. */
  const writeOwn = async () => {
    const chosen = langs.filter(l => targets.some(t => t.lang === l));
    if (chosen.length === 0) { toast('Vyber aspoň jeden trh.', 'error'); return; }
    try {
      const target = await ensurePost();
      setPost(await api.ig.blankCaptions(target.id, chosen));
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const publishAll = async () => {
    if (!post) return;
    setPublishing(true);
    try {
      const at = when ? toIso(when) : null;
      const res = await api.ig.publishPost(post.id, at, republish);
      toast(at
        ? `Naplánováno ${res.queued} příspěvků na ${fmtDate(at)}.`
        : `Do fronty šlo ${res.queued} příspěvků.`);
      if (res.skipped.length) toast(res.skipped.join(' · '), 'error');
      onGoQueue();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setPublishing(false);
    }
  };

  const discard = async () => {
    if (!post) { setFiles([]); setBrief(''); setMediaNote(''); return; }
    await api.ig.deletePost(post.id);
    onPostId(null);
    toast('Koncept smazaný.');
  };

  const ready = post && post.captions.length > 0;

  return (
    <div className="ig-page">
      <div className="ig-head">
        <h2>{postId == null ? 'Nový příspěvek' : isSourcePost ? 'Přepis příspěvku' : 'Rozpracovaný příspěvek'}</h2>
        <div className="ig-head-tools">
          {post && <button className="btn ghost" onClick={discard}>Zahodit</button>}
          {postId != null && <button className="btn ghost" onClick={() => onPostId(null)}>Zpět na rozpracované</button>}
        </div>
      </div>

      <div className="ig-compose">
        <section className="ig-card">
          <h3>Média</h3>
          {isSourcePost ? (
            <div className="ig-source-media">
              <SourcePreview sourcePostId={post!.sourcePostId} />
              <div>
                <p className="ig-muted">Média zůstávají na Instagramu — přebírá se jen fotka a video z původního příspěvku.</p>
                {post!.sourcePermalink && (
                  <button className="btn ghost" onClick={() => api.shell.openUrl(post!.sourcePermalink!)}>
                    <Icon name="globe" size={13} /> Otevřít původní příspěvek
                  </button>
                )}
              </div>
            </div>
          ) : (
            <>
              <div className="ig-media-strip">
                {files.map(f => <FileChip key={f} file={f} onRemove={() => removeFile(f)} />)}
                <button className="ig-media-add" onClick={pickFiles}>
                  <Icon name="plus" size={18} />
                  <span>Přidat</span>
                </button>
              </div>
              {files.length > 1 && <p className="ig-muted">Víc souborů = karusel, pořadí odpovídá výběru.</p>}
            </>
          )}
          {warnings.map(w => (
            <div key={w} className="ig-warn"><Icon name="zap" size={13} /> {w}</div>
          ))}
        </section>

        <section className="ig-card">
          <h3>{isSourcePost ? 'Původní text' : 'Zadání'}</h3>
          {isSourcePost ? (
            <div className="ig-source-caption">{post!.sourceCaption || <span className="ig-muted">Původní příspěvek nemá popisek — doplň zadání níž.</span>}</div>
          ) : (
            <textarea
              rows={4}
              value={brief}
              onChange={e => setBrief(e.target.value)}
              placeholder="O čem příspěvek je, co má vypíchnout, k jaké příležitosti…"
            />
          )}
          <div className="field">
            <label>Poznámka k médiím <span className="ig-muted">(nepovinné)</span></label>
            <input
              value={mediaNote}
              onChange={e => setMediaNote(e.target.value)}
              placeholder="Co je na fotkách, čeho si má text všimnout"
            />
          </div>
        </section>

        <section className="ig-card">
          <h3>Trhy</h3>
          <div className="ig-market-picks">
            {targets.map(m => {
              const on = langs.includes(m.lang);
              return (
                <button
                  key={m.lang}
                  className={`ig-pick ${on ? 'active' : ''}`}
                  style={on ? { background: m.color, borderColor: m.color } : { color: m.color, borderColor: m.color }}
                  onClick={() => setLangs(on ? langs.filter(l => l !== m.lang) : [...langs, m.lang])}
                >
                  {m.lang} · {m.label}
                </button>
              );
            })}
          </div>
          {targets.length === 0 && (
            <p className="ig-muted">Zatím není připojený žádný cílový účet — udělej to v Účtech.</p>
          )}
          {missing.length > 0 && (
            <p className="ig-muted">Bez účtu: {missing.map(m => m.lang).join(', ')}</p>
          )}
          <div className="ig-actions">
            <button className="btn primary" onClick={generate} disabled={generating}>
              {generating
                ? <><span className="spinner-inline" /> Píšu texty…</>
                : <><Icon name="sparkles" size={14} /> {ready ? 'Vygenerovat znovu' : 'Vygenerovat texty'}</>}
            </button>
            <button className="btn ghost" onClick={writeOwn} disabled={generating}
              data-tip="Připraví prázdná pole pro každý vybraný trh — text napíšeš sám">
              <Icon name="pen" size={13} /> Napsat vlastní
            </button>
            <span className="ig-muted">
              {overview.brand.variants} {overview.brand.variants === 1 ? 'varianta' : 'varianty'} na trh
              {overview.brand.emoji === 'none' ? ' · bez emoji' : overview.brand.emoji === 'free' ? ' · emoji volně' : ' · emoji střídmě'}
            </span>
          </div>
        </section>

        {ready && (
          <section className="ig-card">
            <h3>Popisky</h3>
            <div className="ig-captions">
              {post!.captions.map(c => (
                <CaptionCard
                  key={c.id}
                  caption={c}
                  color={marketColor(overview.markets, c.lang)}
                  label={overview.markets.find(m => m.lang === c.lang)?.label ?? c.lang}
                  onChanged={() => loadPost(post!.id)}
                />
              ))}
            </div>

            <div className="ig-publish">
              <div className="field">
                <label>Naplánovat na</label>
                <div className="ig-when">
                  <input
                    type="datetime-local"
                    value={when}
                    onChange={e => setWhen(e.target.value)}
                  />
                  {when && <button className="btn ghost" onClick={() => setWhen('')}>Zrušit termín</button>}
                </div>
              </div>
              {post!.captions.some(c => c.status === 'published') && (
                <label className="ig-checkline" data-tip="Pošle i trhy, na kterých příspěvek už vyšel — vznikne tam druhý příspěvek">
                  <input type="checkbox" checked={republish} onChange={e => setRepublish(e.target.checked)} />
                  Publikovat znovu i tam, kde už vyšlo
                </label>
              )}
              <button className="btn primary" onClick={publishAll} disabled={publishing}>
                {publishing
                  ? <><span className="spinner-inline" /> Odesílám…</>
                  : when
                    ? <><Icon name="clock" size={14} /> Naplánovat všechny trhy</>
                    : <><Icon name="send" size={14} /> Publikovat na všechny trhy</>}
              </button>
            </div>
          </section>
        )}
      </div>

      {postId == null && drafts.length > 0 && (
        <div className="ig-drafts">
          <h3>Rozpracované</h3>
          {drafts.map(d => (
            <button key={d.id} className="ig-draft-row" onClick={() => onPostId(d.id)}>
              <span className="ig-draft-title">
                {d.kind === 'source' ? 'Přepis: ' : ''}
                {(d.brief || d.sourceCaption || 'Bez zadání').slice(0, 90)}
              </span>
              <span className="ig-muted">{d.captions.length} {d.captions.length === 1 ? 'trh' : 'trhy'} · {fmtDate(d.createdAt)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SourcePreview({ sourcePostId }: { sourcePostId: number | null }) {
  const thumb = useThumb(sourcePostId);
  return (
    <div className="ig-thumb-lg">
      {thumb ? <img src={thumb} alt="" /> : <Icon name="image" size={22} />}
    </div>
  );
}

function FileChip({ file, onRemove }: { file: string; onRemove: () => void }) {
  const preview = useFilePreview(file);
  const name = file.split('/').pop() ?? file;
  const isVideo = /\.(mp4|mov|m4v)$/i.test(file);
  return (
    <div className="ig-file" title={name}>
      {preview
        ? <img src={preview} alt="" />
        : <span className="ig-file-ph"><Icon name={isVideo ? 'zap' : 'image'} size={18} /></span>}
      <button className="ig-file-x" onClick={onRemove} title="Odebrat"><Icon name="x" size={12} /></button>
      {isVideo && <span className="ig-badge">video</span>}
    </div>
  );
}

function CaptionCard({ caption, color, label, onChanged }: {
  caption: IgCaption; color: string; label: string; onChanged: () => void;
}) {
  const toast = useToast();
  const [text, setText] = useState(caption.text);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setText(caption.text); }, [caption.text]);

  const stats = captionStats(text);
  const published = caption.status === 'published';

  const pick = async (i: number) => {
    await api.ig.chooseVariant(caption.id, i);
    onChanged();
  };

  const save = async () => {
    if (text === caption.text) return;
    setSaving(true);
    try {
      await api.ig.editCaption(caption.id, text);
      onChanged();
    } finally {
      setSaving(false);
    }
  };

  const publishOne = async () => {
    try {
      await api.ig.publish(caption.id, null);
      toast(`${caption.lang} šel do fronty.`);
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  return (
    <div className="ig-caption">
      <div className="ig-caption-head">
        <span className="ig-lang ig-lang-done" style={{ background: color, borderColor: color }}>{caption.lang}</span>
        <span className="ig-muted">{label}</span>
        {published && <span className="ig-tag-done">publikováno</span>}
        {caption.variants.length > 1 && (
          <span className="ig-variants">
            {caption.variants.map((_, i) => (
              <button
                key={i}
                className={i === caption.chosen && !caption.edited ? 'active' : ''}
                onClick={() => pick(i)}
              >{i + 1}</button>
            ))}
          </span>
        )}
      </div>
      <textarea
        rows={8}
        value={text}
        onChange={e => setText(e.target.value)}
        onBlur={save}
      />
      <div className="ig-caption-foot">
        <span className={stats.over ? 'ig-over' : 'ig-muted'}>
          {stats.chars} / 2200 znaků · {stats.tags} / 30 hashtagů
        </span>
        <span className="ig-caption-actions">
          {saving && <span className="ig-muted">ukládám…</span>}
          {caption.edited && !published && <span className="ig-muted">ručně upraveno</span>}
          <button className="btn ghost" onClick={publishOne} disabled={stats.over}
            data-tip={published ? 'Vyjde na tomhle trhu ještě jednou' : undefined}>
            <Icon name="send" size={13} /> {published ? 'Publikovat znovu' : 'Jen tento trh'}
          </button>
        </span>
      </div>
    </div>
  );
}
