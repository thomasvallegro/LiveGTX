// Temi importati: ogni tema è un file data/themes/<id>.json
// Formato del file (lo stesso che il pannello esporta e importa):
//   { "livegfx": "theme", "version": 1, "id": "vaporwave", "name": "Vaporwave",
//     "custom": { ...valori del tema personalizzato... }   ← se nasce dall'editor del pannello
//     "css": "[data-theme=\"vaporwave\"] { ... }" }         ← se è scritto a mano o da un'IA
// Le grafiche caricano tutti i temi importati da /themes/user.css.
'use strict';
const fs = require('fs');
const path = require('path');

const BUILTIN = ['glass', 'neon', 'clean', 'cinema', 'oldgame', 'glitch', 'custom'];
const FONT_STACK = {
  inter: "'Inter', system-ui, sans-serif", chakra: "'Chakra Petch', 'Inter', sans-serif",
  playfair: "'Playfair Display', Georgia, serif", pixel: "'Press Start 2P', monospace", vt323: "'VT323', monospace",
};
const MAX_CSS = 200 * 1024;

const hexOk = (v) => /^#[0-9a-fA-F]{6}$/.test(String(v));
function rgba(hex, a) {
  const n = parseInt(String(hex).slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${Number(a).toFixed(3)})`;
}
const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

// Valori del tema personalizzato → variabili CSS (stessa logica di gfx/common.js)
function customToCss(id, c) {
  const col = (k, d) => (hexOk(c[k]) ? c[k] : d);
  const accent = col('accent', '#FF5A36'), accent2 = col('accent2', '#2EC4FF'), accent3 = col('accent3', '#FFD23F');
  const panel = col('panel', '#0E1020'), text = col('text', '#FFFFFF'), onAccent = col('textOnAccent', '#0E1020');
  const alpha = num(c.panelAlpha, 0.88, 0, 1), g = num(c.glow, 0.6, 0, 1), radius = num(c.radius, 12, 0, 60);
  const font = FONT_STACK[c.font] ? c.font : 'inter';
  const sel = `[data-theme="${id}"]`;
  return `/* ${id}: creato con l'editor del tema personalizzato */
${sel} {
  --accent: ${accent}; --accent-2: ${accent2}; --accent-3: ${accent3};
  --yellow: ${accent}; --cyan: ${accent2}; --green: ${accent3};
  --panel: ${rgba(panel, alpha)}; --panel-2: ${rgba(panel, Math.min(1, alpha + 0.08))};
  --text: ${text}; --text-dim: ${rgba(text, 0.65)}; --text-on-accent: ${onAccent}; --line: ${rgba(text, 0.12)};
  --radius: ${radius}px; --font-display: ${FONT_STACK[font]};
  --font-body: ${font === 'vt323' ? FONT_STACK.vt323 : FONT_STACK.inter};
  --glow: ${g}; --accent-glow: ${rgba(accent, 0.75 * g)}; --accent2-glow: ${rgba(accent2, 0.5 * g)};
  --accent2-edge: ${rgba(accent2, 0.25 + 0.4 * g)}; --display-case: ${c.uppercase === false || c.uppercase === 'false' ? 'none' : 'uppercase'};
}
${sel} .head::after, ${sel} #tk::before, ${sel} .question::after, ${sel} #an .line {
  background: linear-gradient(90deg, var(--accent), var(--accent-3), var(--accent-2));
}
${sel} .bar { background: linear-gradient(180deg, var(--accent), var(--accent-3), var(--accent-2)); }
${sel} .name, ${sel} .tname, ${sel} .opt .text { text-transform: var(--display-case, uppercase); }
${sel} .row[data-rank="1"] .rank { color: var(--accent); text-shadow: 0 0 16px var(--accent-glow); }
${sel} .row[data-rank="2"] .rank { color: var(--accent-2); }
${sel} .row[data-rank="3"] .rank { color: var(--accent-3); }
`;
}

// Toglie dal CSS ciò che potrebbe uscire dal Mac o rompere la pagina:
// @import, url() verso internet, chiusure di <style>. Tutto deve funzionare offline.
function sanitizeCss(css) {
  return String(css)
    .replace(/<\/?\s*style[^>]*>/gi, '')
    .replace(/@import[^;]*;?/gi, '/* @import rimosso: i temi funzionano offline */')
    .replace(/url\(\s*(['"]?)\s*(https?:|\/\/|data:text|javascript:)[^)]*\)/gi, 'none')
    .replace(/expression\s*\(/gi, '(');
}

function createThemes(dataDir) {
  const dir = path.join(dataDir, 'themes');
  fs.mkdirSync(dir, { recursive: true });

  function readAll() {
    const out = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try { out.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch { /* file rovinato: saltato */ }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, 'it'));
  }

  // Ricava id e nome da un file .css scritto a mano: id dal primo [data-theme="…"],
  // nome da un commento "LiveGFX tema: Nome" (facoltativo)
  function fromCss(css) {
    const m = /\[data-theme\s*=\s*["']([a-z0-9-]{2,30})["']\]/i.exec(css);
    if (!m) throw new Error('Nel CSS manca un blocco [data-theme="nome-del-tema"]');
    const n = /LiveGFX\s+tema\s*:\s*([^*\n]{1,40})/i.exec(css);
    return { id: m[1].toLowerCase(), name: n ? n[1].trim() : m[1], css };
  }

  function save(input) {
    let t = input;
    if (typeof input === 'string') t = fromCss(input);
    if (!t || typeof t !== 'object') throw new Error('File del tema non valido');
    const id = String(t.id || '').toLowerCase().trim();
    if (!/^[a-z0-9-]{2,30}$/.test(id)) throw new Error('Nome interno del tema non valido: usa 2–30 lettere minuscole, numeri o trattini');
    if (BUILTIN.includes(id)) throw new Error(`"${id}" è il nome di un tema già incluso: scegline un altro`);
    const name = String(t.name || id).trim().slice(0, 40) || id;
    let css = '';
    let custom = null;
    if (t.custom && typeof t.custom === 'object') {
      custom = {};
      for (const k of ['accent', 'accent2', 'accent3', 'panel', 'text', 'textOnAccent']) if (hexOk(t.custom[k])) custom[k] = t.custom[k].toUpperCase();
      for (const k of ['panelAlpha', 'radius', 'glow']) if (Number.isFinite(Number(t.custom[k]))) custom[k] = Number(t.custom[k]);
      if (FONT_STACK[t.custom.font]) custom.font = t.custom.font;
      if ('uppercase' in t.custom) custom.uppercase = t.custom.uppercase === true || t.custom.uppercase === 'true';
      css = customToCss(id, custom);
    }
    if (t.css) {
      if (String(t.css).length > MAX_CSS) throw new Error('CSS troppo lungo (max 200 KB)');
      css += '\n' + sanitizeCss(t.css);
    }
    if (!css.includes(`[data-theme="${id}"]`) && !css.includes(`[data-theme='${id}']`)) {
      throw new Error(`Il CSS non contiene [data-theme="${id}"]: il tema non si vedrebbe`);
    }
    const file = { livegfx: 'theme', version: 1, id, name, ...(custom ? { custom } : {}), css: custom && !t.css ? undefined : sanitizeCss(t.css || '') || undefined };
    const stored = { ...file, builtCss: css };
    fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify(stored, null, 2));
    return { id, name, editable: !!custom };
  }

  function remove(id) {
    const f = path.join(dir, String(id).replace(/[^a-z0-9-]/g, '') + '.json');
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }

  // File da scaricare (senza il CSS già calcolato, che si rigenera all'importazione)
  function exportJson(id) {
    const t = readAll().find((x) => x.id === id);
    if (!t) return null;
    const { builtCss, ...rest } = t;
    return rest;
  }

  return {
    list: () => readAll().map((t) => ({ id: t.id, name: t.name, editable: !!t.custom, ...(t.custom ? { custom: t.custom } : {}) })),
    bundleCss: () => readAll().map((t) => `/* ===== Tema importato: ${String(t.name).replace(/\*\//g, '')} ===== */\n${t.builtCss || ''}`).join('\n\n'),
    save, remove, exportJson, BUILTIN,
  };
}

module.exports = { createThemes, customToCss, sanitizeCss };
