import * as THREE from 'three';

/**
 * PALControls — extracted from PALViewer._bindEvents()
 * Handles mouse navigation (orbit/pan/dolly), keyboard shortcuts,
 * and reference overlay management.
 */
export class PALControls {
  constructor(viewer) {
    this.viewer = viewer;
    this._orbiting = false;
    this._panning = false;
    this._dollying = false;
    this._navStyle = localStorage.getItem('pal_nav_style') || 'pal';
    this._lastMouse = { x: 0, y: 0 };
    this._clickStart = null;
    this._refOverlayEl = null;
    this._invertOrbit = localStorage.getItem('pal_invert_orbit') === 'true';

    // Store bound references for cleanup
    this._boundHandlers = {};

    this._bindEvents();
  }

  _bindEvents() {
    // Detect if mouse is in the right panel (shotCam) of Director split
    this._isRightPanel = (e) => {
      if (this.viewer.mode !== 'director') return false;
      const rect = this.viewer.canvas.getBoundingClientRect();
      const split = rect.width * (this.viewer._splitRatio || 0.5);
      return (e.clientX - rect.left) > split;
    };

    this._onMouseDown = (e) => {
      const nav = this._navStyle || 'pal';
      this._altHeld = e.altKey;
      this._shiftHeldNav = e.shiftKey;
      const mode = this.viewer.mode;
      this._inRightPanel = this._isRightPanel(e);

      // RMB in camera view or director right panel = activate WASD mode
      if (e.button === 2 && (mode === 'camera' || (mode === 'director' && this._inRightPanel))) {
        this._wasdViaRMB = true;
        if (window._flyMode && !window._flyMode.active) window._flyMode.enter();
        this._lastMouse = { x: e.clientX, y: e.clientY };
        return;
      }

      // Director right panel: LMB = orbit shotCam, same as camera mode
      if (mode === 'director' && this._inRightPanel) {
        // Sync spherical from shotCam before orbiting
        const off = new THREE.Vector3().subVectors(this.viewer.shotCam.position, this.viewer._target);
        const r = Math.max(1, off.length());
        this.viewer._spherical.radius = r;
        this.viewer._spherical.phi = Math.acos(Math.max(-1, Math.min(1, off.y / r)));
        this.viewer._spherical.theta = Math.atan2(off.x, off.z);
        if (e.button === 0) { this._orbiting = true; this._orbitTarget = 'shot'; }
        if (e.button === 2) { this._panning = true; this._orbitTarget = 'shot'; }
        this._lastMouse = { x: e.clientX, y: e.clientY };
        if (e.button === 0) this._clickStart = { x: e.clientX, y: e.clientY };
        return;
      }

      // Default: orbit/pan controls for directorCam (left panel or layout)
      this._orbitTarget = 'director';
      if (nav === 'pal') {
        if (e.button === 0) this._orbiting = true;
        if (e.button === 2) this._panning = true;
      } else if (nav === 'maya') {
        if (e.altKey && e.button === 0) this._orbiting = true;
        if (e.altKey && e.button === 1) this._panning = true;
        if (e.altKey && e.button === 2) this._dollying = true;
      } else if (nav === 'blender') {
        if (e.button === 1 && e.shiftKey) this._panning = true;
        else if (e.button === 1) this._orbiting = true;
      } else if (nav === 'max') {
        if (e.button === 1 && e.altKey) this._orbiting = true;
        else if (e.button === 1) this._panning = true;
      }

      this._lastMouse = { x: e.clientX, y: e.clientY };

      if (e.button === 0) {
        this._clickStart = { x: e.clientX, y: e.clientY };
      }
    };

    this._onMouseMove = (e) => {
      const dx = e.clientX - this._lastMouse.x;
      const dy = e.clientY - this._lastMouse.y;
      this._lastMouse = { x: e.clientX, y: e.clientY };

      // WASD via RMB — send look input to fly mode
      if (this._wasdViaRMB && window._flyMode?.active) {
        window._flyMode.handleMouseLook(dx, dy);
        return;
      }

      const wasdActive = window._flyMode?.active;
      // Determine which camera to orbit: shotCam for camera mode or director right panel
      const orbitShot = this._orbitTarget === 'shot' || this.viewer.mode === 'camera';
      if (this._orbiting && !wasdActive) {
        const inv = (this.viewer._invertOrbit || this._invertOrbit) ? -1 : 1;
        this.viewer._spherical.theta += dx * 0.005 * inv;
        this.viewer._spherical.phi = Math.max(0.1, Math.min(Math.PI - 0.1, this.viewer._spherical.phi - dy * 0.005));
        if (orbitShot) {
          // Orbit shotCam
          const t = this.viewer._target, { theta, phi, radius } = this.viewer._spherical;
          this.viewer.shotCam.position.set(
            t.x + radius * Math.sin(phi) * Math.sin(theta),
            t.y + radius * Math.cos(phi),
            t.z + radius * Math.sin(phi) * Math.cos(theta)
          );
          this.viewer.shotCam.lookAt(t);
          const cp = this.viewer.objects.get('__camera__');
          if (cp) { cp.position.copy(this.viewer.shotCam.position); cp.rotation.copy(this.viewer.shotCam.rotation); }
        } else {
          this.viewer._updateOrbit();
        }
      }
      if (this._panning && !wasdActive) {
        const panSpeed = this.viewer._spherical.radius * 0.001;
        const right = new THREE.Vector3();
        const up = new THREE.Vector3(0, 1, 0);
        const cam = orbitShot ? this.viewer.shotCam : this.viewer.directorCam;
        right.crossVectors(cam.getWorldDirection(new THREE.Vector3()), up).normalize();
        this.viewer._target.addScaledVector(right, -dx * panSpeed);
        this.viewer._target.y += dy * panSpeed;
        if (orbitShot) {
          const t = this.viewer._target, { theta, phi, radius } = this.viewer._spherical;
          this.viewer.shotCam.position.set(
            t.x + radius * Math.sin(phi) * Math.sin(theta),
            t.y + radius * Math.cos(phi),
            t.z + radius * Math.sin(phi) * Math.cos(theta)
          );
          this.viewer.shotCam.lookAt(t);
          const cp = this.viewer.objects.get('__camera__');
          if (cp) { cp.position.copy(this.viewer.shotCam.position); cp.rotation.copy(this.viewer.shotCam.rotation); }
        } else {
          this.viewer._updateOrbit();
        }
      }
      if (this._dollying && !wasdActive) {
        this.viewer._spherical.radius = Math.max(2, Math.min(5000, this.viewer._spherical.radius * (1 + dy * 0.005)));
        this.viewer._updateOrbit();
      }
    };

    this._onMouseUp = (e) => {
      // RMB release exits WASD mode — re-sync orbit from new shotCam position
      if (e.button === 2 && this._wasdViaRMB) {
        this._wasdViaRMB = false;
        if (window._flyMode?.active) window._flyMode.exit();
        // Set orbit target to where camera is looking, then sync spherical
        if (this.viewer.mode === 'camera' || this.viewer.mode === 'director') {
          const cam = this.viewer.shotCam;
          const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
          // Place target 10 units in front of camera (natural orbit pivot)
          const pivotDist = 10;
          this.viewer._target.copy(cam.position).addScaledVector(fwd, pivotDist);
          this.viewer._spherical.radius = pivotDist;
          // Derive spherical angles from camera→target offset
          const off = new THREE.Vector3().subVectors(cam.position, this.viewer._target);
          this.viewer._spherical.phi = Math.acos(Math.max(-1, Math.min(1, off.y / pivotDist)));
          this.viewer._spherical.theta = Math.atan2(off.x, off.z);
        }
        return;
      }
      // Detect click (not drag) — LMB only
      if (e.button === 0 && this._clickStart) {
        const dx = Math.abs(e.clientX - this._clickStart.x);
        const dy = Math.abs(e.clientY - this._clickStart.y);
        if (dx < 3 && dy < 3) {
          const id = this.viewer.pickObject(e.clientX, e.clientY);
          this.viewer.selectObject(id, e.shiftKey);
        }
      }
      this._orbiting = false;
      this._panning = false;
      this._dollying = false;
      this._clickStart = null;
    };

    this._onWheel = (e) => {
      e.preventDefault();
      this.viewer._spherical.radius = Math.max(2, Math.min(5000, this.viewer._spherical.radius * (1 + e.deltaY * 0.001)));
      this.viewer._updateOrbit();
    };

    this._onResize = () => this.viewer._resize();

    // Canvas mousedown (with MMB preventDefault)
    this._boundHandlers.canvasMouseDown = (e) => { if (e.button === 1) e.preventDefault(); this._onMouseDown(e); };
    this.viewer.canvas.addEventListener('mousedown', this._boundHandlers.canvasMouseDown);

    window.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('mouseup', this._onMouseUp);
    this.viewer.canvas.addEventListener('wheel', this._onWheel, { passive: false });

    this._boundHandlers.auxclick = (e) => { if (e.button === 1) e.preventDefault(); };
    this.viewer.canvas.addEventListener('auxclick', this._boundHandlers.auxclick); // prevent MMB auto-scroll

    this._boundHandlers.contextmenu = (e) => e.preventDefault();
    this.viewer.canvas.addEventListener('contextmenu', this._boundHandlers.contextmenu);

    window.addEventListener('resize', this._onResize);

    // Push undo snapshot when gizmo drag starts
    if (typeof window !== 'undefined' && window.PALBus) {
      const _self = this;
      this._boundHandlers.transformStart = (e) => {
        if (e.detail?.objectId) _self.viewer.pushUndo(e.detail.objectId);
      };
      window.PALBus.addEventListener('pal:transform-start', this._boundHandlers.transformStart);
    }

    // Sync shotCam when camera proxy is moved via gizmos
    this._boundHandlers.camSync = () => {
      const camProxy = this.viewer.objects.get('__camera__');
      if (camProxy && this.viewer.gizmos.attachedObject === camProxy) {
        this.viewer.shotCam.position.copy(camProxy.position);
        this.viewer.shotCam.rotation.copy(camProxy.rotation);
        if (this.viewer.frustumHelper) {
          this.viewer.frustumHelper.position.copy(camProxy.position);
          this.viewer.frustumHelper.rotation.copy(camProxy.rotation);
        }
      }
    };
    window.addEventListener('mousemove', this._boundHandlers.camSync);

    // Keyboard shortcuts — gizmos, framing, keyframes, axis lock
    let _pendingMode = null;
    this._boundHandlers.keydown = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
      // Reset transform/rotation
      if ((e.key === 'g' || e.key === 'G') && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (this.viewer.selectedId && this.viewer.objects.has(this.viewer.selectedId)) {
          this.viewer.pushUndo(this.viewer.selectedId);
          const obj = this.viewer.objects.get(this.viewer.selectedId);
          obj.position.set(0, 0, 0);
          if (this.viewer.selectedId === '__camera__') {
            this.viewer.shotCam.position.set(0, 1.65, 5);
            this.viewer.shotCam.updateProjectionMatrix();
            if (this.viewer.frustumHelper) this.viewer.frustumHelper.position.copy(this.viewer.shotCam.position);
          }
          window.PALBus?.dispatchEvent(new CustomEvent('pal:hud-hint', { detail: { message: 'Position reset to origin', duration: 1000 } }));
        }
        return;
      }
      if ((e.key === 'r' || e.key === 'R') && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (this.viewer.selectedId && this.viewer.objects.has(this.viewer.selectedId)) {
          this.viewer.pushUndo(this.viewer.selectedId);
          const obj = this.viewer.objects.get(this.viewer.selectedId);
          obj.rotation.set(0, 0, 0);
          if (this.viewer.selectedId === '__camera__') {
            this.viewer.shotCam.rotation.set(0, 0, 0);
            this.viewer.shotCam.updateProjectionMatrix();
            if (this.viewer.frustumHelper) this.viewer.frustumHelper.rotation.set(0, 0, 0);
          }
          window.PALBus?.dispatchEvent(new CustomEvent('pal:hud-hint', { detail: { message: 'Rotation reset to zero', duration: 1000 } }));
        }
        return;
      }
      // Gizmo mode
      if (e.key === 'g' || e.key === 'G') { this.viewer.gizmos.setMode('translate'); _pendingMode = 'translate'; return; }
      if (e.key === 'r' || e.key === 'R') { this.viewer.gizmos.setMode('rotate'); _pendingMode = 'rotate'; return; }
      // Axis lock after G/R
      if (_pendingMode && ['x','X','y','Y','z','Z'].includes(e.key)) {
        this.viewer.gizmos.lockAxis(e.key.toUpperCase());
        this.viewer.gizmos.highlightAxis(e.key.toUpperCase());
        _pendingMode = null; return;
      }
      // Escape
      if (e.key === 'Escape') { this.viewer.gizmos.detach(); this.viewer.gizmos.lockAxis(null); this.viewer.gizmos.highlightAxis(null); _pendingMode = null; this.viewer.selectObject(null); return; }
      // Frame selected
      if (e.key === 'f' || e.key === 'F') { this.viewer.frameSelected(); return; }
      // Spacebar = play/pause timeline
      if (e.key === ' ') { e.preventDefault(); if (window._palTimeline) { window._palTimeline._playing ? window._palTimeline.pause() : window._palTimeline.play(); } return; }
      // Delete selected keyframe or object
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (window._palTimeline?.getSelectedKeyframe()) { window._palTimeline.deleteSelectedKeyframe(); return; }
        this.viewer.deleteSelected(); return;
      }
      // Undo
      if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey)) { this.viewer.undo(); return; }
      // Gizmo size
      if (e.key === '+' || e.key === '=') { this.viewer.gizmos._sizeMultiplier += 0.2; return; }
      if (e.key === '-') { this.viewer.gizmos._sizeMultiplier = Math.max(0.2, this.viewer.gizmos._sizeMultiplier - 0.2); return; }
      // Keyframe: I or K = set, Alt+K = remove
      if ((e.key === 'i' || e.key === 'I' || e.key === 'k' || e.key === 'K') && !e.altKey) {
        if (this.viewer.selectedId && window._palTimeline) {
          window._palTimeline.addKeyframeForObject(this.viewer.selectedId, window._palTimeline.getCurrentFrame(), this.viewer);
        }
        return;
      }
      if ((e.key === 'k' || e.key === 'K') && e.altKey) {
        if (this.viewer.selectedId && window._palTimeline) {
          window._palTimeline.removeKeyframe(this.viewer.selectedId, window._palTimeline.getCurrentFrame());
        }
        return;
      }
    };
    window.addEventListener('keydown', this._boundHandlers.keydown);
  }

  // ── Reference image overlay ────────────────────────────────

  setReferenceOverlay(imageFile, opacity = 0.25) {
    this.clearReferenceOverlay();
    const url = URL.createObjectURL(imageFile);
    this._refOverlayEl = document.createElement('img');
    this._refOverlayEl.src = url;
    this._refOverlayEl.style.cssText = `position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:${opacity};pointer-events:none;mix-blend-mode:screen;`;
    this.viewer.canvas.parentElement.appendChild(this._refOverlayEl);
  }

  setReferenceOverlayOpacity(opacity) {
    if (this._refOverlayEl) this._refOverlayEl.style.opacity = opacity;
  }

  clearReferenceOverlay() {
    if (this._refOverlayEl) {
      URL.revokeObjectURL(this._refOverlayEl.src);
      this._refOverlayEl.remove();
      this._refOverlayEl = null;
    }
  }

  // ── Cleanup ────────────────────────────────────────────────

  destroy() {
    this.viewer.canvas.removeEventListener('mousedown', this._boundHandlers.canvasMouseDown);
    window.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('mouseup', this._onMouseUp);
    this.viewer.canvas.removeEventListener('wheel', this._onWheel);
    this.viewer.canvas.removeEventListener('auxclick', this._boundHandlers.auxclick);
    this.viewer.canvas.removeEventListener('contextmenu', this._boundHandlers.contextmenu);
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('mousemove', this._boundHandlers.camSync);
    window.removeEventListener('keydown', this._boundHandlers.keydown);

    if (typeof window !== 'undefined' && window.PALBus && this._boundHandlers.transformStart) {
      window.PALBus.removeEventListener('pal:transform-start', this._boundHandlers.transformStart);
    }

    this.clearReferenceOverlay();
    this._boundHandlers = {};
  }
}
