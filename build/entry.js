/**
 * PAL Viewport Bundle Entry Point — Full PAL
 *
 * Bundles Three.js r171 + all PAL viewport modules into a single IIFE.
 * Exposes window.PALViewport = { init, destroy, renderPasses, getState, loadState, setCamera }
 *
 * Built with: npx esbuild build/entry.js --bundle --format=iife
 *             --global-name=PALViewport --outfile=web/pal_three_bundle.js
 */

import * as THREE from 'three';

// Three.js addons used by PAL
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutlinePass } from 'three/addons/postprocessing/OutlinePass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { Lensflare, LensflareElement } from 'three/addons/objects/Lensflare.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';

// ── State ────────────────────────────────────────────────
let _viewer = null;
let _container = null;
let _onStateChange = null;
let _destroyed = false;

// ── PAL Event Bus ────────────────────────────────────────
const PALBus = new EventTarget();

// ── Cameras/Lenses data (embedded) ───────────────────────
import camerasData from '../web/pal/data/cameras.json';
import lensesData from '../web/pal/data/lenses.json';

// ── Proxy builders ───────────────────────────────────────
// Import the proxy builder functions directly
import {
  humanStanding, humanSeated, vehicleCar, vehicleLarge, cameraRig,
  terrainPlane, terrainCanyon, buildingGeneric, wallPlane, treeGeneric,
  waterPlane, propGeneric, horse, chariot, houseSingle, houseTwoStory,
  tent, boatSmall, boatLarge, throne, altar, bridge, wallFortified,
  gateArch, column, torch, rockLarge, stairsWide, tableSimple,
  campfire, fenceSection, cart, barrel, crate, buildCompound,
  COLORS, mat,
} from '../web/pal/proxy_builders.js';

// ── Build proxy registry ─────────────────────────────────
const PROXY_BUILDERS = {
  human_standing: humanStanding, human_seated: humanSeated,
  vehicle_car: vehicleCar, vehicle_large: vehicleLarge,
  camera_rig: cameraRig, terrain_plane: terrainPlane,
  terrain_canyon: terrainCanyon, building_generic: buildingGeneric,
  wall_plane: wallPlane, tree_generic: treeGeneric,
  water_plane: waterPlane, prop_generic: propGeneric,
  horse, chariot, cart, tent,
  house_single: houseSingle, house_two_story: houseTwoStory,
  boat_small: boatSmall, boat_large: boatLarge,
  throne, altar, bridge, column, torch, barrel, crate,
  wall_fortified: wallFortified, gate_arch: gateArch,
  rock_large: rockLarge, stairs_wide: stairsWide,
  table_simple: tableSimple, campfire, fence_section: fenceSection,
};

function buildProxy(proxyType, colorHint) {
  const fn = PROXY_BUILDERS[proxyType] || PROXY_BUILDERS.prop_generic;
  const mesh = fn(colorHint || 'white');
  mesh.traverse(child => {
    if (child.isMesh) { child.castShadow = true; child.receiveShadow = true; }
  });
  mesh.userData.proxyType = proxyType;
  mesh.userData.colorHint = colorHint || 'white';
  return mesh;
}

// ── Public API ───────────────────────────────────────────

/**
 * Initialise the PAL viewport inside a container element.
 */
