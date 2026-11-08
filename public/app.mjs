import { deriveKeys, chunkCount, CHUNK, encryptChunk, decryptChunk, encryptMeta, decryptMeta, b64enc, b64dec } from './crypto.mjs';

const $ = (id) => document.getElementById(id);
const el = (tag, props) => Object.assign(document.createElement(tag), props);
let session = null; // { key: non-extractable CryptoKey, token: login token }
let files = []; // decrypted: { id, created, name, size, type, prefix, thumb, folder }
let cwd = ''; // folder being shown: '' is the top level, 'Photos/2024' a subfolder

// Folders are just a path in each file's encrypted meta: a folder exists while it holds a file.
const clean = (path) => path.split('/').map((s) => s.trim()).filter(Boolean).join('/');

// The session lives in IndexedDB: unlike localStorage it can hold the CryptoKey itself,
// which stays non-extractable, so not even a script on this page can read the raw key out.
function db(mode, op) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('family-files', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('kv', mode);
      const req = op(tx.objectStore('kv'));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
    };
  });
}

async function api(url, options = {}) {
  const res = await fetch(url, { ...options, headers: { Authorization: `Bearer ${session.token}` } });
  if (res.status === 401) { await logout(); throw new Error('Wrong password'); }
  if (!res.ok) throw new Error(await res.text());
  return res;
}

const say = (text) => { $('msg').textContent = text; };

// Spinner toast while something slow runs. The page is inert meanwhile, so a second tap can't start it twice.
// Calls nest (move -> refresh): the toast hides when the outermost one finishes.
let busyDepth = 0;
const setBusy = (text) => {
  $('busy-text').textContent = text;
  $('busy').hidden = !text;
  $('app').inert = $('login-form').inert = Boolean(text);
};
async function busy(text, fn) {
  busyDepth++;
  setBusy(text);
  try { return await fn(); } finally { if (!--busyDepth) setBusy(''); }
}
const units = ['B', 'KB', 'MB', 'GB'];
const fmt = (n) => { let i = 0; while (n >= 1024 && i < 3) { n /= 1024; i++; } return `${i ? n.toFixed(1) : n} ${units[i]}`; };

function show(loggedIn) {
  $('login-form').hidden = loggedIn;
  $('app').hidden = !loggedIn;
  $('logout').hidden = !loggedIn;
}

const login = (password) => busy('Unlocking… (a few seconds)', async () => {
  say('');
  const { salt } = await (await fetch('/api/salt')).json();
  session = await deriveKeys(password, salt);
  await api('/api/files'); // throws on a wrong password
  await db('readwrite', (s) => s.put(session, 'session'));
  show(true);
  await refresh();
});

async function logout() {
  session = null;
  files = [];
  cwd = '';
  $('preview').close();
  render(); // don't leave decrypted names or photos in the page
  await db('readwrite', (s) => s.delete('session'));
  show(false);
}

const refresh = () => busy('Loading files…', async () => {
  const [list, { used, free }] = await Promise.all(['/api/files', '/api/disk'].map(async (u) => (await api(u)).json()));
  const pct = (n) => `${Math.round((n / (used + free)) * 100)}%`;
  $('disk-meter').value = used / (used + free);
  $('disk').textContent = `Disk: ${fmt(used)} used (${pct(used)}) · ${fmt(free)} free (${pct(free)}) of ${fmt(used + free)}`;
  const rows = await Promise.all(list.map(async ({ id, created, meta }) => {
    try { return { folder: '', ...(await decryptMeta(session.key, id, meta)), id, created }; } catch { return null; }
  }));
  files = rows.filter(Boolean);
  render();
});

// Folders go on the browser history, so the phone's back button goes up a level.
function go(folder) {
  cwd = folder;
  history.pushState({ folder }, '');
  render();
}
window.onpopstate = (e) => { cwd = e.state?.folder ?? ''; render(); };

function row(thumb, title, info, open, ...actions) {
  const text = el('span');
  text.append(el('span', { textContent: title }), el('small', { textContent: info }));
  const btn = el('button', { className: 'open', onclick: open });
  btn.append(thumb, text);
  const li = el('li');
  li.append(btn, ...actions);
  return li;
}

const fileRow = (f) => row(
  f.thumb
    ? el('img', { className: 'thumb', src: f.thumb, alt: '' })
    : el('span', { className: 'thumb', textContent: (f.name.split('.').pop() || '').slice(0, 4).toUpperCase() }),
  f.name,
  `${fmt(f.size)} · ${new Date(f.created).toLocaleDateString()}`,
  () => (f.type.startsWith('image/') ? preview(f) : download(f)).catch((e) => say(`Couldn't open ${f.name}: ${e.message}`)),
  el('button', { className: 'act', textContent: 'Move', ariaLabel: `Move ${f.name}`, onclick: () => move(f).catch((e) => say(`Move failed: ${e.message}`)) }),
  el('button', { className: 'act', textContent: '✕', ariaLabel: `Delete ${f.name}`, onclick: () => remove(f).catch((e) => say(`Delete failed: ${e.message}`)) }),
);

