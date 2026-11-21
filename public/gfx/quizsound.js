/* LiveGFX · suoni del quiz, sintetizzati con Web Audio (nessun file audio, nessuna licenza).
   Il "set" di suoni segue il tema grafico attivo. Un tema può sceglierlo con
   la variabile CSS  --qz-sound: classic | arcade | cinema | digital | news | fun
   In OBS: Proprietà della Browser Source → "Controlla l'audio tramite OBS". */
(function () {
  const muteUrl = new URLSearchParams(location.search).get('mute') === '1';
  let ctx = null, master = null, verb = null, volume = 0.8, muted = false, mul = 1;
  // livellamento: i set e gli eventi escono a volume simile (misurato con un render offline)
  const PAL_GAIN = { classic: 1, arcade: 3, cinema: 0.75, digital: 2.2, news: 1.4, fun: 1.8 };
  const EV_GAIN = { in: 4, tick: 7, fifty: 1.5 };

  // Tema → set di suoni (per i temi che non dichiarano --qz-sound)
  const BY_THEME = {
    glass: 'classic', clean: 'news', custom: 'classic', quizshow: 'classic', gala: 'cinema',
    cinema: 'cinema', cinemamuto: 'cinema', horror: 'cinema', marmo: 'cinema', tempesta: 'cinema', spy: 'cinema', survival: 'cinema',
    oldgame: 'arcade', rpg: 'arcade', insegna: 'arcade',
    glitch: 'digital', neon: 'digital', techno: 'digital', esports: 'digital', olografico: 'digital', spazio: 'digital', aurora: 'digital', vaporwave: 'digital',
    telegiornale: 'news', breaking: 'news', talkshow: 'news', assemblea: 'news', reality: 'news', typewriter: 'news',
    fumetto: 'fun', televendita: 'fun', origami: 'fun', legno: 'fun', hiphop: 'fun',
  };
  function setName() {
    const css = getComputedStyle(document.documentElement).getPropertyValue('--qz-sound').trim().replace(/['"]/g, '');
    if (PALETTES[css]) return css;
    const t = document.documentElement.dataset.theme || '';
    for (const k of Object.keys(BY_THEME)) if (t === k || t.includes(k)) return BY_THEME[k];
    return 'classic';
  }

  function init() {
    if (ctx || muteUrl) return !!ctx;
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return false;
    ctx = new AC();
    master = ctx.createGain(); master.gain.value = muted ? 0 : volume;
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 4;
    master.connect(comp).connect(ctx.destination);
    // riverbero generato (rumore che decade)
    verb = ctx.createConvolver();
    const len = ctx.sampleRate * 2.2, buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3); }
    verb.buffer = buf;
    const vg = ctx.createGain(); vg.gain.value = 0.35; verb.connect(vg).connect(master);
    return true;
  }
  const T = () => ctx.currentTime;

  // ---------- mattoncini ----------
  function env(g, t, a, peak, d, rel) {
    peak = Math.min(1.2, peak * mul);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak * 0.4), t + a + d);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d + rel);
  }
  function tone(f, o = {}) {
    const t = T() + (o.at || 0), dur = o.dur || 0.3;
    const osc = ctx.createOscillator(); osc.type = o.type || 'sine'; osc.frequency.setValueAtTime(f, t);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t + (o.slide || dur));
    if (o.detune) osc.detune.value = o.detune;
    const g = ctx.createGain(); env(g, t, o.a || 0.005, o.vol || 0.3, dur * 0.4, dur * 0.6 + (o.rel || 0.05));
    let node = osc;
    if (o.lp) { const f2 = ctx.createBiquadFilter(); f2.type = 'lowpass'; f2.frequency.value = o.lp; f2.Q.value = o.q || 0.7; node.connect(f2); node = f2; }
    node.connect(g); g.connect(master); if (o.wet) { const w = ctx.createGain(); w.gain.value = o.wet; g.connect(w).connect(verb); }
    osc.start(t); osc.stop(t + dur + (o.rel || 0.05) + 0.1);
  }
  function noise(o = {}) {
    const t = T() + (o.at || 0), dur = o.dur || 0.2;
    const len = Math.ceil(ctx.sampleRate * (dur + 0.1)), buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource(); src.buffer = buf;
    const f = ctx.createBiquadFilter(); f.type = o.ft || 'lowpass'; f.frequency.setValueAtTime(o.f || 2000, t);
    if (o.fto) f.frequency.exponentialRampToValueAtTime(o.fto, t + dur);
    f.Q.value = o.q || 0.8;
    const g = ctx.createGain(); env(g, t, o.a || 0.003, o.vol || 0.3, dur * 0.3, dur * 0.7);
    src.connect(f).connect(g).connect(master); if (o.wet) { const w = ctx.createGain(); w.gain.value = o.wet; g.connect(w).connect(verb); }
    src.start(t); src.stop(t + dur + 0.1);
  }
  const chord = (fs, o) => fs.forEach((f, i) => tone(f, { ...o, at: (o.at || 0) + (o.spread || 0) * i }));
  const arp = (fs, step, o) => fs.forEach((f, i) => tone(f, { ...o, at: (o.at || 0) + step * i }));
  const boom = (o = {}) => { tone(o.f || 60, { type: 'sine', to: 32, slide: 0.5, dur: o.dur || 0.9, vol: o.vol || 0.9, wet: o.wet || 0.3, at: o.at }); noise({ f: 900, fto: 80, dur: 0.35, vol: 0.35, wet: 0.4, at: o.at }); };
  const N = (n) => 440 * Math.pow(2, (n - 69) / 12);   // nota MIDI → Hz

  // ---------- i sei set ----------
  const PALETTES = {
    classic: {
      in: () => noise({ ft: 'bandpass', f: 400, fto: 3500, dur: 0.5, vol: 0.18, q: 1.5, wet: 0.3 }),
      lit: () => { boom({ f: 70, vol: 0.8 }); chord([N(45), N(52), N(57)], { type: 'sawtooth', lp: 900, dur: 0.9, vol: 0.09, wet: 0.5 }); },
      pulse: (k) => { tone(N(33), { type: 'sine', dur: 0.18, vol: 0.55 }); tone(N(33), { type: 'sine', dur: 0.14, vol: 0.4, at: 0.2 }); tone(N(57 + (k % 4)), { type: 'triangle', dur: 0.4, vol: 0.05 + Math.min(k, 8) * 0.01, lp: 1500 }); },
      pulseEvery: 0.9,
      correct: () => { boom({ f: 80, vol: 0.6 }); arp([N(60), N(64), N(67), N(72), N(76)], 0.07, { type: 'sawtooth', lp: 3200, dur: 0.6, vol: 0.12, wet: 0.5 }); chord([N(72), N(76), N(79), N(84)], { type: 'triangle', dur: 1.6, vol: 0.12, at: 0.35, wet: 0.6 }); },
      wrong: () => { boom({ f: 55, vol: 0.8 }); chord([N(40), N(41), N(46)], { type: 'sawtooth', lp: 700, to: undefined, dur: 1.2, vol: 0.13, wet: 0.4 }); tone(N(52), { type: 'sawtooth', to: N(40), slide: 0.9, dur: 1, vol: 0.1, lp: 1200 }); },
      tick: (last) => tone(last ? 1600 : 1100, { type: 'square', dur: 0.03, vol: 0.12, lp: 4000 }),
      timeup: () => { chord([N(41), N(42)], { type: 'square', lp: 1100, dur: 0.9, vol: 0.14 }); },
      fifty: () => { noise({ ft: 'highpass', f: 1500, fto: 6000, dur: 0.4, vol: 0.2 }); arp([N(76), N(71)], 0.12, { type: 'triangle', dur: 0.25, vol: 0.18 }); },
      final: () => { boom({ f: 50, vol: 1, dur: 1.4, wet: 0.6 }); chord([N(36), N(43), N(48), N(55)], { type: 'sawtooth', lp: 600, a: 1.2, dur: 2.6, vol: 0.12, wet: 0.6 }); noise({ ft: 'bandpass', f: 300, fto: 5000, a: 1.5, dur: 2.2, vol: 0.12, q: 2, wet: 0.5 }); boom({ f: 60, vol: 0.9, at: 2.4, wet: 0.6 }); },
    },
    arcade: {
      in: () => arp([N(72), N(76), N(79)], 0.05, { type: 'square', dur: 0.08, vol: 0.12 }),
      lit: () => { tone(N(48), { type: 'square', dur: 0.12, vol: 0.2 }); tone(N(60), { type: 'square', dur: 0.2, vol: 0.15, at: 0.08 }); },
      pulse: (k) => tone(N(48 + (k % 2) * 7 + Math.floor(k / 2)), { type: 'square', dur: 0.08, vol: 0.12 }),
      pulseEvery: 0.45,
      correct: () => arp([N(72), N(76), N(79), N(84), N(88), N(91)], 0.07, { type: 'square', dur: 0.12, vol: 0.13 }),
      wrong: () => { tone(N(55), { type: 'square', to: N(31), slide: 0.7, dur: 0.75, vol: 0.18 }); tone(N(54), { type: 'square', to: N(30), slide: 0.7, dur: 0.75, vol: 0.12, detune: 30 }); },
      tick: (last) => tone(last ? N(88) : N(84), { type: 'square', dur: 0.03, vol: 0.1 }),
      timeup: () => arp([N(64), N(60), N(55), N(48)], 0.12, { type: 'square', dur: 0.14, vol: 0.15 }),
      fifty: () => { tone(N(84), { type: 'square', to: N(60), slide: 0.25, dur: 0.25, vol: 0.13 }); tone(N(84), { type: 'square', to: N(60), slide: 0.25, dur: 0.25, vol: 0.13, at: 0.25 }); },
      final: () => { arp([N(48), N(55), N(60), N(64), N(67), N(72)], 0.11, { type: 'square', dur: 0.14, vol: 0.13 }); arp([N(72), N(72), N(79)], 0.18, { type: 'square', dur: 0.35, vol: 0.15, at: 0.9 }); noise({ f: 4000, dur: 0.3, vol: 0.15, at: 1.6 }); },
    },
    cinema: {
      in: () => { noise({ ft: 'bandpass', f: 200, fto: 1800, dur: 0.9, vol: 0.18, q: 1, wet: 0.6 }); },
      lit: () => { boom({ f: 48, vol: 1, dur: 1.6, wet: 0.7 }); chord([N(36), N(43)], { type: 'sawtooth', lp: 400, dur: 1.5, vol: 0.12, wet: 0.7 }); },
      pulse: (k) => { boom({ f: 42, vol: 0.5 + Math.min(k, 6) * 0.05, dur: 0.6, wet: 0.5 }); tone(N(60 + k), { type: 'sawtooth', a: 0.4, dur: 1, vol: 0.03 + Math.min(k, 6) * 0.008, lp: 1200, wet: 0.6 }); },
      pulseEvery: 1.2,
      correct: () => { boom({ f: 55, vol: 0.9, wet: 0.7 }); chord([N(48), N(55), N(60), N(64), N(67)], { type: 'sawtooth', lp: 2500, a: 0.05, dur: 2.2, vol: 0.09, wet: 0.8 }); },
      wrong: () => { boom({ f: 40, vol: 1, dur: 1.8, wet: 0.8 }); chord([N(36), N(37), N(43)], { type: 'sawtooth', lp: 500, dur: 2, vol: 0.12, wet: 0.7 }); },
      tick: (last) => noise({ ft: 'bandpass', f: last ? 3000 : 2200, q: 8, dur: 0.05, vol: 0.4 }),
      timeup: () => { boom({ f: 38, vol: 1, dur: 2, wet: 0.8 }); chord([N(30), N(31)], { type: 'sawtooth', lp: 300, dur: 2, vol: 0.15, wet: 0.6 }); },
      fifty: () => { noise({ ft: 'bandpass', f: 600, fto: 4000, dur: 0.7, vol: 0.2, q: 2, wet: 0.6 }); },
      final: () => { boom({ f: 40, vol: 1, dur: 2, wet: 0.8 }); chord([N(36), N(43), N(48)], { type: 'sawtooth', lp: 500, a: 1.5, dur: 3, vol: 0.12, wet: 0.8 }); boom({ f: 45, vol: 1, at: 2.4, dur: 2, wet: 0.8 }); chord([N(48), N(55), N(60), N(64)], { type: 'sawtooth', lp: 2000, at: 2.4, dur: 2, vol: 0.09, wet: 0.8 }); },
    },
    digital: {
      in: () => { tone(200, { type: 'sawtooth', to: 2400, slide: 0.25, dur: 0.25, vol: 0.08, lp: 5000 }); noise({ ft: 'highpass', f: 3000, dur: 0.15, vol: 0.1 }); },
      lit: () => { tone(N(36), { type: 'sawtooth', dur: 0.4, vol: 0.2, lp: 800, q: 8 }); noise({ f: 6000, dur: 0.08, vol: 0.2 }); [0, 0.05, 0.1].forEach((d) => tone(800 + Math.random() * 2000, { type: 'square', dur: 0.03, vol: 0.06, at: d })); },
      pulse: (k) => { tone(N(36), { type: 'sawtooth', dur: 0.15, vol: 0.18, lp: 300 + k * 120, q: 10 }); tone(N(72 + (k % 3) * 2), { type: 'sine', dur: 0.06, vol: 0.08, at: 0.25 }); },
      pulseEvery: 0.5,
      correct: () => { arp([N(67), N(74), N(79), N(86)], 0.06, { type: 'sawtooth', dur: 0.3, vol: 0.09, lp: 4000, wet: 0.3 }); tone(N(91), { type: 'sine', dur: 1, vol: 0.12, at: 0.25, wet: 0.5 }); },
      wrong: () => { for (let i = 0; i < 6; i++) tone(100 + Math.random() * 300, { type: 'square', dur: 0.07, vol: 0.13, at: i * 0.06, lp: 2000 }); tone(N(40), { type: 'sawtooth', to: N(28), slide: 0.6, dur: 0.7, vol: 0.15, lp: 900, at: 0.3 }); },
      tick: (last) => tone(last ? 2400 : 1800, { type: 'sine', dur: 0.025, vol: 0.12 }),
      timeup: () => { for (let i = 0; i < 8; i++) tone(i % 2 ? 300 : 280, { type: 'square', dur: 0.08, vol: 0.12, at: i * 0.09, lp: 1500 }); },
      fifty: () => { tone(3000, { type: 'sine', to: 200, slide: 0.3, dur: 0.3, vol: 0.1 }); noise({ ft: 'highpass', f: 4000, dur: 0.2, vol: 0.1, at: 0.1 }); },
      final: () => { tone(60, { type: 'sawtooth', to: 1200, slide: 2.2, dur: 2.3, vol: 0.12, lp: 3000, q: 6, wet: 0.4 }); noise({ ft: 'bandpass', f: 500, fto: 8000, dur: 2.2, vol: 0.1, q: 3 }); boom({ f: 55, at: 2.3, vol: 0.9 }); arp([N(67), N(74), N(79)], 0.05, { type: 'sawtooth', dur: 0.4, vol: 0.1, lp: 5000, at: 2.3, wet: 0.4 }); },
    },
    news: {
      in: () => noise({ ft: 'bandpass', f: 800, fto: 4000, dur: 0.35, vol: 0.12, q: 1 }),
      lit: () => { tone(N(57), { type: 'sine', dur: 0.6, vol: 0.25, wet: 0.3 }); tone(N(57) * 2.76, { type: 'sine', dur: 0.3, vol: 0.06 }); tone(N(33), { type: 'triangle', dur: 0.4, vol: 0.3 }); },
      pulse: (k) => { tone(N(45), { type: 'triangle', dur: 0.12, vol: 0.3 }); noise({ ft: 'highpass', f: 6000, dur: 0.04, vol: 0.08 + Math.min(k, 6) * 0.01, at: 0.3 }); },
      pulseEvery: 0.6,
      correct: () => arp([N(72), N(79), N(84)], 0.12, { type: 'sine', dur: 0.9, vol: 0.22, wet: 0.4 }),
      wrong: () => { tone(N(52), { type: 'triangle', dur: 0.5, vol: 0.25 }); tone(N(46), { type: 'triangle', dur: 0.8, vol: 0.25, at: 0.25 }); tone(N(34), { type: 'sine', dur: 0.8, vol: 0.3, at: 0.25 }); },
      tick: (last) => tone(last ? 1500 : 1000, { type: 'sine', dur: 0.03, vol: 0.15 }),
      timeup: () => { tone(N(64), { type: 'sine', dur: 0.6, vol: 0.25 }); tone(N(60), { type: 'sine', dur: 0.9, vol: 0.25, at: 0.3 }); },
      fifty: () => arp([N(79), N(74)], 0.1, { type: 'sine', dur: 0.3, vol: 0.2 }),
      final: () => { arp([N(60), N(67), N(72)], 0.2, { type: 'sine', dur: 1.2, vol: 0.22, wet: 0.5 }); boom({ f: 60, vol: 0.7, at: 0.6 }); chord([N(48), N(55), N(60), N(64)], { type: 'triangle', a: 0.8, dur: 2, vol: 0.1, at: 0.9, wet: 0.5 }); tone(N(84), { type: 'sine', dur: 1.2, vol: 0.2, at: 2.4, wet: 0.5 }); },
    },
    fun: {
      in: () => tone(N(60), { type: 'triangle', to: N(84), slide: 0.2, dur: 0.22, vol: 0.15 }),
      lit: () => { tone(N(67), { type: 'sine', dur: 0.25, vol: 0.3 }); tone(N(79), { type: 'sine', dur: 0.2, vol: 0.15, at: 0.04 }); },
      pulse: (k) => tone(N(60 + [0, 4, 7, 4][k % 4]), { type: 'triangle', dur: 0.1, vol: 0.15 }),
      pulseEvery: 0.35,
      correct: () => { arp([N(72), N(76), N(79), N(84)], 0.09, { type: 'sine', dur: 0.25, vol: 0.25 }); arp([N(84), N(88), N(91), N(96)], 0.05, { type: 'sine', dur: 0.2, vol: 0.12, at: 0.4 }); },
      wrong: () => { tone(N(60), { type: 'sawtooth', to: N(48), slide: 0.3, dur: 0.3, vol: 0.12, lp: 1500 }); tone(N(56), { type: 'sawtooth', to: N(44), slide: 0.3, dur: 0.3, vol: 0.12, lp: 1500, at: 0.35 }); tone(N(52), { type: 'sawtooth', to: N(36), slide: 0.8, dur: 0.9, vol: 0.12, lp: 1500, at: 0.7 }); },
      tick: (last) => tone(last ? N(96) : N(91), { type: 'sine', dur: 0.04, vol: 0.15 }),
      timeup: () => tone(N(72), { type: 'triangle', to: N(36), slide: 0.8, dur: 0.9, vol: 0.2 }),
      fifty: () => { tone(N(84), { type: 'sine', to: N(60), slide: 0.15, dur: 0.15, vol: 0.2 }); tone(N(84), { type: 'sine', to: N(60), slide: 0.15, dur: 0.15, vol: 0.2, at: 0.18 }); },
      final: () => { arp([N(60), N(62), N(64), N(65), N(67), N(69), N(71), N(72)], 0.1, { type: 'triangle', dur: 0.15, vol: 0.15 }); chord([N(72), N(76), N(79)], { type: 'sine', dur: 1.5, vol: 0.15, at: 0.9, wet: 0.4 }); boom({ f: 70, vol: 0.6, at: 0.9 }); },
    },
  };

  let suspenseTimer = null, pulseK = 0;
  const QS = {
    setVolume(v, m) { volume = Math.max(0, Math.min(1, v)); muted = !!m; if (master) master.gain.setTargetAtTime(muted ? 0 : volume, ctx.currentTime, 0.05); },
    play(ev, arg) {
      if (muteUrl || muted || !init()) return;
      if (ctx.state === 'suspended') ctx.resume();
      const name = setName(), p = PALETTES[name];
      mul = (PAL_GAIN[name] || 1) * (EV_GAIN[ev] || 1);
      try { p[ev] && p[ev](arg); } catch (e) { console.warn('quizsound', ev, e); }
    },
    suspense(on) {   // pulsazione di tensione finché non si rivela
      clearInterval(suspenseTimer); suspenseTimer = null;
      if (!on || muteUrl || muted || !init()) return;
      pulseK = 0;
      const name = setName(), p = PALETTES[name];
      const step = () => { if (!muted) { mul = PAL_GAIN[name] || 1; try { p.pulse(pulseK++); } catch {} } };
      suspenseTimer = setInterval(step, p.pulseEvery * 1000);
      setTimeout(step, 350);
    },
    stopAll() { this.suspense(false); },
  };
  window.QuizSound = QS;
})();