export function init(container, options = {}) {
  _container = container;
  _onStateChange = options.onStateChange || null;
  _destroyed = false;

  // Build UI layout: left panel + viewport + right panel
  const shell = document.createElement('div');
  shell.style.cssText = 'display:flex;width:100%;height:100%;background:#0e0e0c;font-family:monospace;';

  // Left panel — objects + proxy library
  const leftPanel = document.createElement('div');
  leftPanel.id = 'pal-left-panel';
  leftPanel.style.cssText = 'width:220px;background:#111110;border-right:1px solid #2a2a26;display:flex;flex-direction:column;overflow-y:auto;flex-shrink:0;font-size:9px;color:#888;';
  leftPanel.innerHTML = `
    <div style="padding:8px 12px;border-bottom:1px solid #2a2a26;font-size:8px;letter-spacing:1px;color:#f5c400;text-transform:uppercase">Objects</div>
    <div id="pal-obj-list" style="flex:1;overflow-y:auto;padding:4px 0"></div>
    <div style="padding:8px 12px;border-top:1px solid #2a2a26">
      <div style="font-size:8px;letter-spacing:1px;color:#f5c400;text-transform:uppercase;margin-bottom:6px">Add Proxy</div>
      <select id="pal-proxy-select" style="width:100%;background:#1a1a18;border:1px solid #2a2a26;color:#d0d0c8;font-size:8px;padding:3px 4px;border-radius:2px;margin-bottom:4px"></select>
      <button id="pal-add-proxy-btn" style="width:100%;padding:4px;background:#1a1a18;border:1px solid rgba(245,196,0,.3);border-radius:3px;color:#f5c400;font-size:8px;cursor:pointer">+ Add to Scene</button>
    </div>
  `;
  shell.appendChild(leftPanel);

  // Canvas viewport
  const viewportWrap = document.createElement('div');
  viewportWrap.style.cssText = 'flex:1;position:relative;overflow:hidden;';
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;width:100%;height:100%;';
  viewportWrap.appendChild(canvas);
  shell.appendChild(viewportWrap);

  // Right panel — shot info + camera
  const rightPanel = document.createElement('div');
  rightPanel.id = 'pal-right-panel';
  rightPanel.style.cssText = 'width:200px;background:#111110;border-left:1px solid #2a2a26;display:flex;flex-direction:column;overflow-y:auto;flex-shrink:0;font-size:9px;color:#888;';
  rightPanel.innerHTML = `
    <div style="padding:8px 12px;border-bottom:1px solid #2a2a26;font-size:8px;letter-spacing:1px;color:#f5c400;text-transform:uppercase">Camera</div>
    <div style="padding:8px 12px">
      <div style="margin-bottom:6px"><span style="color:#555;width:40px;display:inline-block">FOV</span> <span id="pal-cam-fov" style="color:#d0d0c8">39.6°</span></div>
      <div style="margin-bottom:6px"><span style="color:#555;width:40px;display:inline-block">Pos</span> <span id="pal-cam-pos" style="color:#d0d0c8;font-size:8px">0, 1.65, 5</span></div>
    </div>
    <div style="padding:8px 12px;border-top:1px solid #2a2a26;font-size:8px;letter-spacing:1px;color:#f5c400;text-transform:uppercase">Scene</div>
    <div style="padding:8px 12px">
      <div id="pal-scene-info" style="color:#666">No objects</div>
    </div>
    <div style="flex:1"></div>
    <div style="padding:8px 12px;border-top:1px solid #2a2a26;font-size:7px;color:#444">
      PAL Layout · LensCowboy<br>Orbit: LMB · Pan: RMB · Zoom: Scroll
    </div>
  `;
  shell.appendChild(rightPanel);

  container.appendChild(shell);

  // Renderer
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const w = container.clientWidth || 800;
  const h = container.clientHeight || 600;
  renderer.setSize(w, h, false);

  // Scene
  const scene = new THREE.Scene();

  // Cameras
  const directorCam = new THREE.PerspectiveCamera(55, w / h, 0.1, 2000);
  directorCam.position.set(8, 6, 12);
  directorCam.lookAt(0, 0, 0);

  const shotCam = new THREE.PerspectiveCamera(39.6, w / h, 0.1, 2000);
  shotCam.position.set(0, 1.65, 5);

  // Grid
  const grid = new THREE.GridHelper(100, 20, 0x444440, 0x2a2a26);
  grid.material.opacity = 0.5;
  grid.material.transparent = true;
  scene.add(grid);

  // Ground
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(2000, 2000),
    new THREE.ShadowMaterial({ opacity: 0.35, transparent: true })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // Lighting
  const hemi = new THREE.HemisphereLight(0x87CEEB, 0x362e28, 0.6);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff4e6, 1.0);
  sun.position.set(50, 80, 50);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.camera.left = -100;
  sun.shadow.camera.right = 100;
  sun.shadow.camera.top = 100;
  sun.shadow.camera.bottom = -100;
  scene.add(sun);

  const fill = new THREE.DirectionalLight(0xc8d8ff, 0.25);
  fill.position.set(-30, 20, -20);
  scene.add(fill);

  // Sky — generate environment map for background
  const sky = new Sky();
  sky.scale.setScalar(10000);
  scene.add(sky);
  const skyUniforms = sky.material.uniforms;
  skyUniforms['turbidity'].value = 2;
  skyUniforms['rayleigh'].value = 1;
  skyUniforms['mieCoefficient'].value = 0.005;
  skyUniforms['mieDirectionalG'].value = 0.8;
  const phi = THREE.MathUtils.degToRad(90 - 45);
  const theta = THREE.MathUtils.degToRad(180);
  const sunPos = new THREE.Vector3().setFromSphericalCoords(1, phi, theta);
  skyUniforms['sunPosition'].value.copy(sunPos);

  // Generate sky environment map for scene background
  try {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const skyScene = new THREE.Scene();
    skyScene.add(sky.clone());
    const envMap = pmrem.fromScene(skyScene, 0, 0.1, 1000).texture;
    scene.background = envMap;
    scene.environment = envMap;
    pmrem.dispose();
    skyScene.clear();
  } catch (e) {
    console.warn('[PAL] Sky env map failed, using solid background:', e);
    scene.background = new THREE.Color(0x1a1a18);
  }

  // Viewer state
  _viewer = {
    renderer, scene, canvas, grid, ground, sun, fill, hemi, sky,
    directorCam, shotCam,
    activeCamera: directorCam,
    mode: 'layout',
    objects: new Map(),
    _spherical: { radius: 16, theta: Math.PI / 4, phi: Math.PI / 3 },
    _target: new THREE.Vector3(0, 0, 0),
    _orbiting: false, _panning: false,
    _lastMouse: { x: 0, y: 0 },
  };

  // Controls
  _bindControls(canvas);

  // Resize observer
  new ResizeObserver(() => _resize()).observe(viewportWrap);

  // Populate proxy dropdown
  const proxySelect = document.getElementById('pal-proxy-select');
  if (proxySelect) {
    Object.keys(PROXY_BUILDERS).forEach(type => {
      const opt = document.createElement('option');
      opt.value = type;
      opt.textContent = type.replace(/_/g, ' ');
      proxySelect.appendChild(opt);
    });
  }

  // Add proxy button
  const addBtn = document.getElementById('pal-add-proxy-btn');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      const type = proxySelect?.value || 'prop_generic';
      addProxy(type, [0, 0, 0]);
      _updateObjectList();
    });
  }

  // Render loop
  let _frameCount = 0;
  function animate() {
    if (_destroyed) return;
    requestAnimationFrame(animate);
    renderer.render(scene, _viewer.activeCamera);
    // Update camera info every 30 frames
    if (++_frameCount % 30 === 0) _updateCameraInfo();
  }
  animate();

  // Load state if provided
  if (options.state?.scene?.objects) {
    loadState(options.state);
  }

  console.log('[PAL ComfyUI] Full viewport initialised with', Object.keys(PROXY_BUILDERS).length, 'proxy types');
}

