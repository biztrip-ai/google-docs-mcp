import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../clients.js', () => ({ getDriveClient: vi.fn() }));

import { getDriveClient } from '../../clients.js';
import { register } from './uploadFile.js';

describe('uploadFile', () => {
  let dir: string;
  let execute: (args: any, ctx: any) => Promise<any>;
  const create = vi.fn();
  let uploaded = '';
  const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-up-'));
    process.env.GOOGLE_DOCS_MCP_DOWNLOAD_ROOTS = dir;
    create.mockReset().mockImplementation(async ({ requestBody, media }: any) => {
      // Read the upload through, as Drive would, before the temp dir goes.
      const chunks: Buffer[] = [];
      for await (const c of media.body) chunks.push(c);
      uploaded = Buffer.concat(chunks).toString();
      return {
        data: {
          id: 'F1',
          name: requestBody.name,
          mimeType: requestBody.mimeType ?? 'x',
          parents: requestBody.parents,
          webViewLink: 'https://drive/F1',
        },
      };
    });
    vi.mocked(getDriveClient).mockResolvedValue({ files: { create } } as any);
    register({ addTool: (t: any) => (execute = t.execute) } as any);
  });

  afterEach(() => {
    delete process.env.GOOGLE_DOCS_MCP_DOWNLOAD_ROOTS;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, body = 'data') => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, body);
    return p;
  };

  it('uploads a file into a folder with its own name and type', async () => {
    const p = write('Contract.pdf', '%PDF-1');
    const out = JSON.parse(await execute({ localPath: p, folderId: 'FOLDER' }, { log }));
    const call = create.mock.calls[0][0];
    expect(call.requestBody).toEqual({ name: 'Contract.pdf', parents: ['FOLDER'] });
    expect(call.media.mimeType).toBe('application/pdf');
    expect(call.supportsAllDrives).toBe(true);
    expect(out).toMatchObject({ id: 'F1', url: 'https://drive/F1', sizeBytes: 6 });
    expect(uploaded).toBe('%PDF-1');
  });

  it('converts to a Google format and drops the extension from the name', async () => {
    const p = write('rates.xlsx');
    await execute({ localPath: p, convertToGoogleFormat: true }, { log });
    expect(create.mock.calls[0][0].requestBody).toEqual({
      name: 'rates',
      mimeType: 'application/vnd.google-apps.spreadsheet',
    });
  });

  it('uploads a type with no Google format unchanged, and says so', async () => {
    const p = write('photo.png');
    const out = JSON.parse(await execute({ localPath: p, convertToGoogleFormat: true }, { log }));
    expect(create.mock.calls[0][0].requestBody).toEqual({ name: 'photo.png' });
    expect(out.note).toMatch(/\.png/);
  });

  it('refuses files outside the download roots, including through a symlink', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-'));
    fs.writeFileSync(path.join(outside, 'agent.env'), 'TOKEN=x');
    fs.symlinkSync(outside, path.join(dir, 'link'));
    try {
      await expect(
        execute({ localPath: path.join(outside, 'agent.env') }, { log })
      ).rejects.toThrow(/localPath must stay inside/);
      await expect(
        execute({ localPath: path.join(dir, 'link', 'agent.env') }, { log })
      ).rejects.toThrow(/localPath must stay inside/);
      expect(create).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses a missing file or a directory', async () => {
    await expect(execute({ localPath: path.join(dir, 'nope.pdf') }, { log })).rejects.toThrow(
      /No such file/
    );
    fs.mkdirSync(path.join(dir, 'sub'));
    await expect(execute({ localPath: path.join(dir, 'sub') }, { log })).rejects.toThrow(
      /Not a regular file/
    );
  });
});
