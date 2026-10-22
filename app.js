'use strict';

/* =====================================================================
   XO-4 · Crossover d'àudio (Web Audio API)
   ===================================================================== */

const F_MIN = 20, F_MAX = 20000;
const FFT = 8192;
const SWEEP_SECONDS = 10;
const XO_MIN_RATIO = 1.15;          // separació mínima entre talls consecutius

const BAND_COLORS = ['#ff6b4a', '#ffc23d', '#4ade80', '#38bdf8'];
const BAND_NAMES = {
  2: ['GREUS', 'AGUTS'],
  3: ['GREUS', 'MITJOS', 'AGUTS'],
  4: ['GREUS', 'MITJOS-GREUS', 'MITJOS-AGUTS', 'AGUTS'],
};
const DEFAULT_XO = { 2: [1500], 3: [300, 3000], 4: [120, 800, 4000] };

// Cada filtre és una cascada de biquads de 2n ordre (Q de cada etapa).
// invertHP: als filtres de 2n ordre cal invertir la polaritat de la banda alta perquè sumin bé.
const FILTERS = {
  LR24: { label: 'LR 24 dB/oct', short: 'LR 24', q: [Math.SQRT1_2, Math.SQRT1_2] },
  LR12: { label: 'LR 12 dB/oct', short: 'LR 12', q: [0.5], invertHP: true },
  LR48: { label: 'LR 48 dB/oct', short: 'LR 48', q: [0.5412, 1.3066, 0.5412, 1.3066] },
  BW12: { label: 'BW 12 dB/oct', short: 'BW 12', q: [Math.SQRT1_2], invertHP: true },
  BW24: { label: 'BW 24 dB/oct', short: 'BW 24', q: [0.5412, 1.3066] },
  BS12: { label: 'Bessel 12 dB/oct', short: 'BES 12', q: [0.5773], invertHP: true },
};
const DEFAULT_FILTER = 'LR24';

const SOURCES = [
  ['off', 'OFF'], ['pink', 'ROSA'], ['white', 'BLANC'], ['brown', 'MARRÓ'],
  ['sine', 'SINUS'], ['sweep', 'ESCOMBR.'], ['mic', 'MIC/LÍN.'], ['file', 'FITXER'],
];

/* ---------- utilitats ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const dbToLin = d => Math.pow(10, d / 20);
const fmtHz = f => f >= 1000 ? (f / 1000).toFixed(f >= 10000 ? 1 : 2) + ' kHz' : Math.round(f) + ' Hz';
const fmtHzShort = f => f >= 1000 ? +(f / 1000).toFixed(f >= 10000 ? 0 : 1) + 'k' : Math.round(f) + '';
const fmtDb = d => (d > 0.05 ? '+' : '') + d.toFixed(1) + ' dB';

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

function makeAnalyser(ctx) {
  const a = ctx.createAnalyser();
  a.fftSize = FFT;
  a.smoothingTimeConstant = 0.8;
  a.minDecibels = -140;
  a.maxDecibels = 0;
  return a;
}

const timeBuf = new Float32Array(FFT);
function peakDb(an) {
  an.getFloatTimeDomainData(timeBuf);
  let m = 0;
  for (let i = 0; i < timeBuf.length; i++) {
    const v = Math.abs(timeBuf[i]);
    if (v > m) m = v;
  }
  return 20 * Math.log10(m || 1e-9);
}

// Buffers de soroll en bucle (8 s) amb fos a l'inici perquè l'empalmament no faci clic.
function makeNoise(ctx, type) {
  const sr = ctx.sampleRate, len = sr * 8, xf = Math.floor(sr * 0.05);
  const tmp = new Float32Array(len + xf);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
  for (let i = 0; i < tmp.length; i++) {
    const w = Math.random() * 2 - 1;
    if (type === 'white') tmp[i] = w;
    else if (type === 'pink') { // Paul Kellet (refinat)
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520; b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.0168980;
      tmp[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
      b6 = w * 0.115926;
    } else { // marró (brownian)
      last = (last + 0.02 * w) / 1.02;
      tmp[i] = last;
    }
  }
  for (let i = 0; i < xf; i++) {
    const t = i / xf;
    tmp[i] = tmp[i] * t + tmp[len + i] * (1 - t);
  }
  const buf = ctx.createBuffer(1, len, sr), d = buf.getChannelData(0);
  let s = 0;
  for (let i = 0; i < len; i++) s += tmp[i] * tmp[i];
  const g = 0.2 / Math.sqrt(s / len); // ≈ -14 dBFS RMS
  for (let i = 0; i < len; i++) d[i] = clamp(tmp[i] * g, -1, 1);
  return buf;
}

/* =====================================================================
   Potenciòmetre
   ===================================================================== */
