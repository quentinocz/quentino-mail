import nodemailer from 'nodemailer';
import fs from 'fs';
import path from 'path';
import { getDb } from './db';
import { getAccountWithPassword } from './accounts';
import { appendToSent } from './imap';
import { ComposeDraft } from '../shared/types';
import { translateHtml } from './ai';
import { rememberAddressList } from './contacts';
import { getCaCertificates } from './systemca';

/** Sestaví MIME zprávu jednou — použije se pro odeslání i kopii do Odeslané pošty. */
async function buildRaw(
  draft: ComposeDraft,
  acc: { name: string; email: string; logoPath?: string | null },
  html: string
): Promise<Buffer> {
  const attachments: any[] = (draft.attachmentPaths ?? []).map(p => ({ filename: path.basename(p), path: p }));
  // Inline obrázky (logo podpisu, fotka osoby) — CID přílohy se zobrazí všem příjemcům
  const inline = [...(draft.inlineImages ?? [])];
  if (acc.logoPath && html.includes('cid:sig-logo') && !inline.some(i => i.cid === 'sig-logo')) {
    inline.push({ cid: 'sig-logo', path: acc.logoPath });
  }
  let finalHtml = html;
  for (const img of inline) {
    if (!finalHtml.includes(`cid:${img.cid}`)) continue;
    // Obsah načteme rovnou do paměti. Kdyby se soubor mezitím ztratil (přesunutý
    // podpisový obrázek, vystrčený iCloud), poslala by se prázdná příloha a příjemce
    // by v podpisu viděl díru — takový obrázek radši ze zprávy vyřadíme.
    let content: Buffer;
    try {
      content = fs.readFileSync(img.path);
      if (content.length === 0) throw new Error('prázdný soubor');
    } catch {
      finalHtml = finalHtml.replace(new RegExp(`<img[^>]*cid:${img.cid}[^>]*>`, 'gi'), '');
      continue;
    }
    attachments.push({
      filename: path.basename(img.path),
      content,
      cid: img.cid,
      contentDisposition: 'inline'
    });
  }
  const composer = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
  const res: any = await composer.sendMail({
    from: { name: draft.fromName || acc.name, address: acc.email },
    to: draft.to,
    cc: draft.cc || undefined,
    bcc: draft.bcc || undefined,
    subject: draft.subject,
    html: finalHtml,
    text: htmlToText(finalHtml),
    inReplyTo: draft.inReplyTo ? `<${draft.inReplyTo}>` : undefined,
    references: draft.references
      ? draft.references.split(/\s+/).filter(Boolean).map(r => `<${r.replace(/[<>]/g, '')}>`).join(' ')
      : undefined,
    attachments
  });
  return res.message as Buffer;
}

export async function sendNow(draft: ComposeDraft): Promise<void> {
  const acc = getAccountWithPassword(draft.accountId);
  if (!acc) throw new Error('Účet nenalezen');

  let html = draft.html;
  if (draft.translateTo && draft.translateTo !== 'cs') {
    html = await translateHtml(html, draft.translateTo);
  }

  const raw = await buildRaw(draft, acc, html);

  const transporter = nodemailer.createTransport({
    host: acc.smtpHost,
    port: acc.smtpPort,
    secure: acc.smtpSecure,
    auth: { user: acc.username, pass: acc.password },
    tls: { ca: getCaCertificates() }
  });

  await transporter.sendMail({
    envelope: {
      from: acc.email,
      to: [draft.to, draft.cc, draft.bcc].filter(Boolean).join(',').split(',').map(s => s.trim()).filter(Boolean)
    },
    raw
  });

  // Kopie do Odeslané pošty na serveru (není kritická)
  try {
    await appendToSent(draft.accountId, raw);
  } catch {
    /* ignorováno */
  }

  if (draft.replyToDbId) {
    getDb().prepare('UPDATE messages SET answered = 1 WHERE id = ?').run(draft.replyToDbId);
  }

  // Adresy do našeptávače
  for (const list of [draft.to, draft.cc, draft.bcc]) {
    if (list) rememberAddressList(list);
  }
}

export function scheduleSend(draft: ComposeDraft): number {
  const d = getDb();
  const info = d.prepare(
    `INSERT INTO outbox (account_id, to_addr, cc, bcc, subject, html, attachments_json, inline_json, from_name, in_reply_to, refs, reply_to_db_id, send_at, status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'scheduled')`
  ).run(
    draft.accountId, draft.to, draft.cc ?? '', draft.bcc ?? '', draft.subject,
    draft.html, JSON.stringify(draft.attachmentPaths ?? []), JSON.stringify(draft.inlineImages ?? []),
    draft.fromName ?? null,
    draft.inReplyTo ?? null, draft.references ?? null, draft.replyToDbId ?? null,
    draft.sendAt ?? new Date().toISOString()
  );
  return Number(info.lastInsertRowid);
}

export async function testSmtp(cfg: {
  smtpHost: string; smtpPort: number; smtpSecure: boolean; username: string; password: string;
}): Promise<void> {
  const transporter = nodemailer.createTransport({
    host: cfg.smtpHost,
    port: cfg.smtpPort,
    secure: cfg.smtpSecure,
    auth: { user: cfg.username, pass: cfg.password },
    tls: { ca: getCaCertificates() }
  });
  await transporter.verify();
}

function htmlToText(html: string): string {
  return html
    // Obsah <style>/<script> musí pryč i s vnitřkem, jinak by se CSS podpisu
    // objevilo jako text v prosté verzi zprávy
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>(?=.)/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
