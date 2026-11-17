// LiveGFX — motore di grafiche live per OBS
// Server locale: file statici + WebSocket (stato in tempo reale) + API HTTP.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { createInitialState, applyAction, OPERATOR_ACTIONS } = require('./lib/state');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA, 'state.json');
const UPLOADS = path.join(DATA, 'uploads');
const themes = require('./lib/themes').createThemes(DATA);
const CONFIG_FILE = path.join(ROOT, 'config.json');

// ---------- Configurazione (porta + PIN) ----------
function randomPin() { return String(crypto.randomInt(0, 1e6)).padStart(6, '0'); }
function loadConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { /* primo avvio */ }
  let changed = false;
  if (!cfg.port) { cfg.port = 3000; changed = true; }
  if (!cfg.adminPin) { cfg.adminPin = randomPin(); changed = true; }
  if (!cfg.operatorPin) { cfg.operatorPin = randomPin(); changed = true; }
  if (changed) fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  return cfg;
}
const config = loadConfig();
const PORT = Number(process.env.PORT) || config.port;

// ---------- Stato persistente ----------
fs.mkdirSync(DATA, { recursive: true });
let state;
try {
  state = Object.assign(createInitialState(), JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')));
} catch { state = createInitialState(); }
// all'avvio l'elenco dei temi importati si rilegge dai file (data/themes/)
state = applyAction(state, { type: 'themes.sync', list: themes.list() }, Date.now());

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_FILE); // scrittura atomica: niente file corrotti se si chiude di colpo
  }, 300);
}

// ---------- Autenticazione ----------
function roleForPin(pin) {
  if (!pin) return null;
  if (String(pin) === String(config.adminPin)) return 'admin';
  if (String(pin) === String(config.operatorPin)) return 'operator';
  return null;
}
function canDo(role, type) {
  if (role === 'admin') return true;
  if (role === 'operator') return OPERATOR_ACTIONS.has(type);
  return false;
}

// ---------- Esecuzione azioni ----------
function dispatch(action, role) {
  if (!action || typeof action.type !== 'string') return { ok: false, error: 'Azione non valida' };
  if (action.type === 'vote.cast') return { ok: false, error: 'Il voto passa solo dalla pagina di voto' };
  if (action.type === 'cover.logo') return { ok: false, error: 'Il logo si carica dal pannello' };
  if (action.type === 'themes.sync') return { ok: false, error: 'Azione interna' };
  if (action.type === 'theme.userDelete') {
    if (!canDo(role, action.type)) return { ok: false, error: 'Permesso negato' };
    themes.remove(String(action.id || ''));
    return applyAndBroadcast({ type: 'themes.sync', list: themes.list() }, false);
  }
  if (!canDo(role, action.type)) return { ok: false, error: 'Permesso negato per ' + action.type };
  if (action.type === 'subs.clear') { relaySubs({ tipo: 'svuota' }); return { ok: true, rev: state.rev }; }
  if (action.type === 'tunnel.start') { tunnel.start(); return { ok: true, rev: state.rev }; }
  if (action.type === 'tunnel.stop') { tunnel.stop(); return { ok: true, rev: state.rev }; }
  return applyAndBroadcast(action, false);
}

function applyAndBroadcast(action, lazy) {
  const prevVoteId = state.vote && state.vote.id;
  try {
    state = applyAction(state, action, Date.now());
  } catch (e) {
    return { ok: false, error: e.message };
  }
  state.rev = (state.rev || 0) + 1;
  if (state.vote.id !== prevVoteId) resetBallots(state.vote.id);   // nuova votazione: registro votanti azzerato
  scheduleSave();
  if (lazy) broadcastSoon(); else broadcast();
  return { ok: true, rev: state.rev };
}

