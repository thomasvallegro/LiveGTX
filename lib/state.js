// Stato dell'evento e azioni che lo modificano.
// Ogni azione è un oggetto { type: 'gruppo.azione', ...dati }.
'use strict';

const crypto = require('crypto');
const uid = () => crypto.randomBytes(4).toString('hex');

function createInitialState() {
  return {
    rev: 0,
    theme: 'glass',
    leaderboard: {
      visible: false, title: 'CLASSIFICA', subtitle: 'LIVE', maxRows: 8, order: 'desc', unit: 'PT',
      entries: [],
    },
    lowerthird: {
      visible: false, position: 'left',
      current: null,                // { id, name, role, tag }
      queue: [],                    // ospiti preparati, pronti da mandare in onda
    },
    scoreboard: {
      visible: false, title: '',
      teams: [
        { id: uid(), name: 'SQUADRA A', score: 0, color: 'yellow' },
        { id: uid(), name: 'SQUADRA B', score: 0, color: 'cyan' },
      ],
    },
    timer: {
      visible: false, label: 'TEMPO', mode: 'countdown',
      duration: 60000, running: false, startedAt: 0, elapsedBefore: 0, finishedAt: 0,
    },
    ticker: {
      visible: false, label: 'LIVE', speed: 120,
      items: ['Benvenuti all\'evento!', 'Seguici sui social'],
    },
    announce: { visible: false, kicker: '', title: '', subtitle: '', shownAt: 0 },
    clock: { visible: false, label: '', seconds: false, date: false, position: 'top-left' },
    subtitles: {
      visible: false, paused: false, position: 'bottom', words: 4, size: 84, hideAfter: 3, highlight: 'accent',
    },
    vote: {
      id: uid(), visible: false, mode: 'phone',      // phone = televoto · hands = alzata di mano
      question: '', options: [], open: false,
      reveal: 'live', revealed: false,               // live = barre in diretta · final = risultati solo alla rivelazione
      showQr: true, joinUrl: '', maxVoters: 300, voters: 0,
      openedAt: 0, closedAt: 0,
    },
    wheel: {
      visible: false, title: 'RUOTA DELLA FORTUNA', items: [],
      spin: null,                                    // { id, index, at, duration, turns }
      history: [],
    },
    customTheme: { ...DEFAULT_CUSTOM },
    userThemes: [], userThemesRev: 0,   // temi importati (file in data/themes/)
    background: { ...DEFAULT_BG, colors: [...DEFAULT_BG.colors] },
    bgPresets: [],
    cover: {
      visible: false, look: 'bg',          // 'bg' = come lo sfondo attuale, oppure l'id di un preset
      transition: 'fade', title: 'TORNIAMO SUBITO', subtitle: '', showLogo: false, logo: '',
    },
  };
}

// Sfondo animato: valori di partenza
const DEFAULT_BG = {
  style: 'fluid', colors: ['#1B0B4D', '#6A2CFF', '#FF4FD8', '#2EC4FF'],
  speed: 0.35, intensity: 0.6, angle: 0, brightness: 1, grain: 0.25,
};
const BG_STYLES = ['fluid', 'scroll', 'aurora', 'waves', 'bokeh'];
function cleanBg(cur, a) {
  const b = { ...cur, colors: [...cur.colors] };
  if ('style' in a) b.style = BG_STYLES.includes(a.style) ? a.style : b.style;
  if (Array.isArray(a.colors)) {
    const c = a.colors.map((x) => hex(x, null)).filter(Boolean).slice(0, 5);
    if (c.length >= 2) b.colors = c;
  }
  const clamp = (k, lo, hi) => { if (k in a) b[k] = Math.min(hi, Math.max(lo, num(a[k], b[k]))); };
  clamp('speed', 0, 1); clamp('intensity', 0, 1); clamp('angle', 0, 360); clamp('brightness', 0.2, 1.5); clamp('grain', 0, 1);
  return b;
}

