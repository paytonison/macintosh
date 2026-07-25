import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { inspectImportPaths } from './import-files';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('host file inspection', () => {
  it('imports text files and folder contents without following symbolic data', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'macintosh-import-test-'));
    temporaryDirectories.push(root);
    const folder = path.join(root, 'Project');
    await mkdir(folder);
    await writeFile(path.join(root, 'Note.txt'), 'hello from Finder');
    await writeFile(path.join(folder, 'Source.c'), 'int main(void) { return 0; }\n');

    const result = await inspectImportPaths([path.join(root, 'Note.txt'), folder]);

    expect(result.skippedCount).toBe(0);
    expect(result.entries[0]).toMatchObject({
      name: 'Note.txt',
      kind: 'document',
      content: 'hello from Finder',
    });
    expect(result.entries[1]?.children?.[0]).toMatchObject({
      name: 'Source.c',
      kind: 'document',
      content: 'int main(void) { return 0; }\n',
    });
  });

  it('keeps binary files as safe document placeholders', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'macintosh-import-test-'));
    temporaryDirectories.push(root);
    const binary = path.join(root, 'Picture.bin');
    await writeFile(binary, Buffer.from([0, 1, 2, 3, 255]));

    const result = await inspectImportPaths([binary]);

    expect(result.entries[0]).toMatchObject({ name: 'Picture.bin', kind: 'document' });
    expect(result.entries[0]?.content).toContain('binary document');
  });
});