// ---------- Registro dei votanti (un voto per telefono) ----------
// Ogni telefono riceve un cookie casuale alla prima visita della pagina di voto.
// Il registro sta in data/ballots.json, così sopravvive a un riavvio del server.
const BALLOTS_FILE = path.join(DATA, 'ballots.json');
let ballots = { voteId: null, voted: {} };
try { ballots = JSON.parse(fs.readFileSync(BALLOTS_FILE, 'utf8')); } catch { /* primo avvio */ }
if (ballots.voteId !== state.vote.id) ballots = { voteId: state.vote.id, voted: {} };
let ballotsTimer = null;
function saveBallots() {
  clearTimeout(ballotsTimer);
  ballotsTimer = setTimeout(() => {
    const tmp = BALLOTS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(ballots));
    fs.renameSync(tmp, BALLOTS_FILE);
  }, 300);
}
function resetBallots(voteId) { ballots = { voteId, voted: {} }; saveBallots(); }

function voterToken(req) {
  const m = /(?:^|;\s*)lgv=([a-f0-9]{32})/.exec(req.headers.cookie || '');
  return m ? m[1] : null;
}
function publicVote(token) {
  const v = state.vote;
  const showResults = v.revealed;
  return {
    id: v.id, question: v.question, open: v.open, mode: v.mode, full: v.voters >= v.maxVoters,
    options: v.options.map((o) => ({ id: o.id, text: o.text, color: o.color, ...(showResults ? { count: o.count } : {}) })),
    revealed: v.revealed, myVote: token ? ballots.voted[token] || null : null,
  };
}

