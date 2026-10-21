/** Fixed virtual stick and hold-to-fire input. Gameplay and aim remain external. */
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const finite = value => typeof value === 'number' && Number.isFinite(value);
const pointerId = event => Number.isInteger(event?.pointerId) ? event.pointerId : null;
const fireKey = event => event.key === 'Enter' || event.code === 'Enter' ? 'Enter'
  : event.key === ' ' || event.key === 'Spacebar' || event.code === 'Space' ? 'Space' : null;

export class TouchControls {
  constructor({ stick, knob, fire, onInteract = () => {}, isActive = () => true, onEnable = () => {} } = {}) {
    if (!stick?.addEventListener || !fire?.addEventListener) throw new TypeError('TouchControls needs stick and fire elements');
    this.stick = stick; this.knob = knob; this.fire = fire;
    this.onInteract = onInteract; this.isActive = isActive; this.onEnable = onEnable;
    this.enabled = false; this.destroyed = false; this.deadzone = .13;
    this._movePointer = null; this._firePointer = null; this._keys = new Set();
    this._moveX = 0; this._moveY = 0; this._center = { x: 0, y: 0 }; this._radius = 1;
    this._cleanup = [];
    const doc = stick.ownerDocument || fire.ownerDocument || globalThis.document;
    const win = doc?.defaultView || globalThis.window;
    this._listen(stick, 'pointerdown', event => this._beginMove(event), { passive: false });
    this._listen(stick, 'pointermove', event => this._move(event), { passive: false });
    this._listen(stick, 'pointerup', event => this._endMove(event));
    this._listen(stick, 'pointercancel', event => this._endMove(event));
    this._listen(stick, 'lostpointercapture', event => this._endMove(event, false));
    this._listen(fire, 'pointerdown', event => this._beginFire(event), { passive: false });
    this._listen(fire, 'pointerup', event => this._endFire(event));
    this._listen(fire, 'pointercancel', event => this._endFire(event));
    this._listen(fire, 'lostpointercapture', event => this._endFire(event, false));
    this._listen(fire, 'keydown', event => this._keyDown(event));
    this._listen(fire, 'keyup', event => this._keyUp(event));
    this._listen(fire, 'blur', () => { this._keys.clear(); this._paintFire(); });
    // Capture normally routes release to the owned element. These fallbacks only
    // inspect matching IDs and never cancel document events or the other finger.
    this._listen(doc, 'pointerup', event => { this._endMove(event); this._endFire(event); });
    this._listen(doc, 'pointercancel', event => { this._endMove(event); this._endFire(event); });
    this._listen(doc, 'pointerdown', event => this._detectTouch(event), { capture: true, passive: true });
    this._listen(doc, 'visibilitychange', () => { if (doc.hidden) this.reset(); });
    this._listen(win, 'blur', () => this.reset());
    this._listen(win, 'resize', () => this.reset());
    this._listen(win, 'pagehide', () => this.reset());
    this._listen(win, 'orientationchange', () => this.reset());
    try {
      const media = win?.matchMedia?.('(any-pointer: coarse), (pointer: coarse)');
      if (media?.matches) this._enable();
      const changed = event => { if (event.matches) this._enable(); };
      if (media?.addEventListener) {
        media.addEventListener('change', changed);
        this._cleanup.push(() => media.removeEventListener('change', changed));
      } else if (media?.addListener) {
        media.addListener(changed); this._cleanup.push(() => media.removeListener(changed));
      }
    } catch { /* A missing media-query implementation does not disable controls. */ }
    this._paintStick(0, 0); this._paintFire();
  }