function arcPath(a0, a1, r) {
  const p = a => { const t = a * Math.PI / 180; return [50 + r * Math.sin(t), 50 - r * Math.cos(t)]; };
  const [x0, y0] = p(a0), [x1, y1] = p(a1);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${Math.abs(a1 - a0) > 180 ? 1 : 0} ${a1 > a0 ? 1 : 0} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

class Knob {
  constructor(opts) {
    Object.assign(this, {
      min: 0, max: 1, value: 0, log: false, step: 0, origin: null,
      format: v => v.toFixed(1), color: '#e8ecf2', label: '', size: 'md', onInput: null,
    }, opts);
    if (this.def == null) this.def = this.value;

    const root = this.el = el('div', `knob knob-${this.size}`);
    root.innerHTML = `
      <div class="knob-label">${this.label}</div>
      <svg viewBox="0 0 100 100" tabindex="0" role="slider" aria-label="${this.label}">
        <path class="k-track" d="${arcPath(-135, 135, 44)}"/>
        <path class="k-val"/>
        <circle class="k-body" cx="50" cy="50" r="34"/>
        <circle class="k-cap" cx="50" cy="50" r="27"/>
        <line class="k-ptr" x1="50" y1="46" x2="50" y2="22"/>
      </svg>
      <div class="knob-lcd"></div>`;
    this.svg = $('svg', root);
    this.valPath = $('.k-val', root);
    this.ptr = $('.k-ptr', root);
    this.lcd = $('.knob-lcd', root);
    this.valPath.style.color = this.color;

    let startY = 0, startN = 0;
    this.svg.addEventListener('pointerdown', e => {
      e.preventDefault();
      this.svg.focus();
      this.svg.setPointerCapture(e.pointerId);
      startY = e.clientY;
      startN = this.norm(this.value);
      root.classList.add('active');
    });
    this.svg.addEventListener('pointermove', e => {
      if (!this.svg.hasPointerCapture(e.pointerId)) return;
      this.setNorm(startN + (startY - e.clientY) / (e.shiftKey ? 900 : 220), true);
    });
    this.svg.addEventListener('lostpointercapture', () => root.classList.remove('active'));
    this.svg.addEventListener('wheel', e => {
      e.preventDefault();
      this.setNorm(this.norm(this.value) - Math.sign(e.deltaY) * (e.shiftKey ? 0.002 : 0.012), true);
    }, { passive: false });
    this.svg.addEventListener('dblclick', () => this.set(this.def, true));
    this.svg.addEventListener('keydown', e => {
      const stepN = { ArrowUp: .01, ArrowRight: .01, ArrowDown: -.01, ArrowLeft: -.01, PageUp: .1, PageDown: -.1 }[e.key];
      if (stepN == null) return;
      e.preventDefault();
      this.setNorm(this.norm(this.value) + stepN * (e.shiftKey ? .2 : 1), true);
    });
    this.set(this.value, false);
  }

  norm(v) {
    return this.log ? Math.log(v / this.min) / Math.log(this.max / this.min) : (v - this.min) / (this.max - this.min);
  }
  denorm(n) {
    n = clamp(n, 0, 1);
    let v = this.log ? this.min * Math.pow(this.max / this.min, n) : this.min + n * (this.max - this.min);
    if (this.step) v = Math.round(v / this.step) * this.step;
    return v;
  }
  setNorm(n, fire) { this.set(this.denorm(n), fire); }

  set(v, fire) {
    v = clamp(v, this.min, this.max);
    if (fire && this.onInput) {
      const r = this.onInput(v);
      if (typeof r === 'number') v = r;
    }
    this.value = v;
    this.render();
  }

  render() {
    const n = this.norm(this.value);
    const a = -135 + 270 * n;
    const a0 = this.origin == null ? -135 : -135 + 270 * this.norm(this.origin);
    this.valPath.setAttribute('d', Math.abs(a - a0) > 0.5 ? arcPath(a0, a, 44) : '');
    this.ptr.setAttribute('transform', `rotate(${a.toFixed(2)} 50 50)`);
    this.lcd.textContent = this.format(this.value);
    this.svg.setAttribute('aria-valuetext', this.lcd.textContent);
  }
}

/* =====================================================================
   Vúmetre
   ===================================================================== */
class Meter {
  constructor(tall) {
    this.el = el('div', 'meter' + (tall ? ' tall' : ''), '<div class="m-mask"></div><div class="m-peak"></div>');
    this.mask = $('.m-mask', this.el);
    this.peakEl = $('.m-peak', this.el);
    this.level = 0; this.peak = 0; this.peakT = 0; this.clipT = 0;
  }
  update(db) {
    const now = performance.now();
    const n = clamp((db + 60) / 60, 0, 1);
    this.level = Math.max(n, this.level - 0.018);
    if (n >= this.peak) { this.peak = n; this.peakT = now; }
    else if (now - this.peakT > 1200) this.peak = Math.max(this.level, this.peak - 0.008);
    if (db > -0.3) this.clipT = now;
    this.mask.style.height = ((1 - this.level) * 100).toFixed(1) + '%';
    this.peakEl.style.bottom = `calc(${(this.peak * 100).toFixed(1)}% - 2px)`;
    this.el.classList.toggle('clip', now - this.clipT < 800);
  }
}

/* =====================================================================
   Canal d'entrada (entrada → crossover → fins a 4 sortides)
   ===================================================================== */
class Channel {
  constructor(app, idx) {
    this.app = app;
    this.idx = idx;
    this.letter = 'AB'[idx];
    const ctx = this.ctx = app.ctx;

    this.enabled = idx === 0;
    this.source = 'off';
    this.srcNode = null; this.srcTrim = null; this.stream = null; this.sweepTimer = null;
    this.fileBuffer = null; this.deviceId = '';
    this.level = -12;
    this.sineFreq = 1000;
    this.n = 4;
    this.xo = DEFAULT_XO[4].slice();
    this.xoType = [DEFAULT_FILTER, DEFAULT_FILTER, DEFAULT_FILTER];
    this.bands = [0, 1, 2, 3].map(() => ({ gain: 0, mute: false, solo: false, invert: false, delay: 0 }));
    this.filterRefs = [];
    this.dirty = true;

    // Entrada (mono)
    this.inGain = ctx.createGain();
    this.inGain.channelCount = 1;
    this.inGain.channelCountMode = 'explicit';
    this.inGain.channelInterpretation = 'speakers';
    this.inGain.gain.value = dbToLin(this.level);
    this.inAn = makeAnalyser(ctx);
    this.inGain.connect(this.inAn);

    // Bandes: in → [filtres] → polaritat → retard → guany → (analitzador) → out (mute/solo)
    this.nodes = this.bands.map(() => {
      const nd = {
        in: ctx.createGain(), filters: [], pol: ctx.createGain(), delay: ctx.createDelay(0.05),
        gain: ctx.createGain(), an: makeAnalyser(ctx), out: ctx.createGain(), sign: 1,
      };
      this.inGain.connect(nd.in);
      nd.pol.connect(nd.delay);
      nd.delay.connect(nd.gain);
      nd.gain.connect(nd.an);
      nd.gain.connect(nd.out);
      return nd;
    });

    this.buildUI();
    this.rebuild();
  }

  effType(j) { return this.app.pro ? this.xoType[j] : DEFAULT_FILTER; }
  effSign(i) { return this.nodes[i].sign * (this.app.pro && this.bands[i].invert ? -1 : 1); }
  effDelay(i) { return this.app.pro ? this.bands[i].delay : 0; } // ms

  /* ----- graf de filtres ----- */
  rebuild() {
    const ctx = this.ctx;
    this.filterRefs = [];
    let sign = 1;
    this.nodes.forEach((nd, i) => {
      nd.in.disconnect();
      nd.filters.forEach(f => f.disconnect());
      nd.filters = [];
      if (i >= this.n) return;

      const chain = [];
      if (i > 0) {
        const t = FILTERS[this.effType(i - 1)];
        t.q.forEach(q => chain.push(this.makeBiquad('highpass', i - 1, q)));
        if (t.invertHP) sign = -sign;
      }
      if (i < this.n - 1) {
        const t = FILTERS[this.effType(i)];
        t.q.forEach(q => chain.push(this.makeBiquad('lowpass', i, q)));
      }
      let prev = nd.in;
      chain.forEach(f => { prev.connect(f); prev = f; });
      prev.connect(nd.pol);
      nd.filters = chain;
      nd.sign = sign;
    });
    this.applyBandParams();
    if (this.app.ready) this.app.updateMutes();
    this.dirty = true;
  }

  makeBiquad(type, j, q) {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    // A Web Audio, la Q dels filtres passa-baix/alt s'expressa en dB.
    f.Q.value = 20 * Math.log10(q);
    f.frequency.value = this.xo[j];
    f.xoIndex = j;
    this.filterRefs.push(f);
    return f;
  }

  applyBandParams() {
    const t = this.ctx.currentTime;
    this.nodes.forEach((nd, i) => {
      nd.pol.gain.value = this.effSign(i);
      nd.delay.delayTime.setTargetAtTime(this.effDelay(i) / 1000, t, 0.01);
      nd.gain.gain.setTargetAtTime(dbToLin(this.bands[i].gain), t, 0.01);
    });
    this.dirty = true;
  }

  updateMutes(anySolo) {
    const t = this.ctx.currentTime;
    this.nodes.forEach((nd, i) => {
      const b = this.bands[i];
      const audible = this.enabled && i < this.n && !b.mute && (!anySolo || b.solo);
      nd.out.gain.setTargetAtTime(audible ? 1 : 0, t, 0.008);
      this.ui.bands[i].root.classList.toggle('silenced', !audible);
    });
    this.dirty = true;
    this.updateScreenTitle();
  }

  setXo(j, f, updateKnob = true) {
    const lo = j > 0 ? this.xo[j - 1] * XO_MIN_RATIO : F_MIN;
    const hi = j < this.n - 2 ? this.xo[j + 1] / XO_MIN_RATIO : F_MAX;
    f = clamp(f, lo, hi);
    this.xo[j] = f;
    this.filterRefs.forEach(b => { if (b.xoIndex === j) b.frequency.value = f; });
    if (updateKnob) this.ui.xo[j].knob.set(f, false);
    this.updateRanges();
    this.dirty = true;
    return f;
  }

  setN(n) {
    this.n = n;
    this.xo = DEFAULT_XO[n].slice();
    this.ui.root.style.setProperty('--n', n);
    $$('.n-seg button', this.ui.root).forEach(b => b.classList.toggle('on', +b.dataset.n === n));
    this.ui.xo.forEach((x, j) => {
      x.root.hidden = j >= n - 1;
      if (j < n - 1) x.knob.set(this.xo[j], false);
    });
    this.ui.bands.forEach((b, i) => {
      b.root.hidden = i >= n;
      if (i < n) b.name.textContent = BAND_NAMES[n][i];
    });
    this.updateRanges();
    this.rebuild();
  }

  setEnabled(on) {
    this.enabled = on;
    this.ui.root.hidden = !on;
    if (!on) this.setSource('off');
    this.app.updateMutes();
  }

  /* ----- fonts d'entrada ----- */
  stopSource() {
    if (this.srcNode) {
      try { this.srcNode.stop && this.srcNode.stop(); } catch (e) { /* ja aturat */ }
      this.srcNode.disconnect();
      this.srcNode = null;
    }
    if (this.srcTrim) { this.srcTrim.disconnect(); this.srcTrim = null; }
    clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
  }

  async setSource(type) {
    if (type === 'file' && !this.fileBuffer) { this.ui.fileInput.click(); return; }
    this.stopSource();
    this.source = type;
    this.updateSourceUI();
    const ctx = this.ctx;
    let node = null, trim = 1;

    if (type === 'pink' || type === 'white' || type === 'brown') {
      node = ctx.createBufferSource();
      node.buffer = this.app.noise[type];
      node.loop = true;
      node.start(0, Math.random() * 6);
    } else if (type === 'sine' || type === 'sweep') {
      node = ctx.createOscillator();
      node.frequency.value = type === 'sine' ? this.sineFreq : F_MIN;
      trim = 0.5;
      node.start();
      if (type === 'sweep') {
        const run = () => {
          const t = ctx.currentTime;
          node.frequency.cancelScheduledValues(t);
          node.frequency.setValueAtTime(F_MIN, t);
          node.frequency.exponentialRampToValueAtTime(F_MAX, t + SWEEP_SECONDS);
        };
        run();
        this.sweepTimer = setInterval(run, SWEEP_SECONDS * 1000);
      }
    } else if (type === 'mic') {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: this.deviceId ? { exact: this.deviceId } : undefined,
            echoCancellation: false, noiseSuppression: false, autoGainControl: false,
          },
        });
        if (this.source !== 'mic') { stream.getTracks().forEach(t => t.stop()); return; }
        this.stream = stream;
        node = ctx.createMediaStreamSource(stream);
        this.populateDevices(stream);
      } catch (e) {
        toast(`Entrada ${this.letter}: no s'ha pogut accedir al micròfon / línia`);
        this.source = 'off';
        this.updateSourceUI();
        return;
      }
    } else if (type === 'file') {
      node = ctx.createBufferSource();
      node.buffer = this.fileBuffer;
      node.loop = true;
      node.start();
    }

    if (node) {
      this.srcTrim = ctx.createGain();
      this.srcTrim.gain.value = trim;
      node.connect(this.srcTrim);
      this.srcTrim.connect(this.inGain);
      this.srcNode = node;
      setTimeout(() => { if (this.ctx.state !== 'running') toast('Prem POWER per sentir el senyal'); }, 400);
    }
  }

  async populateDevices(stream) {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput');
    const current = stream.getAudioTracks()[0]?.getSettings().deviceId;
    const sel = this.ui.devSelect;
    sel.innerHTML = devs.map((d, i) =>
      `<option value="${d.deviceId}">${(d.label || 'Entrada ' + (i + 1)).replace(/</g, '&lt;')}</option>`).join('');
    if (current) sel.value = current;
  }

  async loadFile(file) {
    try {
      const data = await file.arrayBuffer();
      this.fileBuffer = await this.ctx.decodeAudioData(data);
      this.ui.fileName.textContent = file.name;
      this.setSource('file');
    } catch (e) {
      toast(`No s'ha pogut descodificar «${file.name}»`);
    }
  }

  /* ----- interfície ----- */
  buildUI() {
    const root = el('section', 'unit channel');
    root.style.setProperty('--n', this.n);
    root.innerHTML = `
      <div class="panel-row">
        <div class="sec sec-input">
          <div class="sec-title"><span class="ch-badge">${this.letter}</span>ENTRADA ${this.letter} · GENERADOR</div>
          <div class="src-grid">${SOURCES.map(([k, l]) => `<button class="src" data-src="${k}">${l}</button>`).join('')}</div>
          <div class="input-row">
            <div class="slot-level"></div>
            <div class="slot-sine"></div>
            <div class="meter-wrap"><div class="slot-inmeter"></div><span>IN</span></div>
          </div>
          <div class="src-extra">
            <select class="lcd-select dev-select" aria-label="Dispositiu d'entrada"><option>Dispositiu per defecte</option></select>
            <div class="file-row">
              <button class="mini file-btn">Carrega fitxer…</button>
              <span class="file-name">Cap fitxer</span>
            </div>
            <input type="file" accept="audio/*" hidden>
          </div>
        </div>

        <div class="sec sec-xover">
          <div class="sec-title">CROSSOVER</div>
          <div class="seg-row">
            <span class="mini-label">SORTIDES PER ENTRADA</span>
            <div class="seg n-seg">
              <button data-n="2">2</button><button data-n="3">3</button><button data-n="4" class="on">4</button>
            </div>
          </div>
          <div class="xo-knobs"></div>
        </div>

        <div class="sec sec-out">
          <div class="sec-title">SORTIDES</div>
          <div class="bands"></div>
        </div>
      </div>

      <div class="screen">
        <div class="screen-bar">
          <span class="scr-title"></span>
          <span class="scr-hint">Arrossega les línies verticals per moure els talls · doble clic als potenciòmetres per restablir</span>
        </div>
        <canvas></canvas>
      </div>`;

    const ui = this.ui = { root, xo: [], bands: [] };

    $$('.src', root).forEach(b => b.addEventListener('click', () => this.setSource(b.dataset.src)));
    $$('.n-seg button', root).forEach(b => b.addEventListener('click', () => this.setN(+b.dataset.n)));

    ui.level = new Knob({
      label: 'NIVELL', min: -60, max: 12, value: this.level, def: -12, format: fmtDb,
      color: 'var(--amber)',
      onInput: v => {
        this.level = v;
        this.inGain.gain.setTargetAtTime(dbToLin(v), this.ctx.currentTime, 0.01);
      },
    });
    $('.slot-level', root).appendChild(ui.level.el);

    ui.sine = new Knob({
      label: 'FREQ. SINUS', min: F_MIN, max: F_MAX, log: true, value: this.sineFreq, def: 1000, format: fmtHz,
      color: 'var(--amber)',
      onInput: v => {
        this.sineFreq = v;
        if (this.source === 'sine' && this.srcNode) this.srcNode.frequency.setTargetAtTime(v, this.ctx.currentTime, 0.01);
      },
    });
    ui.sineSlot = $('.slot-sine', root);
    ui.sineSlot.appendChild(ui.sine.el);

    ui.inMeter = new Meter(false);
    $('.slot-inmeter', root).appendChild(ui.inMeter.el);

    ui.devSelect = $('.dev-select', root);
    ui.devSelect.addEventListener('change', () => {
      this.deviceId = ui.devSelect.value;
      if (this.source === 'mic') this.setSource('mic');
    });
    ui.fileRow = $('.file-row', root);
    ui.fileName = $('.file-name', root);
    ui.fileInput = $('input[type=file]', root);
    $('.file-btn', root).addEventListener('click', () => ui.fileInput.click());
    ui.fileInput.addEventListener('change', () => {
      const f = ui.fileInput.files[0];
      if (f) this.loadFile(f);
      ui.fileInput.value = '';
    });

    // Talls de freqüència
    const xoWrap = $('.xo-knobs', root);
    for (let j = 0; j < 3; j++) {
      const item = el('div', 'xo-item');
      const knob = new Knob({
        label: `TALL ${j + 1}`, min: F_MIN, max: F_MAX, log: true, value: this.xo[j], def: this.xo[j],
        format: fmtHz, size: 'lg', color: '#e8ecf2',
        onInput: v => this.setXo(j, v, false),
      });
      const sel = el('select', 'lcd-select pro-only');
      sel.setAttribute('aria-label', `Tipus de filtre del tall ${j + 1}`);
      sel.innerHTML = Object.entries(FILTERS).map(([k, f]) => `<option value="${k}" title="${f.label}">${f.short}</option>`).join('');
      sel.value = this.xoType[j];
      sel.addEventListener('change', () => { this.xoType[j] = sel.value; this.rebuild(); });
      item.append(knob.el, sel);
      xoWrap.appendChild(item);
      ui.xo.push({ root: item, knob, sel });
    }

    // Bandes de sortida
    const bandsWrap = $('.bands', root);
    this.bands.forEach((b, i) => {
      const strip = el('div', 'band');
      strip.style.setProperty('--c', BAND_COLORS[i]);
      strip.innerHTML = `
        <div class="band-head"><span class="band-name">${BAND_NAMES[4][i]}</span><span class="band-out"></span></div>
        <div class="band-range"></div>
        <div class="band-body">
          <div class="slot-meter"></div>
          <div class="band-knobs"><div class="slot-gain"></div><div class="slot-delay pro-only"></div></div>
        </div>
        <div class="band-btns">
          <button class="btn solo" aria-pressed="false"><i></i>SOLO</button>
          <button class="btn mute" aria-pressed="false"><i></i>MUTE</button>
          <button class="btn inv pro-only" aria-pressed="false" title="Inverteix la polaritat"><i></i>Ø</button>
        </div>`;
      const meter = new Meter(true);
      $('.slot-meter', strip).appendChild(meter.el);
      const gain = new Knob({
        label: 'GUANY', min: -24, max: 12, value: 0, def: 0, origin: 0, step: 0.1, format: fmtDb, size: 'sm',
        color: BAND_COLORS[i],
        onInput: v => { b.gain = v; this.applyBandParams(); },
      });
      $('.slot-gain', strip).appendChild(gain.el);
      const delay = new Knob({
        label: 'RETARD', min: 0, max: 20, value: 0, def: 0, step: 0.01, format: v => v.toFixed(2) + ' ms', size: 'sm',
        color: BAND_COLORS[i],
        onInput: v => { b.delay = v; this.applyBandParams(); },
      });
      $('.slot-delay', strip).appendChild(delay.el);

      const toggle = (btn, key, after) => btn.addEventListener('click', () => {
        b[key] = !b[key];
        btn.classList.toggle('on', b[key]);
        btn.setAttribute('aria-pressed', b[key]);
        after();
      });
      toggle($('.solo', strip), 'solo', () => this.app.updateMutes());
      toggle($('.mute', strip), 'mute', () => this.app.updateMutes());
      toggle($('.inv', strip), 'invert', () => this.applyBandParams());

      bandsWrap.appendChild(strip);
      ui.bands.push({
        root: strip, meter, gain, delay,
        name: $('.band-name', strip), range: $('.band-range', strip), out: $('.band-out', strip),
      });
    });

    ui.scrTitle = $('.scr-title', root);
    this.analyzer = new Analyzer(this, $('canvas', root));
    this.app.rack.appendChild(root);
    root.hidden = !this.enabled;
    this.updateSourceUI();
    this.updateRanges();
  }

  updateSourceUI() {
    $$('.src', this.ui.root).forEach(b => b.classList.toggle('on', b.dataset.src === this.source));
    this.ui.sineSlot.style.visibility = this.source === 'sine' ? 'visible' : 'hidden';
    this.ui.devSelect.hidden = this.source !== 'mic';
    this.ui.fileRow.hidden = this.source !== 'file' && !this.fileBuffer;
  }

  updateRanges() {
    this.ui.bands.forEach((b, i) => {
      if (i >= this.n) return;
      const lo = i > 0 ? this.xo[i - 1] : F_MIN;
      const hi = i < this.n - 1 ? this.xo[i] : F_MAX;
      b.range.textContent = `${fmtHz(lo)} – ${fmtHz(hi)}`;
    });
  }

  soloed() {
    return this.bands.map((b, i) => i).filter(i => i < this.n && this.bands[i].solo);
  }

  updateScreenTitle() {
    const s = this.soloed();
    this.ui.scrTitle.innerHTML = s.length
      ? `ESPECTRE · SOLO <b>${s.map(i => `${BAND_NAMES[this.n][i]} (${this.letter}${i + 1})`).join(' + ')}</b>`
      : `ESPECTRE · <b>ENTRADA ${this.letter}</b>`;
  }

  setOutLabel(i, text) { this.ui.bands[i].out.textContent = text; }

  tick() {
    this.ui.inMeter.update(peakDb(this.inAn));
    for (let i = 0; i < this.n; i++) this.ui.bands[i].meter.update(peakDb(this.nodes[i].an));
    this.analyzer.draw();
  }
}

