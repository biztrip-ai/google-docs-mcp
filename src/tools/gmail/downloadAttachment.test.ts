import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UserError } from 'fastmcp';

vi.mock('../../clients.js', () => ({ getGmailClient: vi.fn() }));

import { getGmailClient } from '../../clients.js';
import { findAttachmentPart, register } from './downloadAttachment.js';

const b64 = (s: string) => Buffer.from(s).toString('base64url');

// multipart/mixed: a text body, a PDF (fetched by attachmentId), a small CSV
// whose bytes are inline in the part, and two parts that share a name.
const payload = {
  partId: '',
  mimeType: 'multipart/mixed',
  parts: [
    { partId: '0', mimeType: 'text/plain', filename: '', body: { data: b64('hello') } },
    {
      partId: '1',
      mimeType: 'application/pdf',
      filename: 'Contract.pdf',
      body: { attachmentId: 'ATT-1', size: 7 },
    },
    { partId: '2', mimeType: 'text/csv', filename: 'rates.csv', body: { data: b64('a,b\n1,2\n') } },
    { partId: '3', mimeType: 'image/png', filename: 'logo.png', body: { attachmentId: 'ATT-3' } },
    { partId: '4', mimeType: 'image/png', filename: 'logo.png', body: { attachmentId: 'ATT-4' } },
  ],
};

describe('findAttachmentPart', () => {
  it('finds by partId, attachmentId or case-insensitive filename', () => {
    expect(findAttachmentPart(payload, { partId: '2' }).filename).toBe('rates.csv');
    expect(findAttachmentPart(payload, { attachmentId: 'ATT-1' }).partId).toBe('1');
    expect(findAttachmentPart(payload, { filename: 'contract.PDF' }).partId).toBe('1');
  });

  it('falls back to filename when a stale attachmentId no longer matches', () => {
    expect(
      findAttachmentPart(payload, { attachmentId: 'OLD', filename: 'Contract.pdf' }).partId
    ).toBe('1');
  });

  it('refuses an ambiguous filename and an unknown attachment, listing what exists', () => {
    expect(() => findAttachmentPart(payload, { filename: 'logo.png' })).toThrow(/partId/);
    expect(() => findAttachmentPart(payload, { partId: '9' })).toThrow(
      /"Contract.pdf" \(partId 1\)/
    );
    expect(() => findAttachmentPart(payload, { partId: '0' })).toThrow(UserError); // the body, not an attachment
  });
});

describe('downloadAttachment', () => {
  let dir: string;
  let execute: (args: any, ctx: any) => Promise<any>;
  const attachmentsGet = vi.fn();
  const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-att-'));
    process.env.GOOGLE_DOCS_MCP_DOWNLOAD_ROOTS = dir;
    attachmentsGet.mockReset().mockResolvedValue({ data: { data: b64('%PDF-1') } });
    vi.mocked(getGmailClient).mockResolvedValue({
      users: {
        messages: {
          get: vi.fn().mockResolvedValue({ data: { id: 'M1', payload } }),
          attachments: { get: attachmentsGet },
        },
      },
    } as any);
    register({ addTool: (t: any) => (execute = t.execute) } as any);
  });

  afterEach(() => {
    delete process.env.GOOGLE_DOCS_MCP_DOWNLOAD_ROOTS;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('fetches an attachment by its current id and saves it', async () => {
    const savePath = path.join(dir, 'in', 'c.pdf');
    const out = JSON.parse(await execute({ messageId: 'M1', partId: '1', savePath }, { log }));
    expect(attachmentsGet).toHaveBeenCalledWith({ userId: 'me', messageId: 'M1', id: 'ATT-1' });
    expect(fs.readFileSync(savePath, 'utf-8')).toBe('%PDF-1');
    expect(out).toMatchObject({ savedTo: savePath, fileName: 'Contract.pdf', sizeBytes: 6 });
    expect(out.textContent).toBeUndefined();
  });

  it('uses inline part data without another call, and returns text content', async () => {
    const savePath = path.join(dir, 'rates.csv');
    const out = JSON.parse(
      await execute({ messageId: 'M1', filename: 'rates.csv', savePath }, { log })
    );
    expect(attachmentsGet).not.toHaveBeenCalled();
    expect(out.textContent).toBe('a,b\n1,2\n');
  });

  it('refuses to write outside the download roots', async () => {
    await expect(
      execute(
        { messageId: 'M1', partId: '1', savePath: path.join(dir, '..', 'escape.pdf') },
        { log }
      )
    ).rejects.toThrow(/allowed download directory/);
  });

  it('needs something that names the attachment', async () => {
    await expect(execute({ messageId: 'M1' }, { log })).rejects.toThrow(
      /partId, attachmentId or filename/
    );
  });
});