/**
 * Destroy the viewport.
 */
export function destroy() {
  _destroyed = true;
  if (_viewer) {
    _viewer.renderer.dispose();
  }
  if (_container) _container.innerHTML = '';
  _viewer = null;
  _container = null;
}

/**
 * Render beauty, depth, and normal passes.
 */
export function renderPasses(width = 512, height = 512) {
  if (!_viewer) return { beauty: '', depth: '', normals: '' };

  const { renderer, scene } = _viewer;
  const cam = _viewer.shotCam;
  const ow = renderer.domElement.width, oh = renderer.domElement.height;

  renderer.setSize(width, height, false);
  cam.aspect = width / height;
  cam.updateProjectionMatrix();

  // Beauty
  renderer.render(scene, cam);
  const beauty = renderer.domElement.toDataURL('image/png');

  // Depth
  const depthMat = new THREE.ShaderMaterial({
    vertexShader: `varying float vD; void main(){vec4 mv=modelViewMatrix*vec4(position,1.0);vD=(-mv.z-0.1)/(100.0-0.1);gl_Position=projectionMatrix*mv;}`,
    fragmentShader: `varying float vD; void main(){float d=clamp(1.0-vD,0.0,1.0);gl_FragColor=vec4(d,d,d,1.0);}`,
  });
  scene.overrideMaterial = depthMat;
  renderer.render(scene, cam);
  const depth = renderer.domElement.toDataURL('image/png');

  // Normals
  scene.overrideMaterial = new THREE.MeshNormalMaterial();
  renderer.render(scene, cam);
  const normals = renderer.domElement.toDataURL('image/png');

  // Restore
  scene.overrideMaterial = null;
  renderer.setSize(ow, oh, false);
  cam.aspect = ow / oh;
  cam.updateProjectionMatrix();

  return {
    beauty: beauty.replace('data:image/png;base64,', ''),
    depth: depth.replace('data:image/png;base64,', ''),
    normals: normals.replace('data:image/png;base64,', ''),
  };
}

