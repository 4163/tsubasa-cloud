import type React from 'react';

export function isInternalItemDrag(e: React.DragEvent | DragEvent): boolean {
  return Boolean(e.dataTransfer?.types?.includes('application/x-tsubasa-items'));
}

export function isExternalFileDrag(e: React.DragEvent | DragEvent): boolean {
  const types = e.dataTransfer?.types;
  if (!types) return false;
  return types.includes('Files') && !types.includes('application/x-tsubasa-items');
}

export async function extractDataTransferEntries(
  dataTransfer: DataTransfer,
  basePath: string
): Promise<{ files: Array<{ file: File; virtualPath: string }>; emptyFolders: string[]; basePath: string }> {
  const cleanBase = basePath === '/' ? '' : basePath.replace(/\/+$/, '');
  const normalizedBase = cleanBase === '' ? '/' : cleanBase.startsWith('/') ? cleanBase : `/${cleanBase}`;
  const resultFiles: Array<{ file: File; virtualPath: string }> = [];
  const resultEmptyFolders: string[] = [];

  const rawFiles = Array.from(dataTransfer.files || []);
  const items = dataTransfer.items ? Array.from(dataTransfer.items) : [];

  let hasDirectories = false;
  const entries: any[] = [];
  for (const it of items) {
    if (typeof (it as any).webkitGetAsEntry === 'function') {
      const entry = (it as any).webkitGetAsEntry();
      if (entry) {
        entries.push(entry);
        if (entry.isDirectory) {
          hasDirectories = true;
        }
      }
    }
  }

  // Use rawFiles directly when no directories were dropped to avoid async entry traversal.
  if (!hasDirectories && rawFiles.length > 0) {
    for (const f of rawFiles) {
      const rel = (f as any).webkitRelativePath || f.name;
      resultFiles.push({
        file: f,
        virtualPath: `${cleanBase}/${rel}`.replace(/\/+/g, '/'),
      });
    }
    return { files: resultFiles, emptyFolders: resultEmptyFolders, basePath: normalizedBase };
  }

  // Fallback if entries failed to extract from items
  if (entries.length === 0 && rawFiles.length > 0) {
    for (const f of rawFiles) {
      const rel = (f as any).webkitRelativePath || f.name;
      resultFiles.push({
        file: f,
        virtualPath: `${cleanBase}/${rel}`.replace(/\/+/g, '/'),
      });
    }
    return { files: resultFiles, emptyFolders: resultEmptyFolders, basePath: normalizedBase };
  }

  async function traverse(entry: any, currentFolder: string) {
    if (entry.isFile) {
      await new Promise<void>((resolve) => {
        try {
          entry.file(
            (f: File) => {
              resultFiles.push({
                file: f,
                virtualPath: `${currentFolder}/${f.name}`.replace(/\/+/g, '/'),
              });
              resolve();
            },
            () => {
              if (currentFolder === cleanBase) {
                const match = rawFiles.find(
                  (rf) => rf.name === entry.name && !(rf as any).webkitRelativePath?.includes('/')
                );
                if (match) {
                  resultFiles.push({
                    file: match,
                    virtualPath: `${currentFolder}/${match.name}`.replace(/\/+/g, '/'),
                  });
                }
              }
              resolve();
            }
          );
        } catch {
          resolve();
        }
      });
    } else if (entry.isDirectory) {
      const nextFolder = `${currentFolder}/${entry.name}`.replace(/\/+/g, '/');
      const dirReader = entry.createReader();
      const childEntries: any[] = [];
      let readError = false;

      const readBatch = async (): Promise<void> => {
        return new Promise<void>((resolve) => {
          dirReader.readEntries(
            async (results: any[]) => {
              if (results && results.length > 0) {
                childEntries.push(...results);
                await readBatch();
              }
              resolve();
            },
            () => {
              readError = true;
              resolve();
            }
          );
        });
      };

      await readBatch();

      if (childEntries.length === 0) {
        if (!readError) {
          resultEmptyFolders.push(nextFolder);
        }
      } else {
        for (const child of childEntries) {
          await traverse(child, nextFolder);
        }
      }
    }
  }

  for (const entry of entries) {
    await traverse(entry, cleanBase);
  }

  return { files: resultFiles, emptyFolders: resultEmptyFolders, basePath: normalizedBase };
}
