import type { FastMCP } from 'fastmcp';
import { UserError } from 'fastmcp';
import { z } from 'zod';
import { drive_v3 } from 'googleapis';
import { getDriveClient } from '../../clients.js';

export function register(server: FastMCP) {
  server.addTool({
    name: 'setFilePermission',
    description:
      "Sets a sharing permission on a Drive file or folder. Common case: type='anyone' with role='reader' enables 'anyone with the link can view'. Use type='user' with emailAddress to grant a specific person access. To share with everyone in the organization, use type='domain' with domain set to the org's domain (e.g. 'example.com'). Returns the created permission record.",
    parameters: z.strictObject({
      fileId: z
        .string()
        .describe('The file or folder ID from a Drive URL or a previous tool result.'),
      role: z
        .enum(['reader', 'commenter', 'writer'])
        .describe(
          'Access level granted. "reader" = view only, "commenter" = view + comment, "writer" = full edit.'
        ),
      type: z
        .enum(['user', 'group', 'domain', 'anyone'])
        .describe(
          'Who this permission applies to. "anyone" means anyone with the link (combine with allowFileDiscovery=false to keep it unlisted).'
        ),
      emailAddress: z.string().optional().describe("Required when type is 'user' or 'group'."),
      domain: z.string().optional().describe("Required when type is 'domain'."),
      sendNotificationEmail: z
        .boolean()
        .optional()
        .describe(
          'If true, Google sends a notification email when granting access to a user or group. Defaults to false.'
        ),
      allowFileDiscovery: z
        .boolean()
        .optional()
        .describe(
          "Only relevant for type='anyone' or 'domain'. If true, the file is discoverable via search; if false (default), only people with the direct link can find it."
        ),
    }),
    execute: async (args, { log }) => {
      const drive = await getDriveClient();
      log.info(`Setting ${args.type}/${args.role} permission on file ${args.fileId}`);

      if ((args.type === 'user' || args.type === 'group') && !args.emailAddress) {
        throw new UserError(`emailAddress is required when type is "${args.type}".`);
      }
      if (args.type === 'domain' && !args.domain) {
        throw new UserError('domain is required when type is "domain".');
      }

      const requestBody: drive_v3.Schema$Permission = {
        role: args.role,
        type: args.type,
      };
      if (args.emailAddress) requestBody.emailAddress = args.emailAddress;
      if (args.domain) requestBody.domain = args.domain;
      if (typeof args.allowFileDiscovery === 'boolean')
        requestBody.allowFileDiscovery = args.allowFileDiscovery;

      try {
        const response = await drive.permissions.create({
          fileId: args.fileId,
          requestBody,
          sendNotificationEmail: args.sendNotificationEmail ?? false,
          supportsAllDrives: true,
          fields: 'id,type,role,emailAddress,domain,allowFileDiscovery',
        });
        return JSON.stringify(response.data, null, 2);
      } catch (error: any) {
        log.error(`Error setting permission: ${error.message || error}`);
        if (error.code === 404) throw new UserError('File not found. Check the file ID.');
        if (error.code === 403)
          throw new UserError(
            'Permission denied. You may not have rights to share this file, or the requested permission conflicts with org policy.'
          );
        throw new UserError(`Failed to set permission: ${error.message || 'Unknown error'}`);
      }
    },
  });
}
