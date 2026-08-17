/**
 * Generování popisků.
 *
 * Prompt se skládá na jednom místě, aby šlo dohledat, proč model napsal to,
 * co napsal. Vstupem je profil značky, popis trhů a buď hotový český text
 * (přepis existujícího příspěvku), nebo zadání pro nový příspěvek. Obrázky se
 * modelu posílají s sebou, takže popisek může reagovat na to, co je na fotce.
 */
import { client, recordUsage } from '../ai';
import { getSettings, listKnowledge } from '../settings';
import { getBrand, listMarkets } from './store';
import type { IgBrand, IgMarket } from '../../shared/types';

export interface GenerateInput {
  mode: 'brief' | 'source';
  brief: string;
  source: string;
  mediaNote: string;
  langs: string[];
  variants: number;
  /** Obrázky jako base64 (bez prefixu data:) */
  images: { mime: string; b64: string }[];
}

export function buildPrompt(input: GenerateInput, brand: IgBrand, markets: IgMarket[], knowledge: string): string {
  const marketBlock = input.langs
    .map(code => markets.find(m => m.lang === code))
    .filter((m): m is IgMarket => !!m)
    .map(m => `${m.lang} (${m.label}): ${m.note}${m.tags.trim() ? ` Hashtagy k dispozici: ${m.tags}` : ''}`)
    .join('\n');

  const parts: string[] = [
    'Jsi copywriter značky Quentino a píšeš popisky pro Instagram.',
    '',
    'ZNAČKA',
    brand.context
  ];

  if (brand.loveOn && brand.love.trim()) parts.push('', 'PŘÍSTUP KE ZNAČCE', brand.love);
  if (knowledge.trim()) parts.push('', 'DOPLŇUJÍCÍ ZNALOSTI', knowledge);

  parts.push(
    '',
    'TÓN',
    (brand.tones ?? []).join(', ') || 'přirozený',
    '',
    'NIKDY',
    brand.avoid,
    '',
    'TRHY',
    marketBlock || input.langs.join(', ')
  );

  parts.push(
    '',
    input.mode === 'source'
      ? `HOTOVÝ ČESKÝ TEXT K PŘEPSÁNÍ\n"""${input.source}"""`
      : `ZADÁNÍ\n"""${input.brief}"""`
  );

  if (input.mediaNote.trim()) parts.push('', 'K MÉDIÍM', input.mediaNote);

  const emojiRule = brand.emoji === 'none'
    ? 'Nepoužívej emoji.'
    : brand.emoji === 'free'
      ? 'Emoji používej, kde se hodí — ale ne v každé větě a nikdy místo slova, které něco říká.'
      : 'Emoji používej velmi střídmě: nejvýš jedno až dvě na popisek, a jen když opravdu něco přidají.';

  parts.push(
    '',
    'PRAVIDLA',
    brand.rules,
    emojiRule,
    'Nepřekládej doslova — piš tak, jak by to napsal rodilý mluvčí daného trhu.',
    'Popisek nesmí přesáhnout 2 200 znaků ani 30 hashtagů.',
    '',
    `Napiš popisek pro tyto trhy: ${input.langs.join(', ')}.`,
    input.variants > 1
      ? `Pro každý trh vytvoř ${input.variants} různé varianty — ne přeformulování téže věty, ale jiný úhel: jiný začátek, jiná délka, jiný důraz.`
      : 'Pro každý trh vytvoř jednu variantu.',
    '',
    'Vrať POUZE JSON ve tvaru {"KÓD_TRHU": ["varianta 1", "varianta 2"]} bez dalšího textu, '
      + `pro každý z těchto klíčů: ${input.langs.join(', ')}.`
  );

  return parts.join('\n');
}

export interface GeneratedCaption {
  lang: string;
  variants: string[];
}

export async function generate(input: GenerateInput): Promise<{ captions: GeneratedCaption[]; prompt: string }> {
  if (input.langs.length === 0) throw new Error('Není vybraný žádný trh.');
  if (input.mode === 'brief' && !input.brief.trim()) throw new Error('Napiš zadání, o čem má příspěvek být.');
  if (input.mode === 'source' && !input.source.trim()) throw new Error('Původní příspěvek nemá text k přepsání.');

  const brand = getBrand();
  const markets = listMarkets();
  const knowledge = brand.useKnowledge
    ? listKnowledge().map(k => `${k.title}: ${k.content}`).join('\n\n').slice(0, 12_000)
    : '';

  const prompt = buildPrompt(input, brand, markets, knowledge);
  const model = getSettings().draftModel;

  const content: any[] = [
    ...input.images.slice(0, 6).map(im => ({
      type: 'image',
      source: { type: 'base64', media_type: im.mime, data: im.b64 }
    })),
    { type: 'text', text: prompt }
  ];

  const res = await client().messages.create({
    model,
    max_tokens: 3000,
    messages: [{ role: 'user', content }]
  });
  recordUsage(model, res.usage as any);

  const text = res.content.filter(b => b.type === 'text').map(b => (b as any).text).join('').trim();
  const parsed = parseJson(text);

  const captions: GeneratedCaption[] = input.langs.map(lang => {
    const raw = parsed[lang] ?? parsed[lang.toLowerCase()] ?? parsed[lang.toUpperCase()];
    const variants = (Array.isArray(raw) ? raw : raw ? [raw] : [])
      .map(v => String(v).trim())
      .filter(Boolean);
    return { lang, variants };
  });

  const empty = captions.filter(c => c.variants.length === 0).map(c => c.lang);
  if (empty.length === captions.length) throw new Error('Model nevrátil žádný použitelný text. Zkus generování znovu.');

  return { captions: captions.filter(c => c.variants.length > 0), prompt };
}

/** Model občas obalí JSON do bloku s trojitými zpětnými apostrofy nebo přidá větu navíc. */
function parseJson(text: string): Record<string, any> {
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch { /* zkusíme vyříznout objekt */ }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch { /* níž skončíme chybou */ }
  }
  throw new Error('Model nevrátil použitelný JSON. Zkus generování znovu.');
}
