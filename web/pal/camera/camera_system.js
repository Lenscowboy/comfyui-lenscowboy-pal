// frontend/pal/camera/camera_system.js
// Manages camera/lens selection and cinematographic calculations.
// Communicates via PALBus. No Three.js internals.

import { LensRegistry } from './lens_registry.js';

function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }

export class CameraSystem {
  constructor(viewer) {
    this.viewer = viewer;
    this.activeCamera = null;
    this.activeMode = null;
    this.activeLens = null;
    this.aperture = 2.8;
    this.focusDistance = 5.0;
    this.extractionAspect = null;
    this._calculated = null;

    LensRegistry.load().then(() => this._setDefault());
  }

  _setDefault() {
    const cam = LensRegistry.getCameraByModel('ARRI', 'ALEXA 35');
    const lens = LensRegistry.getLensBySpec('Zeiss', 'Supreme Prime', 35);
    if (cam) this.setCamera(cam, cam.modes.find(m => m.aspect_ratio === '16:9') || cam.modes[0]);
    if (lens) this.setLens(lens);
  }

  // ── Setters ────────────────────────────────────────────────

  setCamera(cameraBody, mode) {
    this.activeCamera = cameraBody;
    this.activeMode = mode ?? cameraBody.modes[0];
    this._recalculate();
    this._dispatch();
  }

  setMode(mode) {
    this.activeMode = mode;
    this._recalculate();
    this._dispatch();
  }

  setLens(lens) {
    this.activeLens = lens;
    this._recalculate();
    this._dispatch();
  }

  setFocalLength(mm) {
    if (!this.activeLens) {
      this.activeLens = { make: 'Custom', series: 'Custom', focal_length_mm: mm, max_aperture: 1.4 };
    } else {
      this.activeLens = { ...this.activeLens, focal_length_mm: mm };
    }
    this._recalculate();
    this._dispatch();
  }

  setAperture(tStop) {
    this.aperture = tStop;
    this._recalculate();
    this._dispatch();
  }

  setFocusDistance(metres) {
    this.focusDistance = metres;
    this._recalculate();
    this._dispatch();
  }

  setExtractionAspect(aspectString) {
    this.extractionAspect = aspectString || null;
    this._recalculate();
    this._dispatch();
  }

  // ── Calculations ───────────────────────────────────────────

  _recalculate() {
    if (!this.activeMode || !this.activeLens) return;
    this._calculated = this._computeAll();
    if (this.viewer?.shotCam) {
      this.viewer.shotCam.fov = this._calculated.vFOV;
      this.viewer.shotCam.aspect = this._calculated.aspectRatio;
      this.viewer.shotCam.updateProjectionMatrix();
    }
  }

  _computeAll() {
    const sw = this.activeMode.sensor_width_mm;
    const sh = this.activeMode.sensor_height_mm;
    const fl = this.activeLens.focal_length_mm;
    const f = this.aperture;
    const d = this.focusDistance * 1000; // mm

    // Extraction window
    let ew = sw, eh = sh;
    if (this.extractionAspect) {
      const [aw, ah] = this.extractionAspect.split(':').map(Number);
      const targetAR = aw / ah;
      const sensorAR = sw / sh;
      if (targetAR < sensorAR) { ew = sh * targetAR; } else { eh = sw / targetAR; }
    }

    // Field of view
    const hFOV = 2 * Math.atan(ew / (2 * fl)) * (180 / Math.PI);
    const vFOV = 2 * Math.atan(eh / (2 * fl)) * (180 / Math.PI);
    const dFOV = 2 * Math.atan(Math.sqrt(ew * ew + eh * eh) / (2 * fl)) * (180 / Math.PI);

    // Circle of confusion (sensor diagonal / 1500)
    const sensorDiag = Math.sqrt(sw * sw + sh * sh);
    const coc = sensorDiag / 1500;

    // Hyperfocal distance (mm)
    const hyperfocal = (fl * fl) / (f * coc);

    // Depth of field
    let nearLimit, farLimit, dof;
    if (d >= hyperfocal) {
      nearLimit = hyperfocal / 2;
      farLimit = Infinity;
      dof = Infinity;
    } else {
      nearLimit = (d * (hyperfocal - fl)) / (hyperfocal + d - 2 * fl);
      farLimit = (d * (hyperfocal - fl)) / (hyperfocal - d);
      dof = farLimit - nearLimit;
    }

    return {
      hFOV: round2(hFOV), vFOV: round2(vFOV), dFOV: round2(dFOV),
      aspectRatio: round4(ew / eh),
      extractionW: round2(ew), extractionH: round2(eh),
      hyperfocal_m: round2(hyperfocal / 1000),
      nearLimit_m: round2(nearLimit / 1000),
      farLimit_m: farLimit === Infinity ? Infinity : round2(farLimit / 1000),
      dof_m: dof === Infinity ? Infinity : round2(dof / 1000),
      coc_mm: round4(coc),
      squeeze: this.activeLens.squeeze_factor ?? 1.0,
    };
  }