/* =====================================================================
   Analitzador d'espectre + corbes de resposta del crossover
   ===================================================================== */
const PAD = { l: 34, r: 34, t: 8, b: 18 };
const S_MAX = -20, S_MIN = -120;   // escala de l'espectre (dBFS)
const R_MAX = 12, R_MIN = -48;     // escala de la resposta dels filtres (dB)

class Analyzer {
  constructor(ch, canvas) {
    this.ch = ch;
    this.cv = canvas;
    this.g = canvas.getContext('2d');
    this.W = 0; this.H = 0;
    const L = 360;
    this.freqs = new Float32Array(L);
    for (let k = 0; k < L; k++) this.freqs[k] = F_MIN * Math.pow(F_MAX / F_MIN, k / (L - 1));
    this.tm = new Float32Array(L);
    this.tp = new Float32Array(L);
    this.spec = new Float32Array(FFT / 2);
    this.curves = [];
    this.sum = null;
    this.hoverX = null;
    this.drag = null;

    new ResizeObserver(() => this.resize()).observe(canvas);
    canvas.addEventListener('pointerdown', e => {
      const x = this.localX(e);
      const j = this.nearestXo(x);
      if (j != null) {
        this.drag = j;
        canvas.setPointerCapture(e.pointerId);
        e.preventDefault();
      }
    });
    canvas.addEventListener('pointermove', e => {
      const x = this.localX(e);
      this.hoverX = x;
      if (this.drag != null) ch.setXo(this.drag, this.xf(x));
      canvas.style.cursor = this.drag != null || this.nearestXo(x) != null ? 'ew-resize' : 'crosshair';
    });
    canvas.addEventListener('lostpointercapture', () => { this.drag = null; });
    canvas.addEventListener('pointerleave', () => { this.hoverX = null; });
  }

