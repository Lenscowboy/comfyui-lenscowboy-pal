// frontend/pal/gizmos.js
// PAL — Custom transform gizmos: translate, rotate, camera focal length

import * as THREE from 'three';

const AXIS_COLORS = { x: 0xe84040, y: 0x40e840, z: 0x4080e8 };
const FOCAL_COLOR = 0xf5c400;

const CONSTRAINTS = {
  human_standing:   { translate: 'XZ', rotate: 'Y' },
  human_seated:     { translate: 'XZ', rotate: 'Y' },
  vehicle_car:      { translate: 'XZ', rotate: 'Y' },
  vehicle_large:    { translate: 'XZ', rotate: 'Y' },
  camera_rig:       { translate: 'XYZ', rotate: 'XYZ', focal: true },
  terrain_plane:    { translate: 'XZ', rotate: null },
  terrain_canyon:   { translate: 'XYZ', rotate: null },
  building_generic: { translate: 'XZ', rotate: 'Y' },
  wall_plane:       { translate: 'XYZ', rotate: 'Y' },
  tree_generic:     { translate: 'XZ', rotate: 'Y' },
  prop_generic:     { translate: 'XYZ', rotate: 'XYZ' },
};

function axisMat(hex, opacity = 1) {
  return new THREE.MeshBasicMaterial({ color: hex, depthTest: false, depthWrite: false, transparent: true, opacity: opacity < 1 ? opacity : 0.9 });
}

function hitMat() {
  return new THREE.MeshBasicMaterial({ visible: false });
}

// ── Build handle geometry ────────────────────────────────

function buildTranslateHandles() {
  const group = new THREE.Group();
  group.name = 'translate_handles';

  const axes = [
    { axis: 'x', dir: [1, 0, 0], rot: [0, 0, -Math.PI / 2] },
    { axis: 'y', dir: [0, 1, 0], rot: [0, 0, 0] },
    { axis: 'z', dir: [0, 0, 1], rot: [Math.PI / 2, 0, 0] },
  ];

  for (const { axis, dir, rot } of axes) {
    const color = AXIS_COLORS[axis];
    const handle = new THREE.Group();
    handle.userData.axis = axis;
    handle.userData.type = 'translate';

    // Stem
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.6, 6), axisMat(color));
    stem.position.y = 0.3;
    handle.add(stem);

    // Cone tip
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.4, 6), axisMat(color));
    cone.position.y = 0.8;
    handle.add(cone);

    // Hit mesh (invisible, larger)
    const hit = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 1.0, 6), hitMat());
    hit.position.y = 0.5;
    hit.userData.axis = axis;
    hit.userData.type = 'translate';
    handle.add(hit);

    handle.rotation.set(rot[0], rot[1], rot[2]);
    group.add(handle);
  }

  // Plane squares (XY, XZ, YZ)
  const planes = [
    { axes: 'xy', pos: [0.15, 0.15, 0], color: AXIS_COLORS.z },
    { axes: 'xz', pos: [0.15, 0, 0.15], color: AXIS_COLORS.y },
    { axes: 'yz', pos: [0, 0.15, 0.15], color: AXIS_COLORS.x },
  ];
  for (const { axes: planeAxes, pos, color } of planes) {
    const sq = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.01), axisMat(color, 0.25));
    sq.position.set(pos[0], pos[1], pos[2]);
    if (planeAxes === 'xz') sq.rotation.x = Math.PI / 2;
    if (planeAxes === 'yz') sq.rotation.y = Math.PI / 2;
    sq.userData.axis = planeAxes;
    sq.userData.type = 'translate';
    group.add(sq);
  }

  return group;
}

function buildRotateHandles() {
  const group = new THREE.Group();
  group.name = 'rotate_handles';

  // TorusGeometry lies flat in XZ by default (ring around Y axis)
  // X ring: rotate 90° around Z to stand up in YZ plane
  // Y ring: default (flat in XZ)
  // Z ring: rotate 90° around X to stand up in XY plane
  const rings = [
    { axis: 'x', color: AXIS_COLORS.x, rot: [0, Math.PI / 2, 0] },
    { axis: 'y', color: AXIS_COLORS.y, rot: [0, 0, 0] },
    { axis: 'z', color: AXIS_COLORS.z, rot: [Math.PI / 2, 0, 0] },
  ];

  for (const { axis, color, rot } of rings) {
    const torus = new THREE.Mesh(
      new THREE.TorusGeometry(0.8, 0.025, 4, 32),
      axisMat(color),
    );
    torus.rotation.set(rot[0], rot[1], rot[2]);
    torus.userData.axis = axis;
    torus.userData.type = 'rotate';

    // Hit torus (thicker)
    const hit = new THREE.Mesh(
      new THREE.TorusGeometry(0.8, 0.08, 4, 32),
      hitMat(),
    );
    hit.rotation.set(rot[0], rot[1], rot[2]);
    hit.userData.axis = axis;
    hit.userData.type = 'rotate';

    group.add(torus);
    group.add(hit);
  }

  return group;
}

