import type { FastMCP } from 'fastmcp';
import { UserError, imageContent } from 'fastmcp';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { gmail_v1 } from 'googleapis';
import { getGmailClient } from '../../clients.js';
import { isTextMimeType } from '../drive/downloadFile.js';
import { ensureWithinDownloadRoots, parseDownloadRoots } from '../drive/savePathGuard.js';

const isRemote = process.env.MCP_TRANSPORT === 'httpStream';

const MAX_TEXT_EXTRACT_BYTES = 50_000;
const MAX_INLINE_BYTES = 25 * 1024 * 1024; // Gmail's own attachment limit

/**
 * The attachment part a caller means. Gmail hands out a different
 * `attachmentId` on every fetch of a message, so the part is found again in a
 * fresh copy of the message: by `partId` (stable), then `attachmentId`, then
 * `filename` (case-insensitive, must be unambiguous).
 */
export function findAttachmentPart(
  payload: gmail_v1.Schema$MessagePart | undefined,
  want: { partId?: string; attachmentId?: string; filename?: string }
): gmail_v1.Schema$MessagePart {
  const parts: gmail_v1.Schema$MessagePart[] = [];
  const walk = (part: gmail_v1.Schema$MessagePart) => {
    if (part.filename && (part.body?.attachmentId || part.body?.data)) parts.push(part);
    for (const sub of part.parts ?? []) walk(sub);
  };
  if (payload) walk(payload);

  const names = parts.map((p) => `"${p.filename}" (partId ${p.partId})`).join(', ') || 'none';
  let matches: gmail_v1.Schema$MessagePart[] = [];
  if (want.partId) matches = parts.filter((p) => p.partId === want.partId);
  else if (want.attachmentId)
    matches = parts.filter((p) => p.body?.attachmentId === want.attachmentId);
  if (!matches.length && want.filename) {
    const f = want.filename.toLowerCase();
    matches = parts.filter((p) => p.filename!.toLowerCase() === f);
    if (matches.length > 1)
      throw new UserError(
        `Several attachments are named "${want.filename}"; pass partId instead. Attachments: ${names}.`
      );
  }
  if (!matches.length)
    throw new UserError(`No such attachment on this message. Attachments: ${names}.`);
  return matches[0];
}

const DownloadAttachmentParameters = z.strictObject({
  messageId: z.string().describe('The Gmail message ID, from listMessages or getMessage.'),
  partId: z
    .string()
    .optional()
    .describe("The attachment's partId from getMessage (preferred: it is stable)."),
  attachmentId: z
    .string()
    .optional()
    .describe('The attachmentId from getMessage. Used if partId is not given.'),
  filename: z
    .string()
    .optional()
    .describe("The attachment's file name, if partId and attachmentId are not given."),
  savePath: z
    .string()
    .optional()
    .describe(
      'Local file path to save the attachment to. Parent directories are created automatically. ' +
        "If omitted, saves to the current working directory under the attachment's own name."
    ),
  extractText: z
    .boolean()
    .optional()
    .default(true)
    .describe('If true, also return the content of a text attachment (up to 50KB).'),
});

export function register(server: FastMCP) {
  server.addTool({
    name: 'downloadAttachment',
    description:
      'Downloads one attachment from a Gmail message. Use getMessage first to see the ' +
      "message's attachments, then pass the messageId and the attachment's partId (or " +
      'attachmentId or filename). Saves the file locally and returns where it went; text ' +
      'attachments also come back inline.',
    parameters: DownloadAttachmentParameters,
    execute: async (args, { log }) => {
      if (!args.partId && !args.attachmentId && !args.filename)
        throw new UserError('Pass partId, attachmentId or filename to say which attachment.');
      const gmail = await getGmailClient();
      log.info(`Downloading attachment from Gmail message ${args.messageId}`);

      let resolvedSavePath: string | undefined;
      try {
        const msg = await gmail.users.messages.get({
          userId: 'me',
          id: args.messageId,
          format: 'full',
        });
        const part = findAttachmentPart(msg.data.payload, args);
        const fileName = path.basename(part.filename || 'attachment');
        const mimeType = part.mimeType || 'application/octet-stream';

        let data = part.body?.data;
        if (!data) {
          const res = await gmail.users.messages.attachments.get({
            userId: 'me',
            messageId: args.messageId,
            id: part.body!.attachmentId!,
          });
          data = res.data.data;
        }
        const buffer = Buffer.from(data ?? '', 'base64url');
        const meta = { fileName, mimeType, partId: part.partId, sizeBytes: buffer.length };

        // ---------- Remote mode: no shared disk, return the bytes inline ----------
        if (isRemote) {
          if (buffer.length > MAX_INLINE_BYTES)
            throw new UserError(
              `Attachment too large for inline transfer (${(buffer.length / 1024 / 1024).toFixed(1)}MB).`
            );
          const content: any[] = [];
          if (isTextMimeType(mimeType)) {
            content.push({
              type: 'text' as const,
              text: buffer.toString('utf-8').slice(0, MAX_TEXT_EXTRACT_BYTES),
            });
          } else if (mimeType.startsWith('image/')) {
            content.push(await imageContent({ buffer }));
          } else {
            content.push({
              type: 'resource' as const,
              resource: {
                uri: `gmail:///${args.messageId}/${part.partId}/${fileName}`,
                blob: buffer.toString('base64'),
                mimeType,
              },
            });
          }
          content.push({ type: 'text' as const, text: JSON.stringify(meta) });
          return { content };
        }

        // ---------- Stdio mode: write to local disk ----------
        // `savePath` and the attachment's file name both come from untrusted
        // input (the agent, the email's sender), so confine the write.
        resolvedSavePath = path.resolve(args.savePath || path.join(process.cwd(), fileName));
        try {
          resolvedSavePath = ensureWithinDownloadRoots(resolvedSavePath, parseDownloadRoots());
        } catch (boundaryError: any) {
          throw new UserError(boundaryError?.message || String(boundaryError));
        }
        fs.mkdirSync(path.dirname(resolvedSavePath), { recursive: true });
        fs.writeFileSync(resolvedSavePath, buffer);

        const result: Record<string, unknown> = { savedTo: resolvedSavePath, ...meta };
        if (args.extractText !== false && isTextMimeType(mimeType)) {
          result.textContent = buffer.toString('utf-8').slice(0, MAX_TEXT_EXTRACT_BYTES);
        }
        return JSON.stringify(result, null, 2);
      } catch (error: any) {
        log.error(`Error downloading attachment: ${error.message || error}`);
        if (error instanceof UserError) throw error;
        if (error.code === 404)
          throw new UserError(`Gmail message or attachment not found (message ${args.messageId}).`);
        if (error.code === 403)
          throw new UserError('Permission denied. Confirm the gmail.modify scope was granted.');
        throw new UserError(`Failed to download attachment: ${error.message || 'Unknown error'}`);
      }
    },
  });
}
