import { useCallback, useEffect, useState } from 'react';
import type { AccountPublic, AccountConfig, Settings, CategoryRule, Category, KnowledgeDoc, Person, FeedStatus, MailLang,
  OrderFeed, OrderFeedStatus, OrderStats, LiveStatus, ShorthandRow } from '@shared/types';
import { CATEGORY_LABELS } from '@shared/types';
import { api } from '../api';
import { useToast } from '../toast';
import Icon from './Icon';
import { buildBrandSignature, DEFAULT_SIG_CONFIG } from '../signature';

type Tab = 'accounts' | 'persons' | 'ai' | 'knowledge' | 'rules' | 'sync' | 'phone';

interface SyncCfg { folder: string | null; enabled: boolean; lastRun: string | null; lastResult: string | null }

const EMPTY_ACCOUNT: AccountConfig = {
  name: 'Quentino',
  email: '',
  imapHost: '',
  imapPort: 993,
  imapSecure: true,
  smtpHost: '',
  smtpPort: 465,
  smtpSecure: true,
  username: '',
  password: '',
  signatureHtml: '',
  sigConfig: null,
  logoPath: null,
  color: '#7c5cff'
};

/** Kulatý náhled fotky osoby (v UI; v e-mailu se řeší inline styly). */
function PersonAvatar({ person, size = 40 }: { person: Person; size?: number }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (person.photoPath) {
      api.files.readAsDataUrl(person.photoPath).then(u => { if (!cancelled) setUrl(u); }).catch(() => {});
    } else {
      setUrl(null);
    }
    return () => { cancelled = true; };
  }, [person.photoPath]);
  if (url) {
    return <img src={url} alt={person.name} style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />;
  }
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%', background: 'var(--accent-soft)', color: 'var(--accent-dark)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, flexShrink: 0
    }}>{person.name.charAt(0).toUpperCase()}</div>
  );
}

interface Props {
  accounts: AccountPublic[];
  onClose: () => void;
  onAccountsChanged: () => void;
  onSettingsChanged: () => void;
}