  localX(e) { return e.clientX - this.cv.getBoundingClientRect().left; }
  nearestXo(x) {
    let best = null, bd = 9;
    for (let j = 0; j < this.ch.n - 1; j++) {
      const d = Math.abs(this.fx(this.ch.xo[j]) - x);
      if (d < bd) { bd = d; best = j; }
    }
    return best;
  }

  resize() {
    const r = this.cv.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.W = r.width; this.H = r.height;
    this.cv.width = Math.round(r.width * dpr);
    this.cv.height = Math.round(r.height * dpr);
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  fx(f) { return PAD.l + (this.W - PAD.l - PAD.r) * Math.log(f / F_MIN) / Math.log(F_MAX / F_MIN); }
  xf(x) { return F_MIN * Math.pow(F_MAX / F_MIN, clamp((x - PAD.l) / (this.W - PAD.l - PAD.r), 0, 1)); }
  ys(db) { return PAD.t + (this.H - PAD.t - PAD.b) * (S_MAX - clamp(db, S_MIN, S_MAX)) / (S_MAX - S_MIN); }
  yr(db) { return PAD.t + (this.H - PAD.t - PAD.b) * (R_MAX - clamp(db, R_MIN - 6, R_MAX)) / (R_MAX - R_MIN); }

  computeCurves() {
    const ch = this.ch, F = this.freqs, L = F.length;
    const re = new Float32Array(L), im = new Float32Array(L);
    this.curves = [];
    for (let i = 0; i < ch.n; i++) {
      const nd = ch.nodes[i], b = ch.bands[i];
      const mag = new Float32Array(L).fill(1), ph = new Float32Array(L);
      for (const f of nd.filters) {
        f.getFrequencyResponse(F, this.tm, this.tp);
        for (let k = 0; k < L; k++) { mag[k] *= this.tm[k]; ph[k] += this.tp[k]; }
      }
      const g = dbToLin(b.gain), s = ch.effSign(i), tau = ch.effDelay(i) / 1000;
      const db = new Float32Array(L);
      for (let k = 0; k < L; k++) {
        const m = mag[k] * g;
        db[k] = 20 * Math.log10(m + 1e-12);
        if (!b.mute) {
          const p = ph[k] - 2 * Math.PI * F[k] * tau;
          re[k] += s * m * Math.cos(p);
          im[k] += s * m * Math.sin(p);
        }
      }
      this.curves.push({ i, db });
    }
    this.sum = new Float32Array(L);
    for (let k = 0; k < L; k++) this.sum[k] = 10 * Math.log10(re[k] * re[k] + im[k] * im[k] + 1e-24);
    ch.dirty = false;
  }

  drawGrid() {
    const g = this.g, W = this.W, H = this.H;
    g.font = '500 9px "JetBrains Mono", monospace';
    g.lineWidth = 1;
    // freqüències
    const majors = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
    for (let d = 10; d <= 10000; d *= 10) {
      for (let m = 2; m <= 9; m++) {
        const f = d * m;
        if (f < F_MIN || f > F_MAX) continue;
        g.strokeStyle = majors.includes(f) ? 'rgba(141,255,185,.13)' : 'rgba(141,255,185,.05)';
        const x = Math.round(this.fx(f)) + .5;
        g.beginPath(); g.moveTo(x, PAD.t); g.lineTo(x, H - PAD.b); g.stroke();
      }
    }
    g.fillStyle = 'rgba(141,255,185,.5)';
    g.textAlign = 'center';
    g.textBaseline = 'top';
    majors.forEach(f => g.fillText(fmtHzShort(f), clamp(this.fx(f), PAD.l + 8, W - PAD.r - 8), H - PAD.b + 5));
    // nivells (5 divisions)
    g.textBaseline = 'middle';
    for (let k = 0; k <= 5; k++) {
      const y = Math.round(PAD.t + (H - PAD.t - PAD.b) * k / 5) + .5;
      const rdb = R_MAX - k * (R_MAX - R_MIN) / 5;
      g.strokeStyle = rdb === 0 ? 'rgba(141,255,185,.22)' : 'rgba(141,255,185,.08)';
      g.beginPath(); g.moveTo(PAD.l, y); g.lineTo(W - PAD.r, y); g.stroke();
      g.fillStyle = 'rgba(141,255,185,.45)';
      g.textAlign = 'right';
      g.fillText(String(S_MAX - k * (S_MAX - S_MIN) / 5), PAD.l - 5, y);
      g.fillStyle = 'rgba(255,255,255,.35)';
      g.textAlign = 'left';
      g.fillText((rdb > 0 ? '+' : '') + rdb, W - PAD.r + 5, y);
    }
  }

  spectrumPath(an) {
    an.getFloatFrequencyData(this.spec);
    const g = this.g, buf = this.spec, N = buf.length;
    const binHz = this.ch.ctx.sampleRate / an.fftSize;
    const tilt = this.ch.app.tilt;
    g.beginPath();
    let first = true;
    for (let x = PAD.l; x <= this.W - PAD.r; x += 1) {
      const f0 = this.xf(x - 0.5), f1 = this.xf(x + 0.5), fc = (f0 + f1) / 2;
      let m;
      if (f1 - f0 < binHz) { // menys d'un bin per píxel: interpola
        const kf = fc / binHz, ka = Math.floor(kf), t = kf - ka;
        m = buf[ka] * (1 - t) + buf[Math.min(ka + 1, N - 1)] * t;
      } else {
        m = -Infinity;
        for (let k = Math.floor(f0 / binHz), k1 = Math.min(Math.ceil(f1 / binHz), N); k < k1; k++) if (buf[k] > m) m = buf[k];
      }
      if (!isFinite(m)) m = S_MIN - 10;
      if (tilt) m += 3 * Math.log2(fc / 1000);
      const y = this.ys(m);
      if (first) { g.moveTo(x, y); first = false; } else g.lineTo(x, y);
    }
  }

  fillSpectrum(an, color, alphaFill, alphaLine) {
    const g = this.g;
    this.spectrumPath(an);
    g.lineTo(this.W - PAD.r, this.H - PAD.b);
    g.lineTo(PAD.l, this.H - PAD.b);
    g.closePath();
    const grad = g.createLinearGradient(0, PAD.t, 0, this.H - PAD.b);
    grad.addColorStop(0, hexA(color, alphaFill));
    grad.addColorStop(1, hexA(color, alphaFill * 0.15));
    g.fillStyle = grad;
    g.fill();
    g.strokeStyle = hexA(color, alphaLine);
    g.lineWidth = 1.4;
    g.stroke();
  }

  curvePath(db) {
    const g = this.g, F = this.freqs;
    g.beginPath();
    for (let k = 0; k < F.length; k++) {
      const x = this.fx(F[k]), y = this.yr(db[k]);
      k ? g.lineTo(x, y) : g.moveTo(x, y);
    }
  }

  draw() {
    if (!this.W) return;
    const ch = this.ch, g = this.g, W = this.W, H = this.H;
    if (ch.dirty) this.computeCurves();

    g.clearRect(0, 0, W, H);
    this.drawGrid();

    g.save();
    g.beginPath();
    g.rect(PAD.l, PAD.t, W - PAD.l - PAD.r, H - PAD.t - PAD.b);
    g.clip();

    // Espectre: entrada, o bé les bandes en solo
    const solo = ch.soloed();
    if (solo.length) {
      this.spectrumPath(ch.inAn);
      g.strokeStyle = 'rgba(255,255,255,.18)';
      g.lineWidth = 1;
      g.stroke();
      solo.forEach(i => this.fillSpectrum(ch.nodes[i].an, BAND_COLORS[i], 0.45, 0.95));
    } else {
      this.fillSpectrum(ch.inAn, '#8dffb9', 0.32, 0.85);
    }

    // Corbes de resposta per banda
    this.curves.forEach(({ i, db }) => {
      const b = ch.bands[i];
      const hi = solo.length ? solo.includes(i) : true;
      this.curvePath(db);
      g.setLineDash(b.mute ? [3, 4] : []);
      g.strokeStyle = hexA(BAND_COLORS[i], hi ? 0.95 : 0.3);
      g.lineWidth = hi && solo.length ? 2.4 : 1.6;
      g.stroke();
    });
    g.setLineDash([]);

    // Suma acústica (amb fase)
    if (this.sum && ch.n > 1) {
      this.curvePath(this.sum);
      g.setLineDash([5, 4]);
      g.strokeStyle = 'rgba(255,255,255,.75)';
      g.lineWidth = 1.2;
      g.stroke();
      g.setLineDash([]);
    }
    g.restore();

    // Marcadors dels talls
    g.font = '700 9.5px "JetBrains Mono", monospace';
    g.textBaseline = 'top';
    for (let j = 0; j < ch.n - 1; j++) {
      const x = Math.round(this.fx(ch.xo[j])) + .5;
      const active = this.drag === j;
      g.strokeStyle = active ? '#ffb547' : 'rgba(255,181,71,.6)';
      g.setLineDash([2, 3]);
      g.beginPath(); g.moveTo(x, PAD.t); g.lineTo(x, H - PAD.b); g.stroke();
      g.setLineDash([]);
      const label = fmtHz(ch.xo[j]);
      const tw = g.measureText(label).width + 10;
      const lx = clamp(x - tw / 2, PAD.l, W - PAD.r - tw);
      g.fillStyle = active ? '#ffb547' : 'rgba(30,22,8,.92)';
      g.fillRect(lx, PAD.t + 2, tw, 15);
      g.strokeStyle = '#ffb547';
      g.strokeRect(lx + .5, PAD.t + 2.5, tw - 1, 14);
      g.fillStyle = active ? '#1a1206' : '#ffb547';
      g.textAlign = 'center';
      g.fillText(label, lx + tw / 2, PAD.t + 5);
    }

    // Llegenda
    g.textAlign = 'left';
    g.font = '500 9px "JetBrains Mono", monospace';
    let lx = PAD.l + 8;
    const ly = H - PAD.b - 14;
    const legend = (color, text, dash) => {
      g.strokeStyle = color; g.lineWidth = 1.6; g.setLineDash(dash || []);
      g.beginPath(); g.moveTo(lx, ly + 5); g.lineTo(lx + 14, ly + 5); g.stroke(); g.setLineDash([]);
      g.fillStyle = 'rgba(255,255,255,.55)';
      g.fillText(text, lx + 18, ly);
      lx += 18 + g.measureText(text).width + 14;
    };
    legend('rgba(255,255,255,.75)', 'SUMA', [5, 4]);
    g.fillStyle = 'rgba(255,255,255,.4)';
    g.fillText(FILTERS_LABEL(ch), lx, ly);

    // Cursor
    if (this.hoverX != null && this.hoverX > PAD.l && this.hoverX < W - PAD.r && this.drag == null) {
      const x = Math.round(this.hoverX) + .5;
      g.strokeStyle = 'rgba(255,255,255,.25)';
      g.beginPath(); g.moveTo(x, PAD.t); g.lineTo(x, H - PAD.b); g.stroke();
      const label = fmtHz(this.xf(this.hoverX));
      g.fillStyle = 'rgba(255,255,255,.8)';
      g.textAlign = x > W - 90 ? 'right' : 'left';
      g.fillText(label, x + (x > W - 90 ? -6 : 6), PAD.t + 22);
    }
  }
}

function FILTERS_LABEL(ch) {
  if (ch.n < 2) return '';
  const types = [...new Set(ch.xo.slice(0, ch.n - 1).map((_, j) => FILTERS[ch.effType(j)].label))];
  return 'FILTRE: ' + types.join(' / ');
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
}

/* =====================================================================
   Aplicació
   ===================================================================== */
class App {
  constructor() {
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'interactive' });
    if (this.ctx.state === 'running') this.ctx.suspend();
    this.rack = $('#rack');
    this.pro = false;
    this.tilt = true;
    this.routing = 'mon';
    this.ready = false;

