// Self-check: node test.js
// Drives the server with the same crypto the browser uses and checks the server never holds plaintext.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'family-files-'));
process.env.DATA_DIR = dir;
const { server, setPassword, CHUNK, TAG } = require('./server');

// Pure list logic (public/view.mjs): every edge case is a row.
async function checkView() {
  const v = await import('./public/view.mjs');
  const files = [
    { name: 'beach.jpg', folder: '' },
    { name: 'Zeugnis.pdf', folder: 'Schule' },
    { name: 'Café.png', folder: 'Photos/2024' },
    { name: 'tree.jpg', folder: 'Photos/2024/Xmas' },
    { name: 'old.jpg', folder: 'Photosx' },
  ];
  for (const [cwd, query, folders, names, why] of [
    ['', '', [['Photos', 2], ['Photosx', 1], ['Schule', 1]], ['beach.jpg'], 'top level: subfolders count files at any depth'],
    ['Photos', '', [['2024', 2]], [], 'folder holding only subfolders'],
    ['Photos/2024', '', [['Xmas', 1]], ['Café.png'], 'nested folder'],
    ['Nowhere', '', [], [], 'unknown folder is empty'],
    ['', '   ', [['Photos', 2], ['Photosx', 1], ['Schule', 1]], ['beach.jpg'], 'blank query browses'],
    ['', 'JPG', [], ['beach.jpg', 'tree.jpg', 'old.jpg'], 'search is case-insensitive and spans all depths'],
    ['', 'cafe', [], ['Café.png'], 'search ignores accents'],
    ['', '2024 tree', [], ['tree.jpg'], 'every word must match; folder names count'],
    ['Photos', 'jpg', [], ['tree.jpg'], 'search stays under the current folder, not a same-prefix sibling'],
    ['Photos', 'photos', [], [], 'only the path below the current folder is searched'],
    ['', 'nothing', [], [], 'no match'],
  ]) {
    const shown = v.view(files, cwd, query);
    assert.deepEqual([shown.folders, shown.files.map((f) => f.name)], [folders, names], why);
  }
  for (const [file, cwd, expected] of [
    [files[0], '', ''],
    [files[3], '', 'Photos/2024/Xmas'],
    [files[3], 'Photos', '2024/Xmas'],
    [files[2], 'Photos/2024', ''],
  ]) assert.equal(v.where(file, cwd), expected, `where(${file.folder}, ${cwd})`);
  for (const [bytes, text] of [[0, '0 B'], [1023, '1023 B'], [1024, '1.0 KB'], [1.5 * 2 ** 20, '1.5 MB'], [2 ** 40, '1024.0 GB']]) {
    assert.equal(v.fmt(bytes), text);
  }
  assert.deepEqual(v.folders(files), ['', 'Photos', 'Photos/2024', 'Photos/2024/Xmas', 'Photosx', 'Schule'], 'folders: parents included, sorted');
  assert.deepEqual(v.folders([]), [''], 'folders: top level always there');
  for (const [path, expected] of [['', ''], [' / a // b / ', 'a/b'], ['Photos/2024', 'Photos/2024']]) assert.equal(v.clean(path), expected);
}

