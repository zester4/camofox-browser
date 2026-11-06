/**
 * Durable AgentCard state, written to a file on the app's volume.
 *
 * - Writes are atomic: the new state goes to a temp file, which is renamed over
 *   the old one, so a crash never leaves a half-written file.
 * - The file is created with mode 0600. It holds our user-to-card mapping,
 *   pending vault links and purchase records, but no card data or secrets.
 * - A corrupt file is moved aside and the store starts empty, rather than
 *   refusing to boot. The moved file is kept for inspection.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createMemoryStore } from './store.js';

/**
 * @param {string} filePath
 * @param {{ log?: (level: string, msg: string, fields?: object) => void, now?: () => string }} [options]
 */
export function createFileStore(filePath, { log = () => {}, now } = {}) {
  let saveScheduled = false;
  let saving = false;

  const store = createMemoryStore({
    now,
    onChange: () => scheduleSave(),
  });

  function load() {
    if (!existsSync(filePath)) return;
    try {
      store.restore(JSON.parse(readFileSync(filePath, 'utf8')));
      log('info', 'agentcard state loaded', { file: filePath });
    } catch (err) {
      const aside = `${filePath}.corrupt-${Date.now()}`;
      try { renameSync(filePath, aside); } catch { /* best effort */ }
      log('error', 'agentcard state unreadable, starting empty', { file: filePath, moved: aside, reason: err.message });
    }
  }

  function save() {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    const tmp = join(dirname(filePath), `.agentcard-${process.pid}-${Date.now()}.tmp`);
    writeFileSync(tmp, JSON.stringify(store.snapshot()), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, filePath);
  }

  /** Coalesce bursts of changes into one write per tick. */
  function scheduleSave() {
    if (saveScheduled) return;
    saveScheduled = true;
    queueMicrotask(() => {
      saveScheduled = false;
      if (saving) return;
      saving = true;
      try {
        save();
      } catch (err) {
        log('error', 'agentcard state save failed', { file: filePath, reason: err.message });
      } finally {
        saving = false;
      }
    });
  }

  /** Flush synchronously. Used on shutdown and in tests. */
  function flush() {
    save();
  }

  load();
  return Object.assign(store, { flush, filePath });
}
