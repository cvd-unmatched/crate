import { constants } from 'node:fs';
import { access, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const empty = () => ({ version: 1, username: null, currency: null, lastSyncedAt: null, items: {}, bundles: {} });

/**
 * A JSON file with transactional updates: each update works on a copy,
 * is written atomically (temp file + rename, previous version kept as .bak),
 * and only becomes the live data once it is safely on disk.
 */
export class Store {
  #file;
  #queue = Promise.resolve();
  data;

  static async open(file) {
    const store = new Store();
    store.#file = file;

    // Find out now, not on the first save, if we can't write here.
    const dir = path.dirname(file);
    try {
      await mkdir(dir, { recursive: true });
      await access(dir, constants.W_OK);
    } catch (err) {
      if (err.code !== 'EACCES' && err.code !== 'EPERM') throw err;
      const uid = process.getuid?.();
      throw new Error(
        `Can't write to ${dir} (permission denied).` +
          (uid === undefined
            ? ''
            : ` Crate runs as uid ${uid}. If ${dir} is a bind mount, give that folder on the host to this user:` +
              ` sudo chown -R ${uid}:${uid} <host folder>. Or use a named volume, as in compose.yaml.`),
      );
    }

    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'));
      if (!parsed || typeof parsed.items !== 'object' || typeof parsed.bundles !== 'object') {
        throw new Error('unexpected file structure');
      }
      store.data = parsed;
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Never start empty over a file we couldn't read: the next save would wipe it.
        throw new Error(`Could not read ${file} (${err.message}). Fix it or restore ${file}.bak, then start again.`);
      }
      store.data = empty();
    }
    return store;
  }

  /** Runs `change(draft)` on a copy, persists it, then swaps it in. Updates run one at a time. */
  update(change) {
    const run = this.#queue.then(async () => {
      const draft = structuredClone(this.data);
      const result = change(draft);
      await this.#write(draft);
      this.data = draft;
      return result;
    });
    this.#queue = run.catch(() => {});
    return run;
  }

  /** Resolves once every queued update has been written. */
  idle() {
    return this.#queue;
  }

  async #write(data) {
    const tmp = `${this.#file}.tmp`;
    await mkdir(path.dirname(this.#file), { recursive: true });
    await writeFile(tmp, JSON.stringify(data, null, 2));
    await copyFile(this.#file, `${this.#file}.bak`).catch((err) => {
      if (err.code !== 'ENOENT') throw err;
    });
    await rename(tmp, this.#file);
  }
}