// ---------- Sottotitoli: il programma Python manda le parole qui ----------
let subsLastSeen = 0, subsConnected = false;
function relaySubs(ev) {
  const msg = JSON.stringify({ t: 'subs', ev });
  for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
}
function isLocal(req) {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

// ---------- HTTP ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.webm': 'video/webm', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8', '.ico': 'image/x-icon', '.webp': 'image/webp', '.jpeg': 'image/jpeg',
};

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);

  // API: stato (sola lettura)
  if (p === '/api/state') return sendJson(res, 200, { state, serverNow: Date.now() });

  // API: comando. Utile per ESP32, Stream Deck, script, giochi esterni.
  //   POST /api/action   body: {"pin":"123456","type":"lb.score","id":"...","delta":1}
  //   GET  /api/action?pin=123456&type=all.hide   (comodo per pulsanti fisici)
  if (p === '/api/action') {
    let action;
    if (req.method === 'POST') {
      try { action = JSON.parse(await readBody(req) || '{}'); } catch { return sendJson(res, 400, { ok: false, error: 'JSON non valido' }); }
    } else {
      action = Object.fromEntries(url.searchParams);
      for (const k of ['delta', 'score', 'value', 'duration', 'speed']) if (k in action) action[k] = Number(action[k]);
    }
    const role = roleForPin(action.pin || req.headers['x-pin']);
    delete action.pin;
    if (!role) return sendJson(res, 401, { ok: false, error: 'PIN errato' });
    const r = dispatch(action, role);
    return sendJson(res, r.ok ? 200 : 400, r);
  }

  // Indirizzi utili per il pannello
  if (p === '/api/info') {
    return sendJson(res, 200, { port: PORT, addresses: lanAddresses(), subsConnected, tunnel: tunnel.info() });
  }

  // ---- Televoto: pagina pubblica (niente PIN) ----
  if (await handleVote(req, res, p, false)) return;

  // ---- Temi importati ----
  if (p === '/themes/user.css') {
    res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(themes.bundleCss());
  }
  const mExp = /^\/api\/themes\/([a-z0-9-]{2,30})\.json$/.exec(p);
  if (mExp && req.method === 'GET') {
    const t = themes.exportJson(mExp[1]);
    if (!t) return sendJson(res, 404, { ok: false, error: 'Tema non trovato' });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${t.id}.livegfx-theme.json"` });
    return res.end(JSON.stringify(t, null, 2));
  }
  if (p === '/api/themes' && req.method === 'POST') {
    if (roleForPin(req.headers['x-pin']) !== 'admin') return sendJson(res, 401, { ok: false, error: 'Serve il PIN regia' });
    let body = '';
    try { body = await readBody(req); } catch { return sendJson(res, 413, { ok: false, error: 'File troppo grande' }); }
    let input = body;
    const trimmed = body.trim();
    if (trimmed.startsWith('{')) {
      try { input = JSON.parse(trimmed); } catch { return sendJson(res, 400, { ok: false, error: 'Il file .json del tema non è leggibile' }); }
      if (input.livegfx && input.livegfx !== 'theme') return sendJson(res, 400, { ok: false, error: 'Questo file non è un tema LiveGFX' });
    }
    try {
      const meta = themes.save(input);
      applyAndBroadcast({ type: 'themes.sync', list: themes.list() }, false);
      return sendJson(res, 200, { ok: true, theme: meta });
    } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }

  // ---- Logo della copertura: caricamento (solo PIN regia) ----
  if (p === '/api/upload/logo' && req.method === 'POST') {
    if (roleForPin(req.headers['x-pin']) !== 'admin') return sendJson(res, 401, { ok: false, error: 'Serve il PIN regia' });
    const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/svg+xml': '.svg' }[String(req.headers['content-type']).split(';')[0]];
    if (!ext) return sendJson(res, 400, { ok: false, error: 'Formato non supportato: usa PNG, JPG, WebP o SVG' });
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 5e6) req.destroy(); else chunks.push(c); });
    req.on('end', () => {
      if (size > 5e6) return sendJson(res, 413, { ok: false, error: 'File troppo grande (max 5 MB)' });
      fs.mkdirSync(UPLOADS, { recursive: true });
      for (const f of fs.readdirSync(UPLOADS)) if (f.startsWith('logo.')) fs.unlinkSync(path.join(UPLOADS, f));
      fs.writeFileSync(path.join(UPLOADS, 'logo' + ext), Buffer.concat(chunks));
      const r = applyAndBroadcast({ type: 'cover.logo', url: `/uploads/logo${ext}?v=${Date.now().toString(36)}` }, false);
      sendJson(res, r.ok ? 200 : 400, r);
    });
    return;
  }
  if (p.startsWith('/uploads/')) {
    const full = path.normalize(path.join(UPLOADS, p.slice('/uploads/'.length)));
    if (!full.startsWith(UPLOADS + path.sep)) { res.writeHead(403); return res.end(); }
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    return serveFile(res, full);
  }

  // ---- Sottotitoli: solo dal Mac stesso (il programma Python) ----
  if (p === '/api/subs' && req.method === 'POST') {
    if (!isLocal(req)) return sendJson(res, 403, { ok: false, error: 'Solo da questo Mac' });
    let ev;
    try { ev = JSON.parse(await readBody(req) || '{}'); } catch { return sendJson(res, 400, { ok: false }); }
    subsLastSeen = Date.now();
    if (!subsConnected) { subsConnected = true; broadcastSubsStatus(); }
    if (ev.tipo === 'pausa') dispatch({ type: 'subs.pause' }, 'admin');
    else if (ev.tipo === 'riprendi') dispatch({ type: 'subs.resume' }, 'admin');
    else if (ev.tipo === 'svuota') relaySubs({ tipo: 'svuota' });
    else if (ev.tipo === 'parole' && !state.subtitles.paused && Array.isArray(ev.parole)) {
      relaySubs({ tipo: 'parole', id: Number(ev.id) || 0, finale: !!ev.finale, parole: ev.parole.slice(-200).map((w) => String(w).slice(0, 40)) });
    }
    return sendJson(res, 200, { ok: true, paused: state.subtitles.paused });
  }

  // La radice porta al pannello (redirect, così i percorsi relativi di CSS/JS funzionano)
  if (p === '/' || p === '/panel') { res.writeHead(302, { Location: '/panel/' }); return res.end(); }

  // File statici
  let file = p;
  if (file.endsWith('/')) file += 'index.html';
  const full = path.normalize(path.join(PUBLIC, file));
  if (!full.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  serveFile(res, full);
});

