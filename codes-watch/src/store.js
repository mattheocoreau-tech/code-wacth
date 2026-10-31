import fs from 'node:fs';
import path from 'node:path';

const read = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };
const stable = (o) => JSON.stringify(o, null, 2) + '\n';

export function loadDb(dataDir) {
  const toMap = (arr) => Object.fromEntries((arr || []).map((c) => [c.id, c]));
  const status = read(path.join(dataDir, 'status.json'), {});
  return {
    codes: toMap(read(path.join(dataDir, 'codes.json'), {}).codes),
    archive: toMap(read(path.join(dataDir, 'archive.json'), {}).codes),
    events: read(path.join(dataDir, 'events.json'), {}).events || [],
    sources: status.sources || {},
    writtenAt: status.writtenAt || null,
  };
}

/** Écrit un fichier seulement si son contenu a changé. Retourne true si écrit. */
export function writeIfChanged(file, content) {
  let old = null;
  try { old = fs.readFileSync(file, 'utf8'); } catch { /* nouveau fichier */ }
  if (old === content) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file); // écriture atomique : pas de fichier à moitié écrit en cas de coupure
  return true;
}

const byRecent = (a, b) => b.firstSeen.localeCompare(a.firstSeen) || a.code.localeCompare(b.code);

export function saveDb(dataDir, db, status, generatedAt) {
  const w = (name, obj) => writeIfChanged(path.join(dataDir, name), stable(obj));
  const dataChanged = [
    w('codes.json', { schema: 1, codes: Object.values(db.codes).sort(byRecent) }),
    w('archive.json', { schema: 1, codes: Object.values(db.archive).sort(byRecent) }),
    w('events.json', { schema: 1, events: db.events }),
  ].some(Boolean);
  return dataChanged;
}

export function saveStatus(dataDir, status) {
  return writeIfChanged(path.join(dataDir, 'status.json'), stable(status));
}
