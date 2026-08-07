import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Return true when a module is the process entry point.
 *
 * Node canonicalizes `import.meta.url`, but `process.argv[1]` may still name a
 * symlink. Comparing real paths keeps symlink-based launchers working. Any
 * absent, non-file, or unresolvable path fails closed so importing the server
 * factory can never start a transport accidentally.
 */
export function isDirectEntry(importMetaUrl: string, entryPath: string | undefined): boolean {
  if (entryPath === undefined) return false;

  try {
    const modulePath = realpathSync(fileURLToPath(importMetaUrl));
    const processEntryPath = realpathSync(resolve(entryPath));
    return modulePath === processEntryPath;
  } catch {
    return false;
  }
}
