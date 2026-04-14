// frontend/pal/camera/lens_registry.js
// Loads and provides lookup methods for camera/lens registry.
// No Three.js dependency. Pure data module.

let _cameras = null;
let _lenses = null;
let _loaded = false;

export const LensRegistry = {

  async load() {
    if (_loaded) return;
    try {
      const [camResp, lensResp] = await Promise.all([
        fetch('/pal/static/data/cameras.json'),
        fetch('/pal/static/data/lenses.json'),
      ]);
      _cameras = (await camResp.json()).cameras;
      _lenses = (await lensResp.json()).lenses;
      _loaded = true;
      console.log(`[LensRegistry] loaded: ${_cameras.length} cameras, ${_lenses.length} lenses`);
      window.PALBus?.dispatchEvent(new CustomEvent('pal:registry-loaded'));
    } catch (e) {
      console.error('[LensRegistry] failed to load:', e);
    }
  },

  isLoaded() { return _loaded; },

  getCameras() { return _cameras ?? []; },
  getLenses() { return _lenses ?? []; },

  getCameraByModel(make, model) {
    return _cameras?.find(c => c.make === make && c.model === model) ?? null;
  },

  getLensBySpec(make, series, focal_mm) {
    return _lenses?.find(
      l => l.make === make && l.series === series && l.focal_length_mm === focal_mm
    ) ?? null;
  },

  getMakes() {
    return [...new Set(_cameras?.map(c => c.make) ?? [])];
  },

  getModelsForMake(make) {
    return _cameras?.filter(c => c.make === make) ?? [];
  },

  getLensMakes() {
    return [...new Set(_lenses?.map(l => l.make) ?? [])];
  },

  getLensSeriesForMake(make) {
    return [...new Set(_lenses?.filter(l => l.make === make).map(l => l.series) ?? [])];
  },

  getFocalLengthsForSeries(make, series) {
    return _lenses
      ?.filter(l => l.make === make && l.series === series)
      .map(l => l.focal_length_mm)
      .sort((a, b) => a - b) ?? [];
  },

  getLensesForSeries(make, series) {
    return _lenses?.filter(l => l.make === make && l.series === series) ?? [];
  },
};