function render() {
  const prefix = cwd ? `${cwd}/` : '';
  const sub = new Map(); // subfolder name -> number of files in it (at any depth)
  for (const f of files) {
    if (f.folder === cwd || !f.folder.startsWith(prefix)) continue;
    const name = f.folder.slice(prefix.length).split('/')[0];
    sub.set(name, (sub.get(name) ?? 0) + 1);
  }
  const parts = cwd ? cwd.split('/') : [];
  $('crumbs').replaceChildren(...['All files', ...parts].map((label, i) =>
    el('button', { type: 'button', textContent: label, disabled: i === parts.length, onclick: () => go(parts.slice(0, i).join('/')) })));
  const rows = [
    ...[...sub].sort(([a], [b]) => a.localeCompare(b)).map(([name, n]) =>
      row(el('span', { className: 'thumb folder', textContent: '📁' }), name, `${n} file${n === 1 ? '' : 's'}`, () => go(prefix + name))),
    ...files.filter((f) => f.folder === cwd).map(fileRow),
  ];
  $('list').replaceChildren(...rows);
  if (session && !rows.length) $('list').textContent = cwd ? 'Empty folder: upload files here.' : 'No files yet.';
}

async function move(f) {
  const to = prompt(`Move "${f.name}" to which folder?\nUse / for subfolders (Photos/2024); leave empty for the top level.`, f.folder);
  if (to === null) return;
  const { id, created, ...meta } = f;
  await busy(`Moving ${f.name}…`, async () => {
    await api(`/api/files/${id}`, { method: 'POST', body: await encryptMeta(session.key, id, { ...meta, folder: clean(to) }) });
    await refresh();
  });
}

async function remove(f) {
  if (!confirm(`Delete "${f.name}" for everyone? This can't be undone.`)) return;
  await busy(`Deleting ${f.name}…`, async () => {
    await api(`/api/files/${f.id}`, { method: 'DELETE' });
    await refresh();
  });
}

// Small JPEG preview made on this device and stored inside the encrypted meta, so the server never sees it.
// ponytail: thumbnails ride along in the file list (~10 KB each); move them to their own endpoint if the list gets slow.
async function thumbnail(file) {
  if (!file.type.startsWith('image/')) return undefined;
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, 160 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.7);
  } catch {
    return undefined; // a format this browser can't decode (e.g. HEIC on Chrome): no thumbnail, upload still works
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function upload(file, folder) {
  const id = crypto.randomUUID();
  const prefix = crypto.getRandomValues(new Uint8Array(8));
  const n = chunkCount(file.size);
  for (let i = 0; i < n; i++) {
    const plain = await file.slice(i * CHUNK, (i + 1) * CHUNK).arrayBuffer();
    const body = await encryptChunk(session.key, prefix, id, i, i === n - 1, plain);
    await api(`/api/files/${id}/${i}`, { method: 'PUT', body });
    $('send-bar').value = (i + 1) / n;
  }
  const meta = await encryptMeta(session.key, id, {
    name: file.name, size: file.size, type: file.type, prefix: b64enc(prefix), thumb: await thumbnail(file), folder,
  });
  await api(`/api/files/${id}`, { method: 'POST', body: meta });
}

// ponytail: decrypted chunks are collected into one Blob, so a file must fit in the browser's memory/blob storage
// (fine for photos and documents; multi-GB videos on old phones may fail). Streaming to disk would lift that.
const decrypt = (f) => busy(`Opening ${f.name}…`, async () => {
  const n = chunkCount(f.size);
  const prefix = b64dec(f.prefix);
  const parts = [];
  for (let i = 0; i < n; i++) {
    const ct = await (await api(`/api/files/${f.id}/${i}`)).arrayBuffer();
    parts.push(await decryptChunk(session.key, prefix, f.id, i, i === n - 1, ct));
    if (n > 1) setBusy(`Opening ${f.name}: ${Math.round(((i + 1) / n) * 100)}%`);
  }
  return new Blob(parts, { type: f.type || 'application/octet-stream' });
});

function save(blob, name) {
  const url = URL.createObjectURL(blob);
  el('a', { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const download = async (f) => save(await decrypt(f), f.name);

async function preview(f) {
  const blob = await decrypt(f);
  const url = URL.createObjectURL(blob);
  const img = $('preview-img');
  img.onerror = () => say(`This browser can't show ${f.name}; use Download.`); // e.g. HEIC outside Safari
  Object.assign(img, { src: url, alt: f.name });
  $('preview-name').textContent = f.name;
  $('preview-dl').onclick = () => save(blob, f.name);
  $('preview').onclose = () => { URL.revokeObjectURL(url); img.removeAttribute('src'); say(''); };
  $('preview').showModal();
}

$('login-form').onsubmit = async (e) => {
  e.preventDefault();
  try { await login($('password').value); } catch (err) { say(err.message); }
  $('password').value = '';
};
$('logout').onclick = logout;
$('new-folder').onclick = () => {
  const name = prompt('New folder name:');
  if (name && clean(name)) go(clean(`${cwd}/${name}`));
};
$('pick').onchange = async () => {
  const folder = cwd; // uploads land where they started, even if you browse elsewhere meanwhile
  const picked = [...$('pick').files];
  const art = $('send-art');
  art.setCurrentTime(0);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { art.setCurrentTime(0.8); art.pauseAnimations(); } // still frame: locked file
  $('sending').showModal();
  try {
    for (const [i, file] of picked.entries()) {
      $('send-name').textContent = file.name;
      $('send-count').textContent = picked.length > 1 ? `(${i + 1} of ${picked.length})` : '';
      $('send-bar').value = 0;
      await upload(file, folder);
    }
    say('Done.');
  } catch (e) {
    say(`Upload failed: ${e.message}`);
  }
  $('sending').close();
  $('pick').value = '';
  refresh().catch((e) => say(e.message));
};

if (!globalThis.crypto?.subtle) {
  say('This page must be opened over https:// — encryption is unavailable here.');
} else {
  session = await db('readonly', (s) => s.get('session'));
  show(Boolean(session));
  if (session) refresh().catch((e) => say(e.message));
}
