/* LiveGFX — motore degli sfondi animati (WebGL: lavora la scheda grafica, non il processore).
   Uso:  const bg = BGRender.create(elementoContenitore, { fps: 30 });
         bg.set({ style, colors: ['#RRGGBB', ...], speed, intensity, angle, brightness, grain });
   I cambi di colore e dei cursori sono morbidi; il cambio di stile fa una dissolvenza. */
(function () {
  'use strict';
  const STYLE_ID = { fluid: 0, scroll: 1, aurora: 2, waves: 3, bokeh: 4 };

  const VERT = 'attribute vec2 a; void main(){ gl_Position = vec4(a, 0.0, 1.0); }';
  const FRAG = `
precision highp float;
uniform vec2 uRes; uniform float uTime; uniform vec3 uC[5]; uniform float uN;
uniform float uInt; uniform float uAng; uniform float uBri; uniform float uGrain; uniform int uStyle;

float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float hash1(float n){ return fract(sin(n * 127.1) * 43758.5453); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p){ float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.03 + 17.1; a *= 0.5; } return v; }

// colore lungo la tavolozza (t da 0 a 1, dal primo all'ultimo colore)
vec3 pal(float t){
  float x = clamp(t, 0.0, 1.0) * (uN - 1.0);
  vec3 c = uC[0];
  for (int i = 0; i < 4; i++) { if (float(i) >= uN - 1.0) break; c = mix(c, uC[i + 1], clamp(x - float(i), 0.0, 1.0)); }
  return c;
}

void main(){
  vec2 uv = gl_FragCoord.xy / uRes;
  float asp = uRes.x / uRes.y;
  vec2 p = (uv - 0.5) * vec2(asp, 1.0);
  float ca = cos(uAng), sa = sin(uAng);
  p = mat2(ca, -sa, sa, ca) * p;
  float t = uTime;
  vec3 col;

  if (uStyle == 0) {            // FLUIDO: macchie di colore che si mescolano
    vec2 q = p + (0.15 + 0.45 * uInt) * vec2(fbm(p * 1.4 + vec2(t * 0.21, 0.0)), fbm(p * 1.4 + vec2(5.2, -t * 0.19))) - 0.2;
    vec3 sum = uC[0] * 0.02; float ws = 0.02;
    for (int i = 0; i < 5; i++) {
      if (float(i) >= uN) break;
      float fi = float(i);
      vec2 c = vec2(sin(t * (0.31 + 0.07 * fi) + fi * 2.1) * asp * 0.42, cos(t * (0.27 + 0.05 * fi) + fi * 1.3) * 0.42);
      float d = length(q - c);
      float w = exp(-d * d * (2.0 + 4.0 * uInt));
      sum += uC[i] * w; ws += w;
    }
    col = sum / ws;
  } else if (uStyle == 1) {     // SCORRIMENTO: gradiente lineare che scorre
    float x = p.x * (0.35 + 0.9 * uInt) + t * 0.08 + 0.18 * fbm(p * 1.8 + t * 0.07);
    float tri = 1.0 - abs(2.0 * fract(x) - 1.0);
    col = pal(smoothstep(0.0, 1.0, tri));
  } else if (uStyle == 2) {     // AURORA: bande di luce ondulate su fondo scuro
    col = uC[0] * (0.75 + 0.35 * uv.y);
    for (int i = 1; i < 5; i++) {
      if (float(i) >= uN) break;
      float fi = float(i);
      float yc = 0.13 * sin(p.x * 1.6 + t * 0.35 + fi * 1.7) + 0.22 * (fbm(vec2(p.x * 1.1 + t * 0.09, fi * 3.7)) - 0.5)
               + (fi - 1.0) * 0.15 - 0.12;
      float d = p.y - yc;
      float k = d > 0.0 ? (5.0 - 2.5 * uInt) : (55.0 - 25.0 * uInt);   // coda morbida verso l'alto, bordo netto in basso
      float band = exp(-d * d * k * 6.0);
      float rays = 0.65 + 0.35 * noise(vec2(p.x * 22.0 + fi * 9.0, t * 0.25 + fi));
      col += uC[i] * band * rays * (0.32 + 0.4 * uInt);
    }
  } else if (uStyle == 3) {     // ONDE: strati sovrapposti che ondeggiano
    col = mix(uC[0] * 0.85, uC[0], uv.y);
    float amp = 0.025 + 0.07 * uInt;
    for (int i = 1; i < 5; i++) {
      if (float(i) >= uN) break;
      float fi = float(i);
      float base = 0.22 - (fi - 1.0) / max(uN - 1.0, 1.0) * 0.55;
      float f = 2.2 + fi * 0.9;
      float y = base + amp * sin(p.x * f + t * (0.45 + 0.12 * fi) + fi * 1.7) + amp * 0.45 * sin(p.x * f * 2.3 - t * 0.38 + fi * 4.1);
      float m = smoothstep(y + 0.003, y - 0.003, p.y);
      vec3 lc = uC[i] * (1.0 + 0.35 * clamp((p.y - y) * 3.0 + 0.3, -0.3, 0.3));
      col *= 1.0 - 0.28 * exp(-max(p.y - y, 0.0) * 28.0) * (1.0 - m);     // ombra sopra la cresta
      col = mix(col, lc, m);
    }
  } else {                      // BOKEH: cerchi sfocati che salgono
    col = mix(uC[0], pal(0.35) * 0.55, uv.y);
    for (int k = 0; k < 34; k++) {
      float fk = float(k);
      float h1 = hash1(fk + 1.3), h2 = hash1(fk + 7.1), h3 = hash1(fk + 3.7), h4 = hash1(fk + 11.9), h5 = hash1(fk + 5.5);
      vec2 c = vec2((fract(h1 + t * 0.006 * (h3 - 0.5)) - 0.5) * asp * 1.25, fract(h2 + t * 0.022 * (0.4 + h3)) * 1.4 - 0.7);
      c.x += 0.03 * sin(t * 0.4 + fk);
      float r = 0.03 + 0.1 * h4 * (0.6 + 0.8 * uInt);
      float d = length(p - c);
      float a = smoothstep(r, r * 0.72, d) * (0.25 + 0.4 * h5) + 0.14 * smoothstep(r * 0.06, 0.0, abs(d - r * 0.86)) * h5;
      vec3 bc = pal(0.3 + 0.7 * fract(h5 * 3.1 + 0.2));
      col = 1.0 - (1.0 - col) * (1.0 - bc * a);
    }
  }

  col *= uBri;
  vec2 v = uv - 0.5; col *= 1.0 - 0.22 * dot(v, v) * 2.0;           // vignettatura leggera
  float g = hash(gl_FragCoord.xy + fract(uTime * 13.37) * 311.0) - 0.5;  // grana: evita le "scalette" in streaming
  col += g * uGrain * 0.085;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

  function hexToRgb(h) {
    const n = parseInt(String(h).slice(1), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }

  function makeLayer(container, style) {
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;opacity:0;transition:opacity 1.2s ease;display:block';
    container.appendChild(canvas);
    const gl = canvas.getContext('webgl', { antialias: false, alpha: false, preserveDrawingBuffer: false, powerPreference: 'low-power' });
    if (!gl) return null;
    const sh = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'a');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const u = {};
    for (const n of ['uRes', 'uTime', 'uC', 'uN', 'uInt', 'uAng', 'uBri', 'uGrain', 'uStyle']) u[n] = gl.getUniformLocation(prog, n);
    return { canvas, gl, u, style };
  }

  function create(container, opts = {}) {
    const fpsCap = opts.fps || 30;
    const scale = opts.scale || 1;
    let layers = [];
    let target = null, cur = null, time = 0, last = 0, raf = 0, lastDraw = 0;

    function addLayer(style) {
      const L = makeLayer(container, style);
      if (!L) { container.style.background = target ? target.colors[0] : '#000'; return; }
      layers.push(L);
      resize();
      requestAnimationFrame(() => { L.canvas.style.opacity = '1'; });
      // dopo la dissolvenza, i livelli vecchi si liberano
      setTimeout(() => {
        while (layers.length > 1 && layers[0] !== L) {
          const old = layers.shift();
          const ext = old.gl.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext();
          old.canvas.remove();
        }
      }, 1400);
    }

    function resize() {
      const w = Math.round((container.clientWidth || 1920) * scale), h = Math.round((container.clientHeight || 1080) * scale);
      for (const L of layers) if (L.canvas.width !== w || L.canvas.height !== h) { L.canvas.width = w; L.canvas.height = h; L.gl.viewport(0, 0, w, h); }
    }
    window.addEventListener('resize', resize);

    function toInternal(p) {
      const cols = p.colors.slice(0, 5).map(hexToRgb);
      while (cols.length < 5) cols.push(cols[cols.length - 1]);
      return {
        colors: cols, n: Math.min(5, p.colors.length), speed: p.speed, intensity: p.intensity,
        angle: (p.angle * Math.PI) / 180, brightness: p.brightness, grain: p.grain,
      };
    }

    let paused = false;
    function step(now) {
      if (paused) { raf = 0; return; }
      raf = requestAnimationFrame(step);
      if (now - lastDraw < 1000 / fpsCap - 2) return;
      const dt = Math.min(0.1, (now - (last || now)) / 1000);
      last = now; lastDraw = now;
      if (!cur || !layers.length) return;
      // avvicina dolcemente i valori correnti a quelli richiesti
      const k = 1 - Math.pow(0.02, dt);   // ~1 s per arrivare
      for (let i = 0; i < 5; i++) for (let j = 0; j < 3; j++) cur.colors[i][j] += (target.colors[i][j] - cur.colors[i][j]) * k;
      for (const key of ['speed', 'intensity', 'brightness', 'grain']) cur[key] += (target[key] - cur[key]) * k;
      let da = target.angle - cur.angle; da = Math.atan2(Math.sin(da), Math.cos(da)); cur.angle += da * k;
      cur.n = target.n;
      time += dt * (0.05 + cur.speed * 1.6);
      for (const L of layers) {
        const { gl, u } = L;
        gl.uniform2f(u.uRes, L.canvas.width, L.canvas.height);
        gl.uniform1f(u.uTime, time);
        gl.uniform3fv(u.uC, cur.colors.flat());
        gl.uniform1f(u.uN, cur.n);
        gl.uniform1f(u.uInt, cur.intensity);
        gl.uniform1f(u.uAng, cur.angle);
        gl.uniform1f(u.uBri, cur.brightness);
        gl.uniform1f(u.uGrain, cur.grain);
        gl.uniform1i(u.uStyle, STYLE_ID[L.style] ?? 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
    }

    return {
      set(p) {
        const first = !target;
        target = toInternal(p);
        if (first) cur = JSON.parse(JSON.stringify(target));
        const top = layers[layers.length - 1];
        if (!top || top.style !== p.style) addLayer(p.style);
        if (!raf && !paused) raf = requestAnimationFrame(step);
      },
      pause() { paused = true; },
      resume() { if (paused) { paused = false; last = 0; if (!raf && target) raf = requestAnimationFrame(step); } },
      // per lo screenshot di prova: avanza il tempo senza aspettare
      _advance(s) { time += s; },
    };
  }

  window.BGRender = { create };
})();