// Tema personalizzato: valori di partenza (si modificano dal pannello)
const DEFAULT_CUSTOM = {
  accent: '#FF5A36', accent2: '#2EC4FF', accent3: '#FFD23F',
  panel: '#0E1020', panelAlpha: 0.88, text: '#FFFFFF', textOnAccent: '#0E1020',
  radius: 12, font: 'inter', glow: 0.6, uppercase: true,
};
const THEMES = ['glass', 'neon', 'clean', 'cinema', 'oldgame', 'glitch', 'custom'];
const FONTS = ['inter', 'chakra', 'playfair', 'pixel', 'vt323'];
const hex = (v, def) => (/^#[0-9a-fA-F]{6}$/.test(String(v)) ? String(v).toUpperCase() : def);
const VOTE_COLORS = ['yellow', 'cyan', 'green', 'magenta', 'orange', 'white'];
const WHEEL_MAX = 40;

// Azioni consentite al PIN operatore: modificano i dati, ma non decidono cosa va in onda.
const OPERATOR_ACTIONS = new Set([
  'lb.add', 'lb.update', 'lb.score', 'lb.remove',
  'sb.score', 'sb.team.update',
  'lt.queue.add', 'lt.queue.remove', 'lt.queue.update',
  'tk.set',
  'vote.hands', 'vote.handsSet',      // l'operatore può contare le mani
  'wheel.add', 'wheel.remove',
]);

const str = (v, max = 80) => String(v ?? '').slice(0, max).trim();
const num = (v, def = 0) => (Number.isFinite(Number(v)) ? Number(v) : def);
const COLORS = ['yellow', 'green', 'cyan', 'magenta', 'orange', 'white'];
const color = (c, def) => (COLORS.includes(c) ? c : def);

function find(list, id) {
  const item = list.find((x) => x.id === id);
  if (!item) throw new Error('Elemento non trovato: ' + id);
  return item;
}

function timerElapsed(t, now) {
  return t.elapsedBefore + (t.running ? now - t.startedAt : 0);
}

function applyAction(prev, a, now) {
  const s = structuredClone(prev);
  const lb = s.leaderboard, lt = s.lowerthird, sb = s.scoreboard, tm = s.timer, tk = s.ticker, an = s.announce;

  switch (a.type) {
    // ---------- Generali ----------
    case 'theme.set':
      s.theme = THEMES.includes(String(a.value)) || (s.userThemes || []).some((t) => t.id === String(a.value)) ? String(a.value) : 'glass'; break;
    case 'themes.sync':   // solo dal server, dopo un'importazione o un'eliminazione
      s.userThemes = (Array.isArray(a.list) ? a.list : []).map((t) => ({ id: str(t.id, 30), name: str(t.name, 40), editable: !!t.editable, ...(t.custom ? { custom: t.custom } : {}) }));
      s.userThemesRev = now;
      if (!THEMES.includes(s.theme) && !s.userThemes.some((t) => t.id === s.theme)) s.theme = 'glass';
      break;
    case 'theme.editUser': {   // copia un tema importato nell'editor del personalizzato
      const t = find(s.userThemes || [], a.id);
      if (!t.custom) throw new Error('Questo tema è scritto in CSS: non si modifica dall\'editor');
      s.customTheme = { ...DEFAULT_CUSTOM, ...t.custom };
      s.theme = 'custom';
      break;
    }
    case 'theme.custom': {
      const c = s.customTheme;
      for (const k of ['accent', 'accent2', 'accent3', 'panel', 'text', 'textOnAccent']) if (k in a) c[k] = hex(a[k], c[k]);
      if ('panelAlpha' in a) c.panelAlpha = Math.min(1, Math.max(0, num(a.panelAlpha, c.panelAlpha)));
      if ('radius' in a) c.radius = Math.min(60, Math.max(0, num(a.radius, c.radius)));
      if ('glow' in a) c.glow = Math.min(1, Math.max(0, num(a.glow, c.glow)));
      if ('font' in a) c.font = FONTS.includes(a.font) ? a.font : c.font;
      if ('uppercase' in a) c.uppercase = a.uppercase === true || a.uppercase === 'true';
      break;
    }
    case 'theme.customReset': s.customTheme = { ...DEFAULT_CUSTOM }; break;

    // ---------- Sfondi animati ----------
    case 'bg.set': s.background = cleanBg(s.background, a); break;
    case 'bg.presetSave': {
      const name = str(a.name, 30);
      if (!name) throw new Error('Dai un nome al preset');
      const ex = s.bgPresets.find((p) => p.name.toLowerCase() === name.toLowerCase());
      const look = { ...s.background, colors: [...s.background.colors] };
      if (ex) ex.bg = look;    // stesso nome: lo aggiorna
      else {
        if (s.bgPresets.length >= 30) throw new Error('Massimo 30 preset');
        s.bgPresets.push({ id: uid(), name, bg: look });
      }
      break;
    }
    case 'bg.presetLoad': { const p = find(s.bgPresets, a.id); s.background = { ...p.bg, colors: [...p.bg.colors] }; break; }
    case 'bg.presetDelete':
      s.bgPresets = s.bgPresets.filter((p) => p.id !== a.id);
      if (s.cover.look === a.id) s.cover.look = 'bg';
      break;
    case 'bg.reset': s.background = { ...DEFAULT_BG, colors: [...DEFAULT_BG.colors] }; break;

    // ---------- Copertura ----------
    case 'cover.show': s.cover.visible = true; break;
    case 'cover.hide': s.cover.visible = false; break;
    case 'cover.config': {
      const c = s.cover;
      if ('title' in a) c.title = str(a.title, 60);
      if ('subtitle' in a) c.subtitle = str(a.subtitle, 90);
      if ('transition' in a) c.transition = ['fade', 'wipe', 'zoom', 'iris'].includes(a.transition) ? a.transition : 'fade';
      if ('showLogo' in a) c.showLogo = a.showLogo === true || a.showLogo === 'true';
      if ('look' in a) c.look = a.look === 'bg' || s.bgPresets.some((p) => p.id === a.look) ? a.look : 'bg';
      break;
    }
    case 'cover.logo': s.cover.logo = str(a.url, 120); s.cover.showLogo = !!s.cover.logo; break;  // solo dal server dopo l'upload
    case 'all.hide':  // "pulsante panico": nasconde tutto
      lb.visible = lt.visible = sb.visible = tm.visible = tk.visible = an.visible = false;
      s.clock.visible = s.subtitles.visible = s.vote.visible = s.wheel.visible = false; break;
    case 'state.reset': return Object.assign(createInitialState(), { theme: s.theme, customTheme: s.customTheme, rev: s.rev });

    // ---------- Orologio ----------
    case 'clock.show': s.clock.visible = true; break;
    case 'clock.hide': s.clock.visible = false; break;
    case 'clock.config': {
      const c = s.clock;
      if ('label' in a) c.label = str(a.label, 20);
      if ('seconds' in a) c.seconds = a.seconds === true || a.seconds === 'true';
      if ('date' in a) c.date = a.date === true || a.date === 'true';
      if ('position' in a) c.position = ['top-left', 'top-right', 'bottom-right', 'bottom-left'].includes(a.position) ? a.position : 'top-left';
      break;
    }

    // ---------- Sottotitoli ----------
    case 'subs.show': s.subtitles.visible = true; break;
    case 'subs.hide': s.subtitles.visible = false; break;
    case 'subs.pause': s.subtitles.paused = true; break;
    case 'subs.resume': s.subtitles.paused = false; break;
    case 'subs.config': {
      const c = s.subtitles;
      if ('position' in a) c.position = ['bottom', 'center', 'top'].includes(a.position) ? a.position : 'bottom';
      if ('words' in a) c.words = Math.min(10, Math.max(1, num(a.words, 4)));
      if ('size' in a) c.size = Math.min(160, Math.max(30, num(a.size, 84)));
      if ('hideAfter' in a) c.hideAfter = Math.min(20, Math.max(1, num(a.hideAfter, 3)));
      if ('highlight' in a) c.highlight = ['accent', 'yellow', 'green', 'cyan', 'magenta', 'white'].includes(a.highlight) ? a.highlight : 'accent';
      break;
    }

    // ---------- Televoto / alzata di mano ----------
    case 'vote.setup': {   // nuova votazione: azzera voti e votanti
      const opts = (Array.isArray(a.options) ? a.options : []).map((x) => str(x, 40)).filter(Boolean).slice(0, 6);
      if (opts.length < 2) throw new Error('Servono almeno 2 opzioni');
      const question = str(a.question, 90);
      if (!question) throw new Error('Domanda mancante');
      Object.assign(s.vote, {
        id: uid(), question, open: false, revealed: false, voters: 0, openedAt: 0, closedAt: 0,
        mode: a.mode === 'hands' ? 'hands' : 'phone',
        options: opts.map((text, i) => ({ id: uid(), text, color: VOTE_COLORS[i], count: 0 })),
      });
      break;
    }
    case 'vote.config': {
      const v = s.vote;
      if ('mode' in a) v.mode = a.mode === 'hands' ? 'hands' : 'phone';
      if ('reveal' in a) v.reveal = a.reveal === 'final' ? 'final' : 'live';
      if ('showQr' in a) v.showQr = a.showQr === true || a.showQr === 'true';
      if ('joinUrl' in a) v.joinUrl = str(a.joinUrl, 120);
      if ('maxVoters' in a) v.maxVoters = Math.min(2000, Math.max(1, Math.round(num(a.maxVoters, 300))));
      break;
    }
    case 'vote.open':
      if (s.vote.options.length < 2) throw new Error('Prepara prima domanda e opzioni');
      s.vote.open = true; s.vote.openedAt = now; s.vote.closedAt = 0; s.vote.revealed = false; break;
    case 'vote.close': if (s.vote.open) { s.vote.open = false; s.vote.closedAt = now; } break;
    case 'vote.reveal': s.vote.open = false; s.vote.revealed = true; if (!s.vote.closedAt) s.vote.closedAt = now; break;
    case 'vote.show': s.vote.visible = true; break;
    case 'vote.hide': s.vote.visible = false; break;
    case 'vote.reset':   // stessa domanda, voti a zero
      s.vote.id = uid(); s.vote.open = false; s.vote.revealed = false; s.vote.voters = 0; s.vote.openedAt = 0; s.vote.closedAt = 0;
      s.vote.options.forEach((o) => { o.count = 0; }); break;
    case 'vote.hands': { const o = find(s.vote.options, a.id); o.count = Math.max(0, num(o.count) + num(a.delta)); break; }
    case 'vote.handsSet': { const o = find(s.vote.options, a.id); o.count = Math.max(0, Math.round(num(a.value))); break; }
    case 'vote.cast': {    // arriva SOLO dal server (pagina di voto), mai dal pannello
      if (!s.vote.open) throw new Error('Votazione chiusa');
      if (s.vote.voters >= s.vote.maxVoters) throw new Error('Limite di votanti raggiunto');
      const o = find(s.vote.options, a.id);
      o.count += 1; s.vote.voters += 1;
      break;
    }

    // ---------- Ruota della fortuna ----------
    case 'wheel.show': s.wheel.visible = true; break;
    case 'wheel.hide': s.wheel.visible = false; break;
    case 'wheel.config': if ('title' in a) s.wheel.title = str(a.title, 40); break;
    case 'wheel.add': {
      const list = (Array.isArray(a.items) ? a.items : [a.text]).map((x) => str(x, 40)).filter(Boolean);
      if (!list.length) throw new Error('Testo mancante');
      if (s.wheel.items.length + list.length > WHEEL_MAX) throw new Error(`Massimo ${WHEEL_MAX} spicchi`);
      if (s.wheel.spin && now < s.wheel.spin.at + s.wheel.spin.duration) throw new Error('Aspetta che la ruota si fermi');
      for (const text of list) s.wheel.items.push({ id: uid(), text });
      s.wheel.spin = null;
      break;
    }
    case 'wheel.remove':
    case 'wheel.removeWinner': {
      if (s.wheel.spin && now < s.wheel.spin.at + s.wheel.spin.duration) throw new Error('Aspetta che la ruota si fermi');
      const id = a.type === 'wheel.remove' ? a.id : s.wheel.spin && s.wheel.spin.itemId;
      s.wheel.items = s.wheel.items.filter((x) => x.id !== id);
      s.wheel.spin = null;
      break;
    }
    case 'wheel.clear': s.wheel.items = []; s.wheel.spin = null; break;
    case 'wheel.import': {   // copia nomi dalla classifica o dalle squadre
      const src = a.source === 'teams' ? sb.teams : lb.entries;
      const have = new Set(s.wheel.items.map((x) => x.text.toLowerCase()));
      for (const x of src) {
        if (s.wheel.items.length >= WHEEL_MAX) break;
        if (!have.has(x.name.toLowerCase())) { s.wheel.items.push({ id: uid(), text: str(x.name, 40) }); have.add(x.name.toLowerCase()); }
      }
      s.wheel.spin = null;
      break;
    }
    case 'wheel.spin': {
      const n = s.wheel.items.length;
      if (n < 2) throw new Error('Servono almeno 2 spicchi');
      if (s.wheel.spin && now < s.wheel.spin.at + s.wheel.spin.duration) throw new Error('La ruota sta già girando');
      const index = crypto.randomInt(0, n);           // estrazione decisa qui, sul server: tutte le grafiche vedono lo stesso risultato
      const duration = Math.min(15000, Math.max(3000, num(a.duration, 7000)));
      // Angoli in gradi, senso orario. Lo spicchio i occupa [i*seg, (i+1)*seg) partendo dall'alto.
      // La ruota parte da dove si era fermata (from) e si ferma con lo spicchio estratto sotto la freccia (to).
      const seg = 360 / n;
      const from = s.wheel.spin && s.wheel.spin.to !== undefined && s.wheel.spin.n === n ? s.wheel.spin.to % 360 : 0;
      const target = (360 - ((index + crypto.randomInt(15, 85) / 100) * seg) % 360) % 360;
      const to = from + (5 + crypto.randomInt(0, 3)) * 360 + ((target - from) % 360 + 360) % 360;
      s.wheel.spin = { id: uid(), index, n, itemId: s.wheel.items[index].id, text: s.wheel.items[index].text,
        at: now + 150, duration, from, to };
      s.wheel.visible = true;
      s.wheel.history = [{ text: s.wheel.items[index].text, at: now }, ...s.wheel.history].slice(0, 20);
      break;
    }

    // ---------- Classifica ----------
    case 'lb.show': lb.visible = true; break;
    case 'lb.hide': lb.visible = false; break;
    case 'lb.config':
      if ('title' in a) lb.title = str(a.title, 40);
      if ('subtitle' in a) lb.subtitle = str(a.subtitle, 30);
      if ('unit' in a) lb.unit = str(a.unit, 8);
      if ('maxRows' in a) lb.maxRows = Math.min(12, Math.max(3, num(a.maxRows, 8)));
      if ('order' in a) lb.order = a.order === 'asc' ? 'asc' : 'desc';
      break;
    case 'lb.add': {
      const name = str(a.name, 40);
      if (!name) throw new Error('Nome mancante');
      lb.entries.push({ id: uid(), name, sub: str(a.sub, 40), score: num(a.score) });
      break;
    }
    case 'lb.update': {
      const e = find(lb.entries, a.id);
      if ('name' in a) e.name = str(a.name, 40) || e.name;
      if ('sub' in a) e.sub = str(a.sub, 40);
      if ('score' in a) e.score = num(a.score, e.score);
      break;
    }
    case 'lb.score': { const e = find(lb.entries, a.id); e.score = num(e.score) + num(a.delta); break; }
    case 'lb.remove': lb.entries = lb.entries.filter((e) => e.id !== a.id); break;
    case 'lb.clear': lb.entries = []; break;
    case 'lb.resetScores': lb.entries.forEach((e) => { e.score = 0; }); break;

    // ---------- Lower third ospiti ----------
    case 'lt.queue.add': {
      const name = str(a.name, 50);
      if (!name) throw new Error('Nome mancante');
      lt.queue.push({ id: uid(), name, role: str(a.role, 60), tag: str(a.tag, 20) });
      break;
    }
    case 'lt.queue.update': {
      const g = find(lt.queue, a.id);
      if ('name' in a) g.name = str(a.name, 50) || g.name;
      if ('role' in a) g.role = str(a.role, 60);
      if ('tag' in a) g.tag = str(a.tag, 20);
      break;
    }
    case 'lt.queue.remove': lt.queue = lt.queue.filter((g) => g.id !== a.id); break;
    case 'lt.take': {   // manda in onda un ospite dalla coda
      const g = find(lt.queue, a.id);
      lt.current = { ...g, shownAt: now };
      lt.visible = true;
      break;
    }
    case 'lt.quick': {  // ospite all'ultimo secondo: in onda subito, senza passare dalla coda
      const name = str(a.name, 50);
      if (!name) throw new Error('Nome mancante');
      lt.current = { id: uid(), name, role: str(a.role, 60), tag: str(a.tag, 20), shownAt: now };
      lt.visible = true;
      break;
    }
    case 'lt.show': if (lt.current) { lt.visible = true; lt.current.shownAt = now; } break;
    case 'lt.hide': lt.visible = false; break;
    case 'lt.position': lt.position = a.value === 'right' ? 'right' : 'left'; break;

    // ---------- Tabellone squadre ----------
    case 'sb.show': sb.visible = true; break;
    case 'sb.hide': sb.visible = false; break;
    case 'sb.config': if ('title' in a) sb.title = str(a.title, 40); break;
    case 'sb.score': { const t = find(sb.teams, a.id); t.score = num(t.score) + num(a.delta); break; }
    case 'sb.team.update': {
      const t = find(sb.teams, a.id);
      if ('name' in a) t.name = str(a.name, 24) || t.name;
      if ('score' in a) t.score = num(a.score, t.score);
      if ('color' in a) t.color = color(a.color, t.color);
      break;
    }
    case 'sb.team.add':
      if (sb.teams.length >= 4) throw new Error('Massimo 4 squadre');
      sb.teams.push({ id: uid(), name: str(a.name, 24) || 'SQUADRA ' + 'ABCD'[sb.teams.length], score: 0,
        color: color(a.color, COLORS[sb.teams.length % 4]) });
      break;
    case 'sb.team.remove':
      if (sb.teams.length <= 2) throw new Error('Servono almeno 2 squadre');
      sb.teams = sb.teams.filter((t) => t.id !== a.id); break;
    case 'sb.reset': sb.teams.forEach((t) => { t.score = 0; }); break;

    // ---------- Timer ----------
    case 'timer.show': tm.visible = true; break;
    case 'timer.hide': tm.visible = false; break;
    case 'timer.config':
      if ('label' in a) tm.label = str(a.label, 20);
      if ('mode' in a) tm.mode = a.mode === 'stopwatch' ? 'stopwatch' : 'countdown';
      if ('duration' in a) tm.duration = Math.max(1000, num(a.duration, 60000));
      tm.running = false; tm.elapsedBefore = 0; tm.finishedAt = 0;
      break;
    case 'timer.start':
      if (!tm.running) {
        if (tm.mode === 'countdown' && tm.elapsedBefore >= tm.duration) tm.elapsedBefore = 0;
        tm.running = true; tm.startedAt = now; tm.finishedAt = 0;
      }
      break;
    case 'timer.pause':
      if (tm.running) { tm.elapsedBefore = timerElapsed(tm, now); tm.running = false; }
      break;
    case 'timer.reset': tm.running = false; tm.elapsedBefore = 0; tm.finishedAt = 0; break;
    case 'timer.add': {   // aggiunge/toglie tempo al volo
      if (tm.mode === 'countdown') tm.duration = Math.max(1000, tm.duration + num(a.delta));
      break;
    }
    case 'timer.finish':
      tm.running = false; tm.elapsedBefore = tm.duration; tm.finishedAt = now; break;

    // ---------- Ticker ----------
    case 'tk.show': tk.visible = true; break;
    case 'tk.hide': tk.visible = false; break;
    case 'tk.set':
      if (Array.isArray(a.items)) tk.items = a.items.map((x) => str(x, 140)).filter(Boolean).slice(0, 30);
      if ('label' in a) tk.label = str(a.label, 16);
      if ('speed' in a) tk.speed = Math.min(400, Math.max(30, num(a.speed, 120)));
      break;

    // ---------- Annuncio a tutto schermo ----------
    case 'an.show':
      if ('title' in a) an.title = str(a.title, 60);
      if ('kicker' in a) an.kicker = str(a.kicker, 40);
      if ('subtitle' in a) an.subtitle = str(a.subtitle, 90);
      if (!an.title) throw new Error('Titolo mancante');
      an.visible = true; an.shownAt = now;
      break;
    case 'an.hide': an.visible = false; break;

    default: throw new Error('Azione sconosciuta: ' + a.type);
  }
  return s;
}

module.exports = { createInitialState, applyAction, OPERATOR_ACTIONS, timerElapsed, DEFAULT_CUSTOM, DEFAULT_BG };
