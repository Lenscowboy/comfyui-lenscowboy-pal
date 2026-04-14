// frontend/pal/hud.js
// PAL — 2D HUD overlay: editable lens, framing, movement, mood

const FRAMING = ['extreme_wide','wide','medium_wide','medium','medium_close','close_up','extreme_close','aerial','pov','over_the_shoulder'];
const MOVEMENT = ['static','push_in','pull_out','pan_left','pan_right','tilt_up','tilt_down','crane_up','crane_down','orbit','handheld'];
const MOOD = ['neutral','tense','dramatic','romantic','comedic','melancholic','epic','intimate','suspense','joyful'];

const hudStyle = 'background:#1a1a18;border:1px solid #2a2a26;border-radius:3px;color:#d0d0c8;font-family:monospace;font-size:9px;padding:2px 4px;outline:none;';
const selStyle = hudStyle + '-webkit-appearance:none;-moz-appearance:none;cursor:pointer;';
const inpStyle = hudStyle + 'width:44px;text-align:right;-moz-appearance:textfield;';

function makeSelect(id, options, value) {
  return `<select id="${id}" style="${selStyle}">${options.map(o =>
    `<option value="${o}" ${o === value ? 'selected' : ''}>${o.replace(/_/g, ' ')}</option>`
  ).join('')}</select>`;
}

export class HUD {
  constructor(containerEl) {
    this.el = containerEl;
    this._extraction = null;
    this._cameraSetup = null;
    this._onChange = null;
  }

  setOnChange(fn) { this._onChange = fn; }

  update(extraction, cameraSetup) {
    if (!extraction || !cameraSetup) { this.el.innerHTML = ''; return; }
    this._extraction = extraction;
    this._cameraSetup = cameraSetup;

    const cam = extraction.camera || {};
    const fl = (cameraSetup.focal_length_mm || 50).toFixed(1);
    const fov = (cameraSetup.fov || 39.6).toFixed(1);
    const movement = cam.movement || 'static';
    const framing = extraction.framing || 'medium_shot';
    const mood = extraction.mood || 'neutral';

    this.el.innerHTML = `
      <input id="hud-focal" type="text" inputmode="numeric" value="${fl}" style="${inpStyle}width:48px;-webkit-appearance:none;">
      <span style="font-size:8px;color:#666">mm</span>
      <input id="hud-fov" type="text" inputmode="numeric" value="${fov}" style="${inpStyle}-webkit-appearance:none;">
      <span style="font-size:8px;color:#666">&deg;</span>
      ${makeSelect('hud-framing', FRAMING, framing)}
      ${makeSelect('hud-movement', MOVEMENT, movement)}
      ${makeSelect('hud-mood', MOOD, mood)}
    `;

    this._bindEvents();
  }

  _bindEvents() {
    const focalEl = document.getElementById('hud-focal');
    const fovEl = document.getElementById('hud-fov');
    const framingEl = document.getElementById('hud-framing');
    const movementEl = document.getElementById('hud-movement');
    const moodEl = document.getElementById('hud-mood');

    // Mouse wheel on focal/fov
    if (focalEl) focalEl.addEventListener('wheel', (e) => {
      e.preventDefault();
      const fl = Math.max(8, Math.min(600, (parseFloat(focalEl.value) || 50) + (e.deltaY < 0 ? 1 : -1)));
      focalEl.value = fl.toFixed(1);
      focalEl.dispatchEvent(new Event('input'));
    }, { passive: false });

    if (fovEl) fovEl.addEventListener('wheel', (e) => {
      e.preventDefault();
      const fov = Math.max(4, Math.min(120, (parseFloat(fovEl.value) || 40) + (e.deltaY < 0 ? 0.5 : -0.5)));
      fovEl.value = fov.toFixed(1);
      fovEl.dispatchEvent(new Event('input'));
    }, { passive: false });

    if (focalEl) focalEl.addEventListener('input', () => {
      const fl = parseFloat(focalEl.value) || 50;
      const fov = 2 * Math.atan(18 / fl) * (180 / Math.PI);
      if (fovEl) fovEl.value = fov.toFixed(1);
      if (this._cameraSetup) {
        this._cameraSetup.fov = fov;
        this._cameraSetup.focal_length_mm = fl;
      }
      this._fireChange('fov', fov);
    });

    if (fovEl) fovEl.addEventListener('input', () => {
      const fov = parseFloat(fovEl.value) || 39.6;
      const fl = 18 / Math.tan(fov / 2 * Math.PI / 180);
      if (focalEl) focalEl.value = fl.toFixed(1);
      if (this._cameraSetup) {
        this._cameraSetup.fov = fov;
        this._cameraSetup.focal_length_mm = fl;
      }
      this._fireChange('fov', fov);
    });

    if (framingEl) framingEl.addEventListener('change', () => {
      if (this._extraction) this._extraction.framing = framingEl.value;
      this._fireChange('framing', framingEl.value);
    });

    if (movementEl) movementEl.addEventListener('change', () => {
      if (this._extraction?.camera) this._extraction.camera.movement = movementEl.value;
      this._fireChange('movement', movementEl.value);
    });

    if (moodEl) moodEl.addEventListener('change', () => {
      if (this._extraction) this._extraction.mood = moodEl.value;
      this._fireChange('mood', moodEl.value);
    });
  }

  _fireChange(field, value) {
    if (this._onChange) this._onChange(field, value, this._extraction, this._cameraSetup);
    if (typeof window !== 'undefined') {
      window.PALBus?.dispatchEvent(new CustomEvent('pal:hud-changed', {
        detail: { field, value, extraction: this._extraction, camera: this._cameraSetup },
      }));
    }
  }

  getExtraction() { return this._extraction; }
  getCameraSetup() { return this._cameraSetup; }
  clear() { this.el.innerHTML = ''; }
}
