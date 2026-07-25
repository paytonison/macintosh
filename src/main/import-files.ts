import { lstat, open, opendir } from 'node:fs/promises';
import path from 'node:path';

import type { ImportedEntry, ImportFilesResult } from '../shared/contracts';

const MAX_ROOTS = 64;
const MAX_ENTRIES = 256;
const MAX_DEPTH = 24;
const MAX_DOCUMENT_BYTES = 60 * 1024;
const MAX_IMPORT_BYTES = 192 * 1024;

const textExtensions = new Set([
  '.c',
  '.cc',
  '.conf',
  '.cpp',
  '.css',
  '.csv',
  '.h',
  '.hpp',
  '.htm',
  '.html',
  '.ini',
  '.js',
  '.json',
  '.jsx',
  '.log',
  '.md',
  '.mjs',
  '.py',
  '.rtf',
  '.sh',
  '.text',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
]);

interface ImportBudget {
  entries: number;
  bytes: number;
  skippedCount: number;
  truncatedCount: number;
}

const cleanName = (value: string): string =>
  value.replaceAll('\0', '').replaceAll('/', ':').trim().slice(0, 96) || 'untitled';

const safeTimestamp = (value: Date, fallback: Date): string => {
  const timestamp = Number.isFinite(value.getTime()) ? value : fallback;
  return timestamp.toISOString();
};

const looksLikeText = (buffer: Buffer, extension: string): boolean => {
  if (textExtensions.has(extension)) return true;
  if (buffer.includes(0)) return false;
  if (buffer.length === 0) return true;

  let controls = 0;
  for (const byte of buffer) {
    if (byte < 9 || (byte > 13 && byte < 32)) controls += 1;
  }
  return controls / buffer.length < 0.02;
};

const readBeginning = async (filePath: string, size: number): Promise<Buffer> => {
  const bytesToRead = Math.min(size, MAX_DOCUMENT_BYTES + 1);
  if (bytesToRead === 0) return Buffer.alloc(0);
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
};

const inspectPath = async (
  filePath: string,
  budget: ImportBudget,
  depth: number,
): Promise<ImportedEntry | null> => {
  if (budget.entries >= MAX_ENTRIES || depth > MAX_DEPTH) {
    budget.skippedCount += 1;
    return null;
  }

  try {
    const stats = await lstat(filePath);
    if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile())) {
      budget.skippedCount += 1;
      return null;
    }

    const name = cleanName(path.basename(filePath));
    const createdAt = safeTimestamp(stats.birthtime, stats.mtime);
    const modifiedAt = safeTimestamp(stats.mtime, stats.birthtime);
    budget.entries += 1;

    if (stats.isDirectory()) {
      const children: ImportedEntry[] = [];
      if (depth === MAX_DEPTH) {
        budget.skippedCount += 1;
      } else {
        const directoryEntries = [];
        const directory = await opendir(filePath);
        for await (const entry of directory) {
          if (directoryEntries.length >= MAX_ENTRIES - budget.entries) {
            budget.skippedCount += 1;
            break;
          }
          directoryEntries.push(entry);
        }
        directoryEntries.sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of directoryEntries) {
          if (budget.entries >= MAX_ENTRIES) {
            budget.skippedCount += 1;
            break;
          }
          const child = await inspectPath(path.join(filePath, entry.name), budget, depth + 1);
          if (child) children.push(child);
        }
      }
      return { name, kind: 'folder', createdAt, modifiedAt, children };
    }

    const beginning = await readBeginning(filePath, stats.size);
    let content: string;
    if (looksLikeText(beginning, path.extname(name).toLowerCase())) {
      const remaining = Math.max(0, MAX_IMPORT_BYTES - budget.bytes);
      const available = beginning.subarray(0, Math.min(beginning.length, remaining));
      content = available.toString('utf8');
      budget.bytes += available.length;
      if (stats.size > available.length) {
        budget.truncatedCount += 1;
        const notice = '\n\n[Document truncated to fit the Macintosh virtual disk.]';
        content = `${content.slice(0, Math.max(0, MAX_DOCUMENT_BYTES - notice.length))}${notice}`;
      }
    } else {
      content = `[${stats.size.toLocaleString('en-US')} byte binary document. The Macintosh preserves its name but does not store binary contents.]`;
      budget.bytes += Buffer.byteLength(content);
    }

    return { name, kind: 'document', content, createdAt, modifiedAt };
  } catch {
    budget.skippedCount += 1;
    return null;
  }
};

export const inspectImportPaths = async (value: unknown): Promise<ImportFilesResult> => {
  if (!Array.isArray(value)) return { entries: [], skippedCount: 1, truncatedCount: 0 };

  const paths = [
    ...new Set(
      value
        .slice(0, MAX_ROOTS)
        .filter((item): item is string => typeof item === 'string' && path.isAbsolute(item)),
    ),
  ];
  const budget: ImportBudget = {
    entries: 0,
    bytes: 0,
    skippedCount: Math.max(0, value.length - MAX_ROOTS),
    truncatedCount: 0,
  };
  const entries: ImportedEntry[] = [];
  for (const filePath of paths) {
    const entry = await inspectPath(filePath, budget, 0);
    if (entry) entries.push(entry);
  }
  return {
    entries,
    skippedCount: budget.skippedCount,
    truncatedCount: budget.truncatedCount,
  };
};