    this.noise = {};
    ['pink', 'white', 'brown'].forEach(t => { this.noise[t] = makeNoise(this.ctx, t); });

    const ctx = this.ctx;
    this.outCount = Math.min(ctx.destination.maxChannelCount || 2, 8);
    this.masterIn = ctx.createGain();
    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = dbToLin(-12);
    this.masterAn = makeAnalyser(ctx);
    this.merger = ctx.createChannelMerger(Math.max(this.outCount, 2));
    this.masterIn.connect(this.masterGain);
    this.masterGain.connect(ctx.destination);
    this.masterGain.connect(this.masterAn);

    this.channels = [new Channel(this, 0), new Channel(this, 1)];
    this.ready = true;
    this.applyRouting();
    this.updateMutes();
    this.bindHeader();
    this.updateStatus();
    ctx.addEventListener('statechange', () => this.updateStatus());
    this.loop();
  }

  bindHeader() {
    $('#power').addEventListener('click', async () => {
      if (this.ctx.state === 'running') await this.ctx.suspend();
      else await this.ctx.resume();
    });

    $$('#inSeg button').forEach(b => b.addEventListener('click', () => {
      const n = +b.dataset.n;
      $$('#inSeg button').forEach(x => x.classList.toggle('on', x === b));
      this.channels[1].setEnabled(n === 2);
    }));

    if (this.outCount > 2) $('#routeWrap').hidden = false;
    $$('#routeSeg button').forEach(b => b.addEventListener('click', () => {
      $$('#routeSeg button').forEach(x => x.classList.toggle('on', x === b));
      this.routing = b.dataset.r;
      this.applyRouting();
    }));

    const tiltBtn = $('#tiltBtn');
    tiltBtn.addEventListener('click', () => {
      this.tilt = !this.tilt;
      tiltBtn.classList.toggle('on', this.tilt);
    });

    const proKey = $('#proKey');
    proKey.addEventListener('click', () => {
      this.pro = !this.pro;
      proKey.classList.toggle('on', this.pro);
      proKey.setAttribute('aria-pressed', this.pro);
      document.body.classList.toggle('pro', this.pro);
      this.channels.forEach(ch => ch.rebuild());
      toast(this.pro ? 'Mode PRO activat: tipus de filtre, polaritat i retard per banda' : 'Mode estàndard: Linkwitz-Riley 24 dB/oct');
    });

    this.masterKnob = new Knob({
      label: 'MASTER', min: -60, max: 6, value: -12, def: -12, format: fmtDb, size: 'lg', color: 'var(--amber)',
      onInput: v => this.masterGain.gain.setTargetAtTime(dbToLin(v), this.ctx.currentTime, 0.01),
    });
    $('#masterKnob').appendChild(this.masterKnob.el);
    this.masterMeter = new Meter(true);
    $('#masterMeter').appendChild(this.masterMeter.el);
  }

  applyRouting() {
    const d = this.ctx.destination, multi = this.routing === 'multi';
    d.channelCount = multi ? this.outCount : 2;
    d.channelInterpretation = multi ? 'discrete' : 'speakers';
    this.merger.disconnect();
    if (multi) this.merger.connect(this.masterGain);
    this.channels.forEach(ch => ch.nodes.forEach((nd, i) => {
      nd.out.disconnect();
      const outIdx = (ch.idx * 4 + i) % this.outCount;
      if (multi) nd.out.connect(this.merger, 0, outIdx);
      else nd.out.connect(this.masterIn);
      ch.setOutLabel(i, multi ? `OUT ${outIdx + 1}` : `OUT ${ch.letter}${i + 1}`);
    }));
  }

  updateMutes() {
    const anySolo = this.channels.some(ch => ch.enabled && ch.soloed().length > 0);
    this.channels.forEach(ch => ch.updateMutes(anySolo));
  }

  updateStatus() {
    const s = $('#status'), on = this.ctx.state === 'running';
    $('#power').classList.toggle('on', on);
    s.classList.toggle('off', !on);
    s.textContent = on
      ? `${(this.ctx.sampleRate / 1000).toFixed(1)} kHz · ${this.outCount} CH · ACTIU`
      : 'STANDBY · prem POWER';
  }

  loop() {
    requestAnimationFrame(() => this.loop());
    this.channels.forEach(ch => { if (ch.enabled) ch.tick(); });
    this.masterMeter.update(peakDb(this.masterAn));
  }
}

/* ---------- tema clar / fosc ---------- */
$('#themeToggle').addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('crossoverTheme', next); } catch (e) { /* sense emmagatzematge */ }
});

/* ---------- correu de contacte (ofuscat) ---------- */
const MAIL_USER = 'amanyosa', MAIL_DOMAIN = 'gmail.com';
$$('a[data-mail]').forEach(a => { a.href = 'mailto:' + MAIL_USER + '@' + MAIL_DOMAIN; });

window.addEventListener('DOMContentLoaded', () => { window.xo = new App(); });
