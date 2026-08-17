/**
 * Úložiště médií.
 *
 * Instagram si obrázek stahuje z veřejné adresy, takže soubor z disku je nutné
 * někam nahrát. Výchozí je Supabase Storage — jeden veřejný „bucket", nahrání
 * je jedno HTTP volání a nepotřebuje žádný vlastní server. Rozhraní je záměrně
 * úzké (`upload`, `remove`), aby šlo úložiště kdykoliv vyměnit za vlastní
 * hosting nebo S3.
 *
 * Po úspěšném zveřejnění se soubor z úložiště maže — Instagram už kopii má
 * a bezplatný tarif je tak pořád skoro prázdný.
 */
import fs from 'fs';
import path from 'path';
import { getSecrets } from './store';

export interface Uploaded {
  publicUrl: string;
  key: string;
}

function storage() {
  const s = getSecrets();
  if (!s.storageUrl || !s.storageKey) {
    throw new Error('Není nastavené úložiště médií (Instagram → Účty → Úložiště médií).');
  }
  return s;
}

export function storageConfigured(): boolean {
  const s = getSecrets();
  return !!(s.storageUrl && s.storageKey);
}

function headers(s: { storageKey: string }, extra: Record<string, string> = {}): Record<string, string> {
  return { apikey: s.storageKey, Authorization: `Bearer ${s.storageKey}`, ...extra };
}

/** Založí veřejný bucket, pokud ještě není. Volá se před prvním nahráním. */
export async function ensureBucket(): Promise<void> {
  const s = storage();
  const res = await fetch(`${s.storageUrl}/storage/v1/bucket/${encodeURIComponent(s.storageBucket)}`, {
    headers: headers(s)
  });
  if (res.ok) return;
  const create = await fetch(`${s.storageUrl}/storage/v1/bucket`, {
    method: 'POST',
    headers: headers(s, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id: s.storageBucket, name: s.storageBucket, public: true })
  });
  if (!create.ok) {
    const text = await create.text();
    // Souběžné založení dvěma cestami není chyba
    if (!/already exists|Duplicate/i.test(text)) {
      throw new Error(`Úložiště se nepodařilo připravit: ${text.slice(0, 200)}`);
    }
  }
}

