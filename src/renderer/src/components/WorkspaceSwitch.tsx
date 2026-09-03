import { useEffect, useRef, useState } from 'react';
import Icon from './Icon';
import { SIDE_COMPACT, useSidebarWidth } from '../sidebar';
import { useIsPhone } from '../mobile';

export type Workspace = 'mail' | 'chat' | 'instagram';

/** Co se skrývá pod „AI" — nástroje, které pracují s modelem nad e-shopem. */
/**
 * Co se skrývá pod „Funkce" — všechno, co není pošta, chat ani sociální sítě.
 *
 * Dřív to byla nabídka „AI" jen pro nástroje nad modelem a zbytek (přehled
 * dne, balení, katalog) měl vlastní řádky v panelu složek. Byly to dvě různá
 * místa pro tutéž věc a v poště přebývala tlačítka, která s poštou nesouvisí.
 */
export type AiTool = 'instagram' | 'digest' | 'packing' | 'catalog' | 'ptrans' | 'articles';

const TABS: { id: Workspace | 'ai'; icon: string; label: string; tip: string }[] = [
  { id: 'mail', icon: 'mail', label: 'Pošta', tip: 'E-mailová schránka' },
  { id: 'chat', icon: 'chat', label: 'Chat', tip: 'Chat ze zákaznického widgetu na e-shopu' },
  { id: 'ai', icon: 'sliders', label: 'Funkce', tip: 'Přehled dne, balení, katalog, sociální sítě, překlady a články' }
];

/**
 * `desktopOnly` — nástroje, které na telefonu nemají co dělat: nativní obal
 * pro ně nemá kanály a na malé obrazovce se stejně nedají obsloužit. Dřív se
 * v nabídce ukazovaly i tam a klepnutí neudělalo nic; teď se prostě nenabízejí.
 */
export const AI_TOOLS: { id: AiTool; icon: string; label: string; hint: string; desktopOnly?: boolean }[] = [
  { id: 'digest', icon: 'sunrise', label: 'Přehled dne', hint: 'Prodeje v číslech, co čeká na odpověď a postřehy k tomu' },
  { id: 'packing', icon: 'bag', label: 'Balení objednávek', hint: 'Odškrtávací seznam — kusy, varianty, adresy' },
  { id: 'catalog', icon: 'layers', label: 'Katalog a naskladnění', hint: 'Produkty a zásoby, příjem zboží, štítky s kódem' },
  { id: 'instagram', icon: 'image', label: 'Sociální sítě', hint: 'Instagram a Facebook ve všech trzích' },
  { id: 'ptrans', icon: 'globe', label: 'Překlady produktů', hint: 'Jazykové mutace z produktového feedu', desktopOnly: true },
  { id: 'articles', icon: 'fileText', label: 'Články', hint: 'Psaní a překlad článků pro e-shop', desktopOnly: true }
];

/**
 * Přepínač pracovních prostorů — ve všech panelech na stejném místě.
 *
 * Pošta a chat jsou samostatné prostory, protože se v nich tráví celý den.
 * Nástroje, které pracují s modelem nad e-shopem, se do řady nevešly a hlavně
 * spolu souvisí — proto jsou pod jedním tlačítkem **AI** a rozbalí se
 * nabídkou. Přibude-li další, přidá se jen řádek, ne další záložka.
 */
export default function WorkspaceSwitch({ current, onChange, onAiTool, chatUnread, activeTool }: {
  current: Workspace;
  onChange: (w: Workspace) => void;
  /** Otevření nástroje z nabídky AI */
  onAiTool?: (tool: AiTool) => void;
  /** Nepřečtené zprávy v chatu — číslo u záložky */
  chatUnread?: number;
  /** Který nástroj je zrovna otevřený (kvůli zvýraznění) */
  activeTool?: AiTool;
}) {
  const compact = useSidebarWidth() < SIDE_COMPACT;
  const phone = useIsPhone();
  const tools = AI_TOOLS.filter(tool => !(phone && tool.desktopOnly));
  /*
   * Na telefonu se mezi prostory přepíná spodní lištou, takže z přepínače
   * zbývá jen „Funkce" — bez něj by se na telefon nedalo dostat do katalogu,
   * balení ani přehledu dne.
   */
  const tabs = phone ? TABS.filter(t => t.id === 'ai') : TABS;
  const [menu, setMenu] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  // Klik mimo nabídku ji zavře; bez toho by zůstala viset přes celou aplikaci
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setMenu(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  const aiActive = current === 'instagram' || !!activeTool;

  return (
    <div className={`ig-switch ${compact ? 'compact' : ''}`} ref={box}>
      {tabs.map(t => (
        <button
          key={t.id}
          className={t.id === 'ai' ? (aiActive ? 'active' : '') : (current === t.id ? 'active' : '')}
          onClick={() => {
            if (t.id === 'ai') { setMenu(open => !open); return; }
            if (current !== t.id) onChange(t.id as Workspace);
          }}
          data-tip={t.tip}
          aria-label={t.label}
        >
          <Icon name={t.icon} size={14} />
          {!compact && <span className="ws-label">{t.label}</span>}
          {t.id === 'ai' && !compact && <Icon name="chevDown" size={10} className="ws-caret" />}
          {t.id === 'chat' && chatUnread ? (
            <span className="ws-badge">{chatUnread > 9 ? '9+' : chatUnread}</span>
          ) : null}
        </button>
      ))}

      {menu && (
        <FunctionsMenu
          activeTool={activeTool}
          onPick={tool => {
            setMenu(false);
            if (tool === 'instagram') onChange('instagram');
            else onAiTool?.(tool);
          }}
          highlightInstagram={current === 'instagram'}
        />
      )}
    </div>
  );
}


/**
 * Obsah nabídky Funkce — jedna kopie pro počítač i telefon.
 *
 * Na počítači visí pod přepínačem prostorů, na telefonu pod tlačítkem
 * v hlavičce pošty. Kdyby se seznam psal dvakrát, přibyla by položka jen
 * na jednom místě a nikdo by si toho hned nevšiml.
 */
export function FunctionsMenu({ activeTool, onPick, highlightInstagram = false, className = '' }: {
  activeTool?: AiTool;
  onPick: (tool: AiTool) => void;
  highlightInstagram?: boolean;
  className?: string;
}) {
  const phone = useIsPhone();
  const tools = AI_TOOLS.filter(tool => !(phone && tool.desktopOnly));

  return (
    <div className={`ws-menu ${className}`}>
      {tools.map(tool => (
        <button
          key={tool.id}
          className={'ws-menu-item '
            + ((tool.id === 'instagram' ? highlightInstagram : activeTool === tool.id) ? 'on' : '')}
          onClick={() => onPick(tool.id)}
        >
          <Icon name={tool.icon} size={15} />
          <span>
            <b>{tool.label}</b>
            <small>{tool.hint}</small>
          </span>
        </button>
      ))}
    </div>
  );
}