/**
 * Get current scene state.
 */
export function getState() {
  if (!_viewer) return {};
  const objects = [];
  _viewer.objects.forEach((mesh, id) => {
    if (id === '__camera__') return;
    objects.push({
      id,
      proxy_type: mesh.userData.proxyType || 'prop_generic',
      position: mesh.position.toArray(),
      rotation: [THREE.MathUtils.radToDeg(mesh.rotation.x), THREE.MathUtils.radToDeg(mesh.rotation.y), THREE.MathUtils.radToDeg(mesh.rotation.z)],
      scale: mesh.scale.toArray(),
      color_hint: mesh.userData.colorHint || 'white',
    });
  });
  return {
    scene: { objects },
    camera: {
      position: _viewer.shotCam.position.toArray(),
      rotation: [THREE.MathUtils.radToDeg(_viewer.shotCam.rotation.x), THREE.MathUtils.radToDeg(_viewer.shotCam.rotation.y), THREE.MathUtils.radToDeg(_viewer.shotCam.rotation.z)],
      fov: _viewer.shotCam.fov,
    },
  };
}

/**
 * Load scene state from a state object.
 */
export function loadState(state) {
  if (!_viewer || !state?.scene?.objects) return;
  // Clear existing objects
  _viewer.objects.forEach(mesh => _viewer.scene.remove(mesh));
  _viewer.objects.clear();
  // Load objects using real proxy builders
  for (const obj of state.scene.objects) {
    const mesh = buildProxy(obj.proxy_type || 'prop_generic', obj.color_hint || 'white');
    mesh.position.set(obj.position[0], obj.position[1], obj.position[2]);
    if (obj.rotation) {
      mesh.rotation.set(THREE.MathUtils.degToRad(obj.rotation[0]), THREE.MathUtils.degToRad(obj.rotation[1]), THREE.MathUtils.degToRad(obj.rotation[2]));
    }
    if (obj.scale) mesh.scale.set(obj.scale[0], obj.scale[1], obj.scale[2]);
    mesh.userData.palId = obj.id;
    _viewer.scene.add(mesh);
    _viewer.objects.set(obj.id, mesh);
  }
  // Load imported models (GLB/OBJ from upstream nodes)
  if (state.scene?.imported_models) {
    _loadImportedModels(state.scene.imported_models);
  }
  // Load camera
  if (state.camera) {
    const c = state.camera;
    _viewer.shotCam.position.set(c.position[0], c.position[1], c.position[2]);
    if (c.rotation) {
      _viewer.shotCam.rotation.set(THREE.MathUtils.degToRad(c.rotation[0]), THREE.MathUtils.degToRad(c.rotation[1]), THREE.MathUtils.degToRad(c.rotation[2]));
    }
    if (c.fov) { _viewer.shotCam.fov = c.fov; _viewer.shotCam.updateProjectionMatrix(); }
  }
}

/**
 * Load imported 3D models (GLB/OBJ) from upstream ComfyUI nodes.
 * Models arrive as base64-encoded data or file paths.
 */
function _loadImportedModels(models) {
  if (!_viewer || !models?.length) return;
  for (const model of models) {
    try {
      if (model.format === 'glb' && model.data) {
        const binary = Uint8Array.from(atob(model.data), c => c.charCodeAt(0));
        const loader = new GLTFLoader();
        loader.parse(binary.buffer, '', (gltf) => {
          const root = gltf.scene;
          root.userData.palId = model.id;
          root.userData.proxyType = 'imported_glb';
          root.userData.imported = true;
          root.traverse(child => { if (child.isMesh) { child.castShadow = true; child.receiveShadow = true; } });
          _viewer.scene.add(root);
          _viewer.objects.set(model.id, root);
          _updateObjectList();
          console.log(`[PAL] Loaded GLB model: ${model.name}`);
        }, (err) => { console.warn('[PAL] GLB parse failed:', err); });
      } else if (model.format === 'obj' && model.data) {
        const text = atob(model.data);
        const loader = new OBJLoader();
        const root = loader.parse(text);
        root.userData.palId = model.id;
        root.userData.proxyType = 'imported_obj';
        root.userData.imported = true;
        root.traverse(child => {
          if (child.isMesh) {
            child.castShadow = true; child.receiveShadow = true;
            if (!child.material || child.material.type === 'MeshBasicMaterial') {
              child.material = new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.6, metalness: 0.1 });
            }
          }
        });
        _viewer.scene.add(root);
        _viewer.objects.set(model.id, root);
        _updateObjectList();
        console.log(`[PAL] Loaded OBJ model: ${model.name}`);
      }
    } catch (e) { console.warn(`[PAL] Failed to load model ${model.name}:`, e); }
  }
}

/**
 * Set camera position/rotation.
 */
export function setCamera(cameraData) {
  if (!_viewer || !cameraData) return;
  if (cameraData.position) _viewer.shotCam.position.set(cameraData.position[0], cameraData.position[1], cameraData.position[2]);
  if (cameraData.rotation) _viewer.shotCam.rotation.set(THREE.MathUtils.degToRad(cameraData.rotation[0]), THREE.MathUtils.degToRad(cameraData.rotation[1]), THREE.MathUtils.degToRad(cameraData.rotation[2]));
  if (cameraData.fov) { _viewer.shotCam.fov = cameraData.fov; _viewer.shotCam.updateProjectionMatrix(); }
}

/**
 * Add a proxy object to the scene.
 */
export function addProxy(proxyType, position = [0, 0, 0], colorHint = 'white') {
  if (!_viewer) return null;
  const mesh = buildProxy(proxyType, colorHint);
  mesh.position.set(position[0], position[1], position[2]);
  const id = `proxy_${Date.now()}`;
  mesh.userData.palId = id;
  _viewer.scene.add(mesh);
  _viewer.objects.set(id, mesh);
  return id;
}

// ── Internal helpers ─────────────────────────────────────

function _updateObjectList() {
  const el = document.getElementById('pal-obj-list');
  const info = document.getElementById('pal-scene-info');
  if (!_viewer || !el) return;
  let html = '';
  _viewer.objects.forEach((mesh, id) => {
    const label = mesh.userData._label || mesh.userData.proxyType || id;
    html += `<div style="padding:3px 12px;cursor:pointer;transition:background .1s;color:#aaa;display:flex;align-items:center;gap:4px" onmouseenter="this.style.background='#1a1a18'" onmouseleave="this.style.background='transparent'">
      <span style="width:6px;height:6px;border-radius:50%;background:#888;flex-shrink:0"></span>
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${label.replace(/_/g, ' ')}</span>
    </div>`;
  });
  el.innerHTML = html || '<div style="padding:8px 12px;color:#444">No objects</div>';
  if (info) info.textContent = `${_viewer.objects.size} object${_viewer.objects.size !== 1 ? 's' : ''}`;
}

function _updateCameraInfo() {
  if (!_viewer) return;
  const fovEl = document.getElementById('pal-cam-fov');
  const posEl = document.getElementById('pal-cam-pos');
  if (fovEl) fovEl.textContent = _viewer.shotCam.fov.toFixed(1) + '°';
  if (posEl) {
    const p = _viewer.shotCam.position;
    posEl.textContent = `${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}`;
  }
}

function _resize() {
  if (!_viewer) return;
  const wrap = _container?.querySelector('div[style*="flex:1"]');
  const w = wrap?.clientWidth || _container?.clientWidth || 800;
  const h = wrap?.clientHeight || _container?.clientHeight || 600;
  _viewer.renderer.setSize(w, h, false);
  _viewer.directorCam.aspect = w / h;
  _viewer.directorCam.updateProjectionMatrix();
  _viewer.shotCam.aspect = w / h;
  _viewer.shotCam.updateProjectionMatrix();
}

function _updateOrbit() {
  const t = _viewer._target, { theta, phi, radius } = _viewer._spherical;
  _viewer.activeCamera.position.set(
    t.x + radius * Math.sin(phi) * Math.sin(theta),
    t.y + radius * Math.cos(phi),
    t.z + radius * Math.sin(phi) * Math.cos(theta)
  );
  _viewer.activeCamera.lookAt(t);
}

function _bindControls(canvas) {
  canvas.addEventListener('mousedown', (e) => {
    if (e.button === 0) _viewer._orbiting = true;
    if (e.button === 2) _viewer._panning = true;
    _viewer._lastMouse = { x: e.clientX, y: e.clientY };
  });

  window.addEventListener('mousemove', (e) => {
    if (!_viewer) return;
    const dx = e.clientX - _viewer._lastMouse.x;
    const dy = e.clientY - _viewer._lastMouse.y;
    _viewer._lastMouse = { x: e.clientX, y: e.clientY };

    if (_viewer._orbiting) {
      _viewer._spherical.theta += dx * 0.005;
      _viewer._spherical.phi = Math.max(0.1, Math.min(Math.PI - 0.1, _viewer._spherical.phi - dy * 0.005));
      _updateOrbit();
    }
    if (_viewer._panning) {
      const panSpeed = _viewer._spherical.radius * 0.001;
      const right = new THREE.Vector3();
      const up = new THREE.Vector3(0, 1, 0);
      right.crossVectors(_viewer.activeCamera.getWorldDirection(new THREE.Vector3()), up).normalize();
      _viewer._target.addScaledVector(right, -dx * panSpeed);
      _viewer._target.y += dy * panSpeed;
      _updateOrbit();
    }
  });

  window.addEventListener('mouseup', () => {
    if (!_viewer) return;
    _viewer._orbiting = false;
    _viewer._panning = false;
  });

  canvas.addEventListener('wheel', (e) => {
    if (!_viewer) return;
    e.preventDefault();
    _viewer._spherical.radius = Math.max(2, Math.min(5000, _viewer._spherical.radius * (1 + e.deltaY * 0.001)));
    _updateOrbit();
  }, { passive: false });

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
}

// Expose for extensions
export { THREE, buildProxy, PROXY_BUILDERS, PALBus };
