// pal/web/camera/filmic_hud.js
// Cinematic overlay: frame lines, safe areas, DOF bar, corner metadata.
// Draws to a 2D canvas overlay. Only visible in camera + fly modes.

export class FilmicHUD {
  constructor(viewer, cameraSystem) {
    this.viewer = viewer;
    this.cameraSystem = cameraSystem;
    this.visible = false;

    this.showFrameLines = true;
    this.showSafeAreas = true;
    this.showDOFIndicator = true;
    this.showCornerMeta = true;
    this.showCrossHair = false;

    // Wrap the Three.js canvas in a relative container so HUD overlays align to it
    this._viewportWrap = document.createElement('div');
    this._viewportWrap.style.cssText = 'position:relative;flex:1 1 0;min-height:0;overflow:hidden;';
    const threeCanvas = viewer.canvas;
    threeCanvas.parentElement.insertBefore(this._viewportWrap, threeCanvas);
    this._viewportWrap.appendChild(threeCanvas);
    threeCanvas.style.cssText = 'display:block;width:100%;height:100%;';

    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:10;';
    this.ctx = this.canvas.getContext('2d');
    this._viewportWrap.appendChild(this.canvas);

    this._frame = null;
    this._dofBar = null; // { x, y, w, h, maxDist } — set during draw
    this._dragging = false;
    new ResizeObserver(() => this._resize()).observe(this._viewportWrap);
    this._resize();
    this._bindInteraction();

    window.PALBus?.addEventListener('pal:camera-changed', () => this.redraw());
    window.PALBus?.addEventListener('pal:camera-moved', () => this.redraw());
    window.PALBus?.addEventListener('pal:mode-changed', e => {
      this.visible = e.detail.mode === 'camera' || e.detail.mode === 'fly' || e.detail.mode === 'director';
      this.redraw();
    });
  }

  _resize() {
    const w = this._viewportWrap.clientWidth;
    const h = this._viewportWrap.clientHeight;
    this.canvas.width = w;
    this.canvas.height = h;
    this.redraw();
  }

  redraw() {
    const ctx = this.ctx;
    const fullW = this.canvas.width, fullH = this.canvas.height;
    ctx.clearRect(0, 0, fullW, fullH);
    if (!this.visible) { this._updateDOFOverlay(); return; }

    const display = this.cameraSystem?.getDisplayData();
    const calc = this.cameraSystem?.getCalculated();
    if (!display || !calc) return;

    // In director mode, only draw on the right panel
    let ox = 0, w = fullW, h = fullH;
    if (this.viewer.mode === 'director') {
      const split = Math.floor(fullW * (this.viewer._splitRatio || 0.5));
      ox = split;
      w = fullW - split;
    }

    const aspect = calc.aspectRatio;

    // ── Frame lines ──────────────────────────────────────
    if (this.showFrameLines) {
      let fw, fh;
      if (w / h > aspect) { fh = h * 0.90; fw = fh * aspect; }
      else { fw = w * 0.90; fh = fw / aspect; }
      const fx = ox + (w - fw) / 2, fy = (h - fh) / 2;

      // Mask outside frame (within the panel area)
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(ox, 0, w, fy);
      ctx.fillRect(ox, h - fy, w, fy);
      ctx.fillRect(ox, fy, fx - ox, fh);
      ctx.fillRect(fx + fw, fy, ox + w - fx - fw, fh);

      // Frame border
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.lineWidth = 1;
      ctx.strokeRect(fx, fy, fw, fh);
      this._frame = { x: fx, y: fy, w: fw, h: fh };
    }

    // ── Safe areas ───────────────────────────────────────
    if (this.showSafeAreas && this._frame) {
      const { x, y, w: fw, h: fh } = this._frame;
      this._safeRect(x + fw * 0.05, y + fh * 0.05, fw * 0.90, fh * 0.90, 'rgba(255,255,255,0.2)');
      this._safeRect(x + fw * 0.10, y + fh * 0.10, fw * 0.80, fh * 0.80, 'rgba(255,255,100,0.15)');
    }

    // ── Crosshair ────────────────────────────────────────
    if (this.showCrossHair) {
      const cx = ox + w / 2, cy = h / 2, sz = 20;
      ctx.strokeStyle = 'rgba(255,255,255,0.4)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx - sz, cy); ctx.lineTo(cx + sz, cy);
      ctx.moveTo(cx, cy - sz); ctx.lineTo(cx, cy + sz);
      ctx.stroke();
    }

    // ── Corner metadata ──────────────────────────────────
    if (this.showCornerMeta) this._drawCorners(display, ox, w, h);

    // ── DOF bar ──────────────────────────────────────────
    if (this.showDOFIndicator && this._frame) this._drawDOF(calc, this._frame);
  }