function buildFocalHandle() {
  const torus = new THREE.Mesh(
    new THREE.TorusGeometry(1.0, 0.03, 4, 32),
    axisMat(FOCAL_COLOR),
  );
  torus.userData.type = 'focal';
  torus.userData.axis = 'focal';

  const hit = new THREE.Mesh(
    new THREE.TorusGeometry(1.0, 0.1, 4, 32),
    hitMat(),
  );
  hit.userData.type = 'focal';
  hit.userData.axis = 'focal';

  const group = new THREE.Group();
  group.name = 'focal_handle';
  group.add(torus);
  group.add(hit);
  return group;
}

// ── PALGizmos class ──────────────────────────────────────

export class PALGizmos {
  constructor(scene, camera, canvas) {
    this.scene = scene;
    this.camera = camera;
    this.canvas = canvas;
    this.attachedObject = null;
    this.mode = 'translate';
    this._sizeMultiplier = 1.0;
    this._lockedAxis = null;
    this._activeAxis = null;
    this._dragging = false;
    this._plane = new THREE.Plane();
    this._intersection = new THREE.Vector3();
    this._offset = new THREE.Vector3();
    this._raycaster = new THREE.Raycaster();
    this._mouse = new THREE.Vector2();

    // Build handle groups
    this.translateGroup = buildTranslateHandles();
    this.rotateGroup = buildRotateHandles();
    this.focalGroup = buildFocalHandle();

    this.gizmoGroup = new THREE.Group();
    this.gizmoGroup.name = 'pal_gizmos';
    this.gizmoGroup.add(this.translateGroup);
    this.gizmoGroup.add(this.rotateGroup);
    this.gizmoGroup.add(this.focalGroup);
    this.gizmoGroup.visible = false;
    this.gizmoGroup.renderOrder = 999;
    // Ensure every child mesh renders on top
    this.gizmoGroup.traverse(child => { if (child.isMesh) child.renderOrder = 999; });
    scene.add(this.gizmoGroup);

    this._constraint = null;
    this._shiftHeld = false;

    this._bindEvents();
  }

  attach(object, mode = 'translate') {
    this.attachedObject = object;
    this.gizmoGroup.visible = true;
    this.gizmoGroup.position.copy(object.position);

    const proxyType = object.userData?.proxyType || 'prop_generic';
    this._constraint = CONSTRAINTS[proxyType] || CONSTRAINTS.prop_generic;

    // Reset all children visible then apply new constraints via setMode
    this.setMode(mode);
  }

  detach() {
    this.attachedObject = null;
    this.gizmoGroup.visible = false;
    this._activeAxis = null;
    this._dragging = false;
  }

  setMode(mode) {
    this.mode = mode;
    this._lockedAxis = null;
    if (this.attachedObject) this.gizmoGroup.visible = true;
    // Reset all children to visible before applying constraints
    this.translateGroup.traverse(c => { if (c.isMesh || c.isGroup) c.visible = true; });
    this.rotateGroup.traverse(c => { if (c.isMesh || c.isGroup) c.visible = true; });
    this._updateVisibility();
  }

  _updateVisibility() {
    const c = this._constraint;
    if (!c) return;

    this.translateGroup.visible = this.mode === 'translate';
    this.rotateGroup.visible = this.mode === 'rotate';
    this.focalGroup.visible = this.mode === 'translate' && !!c.focal;

    if (this.mode === 'translate' && c.translate && !this._shiftHeld) {
      const allowed = c.translate;
      this.translateGroup.children.forEach(child => {
        const axis = child.userData.axis;
        if (!axis) return;
        if (axis.length === 1) {
          child.visible = allowed.includes(axis.toUpperCase());
        }
      });
    }

    if (this.mode === 'rotate' && c.rotate === null) {
      this.rotateGroup.visible = false;
    }
    // Always show all 3 rotate rings when rotation is allowed
  }