export default function SettingsModal(p: Props) {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>(p.accounts.length === 0 ? 'accounts' : 'ai');
  /** Verze běžící aplikace — po vydání je dobré vidět, jestli běží to nové */
  const [version, setVersion] = useState('');

  useEffect(() => {
    api.app.version().then(info => setVersion(info.version)).catch(() => {});
  }, []);

  const freshSigConfig = (email = '') => ({
    ...DEFAULT_SIG_CONFIG,
    names: { ...DEFAULT_SIG_CONFIG.names },
    emails: { cz: email, sk: email, en: email },
    taglines: { ...DEFAULT_SIG_CONFIG.taglines },
    webs: { ...DEFAULT_SIG_CONFIG.webs }
  });
  const [editing, setEditing] = useState<AccountConfig | null>(
    p.accounts.length === 0 ? { ...EMPTY_ACCOUNT, sigConfig: freshSigConfig() } : null
  );
  const [settings, setSettings] = useState<Settings | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  /** Panel pro heslo k záloze — 'export' při ukládání, 'unlock' při obnově zamčeného souboru */
  const [backupBox, setBackupBox] = useState<'export' | 'unlock' | null>(null);
  const [backupPass, setBackupPass] = useState('');
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [sigPrevLang, setSigPrevLang] = useState<MailLang>('cz');
  const [knowledge, setKnowledge] = useState<KnowledgeDoc[]>([]);
  const [editingDoc, setEditingDoc] = useState<{ id?: number; title: string; content: string } | null>(null);
  const [persons, setPersons] = useState<Person[]>([]);
  const [feed, setFeed] = useState<FeedStatus | null>(null);
  const [aiUsage, setAiUsage] = useState<{ month: string; calls: number; inputTokens: number; outputTokens: number; estUsd: number } | null>(null);
  const [syncCfg, setSyncCfg] = useState<SyncCfg | null>(null);
  const [upgates, setUpgates] = useState<{ url: string; login: string; hasKey: boolean } | null>(null);
  const [upgatesKeyInput, setUpgatesKeyInput] = useState('');
  const [editingPerson, setEditingPerson] = useState<{
    id?: number; name: string;
    positions: { cz: string; sk: string; en: string };
    displayNames: { cz: string; sk: string; en: string };
    photoPath: string | null;
  } | null>(null);
  const [personPhotoPreview, setPersonPhotoPreview] = useState<string | null>(null);
  /** SQL pro Supabase — ukazuje se až na vyžádání, je to dlouhé */
  const [chatSql, setChatSql] = useState<string | null>(null);
  /** Stav živého propojení telefonu a počítače */
  const [live, setLive] = useState<LiveStatus>({
    enabled: false, channel: '', connected: false, error: null
  });
  const [sqlCopied, setSqlCopied] = useState(false);

  useEffect(() => {
    api.settings.get().then(setSettings).catch(() => {});
    api.knowledge.list().then(setKnowledge).catch(() => {});
    api.persons.list().then(setPersons).catch(() => {});
    api.products.status().then(setFeed).catch(() => {});
    api.ai.usage().then(setAiUsage).catch(() => {});
    api.appsync.get().then(setSyncCfg).catch(() => {});
    api.upgates.config().then(setUpgates).catch(() => {});
    api.live.status().then(setLive).catch(() => {});
  }, []);

  // Spojení se navazuje na pozadí, takže se stav hlásí sám
  useEffect(() => api.on('live:state', (s: LiveStatus) => setLive(s)), []);

  useEffect(() => {
    if (editing?.logoPath) {
      api.files.readAsDataUrl(editing.logoPath).then(setLogoPreview).catch(() => setLogoPreview(null));
    } else {
      setLogoPreview(null);
    }
  }, [editing?.logoPath]);

  useEffect(() => {
    if (editingPerson?.photoPath) {
      api.files.readAsDataUrl(editingPerson.photoPath).then(setPersonPhotoPreview).catch(() => setPersonPhotoPreview(null));
    } else {
      setPersonPhotoPreview(null);
    }
  }, [editingPerson?.photoPath]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try { await fn(); } catch (e: any) { toast(e.message, 'error'); } finally { setBusy(null); }
  };

  const set = (patch: Partial<AccountConfig>) => setEditing(e => (e ? { ...e, ...patch } : e));

  const testAccount = () => run('test', async () => {
    if (!editing) return;
    await api.accounts.test({
      imapHost: editing.imapHost, imapPort: editing.imapPort, imapSecure: editing.imapSecure,
      smtpHost: editing.smtpHost, smtpPort: editing.smtpPort, smtpSecure: editing.smtpSecure,
      username: editing.username, password: editing.password ?? ''
    });
    toast('Připojení k IMAP i SMTP funguje.');
  });

  const saveAccount = () => run('save', async () => {
    if (!editing) return;
    if (!editing.email || !editing.imapHost || !editing.smtpHost || !editing.username) {
      toast('Vyplň e-mail, servery a přihlašovací jméno.', 'error');
      return;
    }
    await api.accounts.save(editing);
    toast('Účet uložen.');
    setEditing(null);
    p.onAccountsChanged();
  });

  const pickLogo = () => run('logo', async () => {
    const path = await api.files.pickImage();
    if (path) set({ logoPath: path });
  });

  /** Zajistí, že účet má inicializovaný strukturovaný podpis (s e-mailem účtu). */
  const openAccountEditor = (acc: AccountConfig) => {
    setEditing({ ...acc, sigConfig: acc.sigConfig ?? freshSigConfig(acc.email) });
  };

  const setSig = (patch: Partial<NonNullable<AccountConfig['sigConfig']>>) =>
    setEditing(e => (e && e.sigConfig ? { ...e, sigConfig: { ...e.sigConfig, ...patch } } : e));

  /**
   * Nastavení telefonu se ukládá rovnou při změně.
   *
   * Záložka nemá vlastní tlačítko „Uložit" a mít ho tu nemusí — jenže tím se
   * vygenerované téma po zavření okna ztrácelo, protože jediné ukládání
   * v okně visí na tlačítku v záložce AI. Zápis do databáze je levný, tak se
   * dělá hned; nic se nemá kde ztratit.
   */
  const saveNotify = (patch: Partial<Settings>) => {
    setSettings(s => (s ? { ...s, ...patch } : s));
    void api.settings.save(patch).catch((e: any) => toast(e.message, 'error'));
  };

  const saveAi = () => run('saveAi', async () => {
    if (!settings) return;
    await api.settings.save({
      ...(apiKeyInput ? { anthropicApiKey: apiKeyInput } : {}),
      brandPrompt: settings.brandPrompt,
      draftModel: settings.draftModel,
      fastModel: settings.fastModel,
      autoSummarize: settings.autoSummarize,
      autoCategorize: settings.autoCategorize,
      autoTranslate: settings.autoTranslate,
      loadRemoteImages: settings.loadRemoteImages,
      notifyNewMail: settings.notifyNewMail,
      autoSummarizeCategories: settings.autoSummarizeCategories,
      contactInfo: settings.contactInfo,
      productFeedUrl: settings.productFeedUrl,
      adminOrderRef: settings.adminOrderRef,
      voucherLogo: settings.voucherLogo,
      theme: settings.theme
    });
    setApiKeyInput('');
    toast('Nastavení AI uloženo.');
    setSettings(await api.settings.get());
    p.onSettingsChanged();
  });

  const saveRules = () => run('saveRules', async () => {
    if (!settings) return;
    await api.settings.save({ categoryRules: settings.categoryRules });
    toast('Pravidla uložena.');
    p.onSettingsChanged();
  });

  const updateRule = (i: number, patch: Partial<CategoryRule>) => {
    setSettings(s => s ? { ...s, categoryRules: s.categoryRules.map((r, j) => (j === i ? { ...r, ...patch } : r)) } : s);
  };

  const toggleSummarizeCat = (c: Category) => {
    setSettings(s => {
      if (!s) return s;
      const has = s.autoSummarizeCategories.includes(c);
      return { ...s, autoSummarizeCategories: has ? s.autoSummarizeCategories.filter(x => x !== c) : [...s.autoSummarizeCategories, c] };
    });
  };

  const saveDoc = () => run('saveDoc', async () => {
    if (!editingDoc || !editingDoc.title.trim()) { toast('Vyplň název dokumentu.', 'error'); return; }
    setKnowledge(await api.knowledge.save(editingDoc));
    setEditingDoc(null);
    toast('Dokument uložen — AI ho od teď používá při návrzích odpovědí.');
  });

  const importDoc = () => run('import', async () => {
    const res = await api.knowledge.importFile();
    if (res) setEditingDoc(res);
  });

  const savePerson = () => run('savePerson', async () => {
    if (!editingPerson || !editingPerson.name.trim()) { toast('Vyplň jméno osoby.', 'error'); return; }
    setPersons(await api.persons.save(editingPerson));
    setEditingPerson(null);
    toast('Osoba uložena — vybereš ji při psaní zprávy v poli „Podepsán".');
  });

  const setDefaultPerson = (id: number | null) => run('defPerson', async () => {
    await api.settings.save({ defaultPersonId: id });
    setSettings(await api.settings.get());
    p.onSettingsChanged();
    toast(id ? 'Výchozí osoba nastavena.' : 'Výchozí osoba zrušena.');
  });

  /** Po importu je potřeba přenačíst všechno, co se mohlo změnit. */
  const reloadAfterImport = async (msg: string) => {
    toast(msg);
    setSettings(await api.settings.get());
    setKnowledge(await api.knowledge.list());
    setPersons(await api.persons.list());
    p.onAccountsChanged();
    p.onSettingsChanged();
  };

  const exportCfg = () => run('export', async () => {
    const path = await api.config.export(backupPass.trim() || undefined);
    if (!path) return;
    setBackupBox(null);
    setBackupPass('');
    toast(backupPass.trim()
      ? 'Záloha uložena a zamčená heslem — obsahuje účty, hesla, klíče i obrázky.'
      : 'Záloha uložena — obsahuje účty, hesla, klíče i obrázky. Ulož ji na bezpečné místo.');
  });

  const importCfg = () => run('importCfg', async () => {
    const res = await api.config.import();
    if (!res) return;
    if (res.needPassphrase) {
      setBackupBox('unlock');
      setBackupPass('');
      toast('Záloha je zamčená heslem — zadej ho níž.');
      return;
    }
    if (res.message) await reloadAfterImport(res.message);
  });

  const unlockImport = () => run('importCfg', async () => {
    const res = await api.config.importUnlock(backupPass);
    setBackupBox(null);
    setBackupPass('');
    await reloadAfterImport(res.message);
  });

  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) p.onClose(); }}>
      <div className="modal">
        <div className="modal-head">
          <span>Nastavení</span>
          {/* Po vydání je užitečné vidět, jestli běží to, co se právě sestavilo */}
          <span className="set-version">{version ? `verze ${version}` : ''}</span>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <button className="toolbar-btn" disabled={busy === 'export'}
              onClick={() => { setBackupBox('export'); setBackupPass(''); }}
              data-tip="Kompletní záloha: účty s hesly, API klíče, podpisy, loga i fotky">
              <Icon name="download" size={14} /> Záloha
            </button>
            <button className="toolbar-btn" disabled={busy === 'importCfg'} onClick={importCfg} data-tip="Obnovit vše ze souboru se zálohou">
              <Icon name="upload" size={14} /> Obnovit
            </button>
            <button className="icon-btn" data-tip="Zavřít nastavení" onClick={p.onClose}><Icon name="x" size={15} /></button>
          </div>
        </div>

        {backupBox && (
          <div className="backup-box">
            <div className="backup-title">
              <Icon name="ban" size={13} />
              {backupBox === 'export'
                ? 'Záloha obsahuje hesla k účtům i API klíče. Můžeš ji zamknout heslem (nepovinné, ale doporučené).'
                : 'Tahle záloha je zamčená — zadej heslo, kterým jsi ji vytvořil.'}
            </div>
            <div className="backup-row">
              <input
                type="password"
                autoFocus
                value={backupPass}
                onChange={e => setBackupPass(e.target.value)}
                placeholder={backupBox === 'export' ? 'Heslo k záloze (nech prázdné = bez hesla)' : 'Heslo k záloze'}
                onKeyDown={e => { if (e.key === 'Enter') (backupBox === 'export' ? exportCfg() : unlockImport()); }}
              />
              <button className="btn primary"
                disabled={busy === 'export' || busy === 'importCfg' || (backupBox === 'unlock' && !backupPass)}
                onClick={() => (backupBox === 'export' ? exportCfg() : unlockImport())}>
                {backupBox === 'export' ? 'Uložit zálohu' : 'Odemknout a obnovit'}
              </button>
              <button className="btn ghost" onClick={() => { setBackupBox(null); setBackupPass(''); }}>Zrušit</button>
            </div>
          </div>
        )}
        <div className="tabs">
          <button className={`tab ${tab === 'accounts' ? 'active' : ''}`} onClick={() => setTab('accounts')}>Účty a podpisy</button>
          <button className={`tab ${tab === 'persons' ? 'active' : ''}`} onClick={() => setTab('persons')}>Osoby</button>
          <button className={`tab ${tab === 'ai' ? 'active' : ''}`} onClick={() => setTab('ai')}>AI</button>
          <button className={`tab ${tab === 'knowledge' ? 'active' : ''}`} onClick={() => setTab('knowledge')}>Znalosti</button>
          <button className={`tab ${tab === 'rules' ? 'active' : ''}`} onClick={() => setTab('rules')}>Třídění</button>
          <button className={`tab ${tab === 'sync' ? 'active' : ''}`} onClick={() => setTab('sync')}>Sync</button>
          <button className={`tab ${tab === 'phone' ? 'active' : ''}`} onClick={() => setTab('phone')}>Telefon</button>
        </div>

        <div className="modal-body">
          {/* ===================== ÚČTY ===================== */}
          {tab === 'accounts' && !editing && (
            <>
              {p.accounts.map(a => (
                <div key={a.id} className="account-list-item">
                  <span className="account-dot" style={{ background: a.color }} />
                  <div className="grow">
                    <div style={{ fontWeight: 600 }}>{a.name}</div>
                    <div className="mail">{a.email} · {a.imapHost}</div>
                  </div>
                  <button className="btn ghost" onClick={() => openAccountEditor({ ...a, password: '' })}>Upravit</button>
                  <button className="btn danger" onClick={() => run('del', async () => {
                    if (confirm(`Smazat účet ${a.email} včetně lokálních dat?`)) {
                      await api.accounts.delete(a.id);
                      p.onAccountsChanged();
                    }
                  })}>Smazat</button>
                </div>
              ))}
              <button className="btn primary" style={{ alignSelf: 'flex-start' }} onClick={() => openAccountEditor({ ...EMPTY_ACCOUNT })}>
                <Icon name="plus" size={14} /> Přidat účet
              </button>
            </>
          )}

          {tab === 'accounts' && editing && (
            <>
              <div className="field-grid">
                <div className="field"><label>Název (zobrazované jméno)</label>
                  <input value={editing.name} onChange={e => set({ name: e.target.value })} /></div>
                <div className="field"><label>E-mailová adresa</label>
                  <input value={editing.email} onChange={e => set({ email: e.target.value })} placeholder="info@quentino.cz" /></div>
                <div className="field"><label>IMAP server</label>
                  <input value={editing.imapHost} onChange={e => set({ imapHost: e.target.value })} placeholder="imap.hosting.cz" /></div>
                <div className="field"><label>IMAP port</label>
                  <input type="number" value={editing.imapPort} onChange={e => set({ imapPort: Number(e.target.value) })} /></div>
                <div className="field"><label>SMTP server</label>
                  <input value={editing.smtpHost} onChange={e => set({ smtpHost: e.target.value })} placeholder="smtp.hosting.cz" /></div>
                <div className="field"><label>SMTP port</label>
                  <input type="number" value={editing.smtpPort} onChange={e => set({ smtpPort: Number(e.target.value) })} /></div>
                <div className="field"><label>Přihlašovací jméno</label>
                  <input value={editing.username} onChange={e => set({ username: e.target.value })} /></div>
                <div className="field"><label>Heslo {editing.id ? '(prázdné = beze změny)' : ''}</label>
                  <input type="password" value={editing.password ?? ''} onChange={e => set({ password: e.target.value })} /></div>
              </div>
              <label className="check-row">
                <input type="checkbox" checked={editing.imapSecure} onChange={e => set({ imapSecure: e.target.checked })} />
                IMAP přes SSL/TLS (port 993)
              </label>
              <label className="check-row">
                <input type="checkbox" checked={editing.smtpSecure} onChange={e => set({ smtpSecure: e.target.checked })} />
                SMTP přes SSL/TLS (port 465; vypnuto = STARTTLS na 587)
              </label>

              {editing.sigConfig && (
                <div className="field" style={{ borderTop: '1px solid var(--border)', paddingTop: 14 }}>
                  <label><Icon name="pen" size={13} /> Podpis značky</label>
                  <div className="desc">
                    Podpis se do e-mailu vkládá vždy v jazyce zprávy (CZ/SK/EN) — slogan i doména se
                    přepnou automaticky. Logo se vkládá přímo do zprávy a zachovává poměr stran.
                    Osoby s fotkou spravuješ v záložce „Osoby".
                  </div>
                  <div className="field" style={{ marginTop: 6 }}>
                    <label>Telefon (společný pro všechny jazyky)</label>
                    <input value={editing.sigConfig.phone} placeholder="+420 777 123 456"
                      onChange={e => setSig({ phone: e.target.value })} style={{ maxWidth: 260 }} />
                  </div>
                  {([
                    ['names', 'Jméno / značka podle jazyka', { cz: 'Quentino', sk: 'Quentino', en: 'Quentino' }],
                    ['emails', 'E-mail v podpisu podle jazyka', { cz: 'info@quentino.cz', sk: 'info@quentino.sk', en: 'info@wearquentino.com' }],
                    ['taglines', 'Slogan podle jazyka', { cz: 'S láskou zabaleno 💛', sk: 'S láskou zabalené 💛', en: 'Packed with love 💛' }],
                    ['webs', 'Web podle jazyka', { cz: 'quentino.cz', sk: 'quentino.sk', en: 'wearquentino.com' }]
                  ] as const).map(([key, label, ph]) => (
                    <div className="field" key={key}>
                      <label>{label}</label>
                      <div className="field-grid" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
                        {(['cz', 'sk', 'en'] as MailLang[]).map(l => (
                          <div className="field" key={l}><label>{l.toUpperCase()}</label>
                            <input value={editing.sigConfig![key][l]} placeholder={ph[l]}
                              onChange={e => setSig({ [key]: { ...editing.sigConfig![key], [l]: e.target.value } } as any)} /></div>
                        ))}
                      </div>
                    </div>
                  ))}
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
                    <button className="btn ghost" disabled={busy === 'logo'} onClick={pickLogo}>
                      <Icon name="image" size={14} /> {editing.logoPath ? 'Změnit logo' : 'Nahrát logo'}
                    </button>
                    {logoPreview && <img className="sig-logo-preview" src={logoPreview} alt="logo" />}
                    {editing.logoPath && (
                      <button className="btn ghost" onClick={() => set({ logoPath: null })}>Odebrat logo</button>
                    )}
                  </div>
                  <div className="field" style={{ marginTop: 4 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      Náhled podpisu
                      <span className="lang-switch">
                        {(['cz', 'sk', 'en'] as MailLang[]).map(l => (
                          <button key={l} className={`lang-btn ${sigPrevLang === l ? 'active' : ''}`}
                            onClick={() => setSigPrevLang(l)}>{l.toUpperCase()}</button>
                        ))}
                      </span>
                    </label>
                    <div className="signature-preview" style={{ maxHeight: 160 }}
                      dangerouslySetInnerHTML={{
                        __html: (() => {
                          let html = buildBrandSignature(editing.sigConfig!, sigPrevLang, editing.color, !!editing.logoPath);
                          if (logoPreview) html = html.replaceAll('cid:sig-logo', logoPreview);
                          else html = html.replace(/<img[^>]*cid:sig-logo[^>]*>/gi, '');
                          return html;
                        })()
                      }} />
                  </div>
                </div>
              )}
              <div className="field">
                <label>Barva účtu (použije se i v podpisu)</label>
                <input type="color" value={editing.color} onChange={e => set({ color: e.target.value })} style={{ width: 60, padding: 2, height: 32 }} />
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn ghost" disabled={busy === 'test'} onClick={testAccount}>
                  {busy === 'test' ? <span className="spinner-inline" /> : null} Otestovat připojení
                </button>
                <span style={{ flex: 1 }} />
                <button className="btn ghost" onClick={() => setEditing(null)}>Zpět</button>
                <button className="btn primary" disabled={busy === 'save'} onClick={saveAccount}>Uložit účet</button>
              </div>
            </>
          )}

          {/* ===================== OSOBY ===================== */}
          {tab === 'persons' && !editingPerson && (
            <>
              <div className="desc" style={{ fontSize: 12.5, color: 'var(--text-2)' }}>
                Osoby se přidávají do podpisu e-mailu — kulatá fotka, jméno a pozice. Při psaní zprávy
                vybereš osobu v poli „Podepsán" a podpis lze před odesláním ještě upravit.
              </div>
              {persons.length === 0 && (
                <div className="empty-state" style={{ padding: '30px 20px' }}>
                  <div className="big"><Icon name="users" size={32} /></div>
                  Zatím žádné osoby
                </div>
              )}
              {persons.map(person => {
                const isDefault = settings?.defaultPersonId === person.id;
                return (
                  <div key={person.id} className="account-list-item">
                    <PersonAvatar person={person} />
                    <div className="grow">
                      <div style={{ fontWeight: 600 }}>
                        {person.name}
                        {isDefault && <span className="cat-chip cat-other" style={{ marginLeft: 8 }}>výchozí</span>}
                      </div>
                      <div className="mail">
                        {[person.positions.cz, person.positions.sk, person.positions.en].filter(Boolean).join(' / ') || '—'}
                      </div>
                    </div>
                    <button className="icon-btn" data-tip={isDefault ? 'Zrušit výchozí' : 'Nastavit jako výchozí pro nové maily a odpovědi'}
                      style={isDefault ? { color: 'var(--warn)' } : undefined}
                      onClick={() => setDefaultPerson(isDefault ? null : person.id)}>
                      <Icon name="star" size={15} filled={isDefault} />
                    </button>
                    <button className="btn ghost" onClick={() => setEditingPerson({ id: person.id, name: person.name, positions: { ...person.positions }, displayNames: { ...person.displayNames }, photoPath: person.photoPath })}>Upravit</button>
                    <button className="btn danger" onClick={() => run('delPerson', async () => setPersons(await api.persons.delete(person.id)))}>Smazat</button>
                  </div>
                );
              })}
              <button className="btn primary" style={{ alignSelf: 'flex-start' }}
                onClick={() => setEditingPerson({ name: '', positions: { cz: '', sk: '', en: '' }, displayNames: { cz: '', sk: '', en: '' }, photoPath: null })}>
                <Icon name="plus" size={14} /> Přidat osobu
              </button>
            </>
          )}

          {tab === 'persons' && editingPerson && (
            <>
              <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
                {personPhotoPreview
                  ? <img src={personPhotoPreview} alt="" style={{ width: 72, height: 72, borderRadius: '50%', objectFit: 'cover' }} />
                  : <div style={{ width: 72, height: 72, borderRadius: '50%', background: 'var(--accent-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--accent-dark)' }}><Icon name="user" size={28} /></div>}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <button className="btn ghost" onClick={() => run('photo', async () => {
                    const path = await api.files.pickImage();
                    if (path) setEditingPerson(x => x ? { ...x, photoPath: path } : x);
                  })}>
                    <Icon name="image" size={14} /> {editingPerson.photoPath ? 'Změnit fotku' : 'Nahrát fotku'}
                  </button>
                  {editingPerson.photoPath && (
                    <button className="btn ghost" onClick={() => setEditingPerson(x => x ? { ...x, photoPath: null } : x)}>Odebrat fotku</button>
                  )}
                </div>
              </div>
              <div className="field">
                <label>Jméno</label>
                <input value={editingPerson.name} onChange={e => setEditingPerson(x => x ? { ...x, name: e.target.value } : x)} placeholder="Patrik Tokoš" />
              </div>
              <div className="field">
                <label>Pozice (podle jazyka e-mailu se použije správná varianta)</label>
                <div className="field-grid" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
                  <div className="field"><label>🇨🇿 CZ</label>
                    <input value={editingPerson.positions.cz} placeholder="majitel"
                      onChange={e => setEditingPerson(x => x ? { ...x, positions: { ...x.positions, cz: e.target.value } } : x)} /></div>
                  <div className="field"><label>🇸🇰 SK</label>
                    <input value={editingPerson.positions.sk} placeholder="majiteľ"
                      onChange={e => setEditingPerson(x => x ? { ...x, positions: { ...x.positions, sk: e.target.value } } : x)} /></div>
                  <div className="field"><label>🇬🇧 EN</label>
                    <input value={editingPerson.positions.en} placeholder="owner"
                      onChange={e => setEditingPerson(x => x ? { ...x, positions: { ...x.positions, en: e.target.value } } : x)} /></div>
                </div>
                <div className="desc">Prázdná varianta = použije se česká. Fotka se do e-mailu vkládá přímo (CID) a zobrazí se kulatá — doporučujeme čtvercový výřez.</div>
              </div>
              <div className="field">
                <label>Zobrazované jméno odesílatele (co příjemce uvidí jako „Od")</label>
                <div className="field-grid" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
                  {(() => {
                    const first = editingPerson.name.split(' ')[0] || 'Petra';
                    const ph = { cz: `${first} z Quentino`, sk: `${first} z Quentino`, en: `${first} from Quentino` };
                    return (['cz', 'sk', 'en'] as const).map(l => (
                      <div className="field" key={l}><label>{l.toUpperCase()}</label>
                        <input value={editingPerson.displayNames[l]} placeholder={ph[l]}
                          onChange={e => setEditingPerson(x => x ? { ...x, displayNames: { ...x.displayNames, [l]: e.target.value } } : x)} /></div>
                    ));
                  })()}
                </div>
                <div className="desc">Prázdné = doplní se automaticky „Jméno z/from Značka" podle jazyka mailu.</div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn ghost" onClick={() => setEditingPerson(null)}>Zpět</button>
                <button className="btn primary" disabled={busy === 'savePerson'} onClick={savePerson}>Uložit osobu</button>
              </div>
            </>
          )}

          {/* ===================== AI ===================== */}
          {tab === 'ai' && settings && (
            <>
              <div className="field">
                <label>Anthropic API klíč {settings.hasApiKey ? '· nastaven ✓' : '· nenastaven'}</label>
                <input
                  type="password"
                  value={apiKeyInput}
                  onChange={e => setApiKeyInput(e.target.value)}
                  placeholder={settings.hasApiKey ? '••••••••  (vyplň jen pro změnu)' : 'sk-ant-…'}
                />
                <div className="desc">Klíč získáš na console.anthropic.com. Ukládá se šifrovaně v systémové keychain.</div>
              </div>
              {aiUsage && (
                <div className="usage-box">
                  <b>Spotřeba AI tento měsíc ({aiUsage.month})</b><br />
                  {aiUsage.calls} volání · {(aiUsage.inputTokens / 1000).toFixed(0)}k vstupních + {(aiUsage.outputTokens / 1000).toFixed(0)}k výstupních tokenů
                  · odhad nákladů <b>~${aiUsage.estUsd.toFixed(2)}</b>
                  <div className="desc" style={{ marginTop: 4 }}>
                    Zůstatek kreditu Anthropic bohužel nelze přes API zjistit (běžný klíč to neumožňuje) —
                    počítáme proto spotřebu lokálně dle ceníku modelů.{' '}
                    <button style={{ color: 'var(--accent-dark)', fontWeight: 600 }}
                      onClick={() => api.shell.openUrl('https://console.anthropic.com/settings/billing')}>
                      Zobrazit kredit v konzoli →
                    </button>
                  </div>
                </div>
              )}
              <div className="field">
                <label>Znění značky (brand prompt)</label>
                <textarea rows={6} value={settings.brandPrompt}
                  onChange={e => setSettings(s => s ? { ...s, brandPrompt: e.target.value } : s)} />
                <div className="desc">Tímto stylem se řídí všechny AI generované a vylepšované e-maily. Obsahuje i kontext e-shopu (zasíláme, nevymýšlet fakta).</div>
              </div>
              <div className="field">
                <label>Kontaktní údaje firmy (AI je použije v odpovědích)</label>
                <textarea rows={3} value={settings.contactInfo}
                  placeholder={'Quentino s.r.o.\ninfo@quentino.cz · +420 …\nDoručení: Zásilkovna, PPL — odesíláme do 2 pracovních dnů'}
                  onChange={e => setSettings(s => s ? { ...s, contactInfo: e.target.value } : s)} />
              </div>
              <label className="check-row">
                <input type="checkbox" checked={settings.autoSummarize}
                  onChange={e => setSettings(s => s ? { ...s, autoSummarize: e.target.checked } : s)} />
                Automaticky shrnovat nové nepřečtené zprávy
              </label>
              <div className="field">
                <label>Vždy automaticky shrnout při načtení ze serveru — kategorie:</label>
                <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                  {(Object.keys(CATEGORY_LABELS) as Category[]).map(c => (
                    <label key={c} className="check-row">
                      <input type="checkbox" checked={settings.autoSummarizeCategories.includes(c)}
                        onChange={() => toggleSummarizeCat(c)} />
                      {CATEGORY_LABELS[c]}
                    </label>
                  ))}
                </div>
                <div className="desc">U vybraných kategorií se tělo zprávy stáhne a shrne hned po synchronizaci.</div>
              </div>
              <label className="check-row">
                <input type="checkbox" checked={settings.autoCategorize}
                  onChange={e => setSettings(s => s ? { ...s, autoCategorize: e.target.checked } : s)} />
                Automaticky třídit doručenou poštu (objednávky / lidé / firmy)
              </label>
              <label className="check-row">
                <input type="checkbox" checked={settings.loadRemoteImages}
                  onChange={e => setSettings(s => s ? { ...s, loadRemoteImages: e.target.checked } : s)} />
                Vždy načítat vzdálené obrázky v e-mailech (méně soukromí)
              </label>
              <label className="check-row">
                <input type="checkbox" checked={settings.notifyNewMail}
                  onChange={e => setSettings(s => s ? { ...s, notifyNewMail: e.target.checked } : s)} />
                Upozornit systémovou notifikací na novou zprávu
              </label>
              <div className="desc">
                Aplikace drží se serverem otevřené spojení, takže nová pošta dorazí hned,
                bez čekání na synchronizaci. Upozornění se neukáže, když je okno v popředí.
              </div>
              <div className="field-grid">
                <div className="field">
                  <label>Model pro psaní</label>
                  <input value={settings.draftModel} onChange={e => setSettings(s => s ? { ...s, draftModel: e.target.value } : s)} />
                </div>
                <div className="field">
                  <label>Rychlý model (shrnutí, třídění)</label>
                  <input value={settings.fastModel} onChange={e => setSettings(s => s ? { ...s, fastModel: e.target.value } : s)} />
                </div>
              </div>
              <div className="field" style={{ borderTop: '1px solid var(--border)', paddingTop: 14 }}>
                <label>Vzhled aplikace</label>
                <div className="lang-switch" style={{ alignSelf: 'flex-start' }}>
                  <button className={`lang-btn ${settings.theme === 'light' ? 'active' : ''}`}
                    onClick={() => run('theme', async () => {
                      await api.settings.save({ theme: 'light' });
                      setSettings(s => s ? { ...s, theme: 'light' } : s);
                      p.onSettingsChanged();
                    })}><Icon name="sun" size={13} /> Světlý</button>
                  <button className={`lang-btn ${settings.theme === 'dark' ? 'active' : ''}`}
                    onClick={() => run('theme', async () => {
                      await api.settings.save({ theme: 'dark' });
                      setSettings(s => s ? { ...s, theme: 'dark' } : s);
                      p.onSettingsChanged();
                    })}><Icon name="moon" size={13} /> Tmavý</button>
                </div>
              </div>

              {upgates && (
                <div className="field" style={{ borderTop: '1px solid var(--border)', paddingTop: 14 }}>
                  <label><Icon name="bag" size={13} /> Upgates API (objednávky zákazníků)</label>
                  <div className="desc">
                    Po vyplnění AI uvidí u odpovědí reálné objednávky zákazníka (stav, tracking, položky)
                    a u zprávy přibude tlačítko „Objednávky". Přístup vytvoříš v administraci e-shopu:
                    Doplňky → API (doporučujeme práva jen pro čtení objednávek). Dokud údaje nevyplníš, funkce je neaktivní.
                  </div>
                  <div className="field-grid" style={{ marginTop: 6 }}>
                    <div className="field"><label>URL API</label>
                      <input value={upgates.url} placeholder="https://eshop.admin.sX.upgates.com"
                        onChange={e => setUpgates(u => u ? { ...u, url: e.target.value } : u)} /></div>
                    <div className="field"><label>Login API uživatele</label>
                      <input value={upgates.login}
                        onChange={e => setUpgates(u => u ? { ...u, login: e.target.value } : u)} /></div>
                  </div>
                  <div className="field">
                    <label>API klíč {upgates.hasKey ? '· uložen ✓' : '· nenastaven'}</label>
                    <input type="password" value={upgatesKeyInput}
                      placeholder={upgates.hasKey ? '••••••••  (vyplň jen pro změnu)' : 'klíč z administrace'}
                      onChange={e => setUpgatesKeyInput(e.target.value)} />
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="btn primary" disabled={busy === 'upgSave'}
                      onClick={() => run('upgSave', async () => {
                        const saved = await api.upgates.saveConfig({
                          url: upgates.url,
                          login: upgates.login,
                          ...(upgatesKeyInput ? { apiKey: upgatesKeyInput } : {})
                        });
                        setUpgates(saved);
                        setUpgatesKeyInput('');
                        toast('Upgates API uloženo.');
                      })}>Uložit</button>
                    <button className="btn ghost" disabled={busy === 'upgTest'}
                      onClick={() => run('upgTest', async () => toast(await api.upgates.test()))}>
                      {busy === 'upgTest' ? <span className="spinner-inline" /> : null} Otestovat připojení
                    </button>
                  </div>
                </div>
              )}

              <OrderFeedsField />

              <ShorthandField />

              <div className="field" style={{ borderTop: '1px solid var(--border)', paddingTop: 14 }}>
                <label><Icon name="settings" size={13} /> Odkaz na objednávku v administraci</label>
                <input value={settings.adminOrderRef} placeholder="023702:1185"
                  onChange={e => setSettings(s => s ? { ...s, adminOrderRef: e.target.value } : s)} />
                <div className="desc">
                  Adresa objednávky v administraci nese vnitřní ID, ne číslo objednávky
                  (<code>…/orders/edit-order/default/<b>1185</b>/</code> pro objednávku 023702). Obě řady rostou
                  po jedné, takže z jedné známé dvojice <b>číslo objednávky : ID</b> se dopočítají ostatní.
                  Otevři v administraci libovolnou objednávku a opiš obě čísla sem. Je-li nastavené Upgates API,
                  má přednost přesné ID z něj a tohle se nepoužije.
                </div>
              </div>

              <div className="field" style={{ borderTop: '1px solid var(--border)', paddingTop: 14 }}>
                <label><Icon name="image" size={13} /> Logo na dárkové poukazy</label>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input value={settings.voucherLogo} placeholder="zatím nevybráno — poukaz použije název značky"
                    onChange={e => setSettings(s => s ? { ...s, voucherLogo: e.target.value } : s)} />
                  <button className="btn ghost" style={{ flexShrink: 0 }}
                    onClick={() => api.files.pickImage().then(f => {
                      if (f) setSettings(s => s ? { ...s, voucherLogo: f } : s);
                    })}>Vybrat…</button>
                  {settings.voucherLogo && (
                    <button className="btn ghost" style={{ flexShrink: 0 }}
                      onClick={() => setSettings(s => s ? { ...s, voucherLogo: '' } : s)}>Zrušit</button>
                  )}
                </div>
                <div className="desc">
                  PNG nebo SVG na světlé pozadí. Sází se do pravého horního rohu poukazu;
                  bez loga se použije název značky vysazený písmem.
                </div>
              </div>

              <div className="field" style={{ borderTop: '1px solid var(--border)', paddingTop: 14 }}>
                <label><Icon name="bag" size={13} /> Produktový feed (XML)</label>
                <input value={settings.productFeedUrl}
                  onChange={e => setSettings(s => s ? { ...s, productFeedUrl: e.target.value } : s)} />
                <div className="desc">
                  {feed
                    ? `V katalogu ${feed.count} produktů · naposledy aktualizováno ${feed.lastSync ? new Date(feed.lastSync).toLocaleString('cs-CZ') : 'nikdy'}. Aktualizuje se automaticky každý den.`
                    : 'Katalog produktů pro vkládání do e-mailů (CZ/SK/EN odkazy, obrázky, ceny).'}
                </div>
                <button className="btn ghost" style={{ alignSelf: 'flex-start' }} disabled={busy === 'feed'}
                  onClick={() => run('feed', async () => {
                    await api.settings.save({ productFeedUrl: settings.productFeedUrl });
                    const st = await api.products.refresh();
                    setFeed(st);
                    toast(`Feed aktualizován — ${st.count} produktů.`);
                  })}>
                  {busy === 'feed' ? <span className="spinner-inline" /> : <Icon name="refresh" size={14} />} Aktualizovat feed teď
                </button>
              </div>

              <div className="field">
                <label><Icon name="layers" size={13} /> Rychlý feed se zásobami (XML)</label>
                <input value={settings.stockFeedUrl}
                  placeholder="https://…/export-small-products-….xml"
                  onChange={e => setSettings(s => s ? { ...s, stockFeedUrl: e.target.value } : s)} />
                <div className="desc">
                  {/* Proč dva feedy: velký zná obrázky a popisy, ale je z včerejška.
                      Malý zná jen kódy, ceny a zásoby — zato je z posledních dvou hodin. */}
                  Malý export jen s kódy, dostupností, cenami a variantami. Velký katalog se
                  obnovuje jednou denně, tenhle po dvou hodinách — skladová množství v Katalogu
                  a při naskladňování se berou z něj.
                </div>
                <button className="btn ghost" style={{ alignSelf: 'flex-start' }} disabled={busy === 'stock'}
                  onClick={() => run('stock', async () => {
                    await api.settings.save({ stockFeedUrl: settings.stockFeedUrl });
                    const out = await api.catalog.refreshStock();
                    toast(`Zásoby aktuální — ${out.products} produktů, ${out.variants} variant.`);
                  })}>
                  {busy === 'stock' ? <span className="spinner-inline" /> : <Icon name="refresh" size={14} />} Stáhnout zásoby teď
                </button>
              </div>
              <button className="btn primary" style={{ alignSelf: 'flex-start' }} disabled={busy === 'saveAi'} onClick={saveAi}>
                Uložit nastavení AI
              </button>
            </>
          )}

          {/* ===================== ZNALOSTI ===================== */}
          {tab === 'knowledge' && !editingDoc && (
            <>
              <div className="desc" style={{ fontSize: 12.5, color: 'var(--text-2)' }}>
                Nahraj obchodní podmínky, reklamační řád, ceník dopravy, FAQ… AI z nich čerpá fakta
                při návrzích odpovědí — díky tomu odpovídá přesně podle vašich pravidel a nic si nevymýšlí.
              </div>
              {knowledge.length === 0 && (
                <div className="empty-state" style={{ padding: '30px 20px' }}>
                  <div className="big"><Icon name="book" size={32} /></div>
                  Zatím žádné dokumenty
                </div>
              )}
              {knowledge.map(doc => (
                <div key={doc.id} className="account-list-item">
                  <Icon name="fileText" size={18} style={{ color: 'var(--text-2)' }} />
                  <div className="grow">
                    <div style={{ fontWeight: 600 }}>{doc.title}</div>
                    <div className="mail">{doc.content.slice(0, 90)}…</div>
                  </div>
                  <button className="btn ghost" onClick={() => setEditingDoc({ id: doc.id, title: doc.title, content: doc.content })}>Upravit</button>
                  <button className="btn danger" onClick={() => run('delDoc', async () => setKnowledge(await api.knowledge.delete(doc.id)))}>Smazat</button>
                </div>
              ))}
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn primary" onClick={() => setEditingDoc({ title: '', content: '' })}>
                  <Icon name="plus" size={14} /> Nový dokument
                </button>
                <button className="btn ghost" disabled={busy === 'import'} onClick={importDoc}>
                  <Icon name="upload" size={14} /> Importovat soubor (.txt, .md)
                </button>
              </div>
            </>
          )}

          {tab === 'knowledge' && editingDoc && (
            <>
              <div className="field">
                <label>Název (např. „Reklamační řád")</label>
                <input value={editingDoc.title} onChange={e => setEditingDoc(d => d ? { ...d, title: e.target.value } : d)} />
              </div>
              <div className="field">
                <label>Obsah</label>
                <textarea rows={14} value={editingDoc.content}
                  onChange={e => setEditingDoc(d => d ? { ...d, content: e.target.value } : d)} />
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn ghost" onClick={() => setEditingDoc(null)}>Zpět</button>
                <button className="btn primary" disabled={busy === 'saveDoc'} onClick={saveDoc}>Uložit dokument</button>
              </div>
            </>
          )}

          {/* ===================== SYNC ===================== */}
          {tab === 'sync' && syncCfg && (
            <>
              <div className="desc" style={{ fontSize: 12.5, color: 'var(--text-2)' }}>
                Synchronizace mezi zařízeními (např. Mac + Windows) přes sdílenou složku — vyber složku,
                kterou ti synchronizuje Dropbox, OneDrive, Google Drive, Syncthing nebo NAS, a na druhém
                zařízení nastav tu samou. Přenáší se: nastavení AI, brand prompt, znalosti, osoby (včetně fotek),
                pravidla třídění, kontakty našeptávače a <b>lokální archiv včetně příloh</b>.
                U nastavení vyhrává novější změna, archiv a kontakty se slučují — nikdy se nic neztratí.
                Hesla účtů a API klíč se z bezpečnostních důvodů nesynchronizují.
              </div>
              <label className="check-row">
                <input type="checkbox" checked={syncCfg.enabled}
                  onChange={e => run('syncSave', async () => setSyncCfg(await api.appsync.save({ enabled: e.target.checked })))} />
                Zapnout synchronizaci (běží automaticky každou minutu)
              </label>
              <div className="field">
                <label>Synchronizační složka</label>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input readOnly value={syncCfg.folder ?? ''} placeholder="— nevybráno —" style={{ flex: 1 }} />
                  <button className="btn ghost" onClick={() => run('syncFolder', async () => {
                    const folder = await api.appsync.pickFolder();
                    if (folder) setSyncCfg(await api.appsync.save({ folder }));
                  })}>
                    <Icon name="folder" size={14} /> Vybrat
                  </button>
                </div>
                <div className="desc">Doporučení: vytvoř si v cloudové složce podsložku, např. „QuentinoMail-sync".</div>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button className="btn primary" disabled={busy === 'syncNow' || !syncCfg.enabled || !syncCfg.folder}
                  onClick={() => run('syncNow', async () => {
                    const res = await api.appsync.run();
                    toast(`Synchronizace: ${res}`);
                    setSyncCfg(await api.appsync.get());
                  })}>
                  {busy === 'syncNow' ? <span className="spinner-inline" /> : <Icon name="refresh" size={14} />} Synchronizovat teď
                </button>
                {syncCfg.lastRun && (
                  <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
                    Naposledy {new Date(syncCfg.lastRun).toLocaleString('cs-CZ')} · {syncCfg.lastResult}
                  </span>
                )}
              </div>
            </>
          )}

          {/* ===================== TELEFON ===================== */}
          {tab === 'phone' && settings && (
            <>
              <div className="desc" style={{ fontSize: 12.5, color: 'var(--text-2)' }}>
                Upozornění na telefon doručuje <b>ntfy</b>. Push přímo do téhle aplikace by
                znamenal placený vývojářský účet u Applu, tohle je zdarma a bez registrace:
                na telefon si nainstaluješ aplikaci <b>ntfy</b> z App Storu, přihlásíš ji
                k tématu níž a od té chvíle ti chodí upozornění z ní.
                Ven jde <b>odesílatel a předmět</b>, ne text zprávy. Klepnutí na
                upozornění otevře v aplikaci rovnou tu zprávu nebo konverzaci.
              </div>

              <label className="check-row">
                <input type="checkbox" checked={settings.notifyPhone}
                  onChange={e => saveNotify({ notifyPhone: e.target.checked })} />
                Posílat upozornění na telefon
              </label>

              {/*
                * Živé propojení. Je to jiná věc než upozornění — nejde
                * o hlášku, ale o rozdělanou práci — proto má vlastní kanál
                * i vlastní vypínač, i když obojí sedí na téhle záložce.
                */}
              <h4 style={{ marginTop: 18 }}>Naskladnění a balení živě</h4>
              <div className="desc" style={{ fontSize: 12.5, color: 'var(--text-2)' }}>
                Co se naskladní nebo odškrtne na telefonu, se objeví na počítači do vteřiny —
                a naopak. Jede to přes <b>Supabase</b>, který už je napojený kvůli chatu, a to
                způsobem, kdy se <b>nic neukládá do databáze</b>: zpráva se doručí tomu, kdo
                zrovna poslouchá, a tím končí. Není tedy co uklízet ani co přeplnit.
                Sdílená složka funguje dál a zůstává tím, co platí — tohle je jen rychlejší
                cesta. Na počítači nic nevyskočí přes rozdělanou práci: dole se ukáže proužek
                a okno se otevře, teprve když na něj klepneš.
              </div>

              <label className="check-row">
                <input type="checkbox" checked={live.enabled}
                  onChange={e => api.live.save({ enabled: e.target.checked }).then(setLive)} />
                Propojit telefon a počítač živě
              </label>

              <div className="field">
                <label>Kanál (chová se jako heslo — stejný zadej i v telefonu)</label>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input value={live.channel} spellCheck={false}
                    placeholder="— zatím žádný —" className="mono" style={{ flex: 1 }}
                    onChange={e => api.live.save({ channel: e.target.value }).then(setLive)} />
                  <button className="btn ghost" onClick={() => run('liveChannel', async () => {
                    const channel = await api.live.newChannel();
                    setLive(await api.live.save({ channel }));
                    toast('Kanál vygenerován a uložen.');
                  })}>
                    <Icon name="refresh" size={14} /> Vygenerovat
                  </button>
                </div>
                <div className="desc">
                  {live.enabled
                    ? live.connected
                      ? '✓ Propojeno — počítač poslouchá.'
                      : (live.error ?? 'Připojuji…')
                    : 'Vypnuto — naskladnění putuje jen sdílenou složkou.'}
                </div>
              </div>

              <div className="field">
                <label>Téma (chová se jako heslo — kdo ho zná, čte i posílá)</label>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input value={settings.notifyTopic} spellCheck={false}
                    placeholder="— zatím žádné —" className="mono" style={{ flex: 1 }}
                    onChange={e => saveNotify({ notifyTopic: e.target.value })} />
                  <button className="btn ghost" onClick={() => run('topic', async () => {
                    const topic = await api.notify.topic();
                    saveNotify({ notifyTopic: topic });
                    setChatSql(null);
                    toast('Téma vygenerováno a uloženo.');
                  })}>
                    <Icon name="refresh" size={14} /> Vygenerovat
                  </button>
                </div>
                {settings.notifyTopic && (
                  <div className="desc">
                    V aplikaci ntfy dej <b>Subscribe to topic</b> a zadej{' '}
                    <code>{settings.notifyTopic}</code>
                    {settings.notifyServer ? ` (server ${settings.notifyServer})` : ''}.
                  </div>
                )}
              </div>

              <div className="field">
                <label>Server</label>
                <input value={settings.notifyServer} spellCheck={false} placeholder="https://ntfy.sh"
                  onChange={e => saveNotify({ notifyServer: e.target.value })} />
                <div className="desc">
                  Prázdné = veřejný ntfy.sh. Vlastní server má smysl, když nechceš, aby
                  jména a předměty procházela cizí službou — aplikace ntfy si vlastní server
                  přidat umí.
                </div>
              </div>

              <label className="check-row">
                <input type="checkbox" checked={settings.notifyPhoneMail}
                  onChange={e => saveNotify({ notifyPhoneMail: e.target.checked })} />
                Nová pošta
              </label>
              <label className="check-row">
                <input type="checkbox" checked={settings.notifyPhoneChat}
                  onChange={e => saveNotify({ notifyPhoneChat: e.target.checked })} />
                Nová zpráva v chatu
              </label>
              <div className="desc">
                Pošta se hlásí odsud — aplikace drží se serverem otevřené spojení, takže
                upozornění odejde ve chvíli, kdy zpráva dorazí. Když je počítač vypnutý,
                zkusí to telefon sám na pozadí, ale systém ho pustí jen párkrát denně.
                Chat je na tom líp: umí se ozvat přímo ze Supabase, viz níž.
              </div>

              <label className="check-row">
                <input type="checkbox" checked={settings.notifyPhoneLocal}
                  onChange={e => saveNotify({ notifyPhoneLocal: e.target.checked })} />
                Upozornit i z aplikace v telefonu, když si poštu najde sama
              </label>
              <div className="desc">
                Přijde ze správné aplikace a nic neprojde cizí službou. Když je zároveň
                zapnutý počítač, může upozornění na tutéž zprávu přijít dvakrát — telefon
                nemá jak zjistit, že to počítač už ohlásil.
              </div>

              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <button className="btn primary" disabled={busy === 'notifyTest' || !settings.notifyTopic}
                  onClick={() => run('notifyTest', async () => {
                    const out = await api.notify.test(settings.notifyServer, settings.notifyTopic);
                    if (out.ok) toast('Odesláno — mrkni na telefon.');
                    else toast(out.error || 'Nepovedlo se', 'error');
                  })}>
                  {busy === 'notifyTest' ? <span className="spinner-inline" /> : <Icon name="phone" size={14} />}
                  {' '}Poslat zkušební
                </button>
                <button className="btn ghost" disabled={!settings.notifyTopic}
                  onClick={() => run('chatSql', async () => {
                    setChatSql(await api.notify.chatSql(settings.notifyServer, settings.notifyTopic));
                  })}>
                  <Icon name="chat" size={14} /> Nastavení chatu v Supabase
                </button>
              </div>

              {chatSql && (
                <div className="field" style={{ marginTop: 12 }}>
                  <label>SQL pro Supabase</label>
                  <div className="desc">
                    Chat nemá kdo hlídat, když je počítač vypnutý — Supabase ale umí zavolat
                    adresu sám, jakmile přibude zpráva. Vlož tohle do <b>SQL Editoru</b> projektu
                    a spusť. Stačí jednou.
                  </div>
                  <textarea readOnly value={chatSql} spellCheck={false} rows={12}
                    className="mono" style={{ fontSize: 11.5 }} />
                  <button className="btn ghost" style={{ marginTop: 8, alignSelf: 'flex-start' }}
                    onClick={async () => {
                      await navigator.clipboard.writeText(chatSql);
                      setSqlCopied(true);
                      setTimeout(() => setSqlCopied(false), 1800);
                    }}>
                    <Icon name={sqlCopied ? 'check' : 'copy'} size={14} />
                    {' '}{sqlCopied ? 'Zkopírováno' : 'Kopírovat'}
                  </button>
                </div>
              )}
            </>
          )}

          {/* ===================== TŘÍDĚNÍ ===================== */}
          {tab === 'rules' && settings && (
            <>
              <div className="desc" style={{ fontSize: 12.5, color: 'var(--text-2)' }}>
                Pravidla se vyhodnocují před AI klasifikací — jsou okamžitá a zdarma. Co pravidla nezachytí, roztřídí AI podle kontextu.
              </div>
              {settings.categoryRules.map((r, i) => (
                <div key={i} className="compose-row">
                  <select value={r.field} onChange={e => updateRule(i, { field: e.target.value as 'from' | 'subject' })}>
                    <option value="subject">Předmět</option>
                    <option value="from">Odesílatel</option>
                  </select>
                  <span style={{ color: 'var(--text-3)', fontSize: 12 }}>obsahuje</span>
                  <input value={r.contains} onChange={e => updateRule(i, { contains: e.target.value })} />
                  <span style={{ color: 'var(--text-3)', fontSize: 12 }}>→</span>
                  <select value={r.category} onChange={e => updateRule(i, { category: e.target.value as Category })}>
                    {(Object.keys(CATEGORY_LABELS) as Category[]).map(c => (
                      <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>
                    ))}
                  </select>
                  <button className="icon-btn" data-tip="Odebrat pravidlo" onClick={() =>
                    setSettings(s => s ? { ...s, categoryRules: s.categoryRules.filter((_, j) => j !== i) } : s)
                  }><Icon name="x" size={13} /></button>
                </div>
              ))}
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn ghost" onClick={() =>
                  setSettings(s => s ? { ...s, categoryRules: [...s.categoryRules, { field: 'subject', contains: '', category: 'orders' }] } : s)
                }><Icon name="plus" size={14} /> Přidat pravidlo</button>
                <button className="btn primary" disabled={busy === 'saveRules'} onClick={saveRules}>Uložit pravidla</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}


/**
 * Feedy objednávek z e-shopu.
 *
 * Proč zvlášť a ne přes API: export je obyčejná adresa, kterou si člověk
 * v administraci vyklikne za minutu, a stáhne se celý naráz. API by na
 * tisíce objednávek znamenalo tisíce dotazů.
 *
 * Feedy jsou dva druhy a doplňují se — malý s posledními 24 hodinami se
 * obnovuje po pár minutách, velké s celou historií jednou denně.
 *
 * Adresa nese tajný klíč, proto se po uložení ukazuje jen její konec.
 */
function OrderFeedsField() {
  const toast = useToast();
  const [feeds, setFeeds] = useState<OrderFeedStatus[]>([]);
  const [stats, setStats] = useState<OrderStats | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(() => {
    api.orders.feeds().then(data => { setFeeds(data.feeds); setStats(data.stats); }).catch(() => {});
  }, []);
  useEffect(load, [load]);

  /**
   * Adresy se vkládají hromadně, řádek po řádku, ve tvaru „popis <adresa>".
   * Je to rychlejší než klikat čtyři formuláře a hlavně to odpovídá tomu, jak
   * si je člověk vypíše z administrace.
   */
  const save = async () => {
    const parsed = draft.split('\n').map(line => line.trim()).filter(Boolean).map((line, index) => {
      const match = line.match(/^(.*?)\s*(https?:\/\/\S+)$/);
      const url = match ? match[2] : line;
      const label = (match?.[1] ?? '').trim() || `Feed ${index + 1}`;
      // „posledních 24 h" se pozná z popisu — jen ten se vyplatí tahat často
      const recent = /24\s*h|posledn/i.test(label);
      return {
        id: `feed${index + 1}`, label, url,
        market: '', everyMinutes: recent ? 5 : 720, recent, enabled: true
      } as OrderFeed;
    });
    if (parsed.length === 0) { toast('Vlož aspoň jednu adresu feedu.', 'error'); return; }
    setBusy('save');
    try {
      const data = await api.orders.saveFeeds(parsed);
      setFeeds(data.feeds);
      setStats(data.stats);
      setDraft('');
      toast(`Uloženo ${parsed.length} feedů`);
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const refresh = async (id?: string) => {
    setBusy(id ?? 'all');
    try {
      const data = await api.orders.refreshFeeds(id);
      setFeeds(data.feeds);
      setStats(data.stats);
      const failed = data.result.filter(item => item.error);
      toast(failed.length
        ? `${failed.length} feedů selhalo: ${failed[0].error}`
        : `Staženo ${data.result.reduce((sum, item) => sum + item.orders, 0)} objednávek`,
        failed.length ? 'error' : undefined);
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="field" style={{ borderTop: '1px solid var(--border)', paddingTop: 14 }}>
      <label><Icon name="download" size={13} /> Feedy objednávek</label>
      <div className="desc">
        Z exportu objednávek se bere telefon na zákazníka — díky němu jde u zprávy,
        v chatu i při balení rovnou zavolat. Vlož adresy z administrace, každou na
        vlastní řádek, klidně i s popisem: <code>posledních 24h https://…</code>.
        Feed, který má v popisu „24h" nebo „poslední", se obnovuje každých pár minut,
        ostatní dvakrát denně.
      </div>

      {feeds.length > 0 && (
        <table className="pt-table" style={{ marginBottom: 10 }}>
          <thead>
            <tr><th>Feed</th><th>Trh</th><th>Objednávek</th><th>Naposledy</th><th /></tr>
          </thead>
          <tbody>
            {feeds.map(feed => (
              <tr key={feed.id}>
                <td>
                  {feed.label}
                  <div className="ig-muted" style={{ fontSize: 11 }}>{feed.urlHint}</div>
                  {feed.lastError && (
                    <div className="pt-warn" style={{ fontSize: 11 }}>{feed.lastError}</div>
                  )}
                </td>
                <td>{feed.market.toUpperCase()}</td>
                <td>{feed.orders}</td>
                <td className="ig-muted" style={{ fontSize: 11.5 }}>
                  {feed.lastSync ? new Date(feed.lastSync).toLocaleString('cs-CZ') : 'zatím nikdy'}
                </td>
                <td>
                  <button className="btn ghost small" disabled={!!busy}
                    onClick={() => refresh(feed.id)}>
                    {busy === feed.id ? <span className="spinner-inline" /> : 'Stáhnout'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {stats && stats.total > 0 && (
        <div className="ig-muted" style={{ fontSize: 12, marginBottom: 8 }}>
          Uloženo {stats.total} objednávek, z toho {stats.withPhone} s telefonem
          {' '}({Math.round(stats.withPhone / stats.total * 100)} %).
        </div>
      )}

      <textarea rows={4} value={draft} onChange={e => setDraft(e.target.value)}
        placeholder={'posledních 24h https://www.priklad.cz/export-orders-XXXX.xml\nCZ vše https://www.priklad.cz/export-orders-YYYY.xml'} />
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button className="btn primary" disabled={busy === 'save' || !draft.trim()} onClick={save}>
          {busy === 'save' ? <span className="spinner-inline" /> : null} Uložit feedy
        </button>
        <button className="btn ghost" disabled={!!busy || feeds.length === 0}
          onClick={() => refresh()}>
          {busy === 'all' ? <span className="spinner-inline" /> : <Icon name="refresh" size={13} />}
          Stáhnout vše
        </button>
      </div>
    </div>
  );
}

/**
 * Slovník zkratek pro dopravu a platbu.
 *
 * Na telefonu je v seznamu pošty na odznak místo asi pro dvacet znaků.
 * „Zásilkovna – výdejní místo" se tam nevejde, a hlavně to není to, co se
 * z odznaku ráno čte: jde o to, jestli balík míří na výdejnu nebo domů
 * a jestli je zaplaceno, nebo se bude vybírat dobírka.
 *
 * Nabízí se **jen to, co doopravdy je v objednávkách** — vypisovat všechno,
 * co e-shop umí, by znamenalo dvacet řádků, ze kterých se používají tři.
 * Prázdné pole neznamená „nic neukazuj": platí odhad, který je hned vedle
 * vidět, takže je jasné, co se ukáže, i než někdo něco napíše.
 */
function ShorthandField() {
  const [rows, setRows] = useState<ShorthandRow[]>([]);
  const [busy, setBusy] = useState('');

  // Starší verze aplikace v telefonu kanál nezná a vrátí prázdno — pole
  // s rozhraním se kvůli tomu nesmí rozsypat
  useEffect(() => {
    api.shorthand.list().then(list => setRows(Array.isArray(list) ? list : [])).catch(() => {});
  }, []);

  const save = (row: ShorthandRow, value: string) => {
    setRows(prev => prev.map(one =>
      one.kind === row.kind && one.name === row.name ? { ...one, short: value } : one));
    setBusy(`${row.kind}:${row.name}`);
    api.shorthand.save(row.kind, row.name, value)
      .then(list => setRows(Array.isArray(list) ? list : []))
      .catch(() => {})
      .finally(() => setBusy(''));
  };

  const group = (kind: ShorthandRow['kind'], title: string) => {
    const mine = rows.filter(one => one.kind === kind);
    if (mine.length === 0) return null;
    return (
      <div className="sh-group">
        <b>{title}</b>
        {mine.map(row => (
          <label key={`${row.kind}:${row.name}`} className="sh-row">
            <span className="sh-name" title={row.name}>{row.name}</span>
            <span className="sh-count">{row.count}×</span>
            <input value={row.short} placeholder={row.guess} spellCheck={false} maxLength={14}
              onChange={e => save(row, e.target.value)} />
            {busy === `${row.kind}:${row.name}` && <span className="spinner-inline" />}
          </label>
        ))}
      </div>
    );
  };

  return (
    <div className="field" style={{ borderTop: '1px solid var(--border)', paddingTop: 14 }}>
      <label><Icon name="truck" size={13} /> Zkratky dopravy a plateb</label>
      <div className="desc">
        Co se ukáže u objednávky v seznamu pošty na telefonu — místo čísla a částky,
        které se z odznaku stejně nečtou. Nabízí se to, co je v načtených objednávkách.
        Necháš-li pole prázdné, platí odhad v něm napsaný.
      </div>
      {rows.length === 0 ? (
        <div className="desc">Zatím nejsou načtené žádné objednávky — načti feed objednávek výš.</div>
      ) : (
        <div className="sh-list">
          {group('shipment', 'Doprava')}
          {group('payment', 'Platba')}
        </div>
      )}
    </div>
  );
}
