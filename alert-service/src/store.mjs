import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

/** Tiny JSON-file store: atomic writes, one file per collection, plus an append-only log. */
export function createStore(dir) {
  mkdirSync(dir, { recursive: true });
  const file = (name) => join(dir, `${name}.json`);
  return {
    read(name, fallback) {
      const path = file(name);
      if (!existsSync(path)) return fallback;
      try {
        return JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        return fallback;
      }
    },
    write(name, value) {
      const path = file(name);
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(value, null, 2));
      renameSync(tmp, path);
    },
    append(name, entry) {
      appendFileSync(join(dir, `${name}.jsonl`), JSON.stringify(entry) + '\n');
    },
  };
}
