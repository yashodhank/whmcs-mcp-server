import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { isDirectEntry } from '../../src/entryPoint.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'whmcs-mcp-entrypoint-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('isDirectEntry', () => {
  it('recognizes the ordinary resolved entry file', () => {
    const directory = temporaryDirectory();
    const entry = join(directory, 'index.js');
    writeFileSync(entry, '// fixture\n');

    expect(isDirectEntry(pathToFileURL(entry).href, entry)).toBe(true);
  });

  it('fails closed when the process has no entry argv', () => {
    const moduleUrl = pathToFileURL(realpathSync(import.meta.filename)).href;

    expect(isDirectEntry(moduleUrl, undefined)).toBe(false);
  });

  it('recognizes an entry launched through a symlink', () => {
    const directory = temporaryDirectory();
    const entry = join(directory, 'index.js');
    const symlink = join(directory, 'whmcs-mcp');
    writeFileSync(entry, '// fixture\n');
    symlinkSync(entry, symlink);

    expect(isDirectEntry(pathToFileURL(realpathSync(entry)).href, symlink)).toBe(true);
  });

  it('fails closed when either path cannot be resolved', () => {
    const directory = temporaryDirectory();
    const entry = join(directory, 'missing.js');

    expect(isDirectEntry(pathToFileURL(entry).href, entry)).toBe(false);
  });
});
