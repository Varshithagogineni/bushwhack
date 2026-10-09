// Tiny synthesized sound effects (Web Audio), so there are no audio files to download.
let ac = null;
let master = null;
let muted = false;
try { muted = localStorage.getItem('bw_muted') === '1'; } catch { /* private mode */ }

function ensure() {
  if (ac) return ac;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  ac = new Ctx();
  master = ac.createGain();
  master.gain.value = muted ? 0 : 0.5;
  master.connect(ac.destination);
  return ac;
}

// Browsers only allow audio after a user gesture.
for (const ev of ['pointerdown', 'keydown']) {
  addEventListener(ev, () => { const c = ensure(); if (c?.state === 'suspended') c.resume(); }, { passive: true });
}

export const isMuted = () => muted;
export function setMuted(m) {
  muted = m;
  try { localStorage.setItem('bw_muted', m ? '1' : '0'); } catch { /* private mode */ }
  if (master) master.gain.value = m ? 0 : 0.5;
}

function tone(freq, dur, { type = 'square', vol = 0.2, to = null, delay = 0 } = {}) {
  if (muted || !ensure() || ac.state !== 'running') return;
  const t = ac.currentTime + delay;
  const o = ac.createOscillator();
  const g = ac.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + dur + 0.02);
}

function noise(dur, { vol = 0.3, freq = 1200, q = 0.8, delay = 0 } = {}) {
  if (muted || !ensure() || ac.state !== 'running') return;
  const t = ac.currentTime + delay;
  const len = Math.max(1, Math.floor(ac.sampleRate * dur));
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = ac.createBufferSource();
  src.buffer = buf;
  const f = ac.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = freq;
  f.Q.value = q;
  const g = ac.createGain();
  g.gain.value = vol;
  src.connect(f).connect(g).connect(master);
  src.start(t);
}

// `v` is a 0..1 volume factor (quieter when far from your camera).
export const sfx = {
  shot(w, v = 1) {
    if (w === 'shotgun') noise(0.18, { vol: 0.35 * v, freq: 1800 });
    else if (w === 'bullet') tone(900, 0.12, { type: 'sawtooth', vol: 0.12 * v, to: 300 });
    else tone(300, 0.2, { type: 'triangle', vol: 0.2 * v, to: 600 });
  },
  boom(big, v = 1) { noise(big ? 0.7 : 0.45, { vol: (big ? 0.6 : 0.45) * v, freq: big ? 500 : 800 }); },
  hit(v = 1) { tone(220, 0.08, { type: 'square', vol: 0.12 * v, to: 120 }); },
  hurt() { tone(160, 0.18, { type: 'sawtooth', vol: 0.2, to: 70 }); },
  crate(v = 1) { noise(0.06, { vol: 0.2 * v, freq: 600 }); },
  crateBreak(v = 1) { noise(0.3, { vol: 0.35 * v, freq: 900 }); tone(180, 0.2, { type: 'triangle', vol: 0.15 * v, to: 90 }); },
  cube() { tone(660, 0.08, { type: 'square', vol: 0.12 }); tone(990, 0.12, { type: 'square', vol: 0.12, delay: 0.07 }); },
  ko(v = 1) { tone(500, 0.35, { type: 'sawtooth', vol: 0.18 * v, to: 60 }); noise(0.3, { vol: 0.2 * v, freq: 700 }); },
  superReady() { [523, 659, 784].forEach((f, i) => tone(f, 0.12, { type: 'triangle', vol: 0.15, delay: i * 0.07 })); },
  super(v = 1) { tone(200, 0.4, { type: 'sawtooth', vol: 0.2 * v, to: 900 }); },
  haunt(v = 1) { tone(400, 0.6, { type: 'sine', vol: 0.18 * v, to: 180 }); tone(410, 0.6, { type: 'sine', vol: 0.12 * v, to: 190 }); },
  beep(high) { tone(high ? 880 : 440, high ? 0.35 : 0.15, { type: 'square', vol: 0.15 }); },
  emote() { tone(700, 0.06, { type: 'triangle', vol: 0.1 }); },
  win() { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.25, { type: 'triangle', vol: 0.18, delay: i * 0.12 })); },
  lose() { [392, 330, 262].forEach((f, i) => tone(f, 0.3, { type: 'triangle', vol: 0.15, delay: i * 0.15 })); },
};