  _listen(target, type, listener, options) {
    if (!target?.addEventListener) return;
    target.addEventListener(type, listener, options);
    this._cleanup.push(() => target.removeEventListener(type, listener, options));
  }
  _enable() {
    if (this.enabled || this.destroyed) return;
    this.enabled = true; this.onEnable();
  }
  _detectTouch(event) {
    if (event.pointerType === 'touch' || event.pointerType === 'pen') this._enable();
  }
  _active() {
    if (this.destroyed) return false;
    try { return !!this.isActive(); } catch { return false; }
  }
  _interact() {
    try { this.onInteract()?.catch?.(() => {}); } catch { /* Audio unlock cannot block input. */ }
  }
  _capture(target, id) {
    try { target.setPointerCapture?.(id); } catch { /* ID-filtered release still works. */ }
  }
  _release(target, id) {
    if (id == null) return;
    try { if (!target.hasPointerCapture || target.hasPointerCapture(id)) target.releasePointerCapture?.(id); } catch {}
  }
  _canStart(event) {
    this._detectTouch(event);
    return this._active() && pointerId(event) != null && (event.button == null || event.button === 0);
  }
  _beginMove(event) {
    if (!this._canStart(event) || this._movePointer != null || pointerId(event) === this._firePointer) return;
    if (!finite(event.clientX) || !finite(event.clientY)) return;
    const rect = this.stick.getBoundingClientRect();
    const width = finite(rect.width) && rect.width > 0 ? rect.width : 100;
    const height = finite(rect.height) && rect.height > 0 ? rect.height : width;
    const knobRect = this.knob?.getBoundingClientRect?.();
    const knobSize = knobRect && finite(knobRect.width) ? Math.min(knobRect.width, width * .7) : width * .36;
    this._radius = Math.max(1, (Math.min(width, height) - knobSize) / 2);
    this._center = { x: (finite(rect.left) ? rect.left : 0) + width / 2, y: (finite(rect.top) ? rect.top : 0) + height / 2 };
    this._movePointer = event.pointerId; this.stick.classList?.add('active');
    this._capture(this.stick, event.pointerId); this._interact(); this._move(event);
  }
  _move(event) {
    if (pointerId(event) !== this._movePointer || this._movePointer == null) return;
    if (!this._active()) { this.reset(); return; }
    if (!finite(event.clientX) || !finite(event.clientY)) return;
    const dx = event.clientX - this._center.x, dy = event.clientY - this._center.y;
    const length = Math.hypot(dx, dy);
    if (!Number.isFinite(length)) return;
    const raw = clamp(length / this._radius, 0, 1);
    const magnitude = raw <= this.deadzone ? 0 : (raw - this.deadzone) / (1 - this.deadzone);
    const unitX = length > 0 ? dx / length : 0, unitY = length > 0 ? dy / length : 0;
    this._moveX = unitX * magnitude; this._moveY = unitY * magnitude;
    this._paintStick(unitX * raw * this._radius, unitY * raw * this._radius);
    event.preventDefault?.();
  }
  _endMove(event, release = true) {
    if (this._movePointer == null || pointerId(event) !== this._movePointer) return;
    const id = this._movePointer; this._movePointer = null; this._moveX = 0; this._moveY = 0;
    this.stick.classList?.remove('active'); this._paintStick(0, 0);
    if (release) this._release(this.stick, id);
  }
  _beginFire(event) {
    if (!this._canStart(event) || this._firePointer != null || pointerId(event) === this._movePointer) return;
    this._firePointer = event.pointerId; this._capture(this.fire, event.pointerId);
    this._interact(); this._paintFire(); event.preventDefault?.();
  }
  _endFire(event, release = true) {
    if (this._firePointer == null || pointerId(event) !== this._firePointer) return;
    const id = this._firePointer; this._firePointer = null;
    if (release) this._release(this.fire, id);
    this._paintFire();
  }
  _keyDown(event) {
    const key = fireKey(event); if (!key || !this._active()) return;
    event.preventDefault?.(); this._enable();
    if (!this._keys.has(key)) { this._keys.add(key); this._interact(); }
    this._paintFire();
  }
  _keyUp(event) {
    const key = fireKey(event); if (!key) return;
    event.preventDefault?.(); this._keys.delete(key); this._paintFire();
  }
  _paintStick(x, y) {
    if (this.knob?.style) this.knob.style.transform = `translate(-50%, -50%) translate(${x.toFixed(2)}px, ${y.toFixed(2)}px)`;
  }
  _paintFire() {
    const pressed = this._firePointer != null || this._keys.size > 0;
    this.fire.classList?.toggle('active', pressed);
    this.fire.setAttribute?.('aria-pressed', String(pressed));
  }

  snapshot() {
    if (!this._active()) this.reset();
    return { moveX: this._moveX, moveY: this._moveY, shoot: this._firePointer != null || this._keys.size > 0 };
  }
  reset() {
    const move = this._movePointer, fire = this._firePointer;
    this._movePointer = null; this._firePointer = null; this._keys.clear(); this._moveX = 0; this._moveY = 0;
    this.stick.classList?.remove('active'); this._paintStick(0, 0); this._paintFire();
    this._release(this.stick, move); this._release(this.fire, fire);
  }
  destroy() {
    this.reset(); this.destroyed = true;
    this._cleanup.splice(0).forEach(remove => remove());
  }
}
