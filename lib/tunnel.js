// Voto online: avvia un "Quick Tunnel" Cloudflare (gratis, senza account) verso il server
// pubblico del voto. Cloudflare dà un indirizzo https://xxxx.trycloudflare.com che cambia a ogni avvio.
// Se cloudflared non c'è, lo scarica una volta sola in LiveGFX/bin/ (circa 20 MB, da GitHub).
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn, execFileSync } = require('child_process');

const DOWNLOAD = {
  arm64: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz',
  x64: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz',
};

module.exports = function createTunnel({ root, port, onChange }) {
  const binDir = path.join(root, 'bin');
  const localBin = path.join(binDir, 'cloudflared');
  let child = null;
  let info = { status: 'off', url: '', error: '' };   // off · download · starting · online · error

  function set(patch) { info = { ...info, ...patch }; onChange({ ...info }); }

  function findBinary() {
    if (fs.existsSync(localBin)) return localBin;
    for (const p of ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared']) if (fs.existsSync(p)) return p;
    try { return execFileSync('which', ['cloudflared'], { encoding: 'utf8' }).trim() || null; } catch { return null; }
  }

  function get(url, dest, hops = 0) {
    return new Promise((resolve, reject) => {
      if (hops > 5) return reject(new Error('troppi reindirizzamenti'));
      https.get(url, { headers: { 'User-Agent': 'LiveGFX' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(get(new URL(res.headers.location, url).toString(), dest, hops + 1));
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
        const out = fs.createWriteStream(dest);
        res.pipe(out);
        out.on('finish', () => out.close(resolve));
        out.on('error', reject);
      }).on('error', reject);
    });
  }

  async function download() {
    if (process.platform !== 'darwin') throw new Error('download automatico solo su macOS: installa cloudflared a mano');
    const url = DOWNLOAD[process.arch] || DOWNLOAD.arm64;
    fs.mkdirSync(binDir, { recursive: true });
    const tgz = path.join(binDir, 'cloudflared.tgz');
    set({ status: 'download', error: '' });
    await get(url, tgz);
    execFileSync('tar', ['-xzf', tgz, '-C', binDir]);
    fs.unlinkSync(tgz);
    fs.chmodSync(localBin, 0o755);
    return localBin;
  }

  async function start() {
    if (child || info.status === 'download') return;
    let bin = findBinary();
    try {
      if (!bin) bin = await download();
    } catch (e) {
      return set({ status: 'error', url: '', error: 'Download di cloudflared non riuscito (' + e.message + '). Il Mac è collegato a internet?' });
    }
    set({ status: 'starting', url: '', error: '' });
    child = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    const onData = (d) => {
      buf = (buf + d.toString()).slice(-8000);
      const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(buf);
      if (m && !info.url) set({ url: m[0] });
      // pronto quando Cloudflare conferma la connessione del tunnel
      if (info.url && info.status !== 'online' && /Registered tunnel connection/i.test(buf)) set({ status: 'online' });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const me = child;
    child.on('exit', (code) => {
      if (child !== me) return;
      child = null;
      if (info.status === 'off') return;   // fermato da noi
      const reason = /no such host|dial tcp|i\/o timeout|network is unreachable/i.test(buf)
        ? 'Il Mac non riesce a raggiungere Cloudflare: controlla la connessione a internet.'
        : /429|Too Many/i.test(buf)
          ? 'Cloudflare ha rifiutato per troppe richieste: riprova tra qualche minuto.'
          : `cloudflared si è chiuso (codice ${code}). Il Mac è collegato a internet?`;
      set({ status: 'error', url: '', error: reason });
    });
    // se dopo 40 s non è online, segnala
    setTimeout(() => {
      if (child === me && info.status === 'starting') set({ error: 'Ci sta mettendo molto: controlla la connessione a internet del Mac.' });
    }, 40000);
  }

  function stop() {
    if (!child && info.status === 'off') return;
    set({ status: 'off', url: '', error: '' });
    if (child) { const c = child; child = null; try { c.kill('SIGTERM'); } catch { /* */ } }
  }

  return { start, stop, info: () => ({ ...info }) };
};
