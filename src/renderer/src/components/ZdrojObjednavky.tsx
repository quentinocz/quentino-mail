import { useEffect, useState } from 'react';
import type { ZdrojObjednavky as Zdroj } from '@shared/types';
import { api } from '../api';
import Icon from './Icon';

/**
 * Zdroj objednávky — odkud zákazník přišel (Patrik, 25. 11.).
 *
 * Jeden štítek pro tři místa: seznam objednávek v Reklamách, detail
 * objednávky v balení a karta objednávky u e-mailu. Barva podle kanálu,
 * vedle kampaň; podrobnosti (sestava, klíčové slovo, vstupní stránka,
 * první kontakt) v bublině, nebo pod štítkem, když je místo.
 */

export const BARVY_KANALU: Record<string, string> = {
  google_ads: '#1a73e8', google: '#34a853', sklik: '#cc0000', seznam: '#e25b45',
  meta_ads: '#0866ff', meta: '#7b61ff', srovnavac: '#f29900', email: '#0f9d8a',
  odkaz: '#8a6d3b', primo: '#6b7280', jine: '#9ca3af'
};

const ODKUD: Record<Zdroj['odkud'], string> = {
  mereni: 'změřeno skriptem na e-shopu', ga4: 'podle Google Analytics', oboje: 'skript na e-shopu + Google Analytics'
};

export function popisZdroje(z: Zdroj): string {
  return [
    z.nazev + (z.kampan ? ` — kampaň ${z.kampan}` : ''),
    ...z.detail,
    z.prvni ? `poprvé přišel: ${z.prvni.nazev}${z.prvni.kampan ? ` (${z.prvni.kampan})` : ''}` : '',
    z.dotyku > 1 ? `${z.dotyku} prokliků před nákupem` : '',
    ODKUD[z.odkud]
  ].filter(Boolean).join('\n');
}

export function ZdrojStitek({ zdroj, kampan = true }: { zdroj: Zdroj; kampan?: boolean }) {
  return (
    <span className="zdroj-stitek" data-tip={popisZdroje(zdroj)}>
      <i style={{ background: BARVY_KANALU[zdroj.kanal] ?? '#9ca3af' }} />
      <b>{zdroj.nazev}</b>
      {kampan && zdroj.kampan && <span className="zdroj-kampan">{zdroj.kampan}</span>}
    </span>
  );
}

/**
 * Štítek, který si zdroj načte sám podle čísla objednávky a trhu.
 * `podrobne` = i řádky s detailem (balení má místo, karta u mailu ne).
 */
export default function ZdrojObjednavky({ code, market, podrobne = false }: { code: string | null | undefined; market?: string; podrobne?: boolean }) {
  const [zdroj, setZdroj] = useState<Zdroj | null | undefined>(undefined);
  useEffect(() => {
    let platne = true;
    setZdroj(undefined);
    if (!code) { setZdroj(null); return; }
    api.zdroje.objednavka(code, market || 'cz')
      .then(z => { if (platne) setZdroj(z); })
      .catch(() => { if (platne) setZdroj(null); });
    return () => { platne = false; };
  }, [code, market]);
  if (zdroj === undefined) return null;
  if (!zdroj) {
    return podrobne
      ? <div className="zdroj-blok zdroj-nic"><Icon name="globe" size={12} /> Zdroj neznámý — zákazník nejspíš odmítl měření, nebo se ještě nenačetl.</div>
      : null;
  }
  return (
    <div className={`zdroj-blok ${podrobne ? 'podrobne' : ''}`}>
      <span className="zdroj-popisek"><Icon name="globe" size={12} /> Zdroj</span>
      <ZdrojStitek zdroj={zdroj} />
      {podrobne && (zdroj.detail.length > 0 || zdroj.prvni) && (
        <div className="zdroj-detail">
          {zdroj.detail.map((d, i) => <span key={i}>{d}</span>)}
          {zdroj.prvni && <span>poprvé: {zdroj.prvni.nazev}{zdroj.prvni.kampan ? ` (${zdroj.prvni.kampan})` : ''}</span>}
        </div>
      )}
    </div>
  );
}