// ---------- Televoto: pagina e API, usate sia in rete locale sia online (tunnel) ----------
const VOTE_FILES = {   // gli unici file che la pagina di voto può chiedere
  '/vendor/fonts/inter-latin-400-normal.woff2': true, '/vendor/fonts/inter-latin-800-normal.woff2': true,
};
const postTimes = new Map();   // token -> tempi degli ultimi invii (anti-raffica)
async function handleVote(req, res, p, online) {
  if (p === '/v' || p === '/v/' || p === '/vote' || p === '/vote/' || (online && p === '/')) {
    if (!voterToken(req)) {
      res.setHeader('Set-Cookie', `lgv=${crypto.randomBytes(16).toString('hex')}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly${online ? '; Secure' : ''}`);
    }
    serveFile(res, path.join(PUBLIC, 'vote', 'index.html'));
    return true;
  }
  if (online && VOTE_FILES[p]) { serveFile(res, path.join(PUBLIC, p), 'public, max-age=86400'); return true; }
  if (p === '/api/vote' && req.method === 'GET') {
    // ETag: se non è cambiato nulla il telefono riceve "304" senza contenuto (meno traffico)
    const body = JSON.stringify(publicVote(voterToken(req)));
    const tag = '"' + crypto.createHash('sha1').update(body).digest('base64').slice(0, 16) + '"';
    const inm = String(req.headers['if-none-match'] || '').replace(/^W\//, '');
    if (inm === tag) { res.writeHead(304, { ETag: tag, 'Cache-Control': 'no-cache' }); res.end(); return true; }
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-cache', ETag: tag });
    res.end(body);
    return true;
  }
  if (p === '/api/vote' && req.method === 'POST') {
    const token = voterToken(req);
    if (!token) { sendJson(res, 400, { ok: false, error: 'Ricarica la pagina e riprova' }); return true; }
    const now = Date.now();
    const times = (postTimes.get(token) || []).filter((t) => now - t < 10000);
    if (times.length >= 5) { sendJson(res, 429, { ok: false, error: 'Troppi tentativi, aspetta qualche secondo' }); return true; }
    times.push(now); postTimes.set(token, times);
    if (postTimes.size > 5000) postTimes.clear();
    let body;
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { sendJson(res, 400, { ok: false, error: 'Dati non validi' }); return true; }
    const v = state.vote;
    if (v.mode !== 'phone') { sendJson(res, 400, { ok: false, error: 'In questa votazione si vota per alzata di mano' }); return true; }
    if (body.voteId !== v.id) { sendJson(res, 409, { ok: false, error: 'La votazione è cambiata: ricarica', vote: publicVote(token) }); return true; }
    if (ballots.voted[token]) { sendJson(res, 409, { ok: false, error: 'Hai già votato', vote: publicVote(token) }); return true; }
    const r = applyAndBroadcast({ type: 'vote.cast', id: String(body.optionId || '') }, true);
    if (!r.ok) { sendJson(res, 400, { ...r, vote: publicVote(token) }); return true; }
    ballots.voted[token] = String(body.optionId);
    saveBallots();
    sendJson(res, 200, { ok: true, vote: publicVote(token) });
    return true;
  }
  return false;
}

// ---------- Server pubblico per il voto online ----------
// Ascolta SOLO su questo Mac (127.0.0.1) e risponde SOLO alla pagina di voto:
// il tunnel Cloudflare porta qui i telefoni da internet. Pannello, API e grafiche restano privati.
const PUBLIC_PORT = Number(config.publicPort) || PORT + 1;
const publicServer = http.createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (await handleVote(req, res, p, true)) return;
    if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Non trovato');
  } catch { res.writeHead(400); res.end(); }
});
publicServer.on('error', (e) => console.error(`✖ Porta del voto online ${PUBLIC_PORT} non disponibile (${e.code}). Cambia "publicPort" in config.json.`));
publicServer.listen(PUBLIC_PORT, '127.0.0.1');

const tunnel = require('./lib/tunnel')({
  root: ROOT, port: PUBLIC_PORT,
  onChange: (t) => {
    const msg = JSON.stringify({ t: 'tunnel', ...t });
    for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
    if (t.status === 'online') console.log(`\n  🌐 Voto online attivo: ${t.url}\n`);
  },
});

