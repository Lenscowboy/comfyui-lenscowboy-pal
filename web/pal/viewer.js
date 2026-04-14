// frontend/pal/viewer.js — PAL Three.js scene core (thin shell)
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';
import { ProxyLib, buildFrustumHelper } from '/pal/static/proxy_lib.js';
import { PALGizmos } from '/pal/static/gizmos.js';
import { interpolateAtFrame } from '/pal/static/timeline.js';
import { PALLighting } from './core/lighting.js';
import { PALPostprocessing } from './core/postprocessing.js';
import { PALControls } from './core/controls.js';

export async function createPALViewer(canvasEl) {
  const v = new PALViewer(canvasEl, { deferInit: true });
  await v._initRenderer(); v._initSceneAndCameras(); return v;
}

export class PALViewer {
  constructor(canvasEl, opts = {}) {
    this.canvas = canvasEl; this.objects = new Map(); this.selectedId = null;
    this.mode = 'layout'; this._destroyed = false; this._splitRatio = 0.5;
    this._invertOrbit = localStorage.getItem('pal_invert_orbit') === 'true';
    this._undoStack = []; this._backend = 'webgl'; this._currentPreset = 'balanced';
    if (!opts.deferInit) { this._initRendererSync(); this._initSceneAndCameras(); }
  }

  /* Backward-compat getters — delegate to sub-modules */
  get _sunLight() { return this.lighting?._sunLight; }
  get _hemiLight() { return this.lighting?._hemiLight; }
  get sky() { return this.lighting?.sky; }
  get _horizonMesh() { return this.lighting?._horizonMesh; }
  get _hdriRaw() { return this.lighting?._hdriRaw; }
  get _hdriTexture() { return this.lighting?._hdriTexture; }
  get _hdriBackgroundVisible() { return this.lighting?._hdriBackgroundVisible; }
  get _currentSkyMode() { return this.lighting?._currentSkyMode; }
  get composer() { return this.pp?.composer; }
  get ssaoPass() { return this.pp?.ssaoPass; }
  get bloomPass() { return this.pp?.bloomPass; }
  get outlinePass() { return this.pp?.outlinePass; }