  lockAxis(axis) {
    this._lockedAxis = axis;
    // Show only the locked axis handle, hide others
    const group = this.mode === 'translate' ? this.translateGroup : this.rotateGroup;
    group.children.forEach(child => {
      const a = child.userData.axis;
      if (!a) return;
      if (!axis) { child.visible = true; return; }
      child.visible = a === axis.toLowerCase() || a === axis;
    });
  }

  highlightAxis(axis) {
    [this.translateGroup, this.rotateGroup].forEach(group => {
      group.traverse(child => {
        if (child.isMesh && child.material && child.material.emissive) {
          const a = (child.parent?.userData?.axis || child.userData?.axis || '').toUpperCase();
          child.material.emissive.setHex(a && a === axis ? 0x444444 : 0x000000);
        }
      });
    });
  }

  update() {
    if (!this.attachedObject || !this.gizmoGroup.visible) return;
    this.gizmoGroup.position.copy(this.attachedObject.position);
    // Local space: gizmo inherits object rotation
    this.gizmoGroup.quaternion.copy(this.attachedObject.quaternion);

    // Scale with distance
    const dist = this.camera.position.distanceTo(this.attachedObject.position);
    this.gizmoGroup.scale.setScalar(dist * 0.08 * this._sizeMultiplier);
  }

  // Check if a mouse event hits a gizmo handle. Returns axis or null.
  checkHit(mouseX, mouseY) {
    const rect = this.canvas.getBoundingClientRect();
    // In director split mode, map NDC to left panel only
    const viewer = window._palViewer;
    if (viewer && viewer.mode === 'director') {
      const split = rect.width * viewer._splitRatio;
      const localX = mouseX - rect.left;
      if (localX < split) {
        this._mouse.x = (localX / split) * 2 - 1;
      } else {
        return null; // gizmos only work in left (layout) panel
      }
    } else {
      this._mouse.x = ((mouseX - rect.left) / rect.width) * 2 - 1;
    }
    this._mouse.y = -((mouseY - rect.top) / rect.height) * 2 + 1;
    this._raycaster.setFromCamera(this._mouse, this.camera);

    const hitMeshes = [];
    this.gizmoGroup.traverse(child => {
      if (child.isMesh && child.userData.axis && child.parent?.visible !== false) hitMeshes.push(child);
    });

    const hits = this._raycaster.intersectObjects(hitMeshes, false);
    return hits.length > 0 ? hits[0].object.userData : null;
  }

