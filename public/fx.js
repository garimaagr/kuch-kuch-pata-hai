// Little visual and sound effects for the TV. Everything is drawn or synthesised here (no files, no internet).
const fx = (() => {
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---- Confetti ----
  const canvas = document.createElement('canvas');
  canvas.className = 'confetti';
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  let bits = [];
  let running = false;

  function resize() {
    canvas.width = innerWidth * devicePixelRatio;
    canvas.height = innerHeight * devicePixelRatio;
  }
  addEventListener('resize', resize);
  resize();

  function frame() {
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    bits = bits.filter((b) => b.life > 0);
    for (const b of bits) {
      b.vy += 0.25; b.vx *= 0.99; b.x += b.vx; b.y += b.vy; b.rot += b.spin; b.life--;
      ctx.save();
      ctx.globalAlpha = Math.min(1, b.life / 30);
      ctx.translate(b.x, b.y);
      ctx.rotate(b.rot);
      ctx.fillStyle = b.color;
      ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h);
      ctx.restore();
    }
    if (bits.length) requestAnimationFrame(frame);
    else running = false;
  }

  // Burst of confetti from (x, y), in the team's colour plus gold.
  function confetti(x, y, color = '#ffcc33', count = 90) {
    if (calm) return;
    const colors = [color, color, '#ffcc33', '#ffffff', '#ff6b9a'];
    for (let i = 0; i < count; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.2;
      const v = 6 + Math.random() * 9;
      bits.push({
        x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v,
        w: 6 + Math.random() * 6, h: 4 + Math.random() * 6,
        rot: Math.random() * 6, spin: (Math.random() - 0.5) * 0.4,
        color: colors[i % colors.length], life: 90 + Math.random() * 40,
      });
    }
    if (!running) { running = true; requestAnimationFrame(frame); }
  }

  // Restart a CSS animation class on an element.
  function replay(el, cls) {
    if (!el) return;
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  }

  // ---- Sounds (synthesised beeps) ----
  let ac = null;
  let muted = (() => { try { return localStorage.getItem('fbMuted') === '1'; } catch { return false; } })();
  function tone(freq, start, dur, type = 'sine', vol = 0.18) {
    if (muted) return;
    try {
      ac ||= new AudioContext();
      if (ac.state === 'suspended') ac.resume();
      const t = ac.currentTime + start;
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(ac.destination);
      o.start(t);
      o.stop(t + dur + 0.05);
    } catch {}
  }
  const sounds = {
    buzz: () => { tone(880, 0, 0.12, 'square', 0.12); tone(1320, 0.1, 0.18, 'square', 0.1); },
    correct: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.09, 0.3, 'triangle')),
    wrong: () => { tone(180, 0, 0.35, 'sawtooth', 0.12); tone(140, 0.15, 0.4, 'sawtooth', 0.12); },
    open: () => tone(660, 0, 0.15, 'triangle'),
    tick: () => tone(1000, 0, 0.05, 'square', 0.06),
    timeUp: () => [392, 330, 262].forEach((f, i) => tone(f, i * 0.18, 0.35, 'triangle', 0.2)),
    sparkle: () => [784, 988, 1175, 1568, 1976].forEach((f, i) => tone(f, i * 0.07, 0.4, 'sine', 0.12)),
    reveal: () => { tone(392, 0, 0.2, 'triangle'); tone(523, 0.12, 0.35, 'triangle'); },
    double: () => [262, 330, 392, 523, 659, 784].forEach((f, i) => tone(f, i * 0.06, 0.25, 'square', 0.09)),
    winner: () => [523, 523, 523, 659, 784, 659, 784, 1047].forEach((f, i) => tone(f, [0, 0.15, 0.3, 0.45, 0.75, 1.0, 1.15, 1.35][i], 0.3, 'triangle', 0.16)),
  };
  function play(name) { sounds[name]?.(); }
  function setMuted(m) { muted = m; try { localStorage.setItem('fbMuted', m ? '1' : '0'); } catch {} }

  // A huge word that pops over the screen for a moment ("DOUBLE!").
  function banner(text, kind = '') {
    const el = document.createElement('div');
    el.className = `big-banner ${kind}`;
    el.textContent = text;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1800);
  }

  // Emoji confetti for the winner screen: plain spans falling with a CSS animation.
  function emojiRain(emojis = ['🎉', '🏆', '⭐', '🥳', '✨', '🎊', '🪅']) {
    const box = document.getElementById('emojiRain');
    if (!box || calm) return;
    box.replaceChildren();
    for (let i = 0; i < 60; i++) {
      const s = document.createElement('span');
      s.textContent = emojis[i % emojis.length];
      s.style.left = Math.random() * 100 + 'vw';
      s.style.animationDelay = Math.random() * 2.5 + 's';
      s.style.animationDuration = 2.5 + Math.random() * 2.5 + 's';
      s.style.fontSize = 1.4 + Math.random() * 1.8 + 'rem';
      box.appendChild(s);
    }
    setTimeout(() => box.replaceChildren(), 8000);
  }

  return { confetti, replay, play, banner, emojiRain, setMuted, get muted() { return muted; } };
})();