  /* Renderer */
  _initRendererSync() {
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: false });
    this._backend = 'webgl'; this._applyRendererSettings();
  }
  async _initRenderer() {
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: false });
    this._backend = 'webgl'; console.log('[PAL] WebGLRenderer initialised (r171)');
    this._applyRendererSettings(); this._updateBackendIndicator();
    console.log('[PAL] renderer info:', this.getSupportInfo());
  }
  _applyRendererSettings() {
    const r = this.renderer; r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    r.setClearColor(0x1a1a18); r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 1.0;
    r.outputColorSpace = THREE.SRGBColorSpace; this._resize();
  }
  _updateBackendIndicator() {
    const el = document.getElementById('renderer-backend-indicator'); if (!el) return;
    el.textContent = this._backend === 'webgpu' ? 'WebGPU' : 'WebGL';
    el.style.color = this._backend === 'webgpu' ? '#4ade80' : '#888';
  }
  getSupportInfo() {
    return { backend: this._backend, webgpuAvailable: !!navigator.gpu, maxTextureSize: this.renderer.capabilities?.maxTextureSize, shadowMapType: this.renderer.shadowMap.type, pixelRatio: this.renderer.getPixelRatio() };
  }

  /* Scene & cameras */
  _initSceneAndCameras() {
    this.scene = new THREE.Scene(); this.scene.background = new THREE.Color(0x1a1a18);
    this.scene.fog = new THREE.FogExp2(0x1a1a18, 0.002);
    const a = this.canvas.clientWidth / this.canvas.clientHeight;
    this.directorCam = new THREE.PerspectiveCamera(55, a, 0.1, 2000);
    this.directorCam.position.set(8, 6, 12); this.directorCam.lookAt(0, 0, 0);
    this.shotCam = new THREE.PerspectiveCamera(39.6, 1.78, 0.1, 2000);
    this.shotCam.position.set(0, 1.65, 5);
    this.activeCamera = this.directorCam; this.frustumHelper = null;
    // Sub-modules
    this.lighting = new PALLighting(this); this.pp = new PALPostprocessing(this); this.controls = new PALControls(this);
    this.lighting._initLighting(); this.lighting._initSky();
    this.lighting._initHorizonGlow(); this.lighting._initLensflare(); this.lighting._initHDRI();
    // Grid
    this.grid = new THREE.GridHelper(100, 20, 0x444440, 0x2a2a26);
    this.grid.material.opacity = 0.5; this.grid.material.transparent = true; this.scene.add(this.grid);
    // Ground plane
    this.groundPlane = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000), new THREE.ShadowMaterial({ opacity: 0.35, transparent: true }));
    this.groundPlane.rotation.x = -Math.PI / 2; this.groundPlane.receiveShadow = true;
    this.groundPlane.userData.isGround = true; this.scene.add(this.groundPlane);
    // Raycast plane
    this._raycastPlane = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000), new THREE.MeshBasicMaterial({ visible: false }));
    this._raycastPlane.rotation.x = -Math.PI / 2; this.scene.add(this._raycastPlane);
    // Postprocessing (non-fatal — viewer works without it)
    // Note: this.composer and this.outlinePass are getters that delegate to this.pp
    try {
      this.pp._initPostprocessing();
      this.postprocessing = this.pp;
    } catch (ppErr) {
      console.warn('[PAL] Postprocessing init failed — rendering without effects:', ppErr);
      this.postprocessing = null;
    }
    // Gizmos
    this.gizmos = new PALGizmos(this.scene, this.directorCam, this.canvas);
    window._palShotCam = this.shotCam;
    this._cameraKeyframes = []; this.raycaster = new THREE.Raycaster(); this.mouse = new THREE.Vector2();
    this._spherical = { radius: 20, theta: Math.PI / 4, phi: Math.PI / 3 };
    this._panOffset = new THREE.Vector3(); this._target = new THREE.Vector3(0, 0, 0);
    this._updateOrbit(); this._animate();
  }

  /* ── Public API ──────────────────────────────────────── */
  loadScene(p) {
    console.log('[PAL loadScene] called, keys:', Object.keys(p ?? {}));
    console.log('[PAL loadScene] objects:', p?.objects?.length, 'camera:', !!p?.camera);
    if (!p || !p.objects) { console.warn('[PAL loadScene] no objects array', p); return; }
    this.objects.forEach(o => this.scene.remove(o)); this.objects.clear();
    if (this.frustumHelper) { this.scene.remove(this.frustumHelper); this.frustumHelper = null; }
    console.log('[PAL viewer] loading', p.objects.length, 'objects');
    for (const obj of p.objects) {
      console.log('[PAL proxy]', obj.id, obj.proxy_type, obj.position, obj.scale);
      const m = ProxyLib.build(obj.proxy_type, obj.color_hint);
      m.position.set(obj.position[0], obj.position[1], obj.position[2]);
      m.rotation.set(THREE.MathUtils.degToRad(obj.rotation[0]), THREE.MathUtils.degToRad(obj.rotation[1]), THREE.MathUtils.degToRad(obj.rotation[2]));
      m.scale.set(obj.scale[0], obj.scale[1], obj.scale[2]);
      m.userData.palId = obj.id; m.userData.proxyType = obj.proxy_type;
      this.scene.add(m); this.objects.set(obj.id, m);
    }
    const c = p.camera;
    this.shotCam.position.set(c.position[0], c.position[1], c.position[2]);
    this.shotCam.rotation.set(THREE.MathUtils.degToRad(c.rotation[0]), THREE.MathUtils.degToRad(c.rotation[1]), THREE.MathUtils.degToRad(c.rotation[2]));
    this.shotCam.fov = c.fov; this.shotCam.updateProjectionMatrix();
    const cp = ProxyLib.build('camera_rig', 'yellow');
    cp.userData.palId = '__camera__'; cp.userData.proxyType = 'camera_rig'; cp.userData.colorHint = 'yellow';
    cp.position.copy(this.shotCam.position); cp.rotation.copy(this.shotCam.rotation);
    this.scene.add(cp); this.objects.set('__camera__', cp);
    this.frustumHelper = buildFrustumHelper(c.fov);
    this.frustumHelper.position.copy(this.shotCam.position); this.frustumHelper.rotation.copy(this.shotCam.rotation);
    this.scene.add(this.frustumHelper);
    this.scene.remove(this.grid);
    const gs = p.grid_size || 5, div = 20, ts = gs * div * 5;
    this.grid = new THREE.GridHelper(ts, div * 5, 0x888880, 0x444440);
    this.grid.material.opacity = 0.35; this.grid.material.transparent = true; this.scene.add(this.grid);
    this._cameraKeyframes = c.path_keyframes || [];
    this._applySky(p.sky_hint || 'day'); this._autoFrameScene();
    this.setMode('layout'); this._resize();
  }

  setMode(mode) {
    const prevMode = this.mode;
    this.mode = mode;
    const cp = this.objects.get('__camera__');

    if (mode === 'camera') {
      // Entering camera mode — sync shotCam FROM camera proxy position
      if (cp) {
        this.shotCam.position.copy(cp.position);
        this.shotCam.rotation.copy(cp.rotation);
      }
      this.activeCamera = this.shotCam;
      if (this.frustumHelper) this.frustumHelper.visible = false;
      if (cp) cp.visible = false;
      // Sync spherical coords from shotCam so orbit starts from current position
      const off = new THREE.Vector3().subVectors(this.shotCam.position, this._target);
      this._spherical.radius = Math.max(1, off.length());
      this._spherical.phi = Math.acos(Math.max(-1, Math.min(1, off.y / this._spherical.radius)));
      this._spherical.theta = Math.atan2(off.x, off.z);
    } else {
      // Leaving camera mode — sync camera proxy FROM shotCam position
      if (prevMode === 'camera' && cp) {
        cp.position.copy(this.shotCam.position);
        cp.rotation.copy(this.shotCam.rotation);
      }
      if (this.frustumHelper) {
        this.frustumHelper.position.copy(this.shotCam.position);
        this.frustumHelper.rotation.copy(this.shotCam.rotation);
        this.frustumHelper.visible = true;
      }
      this.activeCamera = this.directorCam;
      if (cp) cp.visible = true;
    }
    if (this.lighting?._lensflare) this.lighting._lensflare.visible = this.lighting._lensflareEnabled && mode === 'camera';
    this._resize();
  }

  pickObject(mx, my) {
    const rect = this.canvas.getBoundingClientRect(); let cam = this.activeCamera, nx, ny;
    if (this.mode === 'director') {
      const sp = rect.width * this._splitRatio, lx = mx - rect.left;
      if (lx < sp) { cam = this.directorCam; nx = (lx / sp) * 2 - 1; }
      else { cam = this.shotCam; nx = ((lx - sp) / (rect.width - sp)) * 2 - 1; }
      ny = -((my - rect.top) / rect.height) * 2 + 1;
    } else { nx = ((mx - rect.left) / rect.width) * 2 - 1; ny = -((my - rect.top) / rect.height) * 2 + 1; }
    this.mouse.x = nx; this.mouse.y = ny; this.raycaster.setFromCamera(this.mouse, cam);
    const ms = []; this.objects.forEach(o => { o.traverse(ch => { if (ch.isMesh) ms.push(ch); }); });
    const hits = this.raycaster.intersectObjects(ms, false);
    if (hits.length > 0) { let t = hits[0].object; while (t.parent && !t.userData.palId) t = t.parent; return t.userData.palId || null; }
    return null;
  }

  selectObject(id, additive = false) {
    if (!this._selectedIds) this._selectedIds = new Set();
    if (additive && id) { if (this._selectedIds.has(id)) this._selectedIds.delete(id); else this._selectedIds.add(id); }
    else if (id) { this._selectedIds.clear(); this._selectedIds.add(id); } else { this._selectedIds.clear(); }
    this.selectedId = this._selectedIds.size === 1 ? [...this._selectedIds][0] : (id || null);
    if (this.outlinePass) {
      const ms = []; for (const sid of this._selectedIds) { const o = this.objects.get(sid); if (o) o.traverse(ch => { if (ch.isMesh) ms.push(ch); }); }
      this.outlinePass.selectedObjects = ms;
    }
    if (typeof window !== 'undefined') window.PALBus?.dispatchEvent(new CustomEvent('pal:select', { detail: { id: this.selectedId, selectedIds: [...this._selectedIds] } }));
    if (this.selectedId && this.objects.has(this.selectedId)) this.gizmos.attach(this.objects.get(this.selectedId), 'translate');
    else this.gizmos.detach();
  }

  getSelectedIds() { return [...(this._selectedIds || [])]; }

  getShotCameraData() {
    const r = this.shotCam.rotation;
    return { position: this.shotCam.position.toArray(), rotation: [THREE.MathUtils.radToDeg(r.x), THREE.MathUtils.radToDeg(r.y), THREE.MathUtils.radToDeg(r.z)], fov: this.shotCam.fov, focal_length_mm: Math.round(18.0 / Math.tan(THREE.MathUtils.degToRad(this.shotCam.fov) / 2) * 10) / 10 };
  }

  getSceneObjects() {
    const out = []; this.objects.forEach((m, id) => { if (id === '__camera__') return; out.push({ id, proxy_type: m.userData.proxyType || 'prop_generic', position: m.position.toArray(), rotation: [THREE.MathUtils.radToDeg(m.rotation.x), THREE.MathUtils.radToDeg(m.rotation.y), THREE.MathUtils.radToDeg(m.rotation.z)], scale: m.scale.toArray(), color_hint: m.userData.colorHint || 'white' }); });
    return out;
  }

  captureFrame(w = 1920, h = 1080) {
    const ow = this.canvas.clientWidth, oh = this.canvas.clientHeight;
    this.renderer.setSize(w, h, false); this.shotCam.aspect = w / h; this.shotCam.updateProjectionMatrix();
    const hidden = []; for (const o of [this.grid, this.groundPlane, this._raycastPlane, this.frustumHelper, this.objects.get('__camera__'), this.gizmos?.gizmoGroup, this.sky, this._horizonMesh]) { if (o && o.visible) { o.visible = false; hidden.push(o); } }
    const bg = this.scene.background; this.scene.background = null;
    this.renderer.render(this.scene, this.shotCam);
    const url = this.renderer.domElement.toDataURL('image/jpeg', 0.85);
    this.scene.background = bg; for (const o of hidden) o.visible = true;
    this.renderer.setSize(ow, oh, false); this.shotCam.aspect = ow / oh; this.shotCam.updateProjectionMatrix();
    return url;
  }

  captureAllPasses(w = 1920, h = 1080) {
    const ow = this.canvas.clientWidth, oh = this.canvas.clientHeight;
    this.renderer.setSize(w, h, false); this.shotCam.aspect = w / h; this.shotCam.updateProjectionMatrix();
    const hidden = []; for (const o of [this.grid, this.groundPlane, this._raycastPlane, this.frustumHelper, this.objects.get('__camera__'), this.transformControls, this.gizmos?.gizmoGroup]) { if (o && o.visible) { o.visible = false; hidden.push(o); } }
    try {
      this.scene.overrideMaterial = null; this.renderer.render(this.scene, this.shotCam);
      const colorURL = this.renderer.domElement.toDataURL('image/jpeg', 0.90);
      this.scene.overrideMaterial = new THREE.MeshNormalMaterial(); this.renderer.render(this.scene, this.shotCam);
      const normalURL = this.renderer.domElement.toDataURL('image/jpeg', 0.90); this.scene.overrideMaterial = null;
      const dn = parseFloat(document.getElementById('set-depth-near')?.value) || this.shotCam.near;
      const df = parseFloat(document.getElementById('set-depth-far')?.value) || this.shotCam.far;
      const dm = this._backend === 'webgpu' ? new THREE.MeshDepthMaterial({ depthPacking: THREE.BasicDepthPacking }) : new THREE.ShaderMaterial({
        vertexShader: `varying float vD;uniform float depthNear;uniform float depthFar;void main(){vec4 mv=modelViewMatrix*vec4(position,1.0);vD=(-mv.z-depthNear)/(depthFar-depthNear);gl_Position=projectionMatrix*mv;}`,
        fragmentShader: `varying float vD;void main(){float d=clamp(1.0-vD,0.0,1.0);gl_FragColor=vec4(d,d,d,1.0);}`,
        uniforms: { depthNear: { value: dn }, depthFar: { value: df } } });
      this.scene.overrideMaterial = dm; this.renderer.render(this.scene, this.shotCam);
      const depthURL = this.renderer.domElement.toDataURL('image/jpeg', 0.90); this.scene.overrideMaterial = null;
      return { color: colorURL, normal: normalURL, depth: depthURL };
    } finally { for (const o of hidden) o.visible = true; this.scene.overrideMaterial = null; this.renderer.setSize(ow, oh, false); this.shotCam.aspect = ow / oh; this.shotCam.updateProjectionMatrix(); }
  }

  /* Export */
  _buildExportScene(inclCam) {
    const es = new THREE.Scene(); const conv = localStorage.getItem('pal_export_convention') ?? 'y_up';
    if (conv === 'z_up') { es.rotation.x = -Math.PI / 2; es.updateMatrixWorld(true); }
    for (const [id, obj] of this.objects) { if (id === '__camera__') continue; es.add(obj.clone(true)); }
    if (inclCam && this.shotCam) { const cc = this.shotCam.clone(); cc.userData.focal_length_mm = this.shotCam.userData.focal_length_mm ?? 50; es.add(cc); }
    return { exportScene: es, convention: conv };
  }
  _buildAnimationClips() { const clips = []; if (this._cameraKeyframes?.length > 1) { const t = this._cameraKeyframes.map(k => k.frame / 24); const p = this._cameraKeyframes.flatMap(k => k.position); clips.push(new THREE.AnimationClip('CameraMove', -1, [new THREE.VectorKeyframeTrack('Camera.position', t, p)])); } return clips; }
  exportGLB() { const { exportScene } = this._buildExportScene(true); return new Promise((ok, no) => { new GLTFExporter().parse(exportScene, r => ok(r), e => no(e), { binary: true, animations: this._buildAnimationClips(), includeCustomExtensions: true }); }); }
  exportOBJ() { const { exportScene } = this._buildExportScene(false); return new OBJExporter().parse(exportScene); }

  /* Scene management */
  newScene() {
    console.log('[PAL newScene] clearing', this.objects.size, 'tracked objects, scene has', this.scene.children.length, 'children');
    this.objects.forEach((mesh, id) => { this.scene.remove(mesh); });
    this.objects.clear();
    // Nuclear clear: remove everything except known infrastructure
    const keep = new Set();
    [this.grid, this.groundPlane, this._raycastPlane,
     this.lighting?.sky, this.lighting?._horizonMesh,
     this.lighting?._sunLight, this.lighting?._hemiLight, this.lighting?._fillLight,
     this.lighting?._lensflare, this.gizmos?.gizmoGroup,
    ].forEach(o => { if (o) keep.add(o); });
    // Iterate backwards since removing shifts indices
    for (let i = this.scene.children.length - 1; i >= 0; i--) {
      const child = this.scene.children[i];
      if (keep.has(child)) continue;
      // Keep lights (they're part of lighting setup)
      if (child.isLight) continue;
      // Keep cameras
      if (child.isCamera) continue;
      // Remove everything else
      console.log('[PAL newScene] removing child:', child.type, child.name || '', child.userData?.palId || '');
      this.scene.remove(child);
    }
    if (this.frustumHelper) { this.scene.remove(this.frustumHelper); this.frustumHelper = null; }
    if (this._selectedIds) this._selectedIds.clear(); this.selectedId = null;
    if (this.outlinePass) this.outlinePass.selectedObjects = []; this.gizmos.detach();
    this.shotCam.position.set(0, 1.65, 5); this.shotCam.rotation.set(0, 0, 0); this.shotCam.fov = 39.6; this.shotCam.updateProjectionMatrix();
    this.directorCam.position.set(8, 6, 12); this.directorCam.lookAt(0, 0, 0);
    this._spherical = { radius: 16, theta: Math.PI / 4, phi: Math.PI / 3 }; this._target.set(0, 0, 0); this._updateOrbit();
    this.scene.remove(this.grid);
    this.grid = new THREE.GridHelper(100, 20, 0x444440, 0x2a2a26); this.grid.material.opacity = 0.5; this.grid.material.transparent = true; this.scene.add(this.grid);
    this._applySky('day');
    this.setMode('layout'); this._resize();
  }
  addExternalMesh(mesh, id, name) {
    mesh.userData.palId = id || `ext_${Date.now()}`; if (name) mesh.userData.proxyType = name;
    if (!mesh.userData.proxyType) mesh.userData.proxyType = 'asset';
    this.scene.add(mesh); this.objects.set(mesh.userData.palId, mesh);
    if (typeof window !== 'undefined') window.PALBus?.dispatchEvent(new CustomEvent('pal:objects-changed', { detail: { objects: this.getObjectList() } }));
  }
  getObjectList() { const l = []; this.objects.forEach((m, id) => { l.push({ id, proxy_type: m.userData.proxyType || 'prop_generic', color_hint: m.userData.colorHint || 'white', _label: m.userData._label || null }); }); return l; }

  /* Orbit */
  _updateOrbit() {
    const t = this._target, { theta, phi, radius } = this._spherical;
    const pos = [t.x + radius * Math.sin(phi) * Math.sin(theta), t.y + radius * Math.cos(phi), t.z + radius * Math.sin(phi) * Math.cos(theta)];
    if (this.mode === 'camera') {
      this.shotCam.position.set(pos[0], pos[1], pos[2]);
      this.shotCam.lookAt(t);
      // Keep camera proxy in sync with shotCam while navigating
      const cp = this.objects.get('__camera__');
      if (cp) { cp.position.copy(this.shotCam.position); cp.rotation.copy(this.shotCam.rotation); }
    } else {
      this.directorCam.position.set(pos[0], pos[1], pos[2]);
      this.directorCam.lookAt(t);
    }
  }
  _autoFrameScene() {
    console.log('[PAL autoframe] objects:', this.objects.size, 'shot cam pos:', this.shotCam.position.toArray());
    const box = new THREE.Box3(); this.objects.forEach(o => box.expandByObject(o));
    box.expandByPoint(this.shotCam.position); box.expandByPoint(new THREE.Vector3(0, 0, 0));
    if (box.isEmpty()) { console.warn('[PAL autoframe] empty bounding box — skipping'); return; }
    const sph = new THREE.Sphere(); box.getBoundingSphere(sph); const c = sph.center;
    console.log('[PAL autoframe] sphere centre:', c.toArray(), 'radius:', sph.radius.toFixed(1));
    const d = Math.max(sph.radius * 2.5, 20);
    this.directorCam.position.set(c.x + d * 0.5, c.y + d * 0.7, c.z + d * 0.9); this.directorCam.lookAt(c);
    const off = new THREE.Vector3().subVectors(this.directorCam.position, c);
    this._spherical.radius = off.length();
    this._spherical.phi = Math.acos(THREE.MathUtils.clamp(off.y / this._spherical.radius, -1, 1));
    this._spherical.theta = Math.atan2(off.x, off.z); this._target.copy(c);
    const fp = Math.max(sph.radius * 10, 1000); this.directorCam.far = fp; this.directorCam.near = fp * 0.0001; this.directorCam.updateProjectionMatrix();
    if (this._sunLight?.shadow?.camera) {
      const r = sph.radius * 1.5, sc = this._sunLight.shadow.camera;
      sc.left = -r; sc.right = r; sc.top = r; sc.bottom = -r; sc.far = sph.radius * 6; sc.near = 0.1; sc.updateProjectionMatrix();
      this._sunLight.shadow.map?.dispose(); this._sunLight.shadow.map = null;
    }
    console.log('[PAL autoframe] director cam pos:', this.directorCam.position.toArray().map(v => v.toFixed(1)));
  }

  /* Resize */
  _resize() {
    if (!this.canvas || !this.directorCam || !this.shotCam) return;
    const w = this.canvas.parentElement?.clientWidth || this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.parentElement?.clientHeight || this.canvas.clientHeight || window.innerHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h); if (this.composer) this.composer.setSize(w, h);
    if (this.outlinePass) this.outlinePass.setSize(w, h);
    if (this.pp?.ssaoPass) this.pp.ssaoPass.setSize(w, h);
    const a = w / h; this.directorCam.aspect = a; this.directorCam.updateProjectionMatrix();
    this.shotCam.aspect = a; this.shotCam.updateProjectionMatrix();
  }

  /* Render loop */
  _animate() {
    if (this._destroyed) return; requestAnimationFrame(() => this._animate());
    this.gizmos.camera = this.directorCam;
    if (this.gizmos.gizmoGroup) this.gizmos.gizmoGroup.visible = this.mode !== 'camera';
    this.gizmos.update();
    if (this.mode === 'director') { this._renderDirectorSplit(); return; }
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    this.renderer.setScissorTest(false); this.renderer.setViewport(0, 0, w, h);
    if (this.composer) { this.composer.passes[0].camera = this.activeCamera; if (this.outlinePass) this.outlinePass.renderCamera = this.activeCamera; if (this.postprocessing?.bokehPass) this.postprocessing.bokehPass.camera = this.activeCamera; this.composer.render(); }
    else { this.renderer.render(this.scene, this.activeCamera); }
  }
  _renderDirectorSplit() {
    const sz = this.renderer.getSize(new THREE.Vector2()), w = sz.x, h = sz.y;
    if (w === 0 || h === 0) return;
    const sp = Math.floor(w * this._splitRatio), cp = this.objects.get('__camera__');
    if (cp) { this.shotCam.position.copy(cp.position); this.shotCam.rotation.copy(cp.rotation); if (this.frustumHelper) { this.frustumHelper.position.copy(cp.position); this.frustumHelper.rotation.copy(cp.rotation); } }
    this.renderer.setScissorTest(true);
    if (cp) cp.visible = true; if (this.frustumHelper) this.frustumHelper.visible = true;
    this.renderer.setViewport(0, 0, sp, h); this.renderer.setScissor(0, 0, sp, h);
    this.directorCam.aspect = sp / h; this.directorCam.updateProjectionMatrix();
    this.renderer.render(this.scene, this.directorCam);
    if (cp) cp.visible = false; if (this.frustumHelper) this.frustumHelper.visible = false;
    if (this.gizmos?.gizmoGroup) this.gizmos.gizmoGroup.visible = false;
    const rW = w - sp, rH = h, sa = (this._sensorWidth || 36) / (this._sensorHeight || 24), pa = rW / rH;
    let vx = sp, vy = 0, vw = rW, vh = rH;
    if (pa > sa) { vw = Math.floor(rH * sa); vx = sp + Math.floor((rW - vw) / 2); }
    else { vh = Math.floor(rW / sa); vy = Math.floor((rH - vh) / 2); }
    this.renderer.setViewport(sp, 0, rW, rH); this.renderer.setScissor(sp, 0, rW, rH);
    this.renderer.setClearColor(0x000000, 1); this.renderer.clear();
    this.renderer.setViewport(vx, vy, vw, vh); this.renderer.setScissor(vx, vy, vw, vh);
    this.shotCam.aspect = sa; this.shotCam.updateProjectionMatrix();
    this.renderer.render(this.scene, this.shotCam);
    this.renderer.setScissorTest(false); this.renderer.setViewport(0, 0, w, h); this.renderer.setClearColor(0x1a1a18);
    if (cp) cp.visible = true; if (this.gizmos?.gizmoGroup) this.gizmos.gizmoGroup.visible = true;
    if (this.frustumHelper) this.frustumHelper.visible = true;
  }

  /* Undo / Delete / Frame */
  pushUndo(oid) { const o = this.objects.get(oid); if (!o) return; this._undoStack.push({ objectId: oid, position: o.position.toArray(), rotation: [THREE.MathUtils.radToDeg(o.rotation.x), THREE.MathUtils.radToDeg(o.rotation.y), THREE.MathUtils.radToDeg(o.rotation.z)] }); if (this._undoStack.length > 50) this._undoStack.shift(); }
  undo() {
    const s = this._undoStack.pop(); if (!s) return; const o = this.objects.get(s.objectId); if (!o) return;
    o.position.set(s.position[0], s.position[1], s.position[2]);
    o.rotation.set(THREE.MathUtils.degToRad(s.rotation[0]), THREE.MathUtils.degToRad(s.rotation[1]), THREE.MathUtils.degToRad(s.rotation[2]));
    if (s.objectId === '__camera__') { this.shotCam.position.copy(o.position); this.shotCam.rotation.copy(o.rotation); if (this.frustumHelper) { this.frustumHelper.position.copy(o.position); this.frustumHelper.rotation.copy(o.rotation); } }
    window.PALBus?.dispatchEvent(new CustomEvent('pal:hud-hint', { detail: { message: 'Undo', duration: 800 } }));
  }
  deleteSelected() {
    if (!this.selectedId) return; const o = this.objects.get(this.selectedId); if (!o) return;
    this.gizmos.detach(); this.scene.remove(o);
    if (this.selectedId === '__camera__' && this.frustumHelper) { this.scene.remove(this.frustumHelper); this.frustumHelper = null; }
    this.objects.delete(this.selectedId); this.selectedId = null;
    if (typeof window !== 'undefined') { window.PALBus?.dispatchEvent(new CustomEvent('pal:objects-changed', { detail: { objects: this.getObjectList() } })); window.PALBus?.dispatchEvent(new CustomEvent('pal:select', { detail: { id: null } })); }
  }
  frameSelected() {
    const ids = this._selectedIds?.size ? [...this._selectedIds] : (this.selectedId ? [this.selectedId] : []);
    if (!ids.length) return;
    // Build bounding box around all selected objects
    const box = new THREE.Box3();
    for (const id of ids) {
      const o = this.objects.get(id);
      if (o) box.expandByObject(o);
    }
    if (box.isEmpty()) return;
    const sph = new THREE.Sphere(); box.getBoundingSphere(sph);
    const tgt = sph.center;
    if (this.mode === 'camera') {
      const dist = (sph.radius * 2.5) / Math.tan(THREE.MathUtils.degToRad(this.shotCam.fov) / 2);
      const dir = new THREE.Vector3(); this.shotCam.getWorldDirection(dir);
      this.shotCam.position.copy(tgt).addScaledVector(dir, -dist); this.shotCam.lookAt(tgt); this.shotCam.updateProjectionMatrix();
      window.PALBus?.dispatchEvent(new CustomEvent('pal:hud-hint', { detail: { message: `Fit ${ids.length} object${ids.length > 1 ? 's' : ''}`, duration: 2000 } }));
    } else { this._target.copy(tgt); this._spherical.radius = Math.max(5, sph.radius * 3); this._updateOrbit(); }
  }

  /* Timeline */
  applyFrame(frame, extKfs) {
    const kfs = extKfs || this._cameraKeyframes; if (!kfs || !kfs.length) return;
    const i = interpolateAtFrame(kfs, frame);
    if (i?.position) this.shotCam.position.set(i.position[0], i.position[1], i.position[2]);
    if (i?.rotation) this.shotCam.rotation.set(THREE.MathUtils.degToRad(i.rotation[0]), THREE.MathUtils.degToRad(i.rotation[1]), THREE.MathUtils.degToRad(i.rotation[2]));
    if (this.frustumHelper) { this.frustumHelper.position.copy(this.shotCam.position); this.frustumHelper.rotation.copy(this.shotCam.rotation); }
    const cp = this.objects.get('__camera__'); if (cp) { cp.position.copy(this.shotCam.position); cp.rotation.copy(this.shotCam.rotation); }
  }

  /* Cleanup */
  destroy() { this._destroyed = true; this.controls.destroy(); this.renderer.dispose(); }

  /* Delegation — lighting */
  _applySky(hint) { this.lighting._applySky(hint); }
  setSunFromTime(h, l, s) { return this.lighting.setSunFromTime(h, l, s); }
  setSkyMode(m) { this.lighting.setSkyMode(m); }
  setHDRIIntensity(v) { this.lighting.setHDRIIntensity(v); }
  setHDRIBackground(v) { this.lighting.setHDRIBackground(v); }
  loadHDRIFromBlob(b, f) { return this.lighting.loadHDRIFromBlob(b, f); }
  setLensflare(v) { this.lighting.setLensflare(v); }
  setLensflareSize(v) { this.lighting.setLensflareSize(v); }
  setLensflareIntensity(v) { this.lighting.setLensflareIntensity(v); }
  setViewportTheme(t) { this.lighting.setViewportTheme(t); }
  setAspectRatio(r) { this.shotCam.aspect = r; this.shotCam.updateProjectionMatrix(); }
  /* Delegation — postprocessing */
  setSSAO(e, r) { this.pp.setSSAO(e, r); }
  setBloom(e, s) { this.pp.setBloom(e, s); }
  setToneMapping(m) { this.pp.setToneMapping(m); }
  setShadowQuality(q) { this.pp.setShadowQuality(q); }
  setGridVisible(v) { this.pp.setGridVisible(v); }
  applyViewportPreset(p) { this.pp.applyViewportPreset(p); }
  /* Delegation — controls */
  setReferenceOverlay(f, o) { this.controls.setReferenceOverlay(f, o); }
  setReferenceOverlayOpacity(o) { this.controls.setReferenceOverlayOpacity(o); }
  clearReferenceOverlay() { this.controls.clearReferenceOverlay(); }
}
