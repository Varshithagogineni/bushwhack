// Keyboard + mouse on laptops, twin floating joysticks (plus a super button) on touch screens.
export const STICK_R = 60;
const TAP_MAX = 14; // a drag shorter than this counts as a tap (auto-aim)

// Where the touch super button sits (CSS pixels).
export function superButton() {
  return { x: innerWidth - 78, y: innerHeight - 200, r: 38 };
}

// The weapon-swap button sits just above it.
export function swapButton() {
  const sb = superButton();
  return { x: sb.x, y: sb.y - 82, r: 30 };
}

// The gadget button sits to the left of SUPER.
export function gadgetButton() {
  const sb = superButton();
  return { x: sb.x - 92, y: sb.y + 6, r: 30 };
}

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.mouse = { x: 0, y: 0, down: false };
    this.left = null; // { id, ox, oy, x, y }
    this.right = null;
    this.superStick = null;
    this.touchMode = matchMedia('(pointer: coarse)').matches;
    this.onFire = () => {};
    this.onSuper = () => {};
    this.onEmote = () => {};
    this.onSwap = () => {};
    this.onGadget = () => {};
    this.aimReach = STICK_R * 1.4; // how far you drag for a full-range shot (throwers get a longer stick)
    this.superReach = STICK_R * 1.4;
    this.lastWheel = 0;

    addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return;
      this.keys.add(e.code);
      if (e.code === 'Space') {
        e.preventDefault();
        if (!e.repeat) this.onFire({ auto: true });
      }
      if (e.code === 'KeyE' && !e.repeat) this.onSuper({ mouse: true });
      if (e.code === 'KeyQ' && !e.repeat) this.onSwap();
      if (e.code === 'KeyF' && !e.repeat) this.onGadget();
      const n = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6'].indexOf(e.code);
      if (n >= 0 && !e.repeat) this.onEmote(n);
      if (e.code.startsWith('Arrow')) e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.reset());

    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (performance.now() - this.lastWheel > 300) { this.lastWheel = performance.now(); this.onSwap(); }
    }, { passive: false });
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move_(e));
    canvas.addEventListener('pointerup', (e) => this.up(e));
    canvas.addEventListener('pointercancel', (e) => this.up(e, true));
  }

  reset() {
    this.keys.clear();
    this.mouse.down = false;
    this.left = this.right = this.superStick = null;
  }

  down(e) {
    e.preventDefault();
    if (e.pointerType === 'mouse') {
      this.touchMode = false;
      this.mouse.x = e.clientX; this.mouse.y = e.clientY;
      if (e.button === 0) { this.mouse.down = true; this.onFire({ mouse: true }); }
      if (e.button === 2) this.onSuper({ mouse: true });
      return;
    }
    this.touchMode = true;
    this.canvas.setPointerCapture?.(e.pointerId);
    const stick = { id: e.pointerId, ox: e.clientX, oy: e.clientY, x: e.clientX, y: e.clientY };
    const sb = superButton();
    const wb = swapButton();
    if (Math.hypot(e.clientX - wb.x, e.clientY - wb.y) < wb.r * 1.3) { this.onSwap(); return; }
    const gb = gadgetButton();
    if (Math.hypot(e.clientX - gb.x, e.clientY - gb.y) < gb.r * 1.25) { this.onGadget(); return; }
    if (e.clientX < innerWidth / 2) { if (!this.left) this.left = stick; }
    else if (!this.superStick && Math.hypot(e.clientX - sb.x, e.clientY - sb.y) < sb.r * 1.35) {
      this.superStick = { ...stick, ox: sb.x, oy: sb.y };
    } else if (!this.right) this.right = stick;
  }

  move_(e) {
    if (e.pointerType === 'mouse') {
      this.mouse.x = e.clientX; this.mouse.y = e.clientY;
      return;
    }
    for (const s of [this.left, this.right, this.superStick]) {
      if (!s || s.id !== e.pointerId) continue;
      s.x = e.clientX; s.y = e.clientY;
      // Floating move stick: drag the base along when the thumb goes past the edge.
      const dx = s.x - s.ox, dy = s.y - s.oy, d = Math.hypot(dx, dy);
      if (s === this.left && d > STICK_R) {
        s.ox = s.x - (dx / d) * STICK_R;
        s.oy = s.y - (dy / d) * STICK_R;
      }
    }
  }

  up(e, cancelled = false) {
    if (e.pointerType === 'mouse') {
      if (e.button === 0) this.mouse.down = false;
      return;
    }
    if (this.left?.id === e.pointerId) this.left = null;
    if (this.right?.id === e.pointerId) {
      const aim = this.stickAim(this.right);
      this.right = null;
      if (!cancelled) this.onFire(aim.active ? { angle: aim.angle, frac: aim.frac } : { auto: true });
    }
    if (this.superStick?.id === e.pointerId) {
      const aim = this.stickAim(this.superStick);
      this.superStick = null;
      if (!cancelled) this.onSuper(aim.active ? { angle: aim.angle, frac: aim.frac } : { auto: true });
    }
  }

  // Movement vector, length 0..1
  move() {
    if (this.left) {
      const dx = this.left.x - this.left.ox, dy = this.left.y - this.left.oy;
      const d = Math.hypot(dx, dy);
      if (d < 8) return { mx: 0, my: 0 };
      const k = Math.min(1, d / STICK_R) / d;
      return { mx: dx * k, my: dy * k };
    }
    const k = this.keys;
    let mx = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    let my = (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0) - (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0);
    if (mx && my) { mx *= Math.SQRT1_2; my *= Math.SQRT1_2; }
    return { mx, my };
  }

  // A stick aims once dragged past the tap threshold.
  stickAim(s) {
    if (!s) return { active: false };
    const dx = s.x - s.ox, dy = s.y - s.oy;
    const d = Math.hypot(dx, dy);
    if (d < TAP_MAX) return { active: false };
    const reach = s === this.superStick ? this.superReach : this.aimReach;
    return { active: true, angle: Math.atan2(dy, dx), frac: Math.min(1, d / reach) };
  }

  touchAim() { return this.stickAim(this.right); }
  superAim() { return this.stickAim(this.superStick); }
}
