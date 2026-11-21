// LiveGFX · collegamento a OBS Studio tramite OBS WebSocket (protocollo v5, incluso in OBS 28+).
// In OBS: Strumenti → Impostazioni server WebSocket → Abilita server WebSocket.
// Il collegamento resta sul Mac (127.0.0.1): dal telefono si comanda OBS solo passando dal pannello.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { WebSocket } = require('ws');

const SUBS = 1 | 2 | 4 | 8 | 16 | 64 | 1024;   // General, Config, Scenes, Inputs, Transitions, Outputs, Ui

function createObs(DATA, onChange) {
  const CFG_FILE = path.join(DATA, 'obs.json');
  let cfg = { host: '127.0.0.1', port: 4455, password: '', enabled: true };
  try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')) }; } catch { /* default */ }

  let sock = null, ready = false, reqId = 0, retryTimer = null, authFailed = false;
  const pending = new Map();
  const st = {
    connected: false, error: '', version: '',
    studio: false, program: '', preview: '', scenes: [],
    transitions: [], transition: '', duration: 300, fixed: false,
    inputs: [],   // [{ name, muted, mul }] solo fonti con audio
  };
  let notifyTimer = null;
  const notify = () => { if (!notifyTimer) notifyTimer = setTimeout(() => { notifyTimer = null; onChange(); }, 60); };

  function saveCfg() {
    const tmp = CFG_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
    fs.renameSync(tmp, CFG_FILE);
  }

  function connect() {
    clearTimeout(retryTimer);
    if (sock) { try { sock.terminate(); } catch {} sock = null; }
    if (!cfg.enabled) { st.connected = false; st.error = 'Collegamento a OBS spento'; notify(); return; }
    ready = false;
    let s;
    try { s = new WebSocket(`ws://${cfg.host}:${cfg.port}`, 'obswebsocket.json'); } catch (e) { st.error = e.message; scheduleRetry(); return; }
    sock = s;
    s.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.op === 0) {   // Hello
        const ident = { rpcVersion: 1, eventSubscriptions: SUBS };
        if (m.d.authentication) {
          if (!cfg.password) { st.error = 'OBS chiede una password: inseriscila nelle impostazioni'; authFailed = true; notify(); s.close(); return; }
          const secret = crypto.createHash('sha256').update(cfg.password + m.d.authentication.salt).digest('base64');
          ident.authentication = crypto.createHash('sha256').update(secret + m.d.authentication.challenge).digest('base64');
        }
        st.version = m.d.obsWebSocketVersion || '';
        s.send(JSON.stringify({ op: 1, d: ident }));
      } else if (m.op === 2) {   // Identified
        ready = true; authFailed = false; st.connected = true; st.error = '';
        refreshAll().catch((e) => { st.error = e.message; notify(); });
      } else if (m.op === 7) {   // risposta a una richiesta
        const p = pending.get(m.d.requestId); if (!p) return;
        pending.delete(m.d.requestId); clearTimeout(p.timer);
        if (m.d.requestStatus.result) p.resolve(m.d.responseData || {});
        else p.reject(new Error(m.d.requestStatus.comment || `OBS: errore ${m.d.requestStatus.code}`));
      } else if (m.op === 5) onEvent(m.d.eventType, m.d.eventData || {});
    });
    s.on('close', (code) => {
      if (sock !== s) return;
      ready = false; st.connected = false; sock = null;
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('OBS scollegato')); }
      pending.clear();
      if (code === 4009) { authFailed = true; st.error = 'Password OBS errata'; }
      else if (!authFailed) st.error = st.error || 'OBS scollegato';
      notify();
      if (!authFailed) scheduleRetry();
    });
    s.on('error', (e) => {
      st.error = e.code === 'ECONNREFUSED' ? 'OBS non raggiungibile: è aperto con il server WebSocket abilitato?' : e.message;
    });
  }
  function scheduleRetry() { clearTimeout(retryTimer); retryTimer = setTimeout(connect, 4000); }

  function call(requestType, requestData) {
    if (!ready || !sock) return Promise.reject(new Error('OBS non collegato'));
    const requestId = 'lg' + (++reqId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('OBS non risponde')); }, 5000);
      pending.set(requestId, { resolve, reject, timer });
      sock.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
    });
  }

  async function refreshScenes() {
    const r = await call('GetSceneList');
    st.scenes = (r.scenes || []).slice().sort((a, b) => b.sceneIndex - a.sceneIndex).map((x) => x.sceneName);   // stesso ordine del pannello Scene di OBS
    st.program = r.currentProgramSceneName || '';
    st.preview = r.currentPreviewSceneName || '';
  }
  async function refreshTransitions() {
    const r = await call('GetSceneTransitionList');
    st.transitions = (r.transitions || []).map((t) => t.transitionName);
    st.transition = r.currentSceneTransitionName || '';
    try { const c = await call('GetCurrentSceneTransition'); st.duration = c.transitionDuration ?? st.duration; st.fixed = !!c.transitionFixed; } catch {}
  }
  async function refreshInputs() {
    const r = await call('GetInputList');
    const out = [];
    for (const i of r.inputs || []) {
      try {   // solo le fonti che hanno l'audio rispondono a GetInputVolume
        const v = await call('GetInputVolume', { inputName: i.inputName });
        const m = await call('GetInputMute', { inputName: i.inputName });
        out.push({ name: i.inputName, mul: v.inputVolumeMul, muted: !!m.inputMuted });
      } catch { /* fonte senza audio */ }
    }
    st.inputs = out;
  }
  async function refreshAll() {
    const sm = await call('GetStudioModeEnabled'); st.studio = !!sm.studioModeEnabled;
    await refreshScenes(); await refreshTransitions(); await refreshInputs();
    notify();
  }

  let refreshT = {};
  const later = (k, fn) => { clearTimeout(refreshT[k]); refreshT[k] = setTimeout(() => fn().then(notify).catch(() => {}), 150); };
  function onEvent(type, d) {
    switch (type) {
      case 'CurrentProgramSceneChanged': st.program = d.sceneName; notify(); break;
      case 'CurrentPreviewSceneChanged': st.preview = d.sceneName; notify(); break;
      case 'StudioModeStateChanged': st.studio = !!d.studioModeEnabled; if (st.studio) later('scenes', refreshScenes); else { st.preview = ''; notify(); } break;
      case 'SceneListChanged': case 'SceneCreated': case 'SceneRemoved': case 'SceneNameChanged': later('scenes', refreshScenes); break;
      case 'InputMuteStateChanged': { const i = st.inputs.find((x) => x.name === d.inputName); if (i) { i.muted = !!d.inputMuted; notify(); } break; }
      case 'InputVolumeChanged': { const i = st.inputs.find((x) => x.name === d.inputName); if (i) { i.mul = d.inputVolumeMul; notify(); } break; }
      case 'InputCreated': case 'InputRemoved': case 'InputNameChanged': later('inputs', refreshInputs); break;
      case 'CurrentSceneTransitionChanged': case 'SceneTransitionCreated': case 'SceneTransitionRemoved': later('trans', refreshTransitions); break;
      case 'CurrentSceneTransitionDurationChanged': st.duration = d.transitionDuration; notify(); break;
      case 'ExitStarted': st.connected = false; st.error = 'OBS si sta chiudendo'; notify(); break;
    }
  }

  // ---------- comandi dal pannello ----------
  const needScene = (n) => { const s = String(n || ''); if (!st.scenes.includes(s)) throw new Error('Scena non trovata: ' + s); return s; };
  const needInput = (n) => { const i = st.inputs.find((x) => x.name === String(n || '')); if (!i) throw new Error('Fonte audio non trovata: ' + n); return i; };
  async function exec(a) {
    switch (a.type) {
      case 'obs.preview': {   // in modalità studio va in anteprima; senza modalità studio va direttamente in onda
        const scene = needScene(a.scene);
        if (st.studio) await call('SetCurrentPreviewScene', { sceneName: scene });
        else await call('SetCurrentProgramScene', { sceneName: scene });
        return;
      }
      case 'obs.program': await call('SetCurrentProgramScene', { sceneName: needScene(a.scene) }); return;
      case 'obs.transition':
        if (!st.studio) throw new Error('La modalità studio di OBS è spenta');
        await call('TriggerStudioModeTransition'); return;
      case 'obs.studio': await call('SetStudioModeEnabled', { studioModeEnabled: !!a.on }); return;
      case 'obs.setTransition': await call('SetCurrentSceneTransition', { transitionName: String(a.name) }); later('trans', refreshTransitions); return;
      case 'obs.setDuration': {
        const ms = Math.max(50, Math.min(20000, Math.round(Number(a.ms) || 300)));
        await call('SetCurrentSceneTransitionDuration', { transitionDuration: ms }); st.duration = ms; notify(); return;
      }
      case 'obs.mute': {
        const i = needInput(a.input);
        const on = a.on === undefined || a.on === 'toggle' ? !i.muted : a.on === true || a.on === 'true';
        await call('SetInputMute', { inputName: i.name, inputMuted: on }); i.muted = on; notify(); return;
      }
      case 'obs.volume': {
        const i = needInput(a.input), mul = Math.max(0, Math.min(1, Number(a.mul)));
        if (!Number.isFinite(mul)) throw new Error('Volume non valido');
        await call('SetInputVolume', { inputName: i.name, inputVolumeMul: mul }); i.mul = mul; notify(); return;
      }
      case 'obs.refresh': await refreshAll(); return;
      default: throw new Error('Comando OBS sconosciuto: ' + a.type);
    }
  }

  // Miniature delle scene (JPEG piccoli), solo quando qualcuno guarda la scheda OBS del pannello
  async function screenshot(scene, width) {
    const r = await call('GetSourceScreenshot', { sourceName: scene, imageFormat: 'jpg', imageWidth: width, imageCompressionQuality: 55 });
    return r.imageData;
  }

  return {
    status: () => ({ ...st, host: cfg.host, port: cfg.port, hasPassword: !!cfg.password, enabled: cfg.enabled }),
    exec, screenshot, connect,
    isReady: () => ready,
    configure(c) {   // dal pannello (solo admin)
      if (c.host !== undefined) cfg.host = String(c.host).trim() || '127.0.0.1';
      if (c.port !== undefined) cfg.port = Math.max(1, Math.min(65535, Number(c.port) || 4455));
      if (c.password !== undefined && c.password !== null) cfg.password = String(c.password);
      if (c.enabled !== undefined) cfg.enabled = c.enabled === true || c.enabled === 'true';
      saveCfg(); authFailed = false; st.error = ''; connect();
    },
    close() { clearTimeout(retryTimer); cfg.enabled = false; if (sock) try { sock.close(); } catch {} },
  };
}

module.exports = { createObs };
