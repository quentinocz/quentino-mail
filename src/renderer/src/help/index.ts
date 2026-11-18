import type { HelpTopic } from './types';
import { PTRANS, NEWPRODUCT, BANNERS, PACKING, CATALOG, ARTICLES, MEDIA } from './obchod';
import { MAIL, CHAT, INSTAGRAM, SHOOT, REVIEWS, WEBTEXTS, ZKUSEBNA, DIGEST, SETTINGS } from './obsah';

export type { HelpTopic, HelpGuide, HelpStep, HelpArea } from './types';

/**
 * Všechna témata nápovědy, ve skupinách jako v nabídce Funkce.
 * Pořadí skupin = pořadí v přepínači témat v okně nápovědy.
 */
export const HELP_GROUPS: { label: string; topics: HelpTopic[] }[] = [
  { label: 'Komunikace', topics: [MAIL, CHAT, INSTAGRAM] },
  { label: 'Provoz e-shopu', topics: [PACKING, CATALOG, PTRANS, NEWPRODUCT, ARTICLES] },
  { label: 'Soubory', topics: [MEDIA, SHOOT] },
  { label: 'Obsah webu', topics: [REVIEWS, WEBTEXTS, BANNERS, ZKUSEBNA] },
  { label: 'Přehled a nastavení', topics: [DIGEST, SETTINGS] }
];

export const HELP_TOPICS: HelpTopic[] = HELP_GROUPS.flatMap(group => group.topics);

export type HelpTopicId =
  | 'mail' | 'chat' | 'instagram' | 'packing' | 'catalog' | 'ptrans' | 'newproduct' | 'articles'
  | 'media' | 'shoot' | 'reviews' | 'webtexts' | 'banners' | 'zkusebna' | 'digest' | 'settings';

export function helpTopic(id: string): HelpTopic | null {
  return HELP_TOPICS.find(one => one.id === id) ?? null;
}
