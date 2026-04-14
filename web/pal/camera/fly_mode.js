// pal/web/camera/fly_mode.js
// WASD mode — Unreal-style: hold RMB to activate, release to return to orbit.
// WASD for movement, mouse for look while RMB held.

import * as THREE from 'three';

export class FlyMode {
  constructor(viewer, canvas) {
    this.viewer = viewer;
    this.canvas = canvas;
    this.active = false;
    this.speed = 5.0;
    this.sensitivity = 0.003;

    this._keys = { w: false, s: false, a: false, d: false, q: false, e: false, shift: false };
    this._euler = new THREE.Euler(0, 0, 0, 'YXZ');
    this._lastTime = 0;
    this._animFrame = null;

    // Bind once — always listening, only acts when active
    document.addEventListener('keydown', this._handleKeyDown.bind(this), true);
    document.addEventListener('keyup', this._handleKeyUp.bind(this));
    this.canvas.addEventListener('wheel', this._handleWheel.bind(this), { passive: false });
  }

  enter() {
    if (this.active) return;
    this.active = true;
    // Extract yaw and pitch from camera, discard roll entirely
    const cam = this.viewer.shotCam;
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    this._euler.y = Math.atan2(-dir.x, -dir.z);
    this._euler.x = Math.asin(Math.max(-1, Math.min(1, dir.y)));
    this._euler.z = 0;
    this._lastTime = performance.now();
    this._animFrame = requestAnimationFrame(this._update.bind(this));
    document.getElementById('fly-mode-indicator')?.style.setProperty('display', 'flex');
  }

  exit() {
    if (!this.active) return;
    this.active = false;
    cancelAnimationFrame(this._animFrame);
    Object.keys(this._keys).forEach(k => { this._keys[k] = false; });
    document.getElementById('fly-mode-indicator')?.style.setProperty('display', 'none');
  }

  setSpeed(ms) { this.speed = ms; }

  // Called from controls.js on mouse move while RMB held
  handleMouseLook(dx, dy) {
    if (!this.active) return;
    this._euler.y -= dx * this.sensitivity;
    this._euler.x -= dy * this.sensitivity;
    this._euler.x = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, this._euler.x));
    this._euler.z = 0; // prevent roll — keep camera level
    this.viewer.shotCam.rotation.copy(this._euler);
    // Sync camera proxy rotation during look
    const cp = this.viewer.objects.get('__camera__');
    if (cp) cp.rotation.copy(this._euler);
  }

  _update(now) {
    if (!this.active) return;
    this._animFrame = requestAnimationFrame(this._update.bind(this));
    const dt = Math.min((now - this._lastTime) / 1000, 0.05);
    this._lastTime = now;

    const speed = this.speed * (this._keys.shift ? 4.0 : 1.0);
    const cam = this.viewer.shotCam;
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
    const fH = new THREE.Vector3(forward.x, 0, forward.z).normalize();
    const rH = new THREE.Vector3(right.x, 0, right.z).normalize();

    if (this._keys.w) cam.position.addScaledVector(fH, speed * dt);
    if (this._keys.s) cam.position.addScaledVector(fH, -speed * dt);
    if (this._keys.a) cam.position.addScaledVector(rH, -speed * dt);
    if (this._keys.d) cam.position.addScaledVector(rH, speed * dt);
    if (this._keys.q) cam.position.y -= speed * dt;
    if (this._keys.e) cam.position.y += speed * dt;
    // Sync camera proxy with shotCam during fly
    const cp = this.viewer.objects.get('__camera__');
    if (cp) { cp.position.copy(cam.position); cp.rotation.copy(cam.rotation); }
  }

  _handleKeyDown(e) {
    if (!this.active) return;
    const k = e.key.toLowerCase();
    if (k in this._keys) { this._keys[k] = true; e.preventDefault(); e.stopPropagation(); }
    if (e.key === 'Shift') this._keys.shift = true;
    if (e.key === 'i' || e.key === 'I') this._setKeyframe();
  }

  _handleKeyUp(e) {
    const k = e.key.toLowerCase();
    if (k in this._keys) this._keys[k] = false;
    if (e.key === 'Shift') this._keys.shift = false;
  }

  _handleWheel(e) {
    if (!this.active) return;
    e.preventDefault();
    const fov = Math.max(5, Math.min(120, this.viewer.shotCam.fov + e.deltaY * 0.05));
    this.viewer.shotCam.fov = fov;
    this.viewer.shotCam.updateProjectionMatrix();
  }

  _setKeyframe() {
    const cam = this.viewer.shotCam;
    const frame = window._palTimeline?.getCurrentFrame?.() ?? 0;
    window.PALBus?.dispatchEvent(new CustomEvent('pal:set-keyframe', {
      detail: { objectId: '__camera__', frame,
        position: cam.position.toArray(),
        rotation: [THREE.MathUtils.radToDeg(cam.rotation.x), THREE.MathUtils.radToDeg(cam.rotation.y), THREE.MathUtils.radToDeg(cam.rotation.z)] }
    }));
    const ind = document.getElementById('fly-mode-indicator');
    if (ind) { ind.style.background = '#1a3a1a'; setTimeout(() => { ind.style.background = ''; }, 200); }
  }
}
