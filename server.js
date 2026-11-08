// Family Files: an end-to-end encrypted file share for the home Wi-Fi. No dependencies.
// Browsers encrypt before upload and decrypt after download (public/crypto.mjs); this server stores ciphertext only.
//
//   echo -n 'family password' | node server.js set-password   # once, before first start
//   node server.js                                            # env: PORT, DATA_DIR, TLS_CERT, TLS_KEY
//
// Web Crypto only works over HTTPS (or localhost), so on the Pi set TLS_CERT/TLS_KEY.
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');

const DATA = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const FILES = path.join(DATA, 'files');
const CONFIG = path.join(DATA, 'config.json');
const PUBLIC = path.join(__dirname, 'public');
const CHUNK = 4 * 1024 * 1024; // must match public/crypto.mjs (test.js checks)
const TAG = 16;
const SLOT = CHUNK + TAG; // bytes per stored chunk
fs.mkdirSync(FILES, { recursive: true });

const readConfig = () => (fs.existsSync(CONFIG) ? JSON.parse(fs.readFileSync(CONFIG, 'utf8')) : null);

// Stores a fresh salt and the SHA-256 of the login token. Refuses once files exist: a new password
// means a new key, and every existing file would become unreadable.
async function setPassword(password) {
  if (password.length < 8) throw new Error('password must be at least 8 characters');
  if (fs.readdirSync(FILES).some((f) => f.endsWith('.bin'))) throw new Error('files exist; they would become unreadable');
  const { deriveKeys } = await import('./public/crypto.mjs');
  const salt = crypto.randomBytes(16).toString('base64');
  const { token } = await deriveKeys(password, salt);
  fs.writeFileSync(CONFIG, JSON.stringify({ salt, verifier: sha256(token) }), { mode: 0o600 });
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function authorized(req, config) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return crypto.timingSafeEqual(Buffer.from(sha256(token), 'hex'), Buffer.from(config.verifier, 'hex'));
}

const fail = (status, message) => Object.assign(new Error(message), { status });

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    const onData = (c) => {
      size += c.length;
      if (size <= limit) return parts.push(c);
      // stop buffering and drain the rest, so the 413 still reaches the client instead of a reset socket
      req.off('data', onData);
      req.resume();
      reject(fail(413, 'too large'));
    };
    req.on('data', onData);
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

const HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store, no-transform',
  // data:/blob: images: thumbnails are decrypted in the browser and shown as data URLs, and made from blob URLs
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};
function send(res, status, body = '', type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { ...HEADERS, 'Content-Type': type });
  res.end(body);
}
const json = (res, status, value) => send(res, status, JSON.stringify(value), 'application/json');

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.mjs': ['app.mjs', 'text/javascript; charset=utf-8'],
  '/crypto.mjs': ['crypto.mjs', 'text/javascript; charset=utf-8'],
};

const filePath = (id, ext) => path.join(FILES, `${id}.${ext}`);
const statOf = (p) => fs.statSync(p, { throwIfNoEntry: false });

function listFiles() {
  return fs.readdirSync(FILES)
    .filter((f) => f.endsWith('.bin'))
    .map((f) => {
      const id = f.slice(0, -4);
      return { id, meta: fs.readFileSync(filePath(id, 'meta'), 'utf8'), created: statOf(filePath(id, 'bin')).mtimeMs };
    })
    .sort((a, b) => b.created - a.created);
}

// Counted like `df`: reserved root blocks are neither used nor free, so used + free is what the app can see.
function disk() {
  const s = fs.statfsSync(DATA);
  return { used: (s.blocks - s.bfree) * s.bsize, free: s.bavail * s.bsize };
}

// Chunks must arrive in order: chunk i is accepted only when the .part file holds exactly i full chunks.
async function putChunk(req, res, id, i) {
  const body = await readBody(req, SLOT);
  if (statOf(filePath(id, 'bin'))) throw fail(409, 'file already finished');
  const have = statOf(filePath(id, 'part'))?.size ?? 0;
  if (have !== i * SLOT) throw fail(409, `out of order: server has ${have} bytes`);
  fs.appendFileSync(filePath(id, 'part'), body);
  send(res, 204);
}

