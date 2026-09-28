# Drive

Tools for managing files and folders in Google Drive, including listing, searching, creating, copying, moving, renaming, and deleting documents and folders.

| Tool                         | Description                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| `listDocuments`              | Lists Google Documents in your Drive, optionally filtered by name or content                           |
| `searchDocuments`            | Searches for documents by name, content, or both                                                       |
| `getDocumentInfo`            | Gets metadata about a document (owner, sharing, modification history)                                  |
| `createDocument`             | Creates a new empty Google Document                                                                    |
| `createDocumentFromTemplate` | Creates a new document by copying a template with placeholder replacements                             |
| `createFolder`               | Creates a new folder in Google Drive                                                                   |
| `listFolderContents`         | Lists files and subfolders within a Drive folder                                                       |
| `getFolderInfo`              | Gets metadata about a Drive folder                                                                     |
| `moveFile`                   | Moves a file or folder to a different Drive folder                                                     |
| `copyFile`                   | Creates a copy of a file or document                                                                   |
| `renameFile`                 | Renames a file or folder                                                                               |
| `deleteFile`                 | Moves a file or folder to the trash, or permanently deletes it                                         |
| `uploadFile`                 | Uploads a local file (inside the download roots) to Drive, optionally converting to Docs/Sheets/Slides |
| `setFilePermission`          | Shares a file or folder with a user, group, the whole organization (`domain`) or anyone with the link  |
