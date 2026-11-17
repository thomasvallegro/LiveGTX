// Pannello di regia LiveGFX
(function () {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage non disponibile */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* */ } },
  };

  let ws = null, S = null, role = null, offset = 0, msgId = 0, retry = 500, subsConnected = false, info = null, tunnel = { status: 'off', url: '', error: '' };
  let pin = store.get('livegfx.pin');
  const pending = new Map();

  // ---------- Connessione ----------
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => { retry = 500; $('#conn').classList.add('ok'); if (pin) ws.send(JSON.stringify({ t: 'login', pin })); };
    ws.onclose = () => { $('#conn').classList.remove('ok'); setTimeout(connect, retry); retry = Math.min(retry * 2, 5000); };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.t === 'state') { offset = m.serverNow - Date.now(); S = m.state; if (role) render(); }
      else if (m.t === 'subsStatus') { subsConnected = m.connected; if (S && role) renderSubsEngine(); }
      else if (m.t === 'tunnel') { tunnel = m; if (S && role) { renderTunnel(); renderVote(); } }
      else if (m.t === 'login') onLogin(m);
      else if (m.t === 'ack') {
        const p = pending.get(m.id); pending.delete(m.id);
        if (!m.ok) toast(m.error || 'Errore', true);
        p?.(m);
      }
    };
  }

  function onLogin(m) {
    if (!m.ok) {
      store.del('livegfx.pin'); pin = null; role = null;
      $('#loginErr').textContent = 'PIN errato';
      $('#login').hidden = false; $('#app').hidden = true;
      return;
    }
    role = m.role;
    store.set('livegfx.pin', pin);
    document.body.classList.toggle('operator', role === 'operator');
    $('#roleLabel').textContent = role === 'admin' ? 'Regia' : 'Operatore';
    $('#login').hidden = true; $('#app').hidden = false;
    loadInfo();
    if (S) render();
  }

  function send(action) {
    if (!ws || ws.readyState !== 1) { toast('Non connesso al server', true); return Promise.resolve({ ok: false }); }
    const id = ++msgId;
    ws.send(JSON.stringify({ t: 'action', id, action }));
    return new Promise((res) => pending.set(id, res));
  }

  let toastTimer;
  function toast(text, isErr) {
    const t = $('#toast');
    t.textContent = text; t.classList.toggle('error', !!isErr); t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  // ---------- Login ----------
  $('#loginForm').addEventListener('submit', (e) => {
    e.preventDefault();
    pin = $('#pin').value.trim();
    $('#loginErr').textContent = '';
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'login', pin }));
  });
  $('#logoutBtn').addEventListener('click', () => { store.del('livegfx.pin'); location.reload(); });
  if (pin) { $('#login').hidden = true; }

  // ---------- Tab ----------
  function showTab(name) {
    $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    $$('.tab').forEach((t) => { t.hidden = t.dataset.panel !== name; });
    store.set('livegfx.tab', name);
  }
  $('#tabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) showTab(b.dataset.tab); });
  showTab(store.get('livegfx.tab') || 'lb');

  // ---------- Anteprima ----------
  function sizePreview() {
    const box = $('.preview-inner'); const f = $('#previewFrame');
    f.style.transform = `scale(${box.clientWidth / 1920})`;
  }
  $('#previewBtn').addEventListener('click', () => {
    const w = $('#previewWrap');
    w.hidden = !w.hidden;
    if (!w.hidden) { if (!$('#previewFrame').src) $('#previewFrame').src = '/gfx/overlay.html'; sizePreview(); }
  });
  window.addEventListener('resize', sizePreview);

  // ---------- Pulsanti generici: data-a="tipo.azione" + data-* come parametri ----------
  document.addEventListener('click', async (e) => {
    const toggle = e.target.closest('[data-toggle]');
    if (toggle) { const on = S?.[toggle.dataset.toggle]?.visible; send({ type: on ? toggle.dataset.off : toggle.dataset.on }); return; }
    const b = e.target.closest('[data-a]');
    if (!b) return;
    e.preventDefault();
    if (b.dataset.confirm && !confirm(b.dataset.confirm)) return;
    const action = { type: b.dataset.a };
    for (const [k, v] of Object.entries(b.dataset)) {
      if (k === 'a' || k === 'confirm') continue;
      action[k] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
    }
    if (action.type === 'lb.edit') return editEntry(action.id);
    if (action.type === 'lt.edit') return editGuest(action.id);
    if (action.type === 'sb.edit') return editTeam(action.id);
    if (action.type === 'sb.set') return setTeamScore(action.id);
    send(action);
  });

  // Campi di configurazione: data-cfg="tipo.azione:campo"
  function sendCfg(el) {
    const [type, field] = el.dataset.cfg.split(':');
    const isNum = el.type === 'number' || el.type === 'range';
    if (el.type === 'number' && el.value === '') return;
    send({ type, [field]: isNum ? Number(el.value) : el.value });
  }
  document.addEventListener('change', (e) => { const el = e.target.closest('[data-cfg]'); if (el) sendCfg(el); });
  // cursori e selettori colore: aggiornamento dal vivo mentre trascini (max ~8 al secondo)
  let liveT = 0, liveTimer = null;
  document.addEventListener('input', (e) => {
    const el = e.target.closest('[data-cfg]');
    if (!el || !(el.type === 'range' || el.type === 'color')) return;
    const out = el.closest('label')?.querySelector('output'); if (out) out.textContent = el.value;
    clearTimeout(liveTimer);
    const wait = Math.max(0, 120 - (Date.now() - liveT));
    liveTimer = setTimeout(() => { liveT = Date.now(); sendCfg(el); }, wait);
  });

  // ---------- Form ----------
  function formData(form) { return Object.fromEntries(new FormData(form)); }

  $$('form[data-form]').forEach((form) => form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(form);
    if ('score' in d) d.score = Number(d.score) || 0;
    const r = await send({ type: form.dataset.form, ...d });
    if (r.ok) { form.reset(); form.querySelector('input')?.focus(); }
  }));

  $('#ltForm').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-submit]');
    if (!b) return;
    e.preventDefault();
    const form = $('#ltForm');
    if (!form.reportValidity()) return;
    const r = await send({ type: b.dataset.submit, ...formData(form) });
    if (r.ok) { form.reset(); toast(b.dataset.submit === 'lt.quick' ? 'In onda!' : 'Aggiunto in coda'); }
  });
  $('#ltForm').addEventListener('submit', (e) => { e.preventDefault(); $('#ltForm [data-submit="lt.queue.add"]').click(); });

  $('#tmForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const d = formData(e.target);
    send({ type: 'timer.config', label: d.label, mode: d.mode, duration: ((Number(d.min) || 0) * 60 + (Number(d.sec) || 0)) * 1000 || 60000 });
    toast('Timer impostato');
  });

  $('#tkForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(e.target);
    const r = await send({ type: 'tk.set', items: d.items.split('\n'), label: d.label, speed: Number(d.speed) });
    if (r.ok) toast('Ticker aggiornato');
  });
  $('#tkForm [name=speed]').addEventListener('input', (e) => { $('#tkSpeedOut').textContent = e.target.value; });

  function recentAnnouncements() { try { return JSON.parse(store.get('livegfx.recentAn') || '[]'); } catch { return []; } }
  $('#anForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(e.target);
    const r = await send({ type: 'an.show', ...d });
    if (r.ok) {
      const list = [d, ...recentAnnouncements().filter((x) => x.title !== d.title)].slice(0, 8);
      store.set('livegfx.recentAn', JSON.stringify(list));
      renderRecent();
    }
  });
  function renderRecent() {
    const list = recentAnnouncements();
    $('#anRecent').innerHTML = list.length ? list.map((a, i) => `<div class="item"><div></div>
      <div><div class="name">${esc(a.title)}</div><div class="sub">${esc([a.kicker, a.subtitle].filter(Boolean).join(' · '))}</div></div>
      <button class="btn sm admin-only" data-recent="${i}">Mostra</button></div>`).join('') : '<div class="empty">Nessun annuncio recente</div>';
  }
  $('#anRecent').addEventListener('click', (e) => {
    const b = e.target.closest('[data-recent]'); if (!b) return;
    send({ type: 'an.show', ...recentAnnouncements()[Number(b.dataset.recent)] });
  });
  renderRecent();

  // ---------- Finestre di modifica ----------
  function dialog(title, fields) {
    $('#editTitle').textContent = title;
    $('#editFields').innerHTML = fields.map((f) => f.options
      ? `<label>${f.label}<select name="${f.name}">${f.options.map((o) => `<option value="${o[0]}" ${o[0] === f.value ? 'selected' : ''}>${o[1]}</option>`).join('')}</select></label>`
      : `<label>${f.label}<input name="${f.name}" type="${f.type || 'text'}" value="${esc(f.value)}" ${f.type === 'number' ? 'inputmode="numeric"' : ''}></label>`).join('');
    const dlg = $('#editDlg');
    dlg.showModal();
    $('#editFields input')?.select();
    return new Promise((res) => {
      dlg.addEventListener('close', () => res(dlg.returnValue === 'ok' ? formData($('#editForm')) : null), { once: true });
    });
  }
  async function editEntry(id) {
    const en = S.leaderboard.entries.find((x) => x.id === id); if (!en) return;
    const d = await dialog('Modifica partecipante', [
      { name: 'name', label: 'Nome', value: en.name }, { name: 'sub', label: 'Dettaglio', value: en.sub },
      { name: 'score', label: 'Punti', type: 'number', value: en.score }]);
    if (d) send({ type: 'lb.update', id, ...d, score: Number(d.score) });
  }
  async function editGuest(id) {
    const g = S.lowerthird.queue.find((x) => x.id === id); if (!g) return;
    const d = await dialog('Modifica ospite', [
      { name: 'name', label: 'Nome', value: g.name }, { name: 'role', label: 'Ruolo', value: g.role }, { name: 'tag', label: 'Etichetta', value: g.tag }]);
    if (d) send({ type: 'lt.queue.update', id, ...d });
  }
  const COLORS = [['yellow', 'Giallo'], ['green', 'Verde'], ['cyan', 'Azzurro'], ['magenta', 'Magenta'], ['orange', 'Arancione'], ['white', 'Bianco']];
  async function editTeam(id) {
    const t = S.scoreboard.teams.find((x) => x.id === id); if (!t) return;
    const fields = [{ name: 'name', label: 'Nome squadra', value: t.name }];
    if (role === 'admin') fields.push({ name: 'color', label: 'Colore', value: t.color, options: COLORS });
    const d = await dialog('Modifica squadra', fields);
    if (d) send({ type: 'sb.team.update', id, ...d });
  }
  async function setTeamScore(id) {
    const t = S.scoreboard.teams.find((x) => x.id === id); if (!t) return;
    const d = await dialog('Imposta punteggio', [{ name: 'score', label: t.name, type: 'number', value: t.score }]);
    if (d) send({ type: 'sb.team.update', id, score: Number(d.score) });
  }

  // ---------- Rendering ----------
  function setCfgInputs() {
    for (const el of $$('[data-cfg]')) {
      if (document.activeElement === el) continue;
      const [type, field] = el.dataset.cfg.split(':');
      const v = {
        'lb.config:title': S.leaderboard.title, 'lb.config:subtitle': S.leaderboard.subtitle, 'lb.config:unit': S.leaderboard.unit,
        'lb.config:maxRows': S.leaderboard.maxRows, 'lb.config:order': S.leaderboard.order,
        'lt.position:value': S.lowerthird.position, 'sb.config:title': S.scoreboard.title, 'theme.set:value': S.theme,
        'vote.config:reveal': S.vote.reveal, 'vote.config:showQr': String(S.vote.showQr), 'vote.config:maxVoters': S.vote.maxVoters,
        'vote.config:joinUrl': S.vote.joinUrl, 'wheel.config:title': S.wheel.title,
        'subs.config:position': S.subtitles.position, 'subs.config:words': S.subtitles.words, 'subs.config:size': S.subtitles.size,
        'subs.config:hideAfter': S.subtitles.hideAfter, 'subs.config:highlight': S.subtitles.highlight,
        'clock.config:label': S.clock.label, 'clock.config:position': S.clock.position,
        'clock.config:seconds': String(S.clock.seconds), 'clock.config:date': String(S.clock.date),
        ...(type === 'bg.set' ? { [type + ':' + field]: S.background[field] } : {}),
        'cover.config:title': S.cover.title, 'cover.config:subtitle': S.cover.subtitle, 'cover.config:look': S.cover.look,
        'cover.config:transition': S.cover.transition, 'cover.config:showLogo': String(S.cover.showLogo),
        ...(type === 'theme.custom' ? { [type + ':' + field]: field === 'uppercase' ? String(S.customTheme.uppercase) : S.customTheme[field] } : {}),
      }[type + ':' + field];
      if (v !== undefined) {
        el.value = typeof v === 'string' && el.type === 'color' ? v.toLowerCase() : v;
        const out = el.closest('label')?.querySelector('output'); if (out && el.type === 'range') out.textContent = v;
      }
    }
  }

  function fillFormOnce(form, values) {
    // Riempie i form solo se l'utente non ci sta scrivendo
    if (form.contains(document.activeElement)) return;
    for (const [k, v] of Object.entries(values)) { const el = form.elements[k]; if (el) el.value = v; }
  }

  let lastTkKey = '', lastTmKey = '';
  function render() {
    // stato "in onda"
    for (const b of $$('[data-toggle]')) b.classList.toggle('on', !!S[b.dataset.toggle].visible);
    for (const d of $$('[data-dot]')) d.classList.toggle('on', !!S[d.dataset.dot].visible);
    setCfgInputs();

    // Classifica
    const lb = S.leaderboard;
    const sorted = [...lb.entries].sort((a, b) => lb.order === 'asc' ? a.score - b.score : b.score - a.score);
    let rank = 0;
    $('#lbList').innerHTML = sorted.length ? sorted.map((e, i) => {
      if (i === 0 || e.score !== sorted[i - 1].score) rank = i + 1;
      const hiddenOnAir = i >= lb.maxRows ? ' <span class="sub">(fuori schermo)</span>' : '';
      return `<div class="item">
        <div class="rank r${rank}">${rank}</div>
        <div><div class="name">${esc(e.name)}${hiddenOnAir}</div>${e.sub ? `<div class="sub">${esc(e.sub)}</div>` : ''}</div>
        <div class="score num">${e.score}</div>
        <div class="actions">
          <button class="btn sm" data-a="lb.score" data-id="${e.id}" data-delta="-1">−1</button>
          <button class="btn sm" data-a="lb.score" data-id="${e.id}" data-delta="1">+1</button>
          <button class="btn sm" data-a="lb.score" data-id="${e.id}" data-delta="5">+5</button>
          <button class="btn sm" data-a="lb.score" data-id="${e.id}" data-delta="10">+10</button>
          <span class="spacer"></span>
          <button class="btn sm" data-a="lb.edit" data-id="${e.id}">✎</button>
          <button class="btn sm danger" data-a="lb.remove" data-id="${e.id}" data-confirm="Eliminare ${esc(e.name)}?">✕</button>
        </div></div>`;
    }).join('') : '<div class="empty">Nessun partecipante. Aggiungine uno qui sopra.</div>';

    // Ospiti
    const L = S.lowerthird;
    const cur = $('#ltCurrent');
    cur.classList.toggle('on', L.visible && !!L.current);
    cur.innerHTML = L.current
      ? `<div class="sub">${L.visible ? '● IN ONDA' : 'Ultimo mostrato (nascosto)'}</div><div class="big-name">${esc(L.current.name)}</div><div class="sub">${esc([L.current.tag, L.current.role].filter(Boolean).join(' · '))}</div>`
      : '<div class="sub">Nessun ospite in onda</div>';
    $('#ltQueue').innerHTML = L.queue.length ? L.queue.map((g) => `<div class="item"><div>🎤</div>
      <div><div class="name">${esc(g.name)}</div><div class="sub">${esc([g.tag, g.role].filter(Boolean).join(' · '))}</div></div>
      <button class="btn primary sm admin-only" data-a="lt.take" data-id="${g.id}">▶ In onda</button>
      <div class="actions"><span class="spacer"></span>
        <button class="btn sm" data-a="lt.edit" data-id="${g.id}">✎</button>
        <button class="btn sm danger" data-a="lt.queue.remove" data-id="${g.id}">✕</button></div></div>`).join('')
      : '<div class="empty">Coda vuota</div>';

    // Squadre
    const colorVar = { yellow: '#FFE14D', green: '#3DFFA0', cyan: '#36D6FF', magenta: '#FF4FD8', orange: '#FF9A3C', white: '#F4F7FF' };
    $('#sbTeams').innerHTML = S.scoreboard.teams.map((t) => `<div class="team" style="--c:${colorVar[t.color]}">
      <div class="tname">${esc(t.name)}</div>
      <div class="tscore num">${t.score}</div>
      <div class="row-btns score-btns">
        <button class="btn" data-a="sb.score" data-id="${t.id}" data-delta="-1">−1</button>
        <button class="btn primary" data-a="sb.score" data-id="${t.id}" data-delta="1">+1</button>
        <button class="btn" data-a="sb.score" data-id="${t.id}" data-delta="2">+2</button>
        <button class="btn" data-a="sb.score" data-id="${t.id}" data-delta="3">+3</button>
      </div>
      <div class="row-btns" style="margin-top:8px">
        <button class="btn sm" data-a="sb.set" data-id="${t.id}">Imposta</button>
        <button class="btn sm" data-a="sb.edit" data-id="${t.id}">✎</button>
        ${S.scoreboard.teams.length > 2 ? `<button class="btn sm danger admin-only" data-a="sb.team.remove" data-id="${t.id}" data-confirm="Rimuovere ${esc(t.name)}?">✕</button>` : ''}
      </div></div>`).join('');

    renderBg();
    renderUserThemes();
    renderTunnel();
    renderVote();
    renderWheel();
    renderSubsEngine();

    // Timer (form)
    const T = S.timer;
    const tmKey = [T.label, T.mode, T.duration].join('|');
    if (tmKey !== lastTmKey) {
      lastTmKey = tmKey;
      fillFormOnce($('#tmForm'), { label: T.label, mode: T.mode, min: Math.floor(T.duration / 60000), sec: Math.floor(T.duration / 1000) % 60 });
    }

    // Ticker (form)
    const K = S.ticker;
    const tkKey = JSON.stringify([K.items, K.label, K.speed]);
    if (tkKey !== lastTkKey) {
      lastTkKey = tkKey;
      fillFormOnce($('#tkForm'), { items: K.items.join('\n'), label: K.label, speed: K.speed });
      $('#tkSpeedOut').textContent = K.speed;
    }
  }

  // ---------- Televoto ----------
  const VCOL = { yellow: '#FFE14D', green: '#3DFFA0', cyan: '#36D6FF', magenta: '#FF4FD8', orange: '#FF9A3C', white: '#F4F7FF' };
  function joinUrl() {
    if (S.vote.joinUrl) return S.vote.joinUrl;
    if (tunnel.status === 'online' && tunnel.url) return tunnel.url;
    const lan = info && (info.addresses.find((a) => !a.tailscale) || info.addresses[0]);
    return lan ? `http://${lan.ip}:${info.port}/v` : `${location.origin}/v`;
  }
  let lastQr = '';
  function renderVote() {
    const v = S.vote;
    const total = v.options.reduce((a, o) => a + o.count, 0);
    const st = v.revealed ? ['rev', 'Risultati rivelati'] : v.open ? ['open', v.mode === 'hands' ? 'Aperta · alzata di mano' : 'Aperta · si vota col telefono'] : [v.closedAt ? '' : '', v.closedAt ? 'Chiusa' : 'Pronta, non ancora aperta'];
    const hands = v.mode === 'hands';
    $('#vtLive').innerHTML = !v.options.length ? '<div class="empty">Nessuna votazione preparata. Compila il modulo qui sotto.</div>'
      : `<div class="vt-state ${st[0]}">${st[1]}</div>
        <div class="vt-q">${esc(v.question)}</div>
        <div class="sub" style="color:var(--dim);font-size:13px;margin-bottom:6px">${total} voti${hands ? '' : ` · ${v.voters}/${v.maxVoters} telefoni`}${v.reveal === 'final' && !v.revealed ? ' · in onda i risultati sono nascosti' : ''}</div>
        ${v.options.map((o, i) => {
          const pct = total ? Math.round((o.count / total) * 100) : 0;
          return `<div class="vt-opt" style="--c:${VCOL[o.color]}"><div><b>${'ABCDEF'[i]}</b> · ${esc(o.text)}</div><div class="n num">${o.count} <small style="color:var(--dim);font-size:14px">${pct}%</small></div>
            <div class="bar"><i style="width:${pct}%"></i></div>
            ${hands ? `<div class="hands"><button class="btn sm" data-a="vote.hands" data-id="${o.id}" data-delta="-1">−1</button>
              <button class="btn sm primary" data-a="vote.hands" data-id="${o.id}" data-delta="1">+1</button>
              <button class="btn sm" data-a="vote.hands" data-id="${o.id}" data-delta="5">+5</button>
              <button class="btn sm" data-id="${o.id}" data-ask="${esc(o.text)}">Imposta</button></div>` : ''}</div>`;
        }).join('')}`;
    // QR e indirizzo per il pubblico
    const url = joinUrl();
    if (url !== lastQr && window.qrcode) {
      lastQr = url;
      const q = qrcode(0, 'M'); q.addData(url); q.make();
      $('#vtQrPanel').innerHTML = `<div class="qr">${q.createSvgTag({ cellSize: 4, margin: 0, scalable: true })}</div><div class="u"><b>Pagina di voto</b><br>${esc(url)}<br><span style="color:var(--dim)">Provala anche dal tuo telefono prima dell'evento.</span></div>`;
    }
  }
  function fillJoinSelect() {
    const sel = $('#vtJoin');
    const opts = [['', 'Automatico (online se attivo, altrimenti rete locale)']];
    for (const a of info.addresses) opts.push([`http://${a.ip}:${info.port}/v`, `${a.tailscale ? 'Tailscale' : 'Rete'} ${a.name}: ${a.ip}`]);
    sel.innerHTML = opts.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('');
    if (S) sel.value = S.vote.joinUrl;
  }
  $('#vtForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(e.target);
    if (S.vote.open && !confirm('C\'è una votazione aperta: prepararne una nuova la chiude e azzera i voti. Continuare?')) return;
    const r = await send({ type: 'vote.setup', question: d.question, mode: d.mode, options: d.options.split('\n') });
    if (r.ok) toast('Votazione pronta: ora premi "Apri votazione"');
  });
  function fillOptions(names) { $('#vtForm [name=options]').value = names.slice(0, 6).join('\n'); }
  $('#vtFromTeams').addEventListener('click', () => fillOptions(S.scoreboard.teams.map((t) => t.name)));
  $('#vtFromLb').addEventListener('click', () => fillOptions([...S.leaderboard.entries].sort((a, b) => b.score - a.score).map((x) => x.name)));
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-ask]'); if (!b) return;
    e.stopImmediatePropagation();
    const o = S.vote.options.find((x) => x.id === b.dataset.id); if (!o) return;
    const d = await dialog('Imposta voti', [{ name: 'value', label: b.dataset.ask, type: 'number', value: o.count }]);
    if (d) send({ type: 'vote.handsSet', id: o.id, value: Number(d.value) });
  }, true);

  function renderTunnel() {
    const t = tunnel;
    const el = $('#tnStatus');
    const txt = {
      off: ['Spento', 'Vota solo chi è sulla stessa rete del Mac.'],
      download: ['Scarico cloudflared…', 'Solo la prima volta, circa 20 MB.'],
      starting: ['Avvio in corso…', t.error || 'Di solito servono 5–15 secondi.'],
      online: ['Online', t.url],
      error: ['Errore', t.error],
    }[t.status] || ['?', ''];
    el.classList.toggle('ok', t.status === 'online');
    el.innerHTML = `<span class="led" style="${t.status === 'starting' || t.status === 'download' ? 'background:var(--yellow);box-shadow:0 0 8px var(--yellow)' : ''}"></span><div>${esc(txt[0])}<small>${esc(txt[1])}</small></div>`;
    $('#tnStart').hidden = t.status === 'online' || t.status === 'starting' || t.status === 'download';
    $('#tnStop').hidden = t.status === 'off' || t.status === 'error';
  }

  // ---------- Temi: salva, esporta, importa ----------
  function slug(name) {
    return String(name).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'tema';
  }
  function renderUserThemes() {
    const list = S.userThemes || [];
    const grp = $('#userThemeOpts');
    const html = list.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
    if (grp.dataset.h !== html) {
      const sel = grp.parentElement;
      grp.innerHTML = html; grp.dataset.h = html; grp.hidden = !list.length;
      if (document.activeElement !== sel) sel.value = S.theme;
    }
    $('#userThemesList').innerHTML = list.length ? list.map((t) => `<div class="item preset-item">
      <div><div class="name">${esc(t.name)}${S.theme === t.id ? ' <span style="color:var(--green)">● attivo</span>' : ''}</div>
      <div class="sub">${t.editable ? 'creato con l\'editor' : 'CSS'} · <code>${esc(t.id)}</code></div></div>
      <button class="btn sm" data-a="theme.set" data-value="${esc(t.id)}">Usa</button>
      ${t.editable ? `<button class="btn sm" data-a="theme.editUser" data-id="${esc(t.id)}" title="Carica i suoi valori nell'editor del Personalizzato">Modifica</button>` : ''}
      <a class="btn sm" href="/api/themes/${encodeURIComponent(t.id)}.json" download title="Scarica il file del tema">📤</a>
      <button class="btn sm danger" data-a="theme.userDelete" data-id="${esc(t.id)}" data-confirm="Eliminare il tema ${esc(t.name)}?">✕</button></div>`).join('')
      : '<div class="empty">Nessun tema salvato. Crea un Personalizzato e salvalo, oppure importane uno.</div>';
  }
  async function askThemeName(title) {
    const d = await dialog(title, [{ name: 'name', label: 'Nome del tema (es. Vaporwave)', value: '' }]);
    if (!d || !d.name.trim()) return null;
    const name = d.name.trim().slice(0, 40);
    let id = slug(name);
    if (['glass', 'neon', 'clean', 'cinema', 'oldgame', 'glitch', 'custom'].includes(id)) id += '-mio';
    if (id.length < 2) id = 'tema-' + id;
    return { name, id };
  }
  function themeFile(meta) {
    const { accent, accent2, accent3, panel, panelAlpha, text, textOnAccent, radius, font, glow, uppercase } = S.customTheme;
    return { livegfx: 'theme', version: 1, id: meta.id, name: meta.name,
      custom: { accent, accent2, accent3, panel, panelAlpha, text, textOnAccent, radius, font, glow, uppercase } };
  }
  async function uploadTheme(body) {
    try {
      const r = await fetch('/api/themes', { method: 'POST', headers: { 'X-Pin': pin, 'Content-Type': 'text/plain; charset=utf-8' }, body });
      const d = await r.json();
      toast(d.ok ? `Tema "${d.theme.name}" pronto: lo trovi in Tema grafico` : d.error, !d.ok);
      return d;
    } catch { toast('Importazione non riuscita', true); return { ok: false }; }
  }
  $('#customSave').addEventListener('click', async () => {
    const meta = await askThemeName('Salva tra i miei temi');
    if (!meta) return;
    if ((S.userThemes || []).some((t) => t.id === meta.id) && !confirm(`Esiste già un tema "${meta.id}": sostituirlo?`)) return;
    const d = await uploadTheme(JSON.stringify(themeFile(meta)));
    if (d.ok) send({ type: 'theme.set', value: meta.id });
  });
  $('#customExport').addEventListener('click', async () => {
    const meta = await askThemeName('Esporta come file');
    if (!meta) return;
    const blob = new Blob([JSON.stringify(themeFile(meta), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `${meta.id}.livegfx-theme.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });
  $('#themeImport').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    if (f.size > 300 * 1024) { e.target.value = ''; return toast('File troppo grande per un tema', true); }
    const text = await f.text();
    let id = null;
    try { id = text.trim().startsWith('{') ? JSON.parse(text).id : (/\[data-theme\s*=\s*["']([a-z0-9-]+)["']\]/i.exec(text) || [])[1]; } catch { /* lo dirà il server */ }
    if (id && (S.userThemes || []).some((t) => t.id === id) && !confirm(`Esiste già un tema "${id}": sostituirlo?`)) { e.target.value = ''; return; }
    await uploadTheme(text);
    e.target.value = '';
  });

  // ---------- Sfondi ----------
  const STYLE_NAMES = { fluid: 'Fluido', scroll: 'Scorrimento', aurora: 'Aurora', waves: 'Onde', bokeh: 'Bokeh' };
  const COLOR_HINT = {
    fluid: 'ogni colore è una macchia', scroll: 'dal primo all\'ultimo, avanti e indietro',
    aurora: 'il primo è il cielo, gli altri le bande di luce', waves: 'il primo è il fondo, gli altri le onde dal fondo in avanti',
    bokeh: 'i primi due fanno il fondo, gli altri i cerchi',
  };
  function renderBg() {
    const B = S.background;
    for (const b of $$('#bgStyles [data-style]')) b.classList.toggle('active', b.dataset.style === B.style);
    $('#bgColorHint').textContent = '· ' + (COLOR_HINT[B.style] || '');
    // i selettori colore si ricreano solo se cambia il numero (così non si chiudono mentre li usi)
    const box = $('#bgColors');
    const inputs = $$('#bgColors input[type=color]');
    if (inputs.length !== B.colors.length) {
      box.innerHTML = B.colors.map((c, i) => `<span class="sw"><input type="color" data-ci="${i}" value="${c.toLowerCase()}">${B.colors.length > 2 ? `<button class="x" data-cdel="${i}" title="Togli">✕</button>` : ''}</span>`).join('')
        + (B.colors.length < 5 ? '<button class="btn add" id="bgAddColor" title="Aggiungi colore">+</button>' : '');
    } else {
      inputs.forEach((el, i) => { if (document.activeElement !== el && el.value !== B.colors[i].toLowerCase()) el.value = B.colors[i].toLowerCase(); });
    }
    $('#bgPresets').innerHTML = S.bgPresets.length ? S.bgPresets.map((p) => `<div class="item preset-item"><span class="bgsw">${p.bg.colors.map((c) => `<i style="background:${c}"></i>`).join('')}</span>
      <div><div class="name">${esc(p.name)}</div><div class="sub">${STYLE_NAMES[p.bg.style] || p.bg.style}</div></div>
      <button class="btn sm" data-a="bg.presetLoad" data-id="${p.id}">Usa</button>
      <button class="btn sm danger" data-a="bg.presetDelete" data-id="${p.id}" data-confirm="Eliminare il preset ${esc(p.name)}?">✕</button></div>`).join('')
      : '<div class="empty">Nessun preset salvato.</div>';
    const look = $('#coverLook');
    const opts = [['bg', 'Come lo sfondo attuale'], ...S.bgPresets.map((p) => [p.id, 'Preset: ' + p.name])];
    const html = opts.map(([v, t]) => `<option value="${v}">${esc(t)}</option>`).join('');
    if (look.dataset.h !== html) { look.innerHTML = html; look.dataset.h = html; }
    if (document.activeElement !== look) look.value = S.cover.look;
    $('#coverLogoPrev').innerHTML = S.cover.logo ? `<img src="${esc(S.cover.logo)}" alt="Logo">` : '';
    const prev = $('#bgPrev');
    if (!prev.src && !$('[data-panel="bg"]').hidden) prev.src = '/gfx/background.html?fps=24';
  }
  let colorT = null;
  $('#bgColors').addEventListener('input', (e) => {
    const el = e.target.closest('[data-ci]'); if (!el) return;
    clearTimeout(colorT);
    colorT = setTimeout(() => {
      const colors = $$('#bgColors input[type=color]').map((x) => x.value);
      send({ type: 'bg.set', colors });
    }, 90);
  });
  $('#bgColors').addEventListener('click', (e) => {
    const del = e.target.closest('[data-cdel]');
    if (del) { const colors = S.background.colors.filter((_, i) => i !== Number(del.dataset.cdel)); return send({ type: 'bg.set', colors }); }
    if (e.target.closest('#bgAddColor')) {
      const c = S.background.colors;
      send({ type: 'bg.set', colors: [...c, c[c.length - 1]] });
    }
  });
  $('#bgPresetForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = formData(e.target).name.trim();
    if (S.bgPresets.some((p) => p.name.toLowerCase() === name.toLowerCase()) && !confirm(`Esiste già "${name}": aggiornarlo con lo sfondo attuale?`)) return;
    const r = await send({ type: 'bg.presetSave', name });
    if (r.ok) { e.target.reset(); toast('Preset salvato'); }
  });
  $('#coverLogoFile').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    if (f.size > 5e6) { e.target.value = ''; return toast('File troppo grande (max 5 MB)', true); }
    try {
      const r = await fetch('/api/upload/logo', { method: 'POST', headers: { 'X-Pin': pin, 'Content-Type': f.type }, body: f });
      const d = await r.json();
      toast(d.ok ? 'Logo caricato' : d.error, !d.ok);
    } catch { toast('Caricamento non riuscito', true); }
    e.target.value = '';
  });
  // l'anteprima parte solo quando apri la scheda (non consuma se non la guardi)
  document.addEventListener('click', (e) => {
    const t = e.target.closest('#tabs [data-tab]'); if (!t) return;
    const prev = $('#bgPrev');
    if (t.dataset.tab === 'bg') { if (!prev.src) prev.src = '/gfx/background.html?fps=24'; }
    else if (prev.src) prev.removeAttribute('src');
  });

  // ---------- Ruota ----------
  function renderWheel() {
    const W = S.wheel;
    const sp = W.spin;
    const running = sp && Date.now() + offset < sp.at + sp.duration;
    $('#whResult').innerHTML = !sp ? `<div class="sub" style="color:var(--dim)">${W.items.length} spicchi. Premi "Gira!" per estrarre.</div>`
      : running ? '<div class="wh-win">La ruota gira…</div>'
      : `<div class="sub" style="color:var(--dim)">Estratto</div><div class="wh-win">${esc(sp.text)}</div>`;
    if (W.history.length) $('#whResult').innerHTML += `<div class="wh-hist">Ultimi: ${W.history.slice(0, 6).map((h) => esc(h.text)).join(' · ')}</div>`;
    if (running) setTimeout(() => S && renderWheel(), sp.at + sp.duration - (Date.now() + offset) + 50);
    $('#whRemove').disabled = !sp || running;
    $('#whSpin').disabled = !!running || W.items.length < 2;
    $('#whList').innerHTML = W.items.length ? W.items.map((x, i) => `<div class="item${sp && !running && sp.itemId === x.id ? ' winner' : ''}"><div class="rank">${i + 1}</div>
      <div><div class="name">${esc(x.text)}</div></div>
      <button class="btn sm danger" data-a="wheel.remove" data-id="${x.id}">✕</button></div>`).join('')
      : '<div class="empty">Ruota vuota. Aggiungi almeno 2 spicchi.</div>';
  }
  $('#whForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const items = formData(e.target).items.split('\n').map((x) => x.trim()).filter(Boolean);
    if (!items.length) return;
    const r = await send({ type: 'wheel.add', items });
    if (r.ok) { e.target.reset(); toast(`Aggiunti ${items.length}`); }
  });
  $('#whDur').addEventListener('input', (e) => { $('#whDurOut').textContent = e.target.value; store.set('livegfx.whDur', e.target.value); });
  if (store.get('livegfx.whDur')) { $('#whDur').value = store.get('livegfx.whDur'); $('#whDurOut').textContent = $('#whDur').value; }
  $('#whSpin').addEventListener('click', () => send({ type: 'wheel.spin', duration: Number($('#whDur').value) * 1000 }));

  // ---------- Sottotitoli ----------
  function renderSubsEngine() {
    const el = $('#stEngine');
    el.classList.toggle('ok', subsConnected);
    el.innerHTML = `<span class="led"></span><div>${subsConnected ? 'Programma dei sottotitoli collegato' : 'Programma dei sottotitoli non avviato'}
      <small>${subsConnected ? (S.subtitles.paused ? 'In pausa: niente testo a schermo né in trascrizione' : 'Sta ascoltando il microfono') : 'Doppio clic su sottotitoli/start.command (sullo stesso Mac di LiveGFX)'}</small></div>`;
    $('#stPause').textContent = S.subtitles.paused ? '▶ Riprendi' : '⏸ Pausa';
    $('#stPause').classList.toggle('primary', S.subtitles.paused);
  }
  $('#stPause').addEventListener('click', () => send({ type: S.subtitles.paused ? 'subs.resume' : 'subs.pause' }));

  // Display del timer aggiornato in continuo
  function fmt(ms, up) {
    const total = Math.max(0, up ? Math.floor(ms / 1000) : Math.ceil(ms / 1000));
    const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    return (h ? h + ':' : '') + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }
  setInterval(() => {
    if (!S) return;
    const T = S.timer;
    const el = T.elapsedBefore + (T.running ? Date.now() + offset - T.startedAt : 0);
    const left = T.duration - el;
    $('#tmDisplay').textContent = T.mode === 'countdown' ? fmt(left) : fmt(el, true);
    $('#tmDisplay').classList.toggle('warn', T.mode === 'countdown' && left <= 10000);
    const d = new Date(Date.now() + offset);
    $('#ckDisplay').textContent = [d.getHours(), d.getMinutes(), ...(S.clock.seconds ? [d.getSeconds()] : [])].map((n) => String(n).padStart(2, '0')).join(':');
  }, 200);

  // ---------- Impostazioni: indirizzi ----------
  async function loadInfo() {
    const base = `${location.protocol}//${location.host}`;
    const gfx = [['Overlay unico (tutte)', 'overlay'], ['Classifica', 'leaderboard'], ['Ospiti', 'lowerthird'], ['Squadre', 'scoreboard'],
      ['Timer', 'timer'], ['Ticker', 'ticker'], ['Annuncio', 'announce'], ['Televoto', 'vote'], ['Ruota', 'wheel'],
      ['Sottotitoli', 'subtitles'], ['Orologio', 'clock']];
    const obsBase = `http://localhost:${location.port || 80}`;
    $('#gfxLinks').innerHTML = gfx.map(([n, f]) => `<div class="link"><b>${n}</b><span>${obsBase}/gfx/${f}.html</span></div>`).join('')
      + `<div class="sub" style="color:var(--dim);font-size:13px;margin-top:6px">Usa "localhost" se OBS è sullo stesso Mac del server. Aggiungi <code>?bg=1</code> per provarle nel browser con uno sfondo.</div>`;
    try {
      info = await (await fetch('/api/info')).json();
      subsConnected = info.subsConnected;
      if (info.tunnel) tunnel = info.tunnel;
      fillJoinSelect(); lastQr = ''; if (S) render();
      $('#addrList').innerHTML = info.addresses.map((a) => `<div class="link"><b>${a.tailscale ? 'Tailscale' : 'Rete locale'} (${esc(a.name)})</b><span>http://${a.ip}:${info.port}/</span></div>`).join('')
        || '<div class="empty">Nessuna rete trovata</div>';
    } catch { $('#addrList').textContent = base; }
  }

  connect();
})();