  _safeRect(x, y, w, h, color) {
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = 1;
    this.ctx.setLineDash([4, 4]);
    this.ctx.strokeRect(x, y, w, h);
    this.ctx.setLineDash([]);
  }

  _drawCorners(d, ox, w, h) {
    const ctx = this.ctx, pad = 14, lh = 16;
    ctx.font = '11px monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';

    // Top left — camera + mode
    [d.cameraLabel, d.modeLabel, d.aspectRatio].forEach((line, i) => {
      ctx.fillText(line, ox + pad, pad + 14 + i * lh);
    });

    // Top right — lens + aperture
    const tr = [d.lensLabel, `${d.aperture}  ${d.fovH} \u00d7 ${d.fovV}`];
    tr.forEach((line, i) => {
      ctx.fillText(line, ox + w - pad - ctx.measureText(line).width, pad + 14 + i * lh);
    });

    // Bottom left — focus + DOF
    const bl = [`Focus: ${d.focusDist}`, `DOF: ${d.nearLimit} \u2013 ${d.farLimit}`, `HFD: ${d.hyperfocal}`];
    bl.forEach((line, i) => {
      ctx.fillText(line, ox + pad, h - pad - (bl.length - 1 - i) * lh);
    });

    // Bottom right — extraction
    ctx.fillText(d.extraction, ox + w - pad - ctx.measureText(d.extraction).width, h - pad);
  }

  _drawDOF(calc, frame) {
    const barY = frame.y + frame.h + 8;
    const barW = frame.w * 0.6, barH = 4;
    const barX = frame.x + (frame.w - barW) / 2;
    const maxDist = Math.max(calc.hyperfocal_m * 1.5, 50);

    // Store bounds for interaction hit-testing
    this._dofBar = { x: barX, y: barY, w: barW, h: barH, maxDist };

    const nearPct = Math.min(calc.nearLimit_m / maxDist, 1);
    const farPct = calc.farLimit_m === Infinity ? 1 : Math.min(calc.farLimit_m / maxDist, 1);

    // Track
    this.ctx.fillStyle = 'rgba(255,255,255,0.15)';
    this.ctx.fillRect(barX, barY, barW, barH);
    // DOF zone
    this.ctx.fillStyle = 'rgba(100,220,100,0.5)';
    this.ctx.fillRect(barX + nearPct * barW, barY, (farPct - nearPct) * barW, barH);
    // Focus marker
    const focusPct = Math.min(this.cameraSystem.focusDistance / maxDist, 1);
    this.ctx.fillStyle = 'rgba(255,255,255,0.9)';
    this.ctx.fillRect(barX + focusPct * barW - 1, barY - 2, 2, barH + 4);

    // Hint text
    this.ctx.font = '9px monospace';
    this.ctx.fillStyle = 'rgba(255,255,255,0.3)';
    this.ctx.fillText('drag=focus  scroll=f-stop', barX, barY + barH + 12);

    // Position the interactive overlay div over the DOF bar
    this._updateDOFOverlay();
  }

  // ── Interactive DOF bar ─────────────────────────────────

  _isOverDOFBar(x, y) {
    if (!this._dofBar) return false;
    const b = this._dofBar;
    // Generous hit zone — 20px above and below the bar
    return x >= b.x - 10 && x <= b.x + b.w + 10 && y >= b.y - 20 && y <= b.y + b.h + 20;
  }

