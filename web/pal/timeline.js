// frontend/pal/timeline.js
// PAL — Lightweight custom timeline scrubber

import * as THREE from 'three';

function lerp3(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

// Bezier ease function (cubic bezier approximation)
function bezierEase(t) {
  // Approximation of cubic-bezier(0.42, 0, 0.58, 1) — smooth ease in/out
  return t * t * (3 - 2 * t);
}

// Ease in (accelerate)
function easeIn(t) { return t * t * t; }
// Ease out (decelerate)
function easeOut(t) { return 1 - Math.pow(1 - t, 3); }

// Interpolation modes
const INTERP_MODES = {
  linear: t => t,
  flat: () => 0,          // hold previous value (step)
  bezier: bezierEase,     // smooth ease in/out
  ease_in: easeIn,
  ease_out: easeOut,
};

function interpolateAtFrame(keyframes, frame) {
  if (!keyframes || !keyframes.length) return null;
  const sorted = [...keyframes].sort((a, b) => a.frame - b.frame);
  if (frame <= sorted[0].frame) return sorted[0];
  if (frame >= sorted.at(-1).frame) return sorted.at(-1);
  const prev = sorted.filter(k => k.frame <= frame).at(-1);
  const next = sorted.find(k => k.frame > frame);
  if (!prev || !next) return sorted[0];
  const rawT = (frame - prev.frame) / (next.frame - prev.frame);
  // Apply interpolation mode from the previous keyframe
  const mode = prev.interpolation || 'linear';
  const easeFn = INTERP_MODES[mode] || INTERP_MODES.linear;
  const t = mode === 'flat' ? 0 : easeFn(rawT);
  return {
    frame,
    position: prev.position && next.position ? lerp3(prev.position, next.position, t) : prev.position,
    rotation: prev.rotation && next.rotation ? lerp3(prev.rotation, next.rotation, t) : prev.rotation,
  };
}

export { interpolateAtFrame };

export class PALTimeline {
  constructor(containerEl) {
    this.el = containerEl;
    this._frame = 0;
    this._totalFrames = 96;
    this._fps = 24;
    this._playing = false;
    this._looping = true;
    this._selectedKF = null; // {objectId, frame}
    this._tickColor = '#333';
    this._tickFontSize = 6;
    this._startFrame = 0;
    this._tracks = new Map(); // objectId → [{frame, position, rotation}]
    this._onFrameChange = () => {};

    this._buildDOM();
  }

  _buildDOM() {
    this.el.innerHTML = '';
    this.el.style.userSelect = 'none';

    // Controls (inline in the flex row)
    const controls = document.createElement('div');
    controls.style.cssText = 'display:flex;align-items:center;gap:6px;flex-shrink:0;';

    const btnStyle = 'background:none;border:1px solid #2a2a26;color:#888;font-size:12px;padding:2px 8px;border-radius:3px;cursor:pointer;font-family:monospace;';

    const rewindBtn = document.createElement('button');
    rewindBtn.style.cssText = btnStyle;
    rewindBtn.textContent = '\u25C0\u25C0';
    rewindBtn.onclick = () => this.scrubTo(0);

    this._playBtn = document.createElement('button');
    this._playBtn.style.cssText = btnStyle;
    this._playBtn.textContent = '\u25B6';
    this._playBtn.onclick = () => this._playing ? this.pause() : this.play();

    const ffBtn = document.createElement('button');
    ffBtn.style.cssText = btnStyle;
    ffBtn.textContent = '\u25B6\u25B6';
    ffBtn.onclick = () => this.scrubTo(this._totalFrames - 1);

    const fpsLabel = document.createElement('span');
    fpsLabel.style.cssText = 'font-family:monospace;font-size:9px;color:#555;margin-left:8px;';
    fpsLabel.textContent = 'fps:';

    const fpsSelect = document.createElement('select');
    fpsSelect.style.cssText = 'background:#1a1a18;border:1px solid #2a2a26;color:#888;font-family:monospace;font-size:9px;padding:1px 4px;border-radius:2px;';
    [12, 24, 25, 30, 48].forEach(f => {
      const o = document.createElement('option');
      o.value = f; o.textContent = f; if (f === 24) o.selected = true;
      fpsSelect.appendChild(o);
    });
    fpsSelect.onchange = () => this.setFPS(parseInt(fpsSelect.value));

    const spacer = document.createElement('div');
    spacer.style.flex = '1';

    // Start frame input
    const inStyle = 'background:#1a1a18;border:1px solid #2a2a26;color:#888;font-family:monospace;font-size:9px;width:36px;text-align:center;padding:1px 2px;border-radius:2px;outline:none;';
    this._startInput = document.createElement('input');
    this._startInput.type = 'text'; this._startInput.inputMode = 'numeric';
    this._startInput.style.cssText = inStyle;
    this._startInput.value = '0';
    this._startInput.onchange = () => { this._startFrame = parseInt(this._startInput.value) || 0; this._draw(); };

    this._frameLabel = document.createElement('span');
    this._frameLabel.style.cssText = 'font-family:monospace;font-size:10px;color:#666;';
    this._updateFrameLabel();

    // End frame input
    this._endInput = document.createElement('input');
    this._endInput.type = 'text'; this._endInput.inputMode = 'numeric';
    this._endInput.style.cssText = inStyle;
    this._endInput.value = String(this._totalFrames);
    this._endInput.onchange = () => {
      const v = parseInt(this._endInput.value) || 96;
      this._totalFrames = Math.max(1, v);
      this._updateFrameLabel(); this._draw();
    };

    const loopBtn = document.createElement('button');
    loopBtn.style.cssText = btnStyle;
    loopBtn.textContent = '\u21BA';
    loopBtn.title = 'Loop';
    loopBtn.style.color = '#f5c400'; // active by default
    loopBtn.onclick = () => {
      this._looping = !this._looping;
      loopBtn.style.color = this._looping ? '#f5c400' : '#555';
      loopBtn.title = this._looping ? 'Loop (on)' : 'Loop (off)';
    };

    controls.append(rewindBtn, this._playBtn, ffBtn, fpsLabel, fpsSelect, spacer, this._startInput, this._frameLabel, this._endInput, loopBtn);
    this.el.appendChild(controls);

    // Track canvas (inline flex child — fixed height)
    this._canvas = document.createElement('canvas');
    this._canvas.style.cssText = 'flex:1;min-width:100px;height:36px;cursor:pointer;border-radius:3px;';
    this.el.appendChild(this._canvas);
    this._ctx = this._canvas.getContext('2d');

    this._resizeCanvas();
    this._bindCanvasEvents();
    this._draw();

    const ro = new ResizeObserver(() => { this._resizeCanvas(); this._draw(); });
    ro.observe(this.el);
  }

  _resizeCanvas() {
    // Use the actual available space after controls
    const rect = this._canvas.getBoundingClientRect();
    this._canvas.width = Math.max(50, Math.floor(rect.width));
    this._canvas.height = 36;
  }

  _updateFrameLabel() {
    if (this._frameLabel) {
      this._frameLabel.textContent = `${String(this._frame).padStart(4, '0')} / ${String(this._totalFrames).padStart(4, '0')}`;
    }
  }

  _draw() {
    const ctx = this._ctx;
    const w = this._canvas.width;
    const h = this._canvas.height;
    const labelW = 60;
    const trackH = 20;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = this._bgColor || '#0e0e0c';
    ctx.fillRect(0, 0, w, h);

    // Track area
    const trackW = w - labelW;
    const tracks = [...this._tracks.entries()];
    const trackCount = Math.max(1, tracks.length);

    // Draw tracks
    tracks.forEach(([id, keyframes], i) => {
      const y = i * trackH;

      // Label
      ctx.fillStyle = '#555';
      ctx.font = '9px monospace';
      ctx.fillText(id.substring(0, 7), 4, y + 14);

      // Track bg
      ctx.fillStyle = '#1a1a18';
      ctx.fillRect(labelW, y, trackW, trackH - 1);

      // Track line
      ctx.strokeStyle = '#2a2a26';
      ctx.beginPath();
      ctx.moveTo(labelW, y + trackH / 2);
      ctx.lineTo(w, y + trackH / 2);
      ctx.stroke();

      // Keyframe dots
      keyframes.forEach(kf => {
        const x = labelW + (kf.frame / this._totalFrames) * trackW;
        const isSel = this._selectedKF && this._selectedKF.objectId === id && this._selectedKF.frame === kf.frame;
        ctx.fillStyle = isSel ? '#ffffff' : '#f5c400';
        ctx.beginPath();
        ctx.arc(x, y + trackH / 2, isSel ? 5 : 4, 0, Math.PI * 2);
        ctx.fill();
        if (isSel) { ctx.strokeStyle = '#f5c400'; ctx.lineWidth = 2; ctx.stroke(); }
      });
    });

    // Playhead
    const phX = labelW + (this._frame / this._totalFrames) * trackW;
    ctx.strokeStyle = '#f5c400';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(phX, 0);
    ctx.lineTo(phX, h);
    ctx.stroke();

    // Playhead triangle
    ctx.fillStyle = '#f5c400';
    ctx.beginPath();
    ctx.moveTo(phX - 4, 0);
    ctx.lineTo(phX + 4, 0);
    ctx.lineTo(phX, 6);
    ctx.fill();

    // Frame tick marks along bottom
    ctx.fillStyle = this._tickColor || '#333';
    ctx.font = (this._tickFontSize || 14) + 'px monospace';
    const step = this._totalFrames <= 48 ? 4 : this._totalFrames <= 96 ? 8 : this._totalFrames <= 200 ? 10 : 24;
    for (let f = 0; f <= this._totalFrames; f += step) {
      const tx = labelW + (f / this._totalFrames) * trackW;
      ctx.fillRect(tx, h - 4, 1, 4);
      if (f % (step * 2) === 0) {
        ctx.fillText(String(f), tx - 4, h - 5);
      }
    }
  }

  _bindCanvasEvents() {
    let dragging = false;
    let draggingKF = null; // {objectId, origFrame}

    const labelW = 60;

    const frameFromEvent = (e) => {
      const rect = this._canvas.getBoundingClientRect();
      const trackW = this._canvas.width - labelW;
      const x = e.clientX - rect.left - labelW;
      return Math.max(0, Math.min(this._totalFrames - 1, Math.round((x / trackW) * this._totalFrames)));
    };

    const hitKeyframe = (e) => {
      const rect = this._canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const trackW = this._canvas.width - labelW;
      const trackH = 20;
      let idx = 0;
      for (const [id, keyframes] of this._tracks) {
        const y = idx * trackH;
        for (const kf of keyframes) {
          const kx = labelW + (kf.frame / this._totalFrames) * trackW;
          if (Math.abs(mx - kx) < 6 && Math.abs(my - (y + trackH / 2)) < 8) {
            return { objectId: id, frame: kf.frame };
          }
        }
        idx++;
      }
      return null;
    };

    this._canvas.addEventListener('mousedown', (e) => {
      const kfHit = hitKeyframe(e);
      if (kfHit) {
        this._selectedKF = kfHit;
        draggingKF = kfHit;
        this._draw();
        return;
      }
      this._selectedKF = null;
      this._draw();
      dragging = true;
      this.scrubTo(frameFromEvent(e));
    });

    // Right-click context menu for keyframe interpolation
    this._canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const kfHit = hitKeyframe(e);
      if (!kfHit) return;
      this._selectedKF = kfHit;
      this._draw();
      this._showInterpMenu(e.clientX, e.clientY, kfHit);
    });

    window.addEventListener('mousemove', (e) => {
      if (dragging) this.scrubTo(frameFromEvent(e));
      if (draggingKF) {
        const newFrame = frameFromEvent(e);
        // Move the keyframe
        const kfs = this._tracks.get(draggingKF.objectId);
        if (kfs) {
          const kf = kfs.find(k => k.frame === draggingKF.frame);
          if (kf) {
            kf.frame = newFrame;
            draggingKF.frame = newFrame;
            this._draw();
          }
        }
      }
    });

    window.addEventListener('mouseup', () => {
      if (draggingKF) {
        if (typeof window !== 'undefined') {
          window.PALBus?.dispatchEvent(new CustomEvent('pal:keyframe-moved', {
            detail: { objectId: draggingKF.objectId, frame: draggingKF.frame },
          }));
        }
        draggingKF = null;
      }
      dragging = false;
    });
  }

  // ── Public API ───────────────────────────────────────

  loadShot(shotData) {
    this._tracks.clear();
    if (!shotData) return;

    // Camera keyframes
    const camKFs = shotData.scene?.camera?.path_keyframes || [];
    if (camKFs.length) {
      this._tracks.set('CAM', camKFs);
      const maxFrame = Math.max(...camKFs.map(k => k.frame), 48);
      this._totalFrames = maxFrame + 1;
    }

    this._frame = 0;
    this._updateFrameLabel();
    this._draw();
  }

  getCurrentFrame() { return this._frame; }

  scrubTo(frame) {
    this._frame = Math.max(0, Math.min(this._totalFrames - 1, frame));
    this._updateFrameLabel();
    this._draw();
    this._dispatchFrameChange();
  }

  play() {
    this._playing = true;
    this._playBtn.textContent = '\u275A\u275A';
    let last = performance.now();
    const tick = (now) => {
      if (!this._playing) return;
      if (now - last >= 1000 / this._fps) {
        if (this._frame >= this._totalFrames - 1) {
          if (this._looping) { this._frame = 0; }
          else { this.pause(); return; }
        } else { this._frame++; }
        this._updateFrameLabel();
        this._draw();
        this._dispatchFrameChange();
        last = now;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  pause() {
    this._playing = false;
    this._playBtn.textContent = '\u25B6';
  }

  setFPS(fps) { this._fps = fps; }

  addKeyframe(objectId, frame, data) {
    if (!this._tracks.has(objectId)) this._tracks.set(objectId, []);
    this._tracks.get(objectId).push({ frame, ...data });
    this._draw();
    if (typeof window !== 'undefined') {
      window.PALBus?.dispatchEvent(new CustomEvent('pal:keyframe-added', { detail: { objectId, frame } }));
    }
  }

  removeKeyframe(objectId, frame) {
    if (!this._tracks.has(objectId)) return;
    const kfs = this._tracks.get(objectId);
    const idx = kfs.findIndex(k => k.frame === frame);
    if (idx >= 0) kfs.splice(idx, 1);
    this._draw();
    if (typeof window !== 'undefined') {
      window.PALBus?.dispatchEvent(new CustomEvent('pal:keyframe-removed', { detail: { objectId, frame } }));
    }
  }

  _dispatchFrameChange() {
    if (typeof window !== 'undefined') {
      window.PALBus?.dispatchEvent(new CustomEvent('pal:frame-changed', { detail: { frame: this._frame } }));
    }
  }

  deleteSelectedKeyframe() {
    if (!this._selectedKF) return;
    this.removeKeyframe(this._selectedKF.objectId, this._selectedKF.frame);
    this._selectedKF = null;
    this._draw();
  }

  getSelectedKeyframe() { return this._selectedKF; }

  addKeyframeForObject(objectId, frame, viewer) {
    if (!viewer) return;
    const obj = viewer.objects?.get(objectId);
    if (!obj) return;
    const data = {
      frame,
      position: [obj.position.x, obj.position.y, obj.position.z],
      rotation: [
        THREE.MathUtils.radToDeg(obj.rotation.x),
        THREE.MathUtils.radToDeg(obj.rotation.y),
        THREE.MathUtils.radToDeg(obj.rotation.z),
      ],
    };
    this.addKeyframe(objectId, frame, data);
  }

  setGreyLevel(level) {
    const v = Math.round(level * 2.55);
    // Only tick marks and numbers — BG stays fixed
    this._tickColor = `rgb(${v},${v},${v})`;
    this._draw();
  }

  _showInterpMenu(x, y, kfHit) {
    // Remove existing menu
    document.getElementById('kf-interp-menu')?.remove();
    const menu = document.createElement('div');
    menu.id = 'kf-interp-menu';
    menu.style.cssText = `position:fixed;background:#1a1a18;border:1px solid #2a2a26;border-radius:4px;padding:4px 0;z-index:500;font-family:monospace;font-size:9px;min-width:140px;box-shadow:0 4px 12px rgba(0,0,0,.5)`;
    // Position menu, clamping to viewport edges
    const menuW = 160, menuH = 160; // approximate size
    const clampX = Math.min(x, window.innerWidth - menuW - 8);
    const clampY = Math.min(y, window.innerHeight - menuH - 8);
    menu.style.left = Math.max(4, clampX) + 'px';
    menu.style.top = Math.max(4, clampY) + 'px';
    const modes = [
      { key: 'linear', label: 'Linear', desc: 'Straight line' },
      { key: 'flat', label: 'Flat (Hold)', desc: 'No interpolation' },
      { key: 'bezier', label: 'Bezier (Smooth)', desc: 'Ease in/out' },
      { key: 'ease_in', label: 'Ease In', desc: 'Accelerate' },
      { key: 'ease_out', label: 'Ease Out', desc: 'Decelerate' },
    ];
    // Find current keyframe data
    const kfs = this._tracks.get(kfHit.objectId);
    const kf = kfs?.find(k => k.frame === kfHit.frame);
    const current = kf?.interpolation || 'linear';
    for (const m of modes) {
      const item = document.createElement('div');
      item.style.cssText = `padding:5px 12px;cursor:pointer;color:${m.key===current?'#f5c400':'#aaa'};display:flex;justify-content:space-between;align-items:center`;
      item.innerHTML = `<span>${m.key===current?'\u2713 ':''}${m.label}</span><span style="font-size:7px;color:#555">${m.desc}</span>`;
      item.addEventListener('mouseenter', () => { item.style.background = '#222'; });
      item.addEventListener('mouseleave', () => { item.style.background = 'transparent'; });
      item.addEventListener('click', () => {
        if (kf) kf.interpolation = m.key;
        menu.remove();
        this._draw();
        window.PALBus?.dispatchEvent(new CustomEvent('pal:keyframe-interp-changed', {
          detail: { objectId: kfHit.objectId, frame: kfHit.frame, interpolation: m.key },
        }));
      });
      menu.appendChild(item);
    }
    document.body.appendChild(menu);
    // Close on click outside
    const close = (e) => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('mousedown', close); } };
    setTimeout(() => document.addEventListener('mousedown', close), 0);
  }

  destroy() {
    this.pause();
    this.el.innerHTML = '';
  }
}
