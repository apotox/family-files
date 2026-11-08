// What the file list shows, as plain data: no DOM, so test.js checks it directly.

// Folders are just a path in each file's encrypted meta: a folder exists while it holds a file.
export const clean = (path) => path.split('/').map((s) => s.trim()).filter(Boolean).join('/');

const UNITS = ['B', 'KB', 'MB', 'GB'];
export function fmt(n) {
  let i = 0;
  while (n >= 1024 && i < UNITS.length - 1) { n /= 1024; i++; }
  return `${i ? n.toFixed(1) : n} ${UNITS[i]}`;
}

// '' -> '', 'Photos/2024' -> 'Photos/2024/': the top level needs no slash, so "is under" is a plain startsWith.
const prefix = (folder) => folder.split('/').filter(Boolean).map((s) => `${s}/`).join('');
const under = (f, cwd) => prefix(f.folder).startsWith(prefix(cwd));

// The folder path from cwd down to f: '' when f sits directly in cwd.
export const where = (f, cwd) => prefix(f.folder).slice(prefix(cwd).length).slice(0, -1);

// Case- and accent-insensitive, so "cafe" finds "Café".
const fold = (s) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

// Browsing: cwd's subfolders as [name, files inside at any depth], sorted, and the files directly in cwd.
function browse(files, cwd) {
  const counts = new Map(); // first path segment below cwd -> file count; '' holds cwd's own files
  for (const f of files.filter((f) => under(f, cwd))) {
    const name = where(f, cwd).split('/')[0];
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  counts.delete('');
  return {
    folders: [...counts].sort(([a], [b]) => a.localeCompare(b)),
    files: files.filter((f) => f.folder === cwd),
  };
}

// Searching: files at any depth under cwd whose path below cwd (folders + name) holds every word.
function search(files, cwd, words) {
  const matches = (f) => words.every((w) => fold(`${where(f, cwd)}/${f.name}`).includes(w));
  return { folders: [], files: files.filter((f) => under(f, cwd) && matches(f)) };
}

export function view(files, cwd, query) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  return words.length ? search(files, cwd, words) : browse(files, cwd);
}
