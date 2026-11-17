// Connessione condivisa da tutte le grafiche: riceve lo stato in tempo reale dal server.
(function () {
  const params = new URLSearchParams(location.search);
  if (params.get('bg') === '1') document.body.classList.add('preview-bg');
  const off = document.createElement('div');
  off.id = 'gfx-offline'; off.textContent = 'Server non raggiungibile — riconnessione…';
  document.body.appendChild(off);

  const listeners = [];
  const msgListeners = {};   // altri messaggi (es. 'subs' per i sottotitoli)
  let prev = null;
  let offset = 0;          // differenza tra orologio del server e di questo browser
  let retry = 500;

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => { retry = 500; document.body.classList.remove('offline'); };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.t !== 'state') { for (const fn of msgListeners[msg.t] || []) fn(msg); return; }
      offset = msg.serverNow - Date.now();
      const st = msg.state;
      if (params.get('theme')) st.theme = params.get('theme');
      document.documentElement.dataset.theme = st.theme;
      applyCustomTheme(st.theme === 'custom' ? st.customTheme : null);
      loadUserThemes(st.userThemesRev);
      for (const fn of listeners) {
        try { fn(st, prev); } catch (e) { console.error(e); }
      }
      prev = st;
    };
    ws.onclose = () => {
      // Se il server cade, le grafiche restano come sono e si riconnettono da sole.
      document.body.classList.add('offline');
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, 5000);
    };
  }

  // Temi importati dal pannello: un unico foglio di stile servito dal server, ricaricato quando cambia
  let userThemesRev = null;
  function loadUserThemes(rev) {
    if (rev === userThemesRev) return;
    userThemesRev = rev;
    let link = document.getElementById('lg-user-themes');
    if (!link) {
      link = document.createElement('link');
      link.id = 'lg-user-themes'; link.rel = 'stylesheet';
      document.head.appendChild(link);   // in fondo: vince sui temi inclusi
    }
    link.href = '/themes/user.css?v=' + (rev || 0);
  }

  // Tema personalizzato: i valori scelti nel pannello diventano variabili CSS
  const FONT_STACK = {
    inter: "'Inter', system-ui, sans-serif", chakra: "'Chakra Petch', 'Inter', sans-serif",
    playfair: "'Playfair Display', Georgia, serif", pixel: "'Press Start 2P', monospace", vt323: "'VT323', monospace",
  };
  let lastCustom = '';
  function rgba(hex, a) {
    const n = parseInt(String(hex).slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
  function applyCustomTheme(c) {
    const key = c ? JSON.stringify(c) : '';
    if (key === lastCustom) return;
    lastCustom = key;
    const st = document.documentElement.style;
    const props = ['--accent', '--accent-2', '--accent-3', '--panel', '--panel-2', '--text', '--text-dim', '--text-on-accent',
      '--radius', '--font-display', '--font-body', '--glow', '--accent-glow', '--accent2-glow', '--accent2-edge', '--line',
      '--yellow', '--green', '--cyan', '--display-case'];
    if (!c) { props.forEach((p) => st.removeProperty(p)); return; }
    const g = Number(c.glow) || 0;
    const set = {
      '--accent': c.accent, '--accent-2': c.accent2, '--accent-3': c.accent3,
      '--yellow': c.accent, '--cyan': c.accent2, '--green': c.accent3,
      '--panel': rgba(c.panel, c.panelAlpha), '--panel-2': rgba(c.panel, Math.min(1, c.panelAlpha + 0.08)),
      '--text': c.text, '--text-dim': rgba(c.text, 0.65), '--text-on-accent': c.textOnAccent, '--line': rgba(c.text, 0.12),
      '--radius': c.radius + 'px', '--font-display': FONT_STACK[c.font] || FONT_STACK.inter,
      '--font-body': c.font === 'pixel' ? FONT_STACK.inter : (c.font === 'vt323' ? FONT_STACK.vt323 : FONT_STACK.inter),
      '--glow': g, '--accent-glow': rgba(c.accent, 0.75 * g), '--accent2-glow': rgba(c.accent2, 0.5 * g),
      '--accent2-edge': rgba(c.accent2, 0.25 + 0.4 * g), '--display-case': c.uppercase ? 'uppercase' : 'none',
    };
    for (const [k, v] of Object.entries(set)) st.setProperty(k, v);
  }

  window.LiveGFX = {
    onMessage(type, fn) { (msgListeners[type] = msgListeners[type] || []).push(fn); },
    onState(fn) { listeners.push(fn); if (prev) fn(prev, null); },
    serverNow() { return Date.now() + offset; },
    // Utility condivise
    esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); },
    splitChars(el, text) {
      el.innerHTML = '';
      for (const word of String(text).split(/(\s+)/)) {
        if (/^\s+$/.test(word)) { el.appendChild(document.createTextNode(' ')); continue; }
        const w = document.createElement('span');
        w.style.display = 'inline-block'; w.style.whiteSpace = 'nowrap';
        for (const ch of word) {
          const c = document.createElement('span');
          c.className = 'ch'; c.style.display = 'inline-block'; c.textContent = ch;
          w.appendChild(c);
        }
        el.appendChild(w);
      }
      return el.querySelectorAll('.ch');
    },
    // clip-path con gli angoli arrotondati del tema (serve al tema glass)
    clip(inset, el) {
      const r = getComputedStyle(el || document.documentElement).getPropertyValue('--radius').trim() || '0px';
      return inset.replace(/\)$/, ` round ${r})`);
    },
    // Rimpicciolisce il testo finché entra nella larghezza disponibile
    fitText(el, maxPx, minPx) {
      let size = maxPx;
      el.style.fontSize = size + 'px';
      while (el.scrollWidth > el.clientWidth && size > minPx) { size -= 2; el.style.fontSize = size + 'px'; }
    },
  };

  connect();
})();
