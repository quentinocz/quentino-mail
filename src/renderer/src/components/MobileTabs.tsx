import { useState } from 'react';
import Icon from './Icon';
import type { Workspace, AiTool } from './WorkspaceSwitch';
import { AI_TOOLS } from './WorkspaceSwitch';
import { Sheet, SheetActions } from './Sheet';

const TABS: { id: Workspace | 'funcs'; icon: string; label: string }[] = [
  { id: 'mail', icon: 'mail', label: 'Pošta' },
  { id: 'chat', icon: 'chat', label: 'Chat' },
  { id: 'funcs', icon: 'sliders', label: 'Funkce' }
];

/**
 * Spodní přepínač prostorů pro telefon.
 *
 * Na iPhonu je horní část obrazovky daleko od palce, proto hlavní navigace
 * patří dolů — stejně jako ji mají systémové aplikace. Lišta si sama nechá
 * místo na spodní ovládací proužek (`env(safe-area-inset-bottom)`), takže
 * o ni tlačítka nezavadí.
 *
 * Třetí místo nepatří jednomu prostoru, ale **všemu ostatnímu**: sociálním
 * sítím, přehledu dne, balení, katalogu. Dřív tam byl jen Instagram a zbytek
 * se schovával v zásuvce pod složkami — o dvě klepnutí dál, než má být, a
 * nebylo o tom vidět, že to existuje.
 */
export default function MobileTabs({ current, onChange, onAiTool, activeTool, chatUnread }: {
  current: Workspace;
  onChange: (w: Workspace) => void;
  /** Otevření nástroje z nabídky Funkce */
  onAiTool?: (tool: AiTool) => void;
  /** Který nástroj je zrovna otevřený — kvůli zvýraznění lišty */
  activeTool?: AiTool;
  chatUnread?: number;
}) {
  const [funcs, setFuncs] = useState(false);
  // Sociální sítě jsou taky „funkce", takže při nich svítí třetí místo
  const funcsActive = current === 'instagram' || !!activeTool;

  return (
    <>
      <nav className="m-tabs" role="tablist">
        {TABS.map(tab => {
          const active = tab.id === 'funcs' ? funcsActive : current === tab.id;
          return (
            <button
              key={tab.id}
              role="tab"
              aria-selected={active}
              className={active ? 'active' : ''}
              onClick={() => {
                if (tab.id === 'funcs') { setFuncs(true); return; }
                if (current !== tab.id) onChange(tab.id as Workspace);
              }}
            >
              <span className="m-tab-icon">
                <Icon name={tab.icon} size={22} />
                {tab.id === 'chat' && chatUnread ? (
                  <span className="m-tab-badge">{chatUnread > 9 ? '9+' : chatUnread}</span>
                ) : null}
              </span>
              <span className="m-tab-label">{tab.label}</span>
            </button>
          );
        })}
      </nav>

      {funcs && (
        <Sheet title="Funkce" onClose={() => setFuncs(false)}>
          <SheetActions
            onDone={() => setFuncs(false)}
            actions={AI_TOOLS
              // Překlady a články se na malé obrazovce dělat nedají
              .filter(tool => !tool.desktopOnly)
              .map(tool => ({
                icon: tool.icon,
                label: tool.label,
                hint: tool.hint,
                active: tool.id === 'instagram' ? current === 'instagram' : activeTool === tool.id,
                onClick: () => onAiTool?.(tool.id)
              }))}
          />
        </Sheet>
      )}
    </>
  );
}