function serveFile(res, full, cache = 'no-cache') {
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Non trovato'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': cache,
    });
    fs.createReadStream(full).pipe(res);
  });
}

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, path: '/ws' });

function stateMessage() {
  return JSON.stringify({ t: 'state', state, serverNow: Date.now() });
}
function broadcast() {
  clearTimeout(soonTimer); soonTimer = null;
  const msg = stateMessage();
  for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
}
// Con tanti voti al secondo, raggruppa gli aggiornamenti (max ~6 al secondo)
let soonTimer = null;
function broadcastSoon() { if (!soonTimer) soonTimer = setTimeout(broadcast, 160); }
function broadcastSubsStatus() {
  const msg = JSON.stringify({ t: 'subsStatus', connected: subsConnected });
  for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
}
setInterval(() => {
  const now = subsLastSeen && Date.now() - subsLastSeen < 6000;
  if (now !== subsConnected) { subsConnected = !!now; broadcastSubsStatus(); }
}, 1000);

wss.on('connection', (ws) => {
  ws.role = null; // le grafiche ricevono lo stato senza PIN; i comandi richiedono il login
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.send(stateMessage());
  ws.send(JSON.stringify({ t: 'subsStatus', connected: subsConnected }));
  ws.send(JSON.stringify({ t: 'tunnel', ...tunnel.info() }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.t === 'login') {
      ws.role = roleForPin(msg.pin);
      ws.send(JSON.stringify({ t: 'login', ok: !!ws.role, role: ws.role }));
      return;
    }
    if (msg.t === 'ping') { ws.send(JSON.stringify({ t: 'pong', id: msg.id, serverNow: Date.now() })); return; }
    if (msg.t === 'action') {
      const r = ws.role ? dispatch(msg.action, ws.role) : { ok: false, error: 'Non autenticato' };
      ws.send(JSON.stringify({ t: 'ack', id: msg.id, ...r }));
    }
  });
});

// Rileva connessioni morte (es. telefono che perde il Wi‑Fi)
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 10000);

// Tick per il timer: quando un countdown arriva a zero, lo stato viene aggiornato
setInterval(() => {
  const t = state.timer;
  if (t && t.running && t.mode === 'countdown') {
    const elapsed = t.elapsedBefore + (Date.now() - t.startedAt);
    if (elapsed >= t.duration) dispatch({ type: 'timer.finish' }, 'admin');
  }
}, 250);

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, ip: a.address, tailscale: a.address.startsWith('100.') });
    }
  }
  return out;
}

server.listen(PORT, '0.0.0.0', () => {
  const line = '─'.repeat(58);
  console.log(`\n${line}\n  LiveGFX attivo\n${line}`);
  console.log(`  Pannello (su questo Mac):  http://localhost:${PORT}/`);
  for (const a of lanAddresses()) {
    console.log(`  Pannello ${a.tailscale ? '(Tailscale)    ' : '(rete locale)  '}:  http://${a.ip}:${PORT}/`);
  }
  console.log(`\n  Overlay unico per OBS:    http://localhost:${PORT}/gfx/overlay.html`);
  const lan = lanAddresses().find((a) => !a.tailscale);
  if (lan) console.log(`  Pagina di voto (pubblico): http://${lan.ip}:${PORT}/v`);
  console.log(`\n  PIN REGIA     : ${config.adminPin}`);
  console.log(`  PIN OPERATORE : ${config.operatorPin}   (solo punteggi e dati, niente "in onda")`);
  console.log(`  (li cambi in config.json)\n${line}\n  Per chiudere: Ctrl+C oppure chiudi questa finestra\n`);
});

// Alla chiusura (Ctrl+C o finestra chiusa) salva subito, senza aspettare il ritardo di 300 ms
function flushAndExit() {
  tunnel.stop();
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch { /* */ }
  try { fs.writeFileSync(BALLOTS_FILE, JSON.stringify(ballots)); } catch { /* */ }
  process.exit(0);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, flushAndExit);

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`\n✖ La porta ${PORT} è già occupata. LiveGFX è già aperto in un'altra finestra?\n`);
  else console.error(e);
  process.exit(1);
});