  getCalculated() { return this._calculated ?? null; }

  getDisplayData() {
    const c = this._calculated;
    const cam = this.activeCamera;
    const mode = this.activeMode;
    const lens = this.activeLens;
    if (!c || !cam || !lens) return null;
    return {
      cameraLabel: `${cam.make} ${cam.model}`,
      modeLabel: mode?.name ?? '',
      lensLabel: `${lens.make} ${lens.series ?? ''} ${lens.focal_length_mm}mm`,
      aperture: `T${this.aperture}`,
      focusDist: `${this.focusDistance}m`,
      fovH: `${c.hFOV}\u00b0`, fovV: `${c.vFOV}\u00b0`,
      aspectRatio: this.extractionAspect ?? mode?.aspect_ratio ?? '16:9',
      nearLimit: `${c.nearLimit_m}m`,
      farLimit: c.farLimit_m === Infinity ? '\u221e' : `${c.farLimit_m}m`,
      dof: c.dof_m === Infinity ? '\u221e' : `${c.dof_m}m`,
      hyperfocal: `${c.hyperfocal_m}m`,
      extraction: `${Math.round(c.extractionW)}\u00d7${Math.round(c.extractionH)}`,
    };
  }

  _dispatch() {
    window.PALBus?.dispatchEvent(new CustomEvent('pal:camera-changed', {
      detail: {
        camera: this.activeCamera, mode: this.activeMode,
        lens: this.activeLens, aperture: this.aperture,
        focus: this.focusDistance, calculated: this._calculated,
        display: this.getDisplayData(),
      }
    }));
  }

  // ── Serialisation ──────────────────────────────────────────

  toJSON() {
    return {
      camera_make: this.activeCamera?.make, camera_model: this.activeCamera?.model,
      camera_mode: this.activeMode?.name, lens_make: this.activeLens?.make,
      lens_series: this.activeLens?.series, focal_length_mm: this.activeLens?.focal_length_mm,
      aperture: this.aperture, focus_distance_m: this.focusDistance,
      extraction_aspect: this.extractionAspect,
    };
  }

  fromJSON(data) {
    if (!data) return;
    const cam = LensRegistry.getCameraByModel(data.camera_make, data.camera_model);
    if (cam) {
      const mode = cam.modes.find(m => m.name === data.camera_mode);
      this.setCamera(cam, mode ?? cam.modes[0]);
    }
    const lens = LensRegistry.getLensBySpec(data.lens_make, data.lens_series, data.focal_length_mm);
    if (lens) this.setLens(lens);
    if (data.aperture) this.setAperture(data.aperture);
    if (data.focus_distance_m) this.setFocusDistance(data.focus_distance_m);
    if (data.extraction_aspect) this.setExtractionAspect(data.extraction_aspect);
  }
}
