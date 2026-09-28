import type { FastMCP } from 'fastmcp';
import { UserError } from 'fastmcp';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { drive_v3 } from 'googleapis';
import { getDriveClient } from '../../clients.js';
import { ensureWithinDownloadRoots, parseDownloadRoots } from './savePathGuard.js';

const isRemote = process.env.MCP_TRANSPORT === 'httpStream';

export const UPLOAD_MIME_BY_EXTENSION: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.html': 'text/html',
  '.json': 'application/json',
  '.rtf': 'application/rtf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.zip': 'application/zip',
};

const DOC = 'application/vnd.google-apps.document';
const SHEET = 'application/vnd.google-apps.spreadsheet';
const SLIDES = 'application/vnd.google-apps.presentation';

/** The Google Workspace type a file of this extension converts to, if any. */
export const CONVERT_TO_BY_EXTENSION: Record<string, string> = {
  '.txt': DOC,
  '.md': DOC,
  '.html': DOC,
  '.rtf': DOC,
  '.doc': DOC,
  '.docx': DOC,
  '.odt': DOC,
  '.csv': SHEET,
  '.tsv': SHEET,
  '.xls': SHEET,
  '.xlsx': SHEET,
  '.ods': SHEET,
  '.ppt': SLIDES,
  '.pptx': SLIDES,
  '.odp': SLIDES,
};

export function register(server: FastMCP) {
  server.addTool({
    name: 'uploadFile',
    description:
      'Uploads a local file to Google Drive, optionally into a folder and optionally converted to ' +
      'a Google Doc, Sheet or Slides. Only files inside the allowed download directory can be ' +
      "uploaded (where downloadFile and downloadAttachment save). Returns the new file's id and link.",
    parameters: z.strictObject({
      localPath: z
        .string()
        .describe('Path of the local file to upload, e.g. the savedTo from downloadAttachment.'),
      folderId: z
        .string()
        .optional()
        .describe('Drive folder to put the file in. Defaults to My Drive root.'),
      name: z
        .string()
        .optional()
        .describe("Name for the file in Drive. Defaults to the local file's name."),
      convertToGoogleFormat: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Convert to a Google Doc (docx, txt, md, html…), Sheet (xlsx, csv…) or Slides (pptx…). ' +
            'The extension is dropped from the default name. Other types upload unchanged.'
        ),
    }),
    execute: async (args, { log }) => {
      if (isRemote)
        throw new UserError('uploadFile reads a local file, so it only works in stdio mode.');

      // `localPath` is agent-controlled, and uploading is a way to move a file
      // off the machine: confine it to the download roots like the writes.
      let localPath: string;
      try {
        localPath = ensureWithinDownloadRoots(path.resolve(args.localPath), parseDownloadRoots());
      } catch (boundaryError: any) {
        throw new UserError(
          (boundaryError?.message || String(boundaryError)).replace('savePath', 'localPath')
        );
      }
      let stat: fs.Stats;
      try {
        stat = fs.statSync(localPath);
      } catch {
        throw new UserError(`No such file: ${localPath}`);
      }
      if (!stat.isFile()) throw new UserError(`Not a regular file: ${localPath}`);

      const ext = path.extname(localPath).toLowerCase();
      const mimeType = UPLOAD_MIME_BY_EXTENSION[ext] || 'application/octet-stream';
      const convertTo = args.convertToGoogleFormat ? CONVERT_TO_BY_EXTENSION[ext] : undefined;
      const baseName = path.basename(localPath);
      const name = args.name || (convertTo ? path.parse(baseName).name : baseName);

      const requestBody: drive_v3.Schema$File = { name };
      if (convertTo) requestBody.mimeType = convertTo;
      if (args.folderId) requestBody.parents = [args.folderId];

      const drive = await getDriveClient();
      log.info(`Uploading ${localPath} to Drive as "${name}"${convertTo ? ` (${convertTo})` : ''}`);
      try {
        const res = await drive.files.create({
          requestBody,
          media: { mimeType, body: fs.createReadStream(localPath) },
          fields: 'id,name,mimeType,parents,webViewLink',
          supportsAllDrives: true,
        });
        const f = res.data;
        const result: Record<string, unknown> = {
          id: f.id,
          name: f.name,
          mimeType: f.mimeType,
          parents: f.parents,
          url: f.webViewLink,
          sizeBytes: stat.size,
        };
        if (args.convertToGoogleFormat && !convertTo)
          result.note = `No Google format for ${ext || 'files without an extension'}; uploaded as is.`;
        return JSON.stringify(result, null, 2);
      } catch (error: any) {
        log.error(`Error uploading file: ${error.message || error}`);
        if (error.code === 404) throw new UserError('Folder not found. Check the folder ID.');
        if (error.code === 403)
          throw new UserError('Permission denied. Make sure you can add files to that folder.');
        throw new UserError(`Failed to upload file: ${error.message || 'Unknown error'}`);
      }
    },
  });
}