  _isOverCornerBL(x, y) {
    if (!this._frame) return false;
    const h = this.canvas.height;
    // Bottom-left corner area where Focus/DOF text is drawn
    let ox = 0;
    if (this.viewer.mode === 'director') ox = Math.floor(this.canvas.width * (this.viewer._splitRatio || 0.5));
    return x >= ox && x <= ox + 160 && y >= h - 60 && y <= h;
  }

  _focusFromX(clientX) {
    if (!this._dofBar) return null;
    const b = this._dofBar;
    const pct = Math.max(0, Math.min(1, (clientX - b.x) / b.w));
    return Math.max(0.3, pct * b.maxDist);
  }

  _bindInteraction() {
    // Create a small overlay div for DOF bar interaction — keeps HUD canvas pointer-events:none
    this._dofOverlay = document.createElement('div');
    this._dofOverlay.style.cssText = 'position:absolute;z-index:11;cursor:ew-resize;display:none;';
    this._viewportWrap.appendChild(this._dofOverlay);

    this._dofOverlay.addEventListener('mousedown', (e) => {
      if (!this.visible || !this.showDOFIndicator) return;
      this._dragging = true;
      e.preventDefault();
      e.stopPropagation();
      const rect = this.canvas.getBoundingClientRect();
      const focus = this._focusFromX(e.clientX - rect.left);
      if (focus !== null) this._setFocus(focus);
    });

    window.addEventListener('mousemove', (e) => {
      if (!this._dragging) return;
      e.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      const focus = this._focusFromX(e.clientX - rect.left);
      if (focus !== null) this._setFocus(focus);
    });

    window.addEventListener('mouseup', () => { this._dragging = false; });

    this._dofOverlay.addEventListener('wheel', (e) => {
      if (!this.visible || !this.showDOFIndicator) return;
      e.preventDefault();
      e.stopPropagation();
      const current = this.cameraSystem?.aperture || 2.8;
      const step = e.deltaY > 0 ? 0.2 : -0.2;
      this._setAperture(Math.max(1, Math.min(22, current + step)));
    }, { passive: false });
  }

  _updateDOFOverlay() {
    if (!this._dofOverlay || !this._dofBar || !this.visible || !this.showDOFIndicator) {
      if (this._dofOverlay) this._dofOverlay.style.display = 'none';
      return;
    }
    const b = this._dofBar;
    this._dofOverlay.style.display = 'block';
    this._dofOverlay.style.left = (b.x - 10) + 'px';
    this._dofOverlay.style.top = (b.y - 20) + 'px';
    this._dofOverlay.style.width = (b.w + 20) + 'px';
    this._dofOverlay.style.height = (b.h + 40) + 'px';
  }

  _setFocus(dist) {
    const rounded = Math.round(dist * 10) / 10;
    if (this.cameraSystem) this.cameraSystem.setFocusDistance(rounded);
    const input = document.getElementById('focus-input');
    if (input) input.value = rounded.toFixed(1);
    const slider = document.getElementById('focus-slider');
    if (slider) slider.value = Math.min(100, rounded);
  }

  _setAperture(val) {
    const rounded = Math.round(val * 10) / 10;
    if (this.cameraSystem) this.cameraSystem.setAperture(rounded);
    const input = document.getElementById('aperture-input');
    if (input) input.value = rounded.toFixed(1);
    const slider = document.getElementById('aperture-slider');
    if (slider) slider.value = rounded;
  }

  // ── Public controls ────────────────────────────────────
  setVisible(v) { this.visible = v; this.redraw(); }
  setFrameLines(v) { this.showFrameLines = v; this.redraw(); }
  setSafeAreas(v) { this.showSafeAreas = v; this.redraw(); }
  setDOFIndicator(v) { this.showDOFIndicator = v; this.redraw(); }
  setCornerMeta(v) { this.showCornerMeta = v; this.redraw(); }
  setCrossHair(v) { this.showCrossHair = v; this.redraw(); }
}
