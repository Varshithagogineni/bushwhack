// Keyboard + mouse on laptops, twin floating joysticks on touch screens.
export const STICK_R = 60;
const TAP_MAX = 14; // a right-thumb drag shorter than this counts as a tap (auto-aim)

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.mouse = { x: 0, y: 0, down: false };
    this.left = null; // { id, ox, oy, x, y }
    this.right = null;
    this.touchMode = matchMedia('(pointer: coarse)').matches;
    this.onFire = () => {};

    addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return;
      this.keys.add(e.code);
      if (e.code === 'Space') {
        e.preventDefault();
        if (!e.repeat) this.onFire({ auto: true });
      }
      if (e.code.startsWith('Arrow')) e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.reset());

    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move_(e));
    canvas.addEventListener('pointerup', (e) => this.up(e));
    canvas.addEventListener('pointercancel', (e) => this.up(e, true));
  }

  reset() {
    this.keys.clear();
    this.mouse.down = false;
    this.left = this.right = null;
  }

  down(e) {
    e.preventDefault();
    if (e.pointerType === 'mouse') {
      this.touchMode = false;
      this.mouse.x = e.clientX; this.mouse.y = e.clientY;
      if (e.button === 0) { this.mouse.down = true; this.onFire({ mouse: true }); }
      return;
    }
    this.touchMode = true;
    this.canvas.setPointerCapture?.(e.pointerId);
    const stick = { id: e.pointerId, ox: e.clientX, oy: e.clientY, x: e.clientX, y: e.clientY };
    if (e.clientX < innerWidth / 2) { if (!this.left) this.left = stick; }
    else if (!this.right) this.right = stick;
  }

  move_(e) {
    if (e.pointerType === 'mouse') {
      this.mouse.x = e.clientX; this.mouse.y = e.clientY;
      return;
    }
    for (const s of [this.left, this.right]) {
      if (!s || s.id !== e.pointerId) continue;
      s.x = e.clientX; s.y = e.clientY;
      // Floating stick: drag the base along when the thumb goes past the edge.
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
      const aim = this.touchAim();
      this.right = null;
      if (!cancelled) this.onFire(aim.active ? { angle: aim.angle, frac: aim.frac } : { auto: true });
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

  // Right-thumb aim: active once dragged past the tap threshold.
  touchAim() {
    if (!this.right) return { active: false };
    const dx = this.right.x - this.right.ox, dy = this.right.y - this.right.oy;
    const d = Math.hypot(dx, dy);
    if (d < TAP_MAX) return { active: false };
    return { active: true, angle: Math.atan2(dy, dx), frac: Math.min(1, d / (STICK_R * 1.4)) };
  }
}