// Stores a file's encrypted meta (name, folder, ...). The first save finishes an upload: .part becomes .bin;
// later saves replace it (moving to another folder). Meta lands before the .bin rename, so a listed .bin always has it.
async function saveMeta(req, res, id) {
  const meta = (await readBody(req, 64 * 1024)).toString();
  const finishing = Boolean(statOf(filePath(id, 'part')));
  if (!finishing && !statOf(filePath(id, 'bin'))) throw fail(404, 'not found');
  fs.writeFileSync(filePath(id, 'tmp'), meta);
  fs.renameSync(filePath(id, 'tmp'), filePath(id, 'meta')); // atomic: a reader never sees half a meta
  if (finishing) fs.renameSync(filePath(id, 'part'), filePath(id, 'bin'));
  send(res, finishing ? 201 : 204);
}

// .bin goes first, so the file leaves the list before its .meta disappears.
function remove(res, id) {
  if (!statOf(filePath(id, 'bin'))) throw fail(404, 'not found');
  for (const ext of ['bin', 'meta']) fs.rmSync(filePath(id, ext), { force: true });
  send(res, 204);
}

async function getChunk(res, id, i) {
  const stat = statOf(filePath(id, 'bin'));
  const start = i * SLOT;
  if (!stat || start >= stat.size) throw fail(404, 'not found');
  const end = Math.min(start + SLOT, stat.size) - 1;
  res.writeHead(200, { ...HEADERS, 'Content-Type': 'application/octet-stream', 'Content-Length': end - start + 1 });
  await pipeline(fs.createReadStream(filePath(id, 'bin'), { start, end }), res);
}

const ID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const CHUNK_URL = new RegExp(`^/api/files/${ID}/(\\d{1,7})$`);
const FILE_URL = new RegExp(`^/api/files/${ID}$`);

async function handle(req, res) {
  const { pathname } = new URL(req.url, 'http://local');
  if (req.method === 'GET' && STATIC[pathname]) {
    const [file, type] = STATIC[pathname];
    return send(res, 200, fs.readFileSync(path.join(PUBLIC, file)), type);
  }
  if (!pathname.startsWith('/api/')) throw fail(404, 'not found');

  const config = readConfig();
  if (!config) throw fail(503, 'no password set: run `node server.js set-password`');
  if (req.method === 'GET' && pathname === '/api/salt') return json(res, 200, { salt: config.salt });
  if (!authorized(req, config)) throw fail(401, 'wrong password');

  if (req.method === 'GET' && pathname === '/api/files') return json(res, 200, listFiles());
  if (req.method === 'GET' && pathname === '/api/disk') return json(res, 200, disk());
  let m;
  if ((m = CHUNK_URL.exec(pathname))) {
    if (req.method === 'PUT') return putChunk(req, res, m[1], Number(m[2]));
    if (req.method === 'GET') return getChunk(res, m[1], Number(m[2]));
  }
  if ((m = FILE_URL.exec(pathname))) {
    if (req.method === 'POST') return saveMeta(req, res, m[1]);
    if (req.method === 'DELETE') return remove(res, m[1]);
  }
  throw fail(404, 'not found');
}

async function onRequest(req, res) {
  try {
    await handle(req, res);
  } catch (err) {
    if (!err.status) console.error(err);
    if (res.headersSent) res.destroy();
    else send(res, err.status || 500, err.status ? err.message : 'server error');
  }
}

const readTls = () => ({ cert: fs.readFileSync(process.env.TLS_CERT), key: fs.readFileSync(process.env.TLS_KEY) });
const tls = process.env.TLS_CERT && readTls();
const server = tls ? https.createServer(tls, onRequest) : http.createServer(onRequest);
// Re-read the certificate twice a day, so a renewed one is picked up without a restart.
if (tls) setInterval(() => { try { server.setSecureContext(readTls()); } catch (e) { console.error(e); } }, 12 * 3600e3).unref();

module.exports = { server, setPassword, CHUNK, TAG };

if (require.main === module) {
  if (process.argv[2] === 'set-password') {
    readBody(process.stdin, 1024)
      .then((b) => setPassword(b.toString().replace(/\r?\n$/, '')))
      .then(() => console.log(`password set (${CONFIG})`), (e) => { console.error(e.message); process.exit(1); });
  } else {
    const port = Number(process.env.PORT || 3000);
    server.listen(port, () => console.log(`Family Files on ${tls ? 'https' : 'http'}://0.0.0.0:${port} -> ${DATA}`));
  }
}