export async function upload(data: Buffer, key: string, mime: string): Promise<Uploaded> {
  const s = storage();
  await ensureBucket();
  const url = `${s.storageUrl}/storage/v1/object/${encodeURIComponent(s.storageBucket)}/${key}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: headers(s, { 'Content-Type': mime || 'application/octet-stream', 'x-upsert': 'true' }),
    body: new Uint8Array(data)
  });
  if (res.status === 413) {
    throw new Error(
      `Soubor má ${Math.round(data.length / 1024 / 1024)} MB a úložiště víc nedovolí. `
      + 'Supabase má ve výchozím stavu limit 50 MB na soubor — zvedni ho v Settings → Storage, '
      + 'nebo video zkrať.'
    );
  }
  if (!res.ok) throw new Error(`Nahrání média selhalo: ${(await res.text()).slice(0, 200)}`);
  return {
    key,
    publicUrl: `${s.storageUrl}/storage/v1/object/public/${encodeURIComponent(s.storageBucket)}/${key}`
  };
}

export async function remove(key: string): Promise<void> {
  try {
    const s = storage();
    await fetch(`${s.storageUrl}/storage/v1/object/${encodeURIComponent(s.storageBucket)}/${key}`, {
      method: 'DELETE',
      headers: headers(s)
    });
  } catch { /* úklid nesmí shodit publikaci */ }
}

/** Zkušební nahrání a smazání — ověří adresu, klíč i veřejnost bucketu. */
export async function testStorage(): Promise<string> {
  const probe = Buffer.from('quentino', 'utf8');
  const { publicUrl, key } = await upload(probe, `test/${Date.now()}.txt`, 'text/plain');
  const res = await fetch(publicUrl);
  const ok = res.ok && (await res.text()).trim() === 'quentino';
  await remove(key);
  if (!ok) throw new Error('Soubor se nahrál, ale není veřejně čitelný — bucket musí být „public".');
  return 'Úložiště funguje, soubory jsou veřejně dostupné.';
}

/* ---------- Stránka pro návrat z přihlášení ---------- */

const CALLBACK_HTML = `<!doctype html>
<html lang="cs"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Quentino Mail — připojení účtu</title>
<style>
 body{font:15px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#201d29;
      background:#f6f5f8;margin:0;display:grid;place-items:center;height:100vh;text-align:center}
 .box{background:#fff;padding:34px 38px;border-radius:14px;box-shadow:0 8px 40px rgba(32,29,41,.12);max-width:420px}
 h1{font-size:17px;margin:0 0 10px}
 p{color:#6b6579;margin:0 0 16px}
 a.btn{display:inline-block;background:#7c5cff;color:#fff;text-decoration:none;padding:10px 18px;border-radius:9px;font-weight:600}
 code{display:block;word-break:break-all;background:#f6f5f8;padding:10px;border-radius:8px;font-size:12px;margin-top:14px;color:#201d29}
</style></head>
<body><div class="box">
 <h1>Účet je ověřený</h1>
 <p>Vrať se do Quentino Mailu — okno se za chvíli zavře samo.</p>
 <a class="btn" id="open" href="#">Otevřít Quentino Mail</a>
 <code id="fallback" hidden></code>
</div>
<script>
 var q = location.search.slice(1);
 var deep = 'quentino-mail://ig-oauth?' + q;
 document.getElementById('open').href = deep;
 document.getElementById('fallback').textContent = deep;
 try { location.replace(deep); } catch (e) {}
 setTimeout(function () { document.getElementById('fallback').hidden = false; }, 2500);
 setTimeout(function () { window.close(); }, 1800);
</script></body></html>`;

/**
 * Nahraje návratovou stránku do úložiště a vrátí její adresu. Tu pak stačí
 * vložit do Meta aplikace jako „Valid OAuth Redirect URI" — vlastní server
 * kvůli tomu nikdo zakládat nemusí.
 */
export async function installCallbackPage(): Promise<string> {
  // Charset výslovně: bez něj některá úložiště pošlou stránku jako čistý text
  // a prohlížeč pak zobrazí zdrojový kód místo stránky.
  const { publicUrl } = await upload(
    Buffer.from(CALLBACK_HTML, 'utf8'),
    'oauth/callback.html',
    'text/html; charset=utf-8'
  );
  return publicUrl;
}

/* ---------- Práce se soubory ---------- */

const MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v'
};

export function mimeFor(file: string): string {
  return MIME[path.extname(file).toLowerCase().slice(1)] ?? 'application/octet-stream';
}

export function isVideoFile(file: string): boolean {
  return mimeFor(file).startsWith('video/');
}

/** Rozměry obrázku z hlavičky souboru — bez knihovny, jen JPEG, PNG a WebP. */
export function imageSize(buf: Buffer): { width: number; height: number } | null {
  try {
    // PNG
    if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    // WebP
    if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const type = buf.toString('ascii', 12, 16);
      if (type === 'VP8X') return { width: (buf.readUIntLE(24, 3) & 0xffffff) + 1, height: (buf.readUIntLE(27, 3) & 0xffffff) + 1 };
      if (type === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      if (type === 'VP8L') {
        const b = buf.readUInt32LE(21);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
      }
    }
    // JPEG — projít značky až k SOFn
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i < buf.length - 9) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
    }
  } catch { /* rozměry jsou jen pro upozornění */ }
  return null;
}

/**
 * Poměr stran, který Instagram u příspěvků přijímá (4:5 až 1.91:1).
 * Vrací text upozornění, nebo null když je vše v pořádku.
 */
export function aspectWarning(width: number, height: number): string | null {
  const r = width / height;
  if (r < 0.8) return `Poměr stran ${r.toFixed(2)}:1 je na výšku víc než 4:5 — Instagram obrázek ořízne.`;
  if (r > 1.91) return `Poměr stran ${r.toFixed(2)}:1 je širší než 1.91:1 — Instagram obrázek ořízne.`;
  return null;
}

export function readFile(file: string): Buffer {
  const stat = fs.statSync(file);
  if (stat.size > 300 * 1024 * 1024) throw new Error('Soubor je větší než 300 MB.');
  return fs.readFileSync(file);
}

export async function download(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Médium se nepodařilo stáhnout (${res.status}).`);
  return Buffer.from(await res.arrayBuffer());
}