  _beginDrag(hitData, mouseX, mouseY) {
    this._activeAxis = hitData.axis;
    this._dragType = hitData.type;
    this._dragging = true;

    // Build constraint plane
    const objPos = this.attachedObject.position.clone();
    const camDir = this.camera.position.clone().sub(objPos).normalize();

    if (this._activeAxis === 'x') this._plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 0, 1), objPos);
    else if (this._activeAxis === 'y') this._plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 0, 1), objPos);
    else if (this._activeAxis === 'z') this._plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(1, 0, 0), objPos);
    else if (this._activeAxis === 'xy') this._plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 0, 1), objPos);
    else if (this._activeAxis === 'xz') this._plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 1, 0), objPos);
    else if (this._activeAxis === 'yz') this._plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(1, 0, 0), objPos);
    else this._plane.setFromNormalAndCoplanarPoint(camDir, objPos);

    // Get initial intersection
    const rect = this.canvas.getBoundingClientRect();
    this._mouse.x = ((mouseX - rect.left) / rect.width) * 2 - 1;
    this._mouse.y = -((mouseY - rect.top) / rect.height) * 2 + 1;
    this._raycaster.setFromCamera(this._mouse, this.camera);
    this._raycaster.ray.intersectPlane(this._plane, this._intersection);
    this._offset.copy(this._intersection).sub(objPos);

    if (typeof window !== 'undefined') {
      window.PALBus?.dispatchEvent(new CustomEvent('pal:transform-start', {
        detail: { objectId: this.attachedObject.userData.palId, mode: this._dragType },
      }));
    }
  }

  _onDrag(mouseX, mouseY) {
    if (!this._dragging || !this.attachedObject) return;

    const rect = this.canvas.getBoundingClientRect();
    const viewer = window._palViewer;
    if (viewer && viewer.mode === 'director') {
      const split = rect.width * viewer._splitRatio;
      const localX = mouseX - rect.left;
      this._mouse.x = localX < split ? (localX / split) * 2 - 1 : 0;
    } else {
      this._mouse.x = ((mouseX - rect.left) / rect.width) * 2 - 1;
    }
    this._mouse.y = -((mouseY - rect.top) / rect.height) * 2 + 1;
    this._raycaster.setFromCamera(this._mouse, this.camera);

    const target = new THREE.Vector3();
    this._raycaster.ray.intersectPlane(this._plane, target);
    if (!target) return;

    const newPos = target.sub(this._offset);

    if (this._dragType === 'translate') {
      const axis = this._activeAxis;
      if (axis === 'x') this.attachedObject.position.x = newPos.x;
      else if (axis === 'y') this.attachedObject.position.y = newPos.y;
      else if (axis === 'z') this.attachedObject.position.z = newPos.z;
      else if (axis === 'xy') { this.attachedObject.position.x = newPos.x; this.attachedObject.position.y = newPos.y; }
      else if (axis === 'xz') { this.attachedObject.position.x = newPos.x; this.attachedObject.position.z = newPos.z; }
      else if (axis === 'yz') { this.attachedObject.position.y = newPos.y; this.attachedObject.position.z = newPos.z; }
    } else if (this._dragType === 'rotate') {
      // Rotate in local object space around the selected axis
      const delta = (mouseX - this._lastMouseX) * 0.01;
      const axis = this._activeAxis;
      const q = new THREE.Quaternion();
      if (axis === 'x') q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), delta);
      else if (axis === 'y') q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), delta);
      else if (axis === 'z') q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), delta);
      this.attachedObject.quaternion.multiply(q);
    } else if (this._dragType === 'focal') {
      // FOV adjust via vertical drag
      const delta = (mouseY - this._lastMouseY) * 0.1;
      if (window._palShotCam) {
        window._palShotCam.fov = Math.max(5, Math.min(120, window._palShotCam.fov + delta));
        window._palShotCam.updateProjectionMatrix();
        const fl = Math.round(18.0 / Math.tan(THREE.MathUtils.degToRad(window._palShotCam.fov) / 2) * 10) / 10;
        window.PALBus?.dispatchEvent(new CustomEvent('pal:fov-changed', {
          detail: { fov: window._palShotCam.fov, focal_length_mm: fl },
        }));
      }
    }

    this._lastMouseX = mouseX;
    this._lastMouseY = mouseY;
  }

  _endDrag() {
    if (!this._dragging) return;
    this._dragging = false;
    this._activeAxis = null;

    if (this.attachedObject && typeof window !== 'undefined') {
      window.PALBus?.dispatchEvent(new CustomEvent('pal:transform-end', {
        detail: {
          objectId: this.attachedObject.userData.palId,
          position: this.attachedObject.position.toArray(),
          rotation: [
            THREE.MathUtils.radToDeg(this.attachedObject.rotation.x),
            THREE.MathUtils.radToDeg(this.attachedObject.rotation.y),
            THREE.MathUtils.radToDeg(this.attachedObject.rotation.z),
          ],
        },
      }));
    }
  }

  _bindEvents() {
    this._onMouseDown = (e) => {
      if (e.button !== 0 || !this.attachedObject) return;
      const hit = this.checkHit(e.clientX, e.clientY);
      if (hit && hit.axis) {
        e.stopPropagation();
        e.preventDefault();
        this._lastMouseX = e.clientX;
        this._lastMouseY = e.clientY;
        this._beginDrag(hit, e.clientX, e.clientY);
      }
    };

    this._onMouseMove = (e) => {
      if (this._dragging) {
        this._onDrag(e.clientX, e.clientY);
      }
    };

    this._onMouseUp = () => {
      if (this._dragging) this._endDrag();
    };

    this._onKeyDown = (e) => {
      if (e.key === 'Shift') { this._shiftHeld = true; this._updateVisibility(); }
    };
    this._onKeyUp = (e) => {
      if (e.key === 'Shift') { this._shiftHeld = false; this._updateVisibility(); }
    };

    this.canvas.addEventListener('mousedown', this._onMouseDown, true);
    window.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('mouseup', this._onMouseUp);
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
  }

  destroy() {
    this.scene.remove(this.gizmoGroup);
    this.canvas.removeEventListener('mousedown', this._onMouseDown, true);
    window.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('mouseup', this._onMouseUp);
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
  }
}
