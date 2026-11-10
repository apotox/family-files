import { deriveKeys, chunkCount, CHUNK, encryptChunk, decryptChunk, encryptMeta, decryptMeta, b64enc, b64dec } from './crypto.mjs';
import { clean, fmt, folders, view, where } from './view.mjs';

const $ = (id) => document.getElementById(id);
const el = (tag, props) => Object.assign(document.createElement(tag), props);
let session = null; // { key: non-extractable CryptoKey, token: login token }
let files = []; // decrypted: { id, created, name, size, type, prefix, thumb, folder }
let cwd = ''; // folder being shown: '' is the top level, 'Photos/2024' a subfolder

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
  $('search').value = '';
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
  [fmt(f.size), new Date(f.created).toLocaleDateString(), where(f, cwd)].filter(Boolean).join(' · '), // where: search hits in subfolders
  () => (f.type.startsWith('image/') ? preview(f) : download(f)).catch((e) => say(`Couldn't open ${f.name}: ${e.message}`)),
  el('button', { className: 'act', textContent: 'Move', ariaLabel: `Move ${f.name}`, onclick: () => move(f).catch((e) => say(`Move failed: ${e.message}`)) }),
  el('button', { className: 'act', textContent: '✕', ariaLabel: `Delete ${f.name}`, onclick: () => remove(f).catch((e) => say(`Delete failed: ${e.message}`)) }),
);

const folderRow = ([name, n]) => row(
  el('span', { className: 'thumb folder', textContent: '📁' }),
  name,
  `${n} file${n === 1 ? '' : 's'}`,
  () => go(clean(`${cwd}/${name}`)),
);

const emptyText = (query) => (query.trim() ? 'No matching files.' : cwd ? 'Empty folder: upload files here.' : 'No files yet.');

function render() {
  const parts = cwd.split('/').filter(Boolean);
  $('crumbs').replaceChildren(...['All files', ...parts].map((label, i) =>
    el('button', { type: 'button', textContent: label, disabled: i === parts.length, onclick: () => go(parts.slice(0, i).join('/')) })));
  const query = $('search').value;
  const shown = view(files, cwd, query);
  const rows = [...shown.folders.map(folderRow), ...shown.files.map(fileRow)];
  $('list').replaceChildren(...rows);
  if (session && !rows.length) $('list').textContent = emptyText(query);
}

// Tap an existing folder, or type a new one (the datalist suggests as you type).
// Each choice is a submit button whose value becomes the dialog's returnValue; closing without one leaves it '\0'.
function pickFolder(f) {
  const d = $('mover');
  const paths = folders(files);
  $('mover-name').textContent = f.name;
  $('mover-new').value = '';
  $('mover-paths').replaceChildren(...paths.map((p) => el('option', { value: p })));
  $('mover-list').replaceChildren(...paths.map((p) =>
    el('button', { value: p, formNoValidate: true, textContent: p ? `📁 ${p}` : '📁 All files (top level)', disabled: p === f.folder })));
  $('mover-go').onclick = () => { $('mover-go').value = $('mover-new').value; };
  d.returnValue = '\0';
  d.showModal();
  return new Promise((resolve) => { d.onclose = () => resolve(d.returnValue === '\0' ? null : d.returnValue); });
}

async function move(f) {
  const to = await pickFolder(f);
  if (to === null || clean(to) === f.folder) return;
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
$('search').oninput = render; // names are decrypted in the browser, so search never asks the server

// Background: a per-device look, so localStorage (it may throw in private mode; the page just stays plain).
// An unknown saved name matches no [data-bg] rule and no radio, so it falls back to plain by itself.
function setBackground(name) {
  document.documentElement.dataset.bg = name;
  $('walls-form').elements.bg.value = name;
  try { localStorage.setItem('background', name); } catch {}
}
try { setBackground(localStorage.getItem('background') ?? 'none'); } catch {}
$('mover-cancel').onclick = () => $('mover').close();
$('wallpaper').onclick = () => $('walls').showModal();
$('walls-form').onchange = (e) => setBackground(e.target.value);
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