(async () => {
  await checkView();
  const c = await import('./public/crypto.mjs');
  assert.deepEqual([c.CHUNK, c.TAG], [CHUNK, TAG], 'server and browser agree on chunk layout');

  await setPassword('correct horse battery');
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  const { salt } = await (await fetch(`${base}/api/salt`)).json();
  const { key, token } = await c.deriveKeys('correct horse battery', salt);
  const wrong = await c.deriveKeys('wrong password!', salt);
  const req = (url, opts = {}, tok = token) => fetch(base + url, { ...opts, headers: { Authorization: `Bearer ${tok}` } });

  try {
    assert.equal((await req('/api/files', {}, wrong.token)).status, 401, 'wrong password rejected');
    assert.equal((await fetch(`${base}/api/files`)).status, 401, 'no token rejected');

    // a 2-chunk file whose plaintext contains a marker we can search for on disk
    const marker = Buffer.from('FAMILY-SECRET-MARKER');
    const plain = Buffer.alloc(CHUNK + 1000, 7);
    marker.copy(plain, 0);
    marker.copy(plain, CHUNK);
    const id = crypto.randomUUID();
    const prefix = crypto.getRandomValues(new Uint8Array(8));
    const n = c.chunkCount(plain.length);
    assert.equal(n, 2);
    const chunk = async (i) => c.encryptChunk(key, prefix, id, i, i === n - 1, plain.subarray(i * CHUNK, (i + 1) * CHUNK));

    assert.equal((await req(`/api/files/${id}/1`, { method: 'PUT', body: await chunk(1) })).status, 409, 'out-of-order chunk rejected');
    for (let i = 0; i < n; i++) assert.equal((await req(`/api/files/${id}/${i}`, { method: 'PUT', body: await chunk(i) })).status, 204);
    const meta = await c.encryptMeta(key, id, { name: 'passport scan.pdf', size: plain.length, type: 'application/pdf', prefix: c.b64enc(prefix) });
    assert.equal((await req(`/api/files/${id}`, { method: 'POST', body: meta })).status, 201);
    assert.equal((await req(`/api/files/${id}/2`, { method: 'PUT', body: await chunk(0) })).status, 409, 'finished file is immutable');

    // the server holds no plaintext: neither content nor file name
    const onDisk = Buffer.concat(fs.readdirSync(path.join(dir, 'files')).map((f) => fs.readFileSync(path.join(dir, 'files', f))));
    assert.ok(!onDisk.includes(marker), 'content is encrypted at rest');
    assert.ok(!onDisk.includes(Buffer.from('passport')), 'file name is encrypted at rest');

    // list + download round trip
    const [entry] = await (await req('/api/files')).json();
    const m = await c.decryptMeta(key, entry.id, entry.meta);
    assert.equal(m.name, 'passport scan.pdf');
    const parts = [];
    for (let i = 0; i < n; i++) {
      const ct = await (await req(`/api/files/${id}/${i}`)).arrayBuffer();
      parts.push(Buffer.from(await c.decryptChunk(key, c.b64dec(m.prefix), id, i, i === n - 1, ct)));
    }
    assert.ok(Buffer.concat(parts).equals(plain), 'download decrypts to the original');

    // tampering is detected: chunk 0 can't pass as the last chunk (truncation), and the wrong key fails
    const first = await (await req(`/api/files/${id}/0`)).arrayBuffer();
    await assert.rejects(c.decryptChunk(key, c.b64dec(m.prefix), id, 0, true, first), 'truncation detected');
    await assert.rejects(c.decryptMeta(wrong.key, id, entry.meta), 'wrong key cannot read names');

    // moving to a folder replaces the meta; the folder name is encrypted too
    const moved = await c.encryptMeta(key, id, { ...m, folder: 'Taxes/2026' });
    assert.equal((await req(`/api/files/${id}`, { method: 'POST', body: moved })).status, 204);
    const [after] = await (await req('/api/files')).json();
    assert.equal((await c.decryptMeta(key, id, after.meta)).folder, 'Taxes/2026');
    assert.ok(!fs.readFileSync(path.join(dir, 'files', `${id}.meta`)).includes('Taxes'), 'folder name is encrypted at rest');
    assert.equal((await req(`/api/files/${crypto.randomUUID()}`, { method: 'POST', body: moved })).status, 404, 'meta for unknown file');

    assert.equal((await req('/api/files/not-a-uuid/0')).status, 404, 'bad id rejected');
    assert.equal((await req(`/api/files/${id}/0`, { method: 'PUT', body: Buffer.alloc(CHUNK + TAG + 1) })).status, 413, 'oversized chunk rejected');
    await assert.rejects(setPassword('another password'), /files exist/, 'password change refused while files exist');
    assert.match(await (await fetch(base)).text(), /id="login-form"/, 'index page served');
    for (const url of ['/app.mjs', '/crypto.mjs', '/view.mjs']) assert.equal((await fetch(base + url)).status, 200, `${url} served`);
    const d = await (await req('/api/disk')).json();
    assert.ok(d.used > 0 && d.free > 0, 'disk usage reported');
    assert.equal((await fetch(`${base}/api/disk`)).status, 401, 'disk usage needs the password');

    assert.equal((await req(`/api/files/${id}`, { method: 'DELETE' }, wrong.token)).status, 401, 'delete needs the password');
    assert.equal((await req(`/api/files/${id}`, { method: 'DELETE' })).status, 204);
    assert.deepEqual(await (await req('/api/files')).json(), [], 'deleted file is gone from the list');
    assert.equal((await req(`/api/files/${id}/0`)).status, 404, 'deleted file cannot be downloaded');
    assert.deepEqual(fs.readdirSync(path.join(dir, 'files')), [], 'nothing left on disk');
    assert.equal((await req(`/api/files/${id}`, { method: 'DELETE' })).status, 404, 'second delete is 404');

    // password guessing is throttled; last, because it locks this address out
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await req('/api/files', {}, wrong.token)).status);
    assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429], 'locked out after 5 wrong passwords');
    assert.equal((await req('/api/files')).status, 429, 'even the right password waits out the lockout');
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal((await req('/api/files')).status, 200, 'right password works after the wait');
    console.log('ok');
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });
