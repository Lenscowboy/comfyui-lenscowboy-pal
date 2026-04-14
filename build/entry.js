/**
 * PAL Viewport Bundle Entry Point
 *
 * Bundles Three.js r171 + all PAL viewport modules into a single IIFE.
 * Exposes window.PALViewport = { init, destroy, renderPasses, getState }
 *
 * Built with: npx esbuild build/entry.js --bundle --format=iife
 *             --global-name=PALViewport --outfile=web/pal_three_bundle.js
 */

import * as THREE from 'three';
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

// ── State ────────────────────────────────────────────────
let _viewer = null;
let _container = null;
let _onStateChange = null;
let _animFrame = null;

// ── Public API ───────────────────────────────────────────

/**
 * Initialise the PAL viewport inside a container element.
 * @param {HTMLElement} container - DOM element to render into
 * @param {Object} options - { state: {}, onStateChange: fn }
 */
export function init(container, options = {}) {
  _container = container;
  _onStateChange = options.onStateChange || null;

  // Create canvas
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;width:100%;height:100%;';
  container.appendChild(canvas);

  // Renderer
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const w = container.clientWidth;
  const h = container.clientHeight;
  renderer.setSize(w, h, false);

  // Scene
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a18);

  // Camera
  const camera = new THREE.PerspectiveCamera(39.6, w / h, 0.1, 2000);
  camera.position.set(8, 6, 12);
  camera.lookAt(0, 0, 0);

  // Grid
  const grid = new THREE.GridHelper(100, 20, 0x444440, 0x2a2a26);
  grid.material.opacity = 0.5;
  grid.material.transparent = true;
  scene.add(grid);

  // Ground plane for shadows
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(2000, 2000),
    new THREE.ShadowMaterial({ opacity: 0.35, transparent: true })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // Basic lighting
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

  // Sky
  const sky = new Sky();
  sky.scale.setScalar(10000);
  scene.add(sky);
  const skyUniforms = sky.material.uniforms;
  skyUniforms['turbidity'].value = 2;
  skyUniforms['rayleigh'].value = 1;
  skyUniforms['mieCoefficient'].value = 0.005;
  skyUniforms['mieDirectionalG'].value = 0.8;
  const sunPos = new THREE.Vector3();
  const phi = THREE.MathUtils.degToRad(90 - 45);
  const theta = THREE.MathUtils.degToRad(180);
  sunPos.setFromSphericalCoords(1, phi, theta);
  skyUniforms['sunPosition'].value.copy(sunPos);
  scene.background = sky;

  // Store viewer state
  _viewer = {
    renderer, scene, camera, canvas, grid, ground, sun, fill, hemi, sky,
    objects: new Map(),
    _spherical: { radius: 16, theta: Math.PI / 4, phi: Math.PI / 3 },
    _target: new THREE.Vector3(0, 0, 0),
    _orbiting: false, _panning: false,
    _lastMouse: { x: 0, y: 0 },
  };

  // Controls
  _bindControls(canvas, _viewer);

  // Resize observer
  new ResizeObserver(() => _resize()).observe(container);

  // Render loop
  function animate() {
    _animFrame = requestAnimationFrame(animate);
    renderer.render(scene, camera);
  }
  animate();

  // Load state if provided
  if (options.state?.scene?.objects) {
    _loadSceneState(options.state.scene);
  }

  console.log('[PAL ComfyUI] Viewport initialised');
}

/**
 * Destroy the viewport and clean up.
 */
export function destroy() {
  if (_animFrame) cancelAnimationFrame(_animFrame);
  if (_viewer) {
    _viewer.renderer.dispose();
    _viewer.scene.clear();
  }
  if (_container) _container.innerHTML = '';
  _viewer = null;
  _container = null;
  _animFrame = null;
}

/**
 * Render beauty, depth, and normal passes.
 * @returns {{ beauty: string, depth: string, normals: string }} Base64 PNG strings
 */
export function renderPasses(width = 512, height = 512) {
  if (!_viewer) return { beauty: '', depth: '', normals: '' };

  const { renderer, scene, camera } = _viewer;
  const ow = renderer.domElement.width, oh = renderer.domElement.height;

  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();

  // Beauty pass
  renderer.render(scene, camera);
  const beauty = renderer.domElement.toDataURL('image/png');

  // Depth pass
  const depthMat = new THREE.ShaderMaterial({
    vertexShader: `
      varying float vDepth;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vDepth = (-mv.z - 0.1) / (100.0 - 0.1);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      varying float vDepth;
      void main() {
        float d = clamp(1.0 - vDepth, 0.0, 1.0);
        gl_FragColor = vec4(d, d, d, 1.0);
      }
    `,
  });
  scene.overrideMaterial = depthMat;
  renderer.render(scene, camera);
  const depth = renderer.domElement.toDataURL('image/png');

  // Normal pass
  scene.overrideMaterial = new THREE.MeshNormalMaterial();
  renderer.render(scene, camera);
  const normals = renderer.domElement.toDataURL('image/png');

  // Restore
  scene.overrideMaterial = null;
  renderer.setSize(ow, oh, false);
  camera.aspect = ow / oh;
  camera.updateProjectionMatrix();

  return {
    beauty: beauty.replace('data:image/png;base64,', ''),
    depth: depth.replace('data:image/png;base64,', ''),
    normals: normals.replace('data:image/png;base64,', ''),
  };
}

/**
 * Get the current scene state as a serialisable object.
 */
export function getState() {
  if (!_viewer) return {};
  const objects = [];
  _viewer.objects.forEach((mesh, id) => {
    objects.push({
      id,
      proxy_type: mesh.userData.proxyType || 'prop_generic',
      position: mesh.position.toArray(),
      rotation: [
        THREE.MathUtils.radToDeg(mesh.rotation.x),
        THREE.MathUtils.radToDeg(mesh.rotation.y),
        THREE.MathUtils.radToDeg(mesh.rotation.z),
      ],
      scale: mesh.scale.toArray(),
      color_hint: mesh.userData.colorHint || 'white',
    });
  });
  return {
    scene: { objects },
    camera: {
      position: _viewer.camera.position.toArray(),
      rotation: [
        THREE.MathUtils.radToDeg(_viewer.camera.rotation.x),
        THREE.MathUtils.radToDeg(_viewer.camera.rotation.y),
        THREE.MathUtils.radToDeg(_viewer.camera.rotation.z),
      ],
      fov: _viewer.camera.fov,
    },
  };
}

// ── Internal helpers ─────────────────────────────────────

function _resize() {
  if (!_viewer || !_container) return;
  const w = _container.clientWidth;
  const h = _container.clientHeight;
  _viewer.renderer.setSize(w, h, false);
  _viewer.camera.aspect = w / h;
  _viewer.camera.updateProjectionMatrix();
}

function _updateOrbit() {
  const { _target: t, _spherical: s, camera } = _viewer;
  camera.position.set(
    t.x + s.radius * Math.sin(s.phi) * Math.sin(s.theta),
    t.y + s.radius * Math.cos(s.phi),
    t.z + s.radius * Math.sin(s.phi) * Math.cos(s.theta)
  );
  camera.lookAt(t);
}

function _bindControls(canvas, v) {
  canvas.addEventListener('mousedown', (e) => {
    if (e.button === 0) v._orbiting = true;
    if (e.button === 2) v._panning = true;
    v._lastMouse = { x: e.clientX, y: e.clientY };
  });

  window.addEventListener('mousemove', (e) => {
    const dx = e.clientX - v._lastMouse.x;
    const dy = e.clientY - v._lastMouse.y;
    v._lastMouse = { x: e.clientX, y: e.clientY };

    if (v._orbiting) {
      v._spherical.theta += dx * 0.005;
      v._spherical.phi = Math.max(0.1, Math.min(Math.PI - 0.1, v._spherical.phi - dy * 0.005));
      _updateOrbit();
    }
    if (v._panning) {
      const panSpeed = v._spherical.radius * 0.001;
      const right = new THREE.Vector3();
      const up = new THREE.Vector3(0, 1, 0);
      right.crossVectors(v.camera.getWorldDirection(new THREE.Vector3()), up).normalize();
      v._target.addScaledVector(right, -dx * panSpeed);
      v._target.y += dy * panSpeed;
      _updateOrbit();
    }
  });

  window.addEventListener('mouseup', () => {
    v._orbiting = false;
    v._panning = false;
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    v._spherical.radius = Math.max(2, Math.min(5000, v._spherical.radius * (1 + e.deltaY * 0.001)));
    _updateOrbit();
  }, { passive: false });

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
}

function _loadSceneState(sceneData) {
  if (!_viewer || !sceneData?.objects) return;
  // Basic proxy loading — creates boxes as placeholder geometry
  for (const obj of sceneData.objects) {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial({ color: 0x888880, roughness: 0.82 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(obj.position[0], obj.position[1], obj.position[2]);
    if (obj.rotation) {
      mesh.rotation.set(
        THREE.MathUtils.degToRad(obj.rotation[0]),
        THREE.MathUtils.degToRad(obj.rotation[1]),
        THREE.MathUtils.degToRad(obj.rotation[2]),
      );
    }
    if (obj.scale) mesh.scale.set(obj.scale[0], obj.scale[1], obj.scale[2]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.palId = obj.id;
    mesh.userData.proxyType = obj.proxy_type || 'prop_generic';
    mesh.userData.colorHint = obj.color_hint || 'white';
    _viewer.scene.add(mesh);
    _viewer.objects.set(obj.id, mesh);
  }
}

// Expose THREE for viewport extensions if needed
export { THREE };
