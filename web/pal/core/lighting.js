// frontend/pal/core/lighting.js — PALLighting extracted from viewer.js
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { Lensflare, LensflareElement } from 'three/addons/objects/Lensflare.js';

function solarElevation(hour, latDeg, declDeg = 0) {
  const lat = THREE.MathUtils.degToRad(latDeg);
  const dec = THREE.MathUtils.degToRad(declDeg);
  const ha  = THREE.MathUtils.degToRad((hour - 12) * 15);
  return THREE.MathUtils.radToDeg(
    Math.asin(Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(ha))
  );
}
function solarAzimuth(hour, latDeg, declDeg = 0) {
  const lat = THREE.MathUtils.degToRad(latDeg);
  const dec = THREE.MathUtils.degToRad(declDeg);
  const ha  = THREE.MathUtils.degToRad((hour - 12) * 15);
  const sinAz = -Math.sin(ha) * Math.cos(dec);
  const cosAz = Math.sin(dec) * Math.cos(lat) - Math.cos(ha) * Math.cos(dec) * Math.sin(lat);
  return (THREE.MathUtils.radToDeg(Math.atan2(sinAz, cosAz)) + 360) % 360;
}
const DECLINATION = { summer: 23.5, spring: 0.0, autumn: -5.0, winter: -23.5 };
export { solarElevation, solarAzimuth, DECLINATION };

const HORIZON_VERT = `varying vec3 vWorldPos;
void main(){vWorldPos=(modelMatrix*vec4(position,1.0)).xyz;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`;
const HORIZON_FRAG = `uniform vec3 sunDirection;uniform vec3 glowColor;uniform vec3 skyColor;uniform float intensity;varying vec3 vWorldPos;
void main(){vec3 dir=normalize(vWorldPos);float align=max(dot(dir,normalize(sunDirection)),0.0);float glow=pow(align,5.0)*intensity;float anti=max(dot(dir,-normalize(sunDirection)),0.0);float shadow=pow(anti,3.0)*0.3;vec3 col=mix(skyColor,glowColor,glow);col-=vec3(shadow*0.2,shadow*0.1,0.0);float vPos=abs(vWorldPos.y)/100.0;float alpha=(1.0-vPos)*0.7*max(glow+0.05,shadow);gl_FragColor=vec4(col,clamp(alpha,0.0,1.0));}`;

export class PALLighting {
  constructor(viewer) {
    this.viewer = viewer;
    this._currentSkyMode = 'hybrid';
    this._hdriBackgroundVisible = true;
    this._hdriTexture = null;
    this._hdriRaw = null;
    this._hdriCache = new Map();
    this._hdriLoader = null;
    this._pmremGen = null;
    this._lensflareEnabled = false;
    this._sunLightBaseIntensity = 1.0;
    this._currentSkyHint = null;
    this._hemiLight = null;
    this._sunLight = null;
    this._fillLight = null;
    this.sky = null;
    this._sunSphere = null;
    this._horizonMesh = null;
    this._lensflare = null;
  }

  _initLighting() {
    this._hemiLight = new THREE.HemisphereLight(0xfff5e0, 0x8899aa, 0.6);
    this._hemiLight.position.set(0, 50, 0);
    this.viewer.scene.add(this._hemiLight);
    this._sunLight = new THREE.DirectionalLight(0xfff5e0, 1.0);
    this._sunLight.position.set(80, 120, 60);
    this._sunLight.castShadow = true;
    this._sunLight.shadow.mapSize.width = 2048;
    this._sunLight.shadow.mapSize.height = 2048;
    this._sunLight.shadow.camera.near = 0.5;
    this._sunLight.shadow.camera.far = 2000;
    this._sunLight.shadow.camera.left = -200;
    this._sunLight.shadow.camera.right = 200;
    this._sunLight.shadow.camera.top = 200;
    this._sunLight.shadow.camera.bottom = -200;
    this._sunLight.shadow.bias = -0.0005;
    this._sunLight.shadow.normalBias = 0.02;
    this.viewer.scene.add(this._sunLight);
    this._fillLight = new THREE.DirectionalLight(0xaabbcc, 0.25);
    this._fillLight.position.set(-60, 40, -80);
    this.viewer.scene.add(this._fillLight);
  }

  _initSky() {
    this.sky = new Sky();
    this.sky.scale.setScalar(10000);
    this.viewer.scene.add(this.sky);
    this._sunSphere = new THREE.Vector3();
  }

  _initHorizonGlow() {
    const geo = new THREE.CylinderGeometry(950, 950, 200, 32, 1, true);
    this._hgSunDir = new THREE.Vector3(0, 0.3, -1);
    this._hgGlowColor = new THREE.Color(0xff4400);
    this._hgSkyColor = new THREE.Color(0x001133);
    this._hgIntensity = 1.0;
    let mat;
    if (this.viewer._backend === 'webgpu') {
      mat = new THREE.MeshBasicMaterial({ color: 0xff4400, transparent: true, opacity: 0.15, side: THREE.BackSide, depthWrite: false });
      mat._isNodeFallback = true;
    } else {
      mat = new THREE.ShaderMaterial({
        uniforms: { sunDirection: { value: this._hgSunDir }, glowColor: { value: this._hgGlowColor }, skyColor: { value: this._hgSkyColor }, intensity: { value: this._hgIntensity } },
        vertexShader: HORIZON_VERT, fragmentShader: HORIZON_FRAG,
        transparent: true, side: THREE.BackSide, depthWrite: false,
      });
    }
    this._horizonMesh = new THREE.Mesh(geo, mat);
    this._horizonMesh.renderOrder = -1;
    this.viewer.scene.add(this._horizonMesh);
  }

  _updateHorizonGlow(sunPos, elevation) {
    if (!this._horizonMesh) return;
    const mat = this._horizonMesh.material;
    if (mat._isNodeFallback) {
      if (elevation < 15 && elevation > -10) { mat.color.set(0xff4400); mat.opacity = THREE.MathUtils.mapLinear(elevation, 15, -10, 0.05, 0.25); }
      else if (elevation <= -10) { mat.color.set(0x001166); mat.opacity = 0.08; }
      else { mat.opacity = 0.01; }
    } else {
      const u = mat.uniforms;
      u['sunDirection'].value.copy(sunPos);
      if (elevation < 15 && elevation > -10) { u['glowColor'].value.set(0xff4400); u['intensity'].value = THREE.MathUtils.mapLinear(elevation, 15, -10, 0.3, 1.5); }
      else if (elevation <= -10) { u['glowColor'].value.set(0x001166); u['intensity'].value = 0.4; }
      else { u['intensity'].value = 0.05; }
    }
  }

  _initHDRI() {
    this._hdriLoader = new RGBELoader();
    this._pmremGen = new THREE.PMREMGenerator(this.viewer.renderer);
    this._pmremGen.compileEquirectangularShader();
  }

  _initLensflare() {
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 256;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
    grad.addColorStop(0.0, 'rgba(255,255,255,1.0)');
    grad.addColorStop(0.2, 'rgba(255,200,100,0.8)');
    grad.addColorStop(0.5, 'rgba(255,100,50,0.3)');
    grad.addColorStop(1.0, 'rgba(0,0,0,0.0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 256, 256);
    const flareTex = new THREE.CanvasTexture(canvas);
    this._lensflare = new Lensflare();
    this._lensflare.addElement(new LensflareElement(flareTex, 400, 0, new THREE.Color(0xff8833)));
    this._lensflare.addElement(new LensflareElement(flareTex, 80, 0.5));
    this._lensflare.addElement(new LensflareElement(flareTex, 40, 0.9));
    this._lensflare.visible = false;
    if (this._sunLight) this._sunLight.add(this._lensflare);
  }

  _applySky(hint = 'day') {
    if (!this.sky) return;
    if (hint.includes(':')) {
      const parts = hint.split(':');
      const hour = parseInt(parts[0]) + parseInt(parts[1] || 0) / 60;
      const lat = parseFloat(localStorage.getItem('pal_default_latitude') || '-26');
      this.setSunFromTime(hour, lat, 'summer');
      return;
    }
    const u = this.sky.material.uniforms;
    const atmosphere = {
      day: { turbidity: 8, rayleigh: 1.5, mie: 0.004, mieG: 0.8 },
      golden_hour: { turbidity: 12, rayleigh: 3.0, mie: 0.008, mieG: 0.9 },
      dusk: { turbidity: 15, rayleigh: 4.0, mie: 0.012, mieG: 0.95 },
      dawn: { turbidity: 10, rayleigh: 2.5, mie: 0.006, mieG: 0.85 },
      night: { turbidity: 2, rayleigh: 0.5, mie: 0.001, mieG: 0.7 },
    };
    const sunAngles = {
      day: { elevation: 45, azimuth: 180 }, golden_hour: { elevation: 4, azimuth: 215 },
      dusk: { elevation: -1, azimuth: 230 }, dawn: { elevation: 3, azimuth: 95 },
      night: { elevation: -18, azimuth: 180 },
    };
    const atmo = atmosphere[hint] ?? atmosphere['day'];
    const sun  = sunAngles[hint]  ?? sunAngles['day'];
    u['turbidity'].value = atmo.turbidity;
    u['rayleigh'].value = atmo.rayleigh;
    u['mieCoefficient'].value = atmo.mie;
    u['mieDirectionalG'].value = atmo.mieG;
    const phi = THREE.MathUtils.degToRad(90 - sun.elevation);
    const theta = THREE.MathUtils.degToRad(sun.azimuth);
    const sunPos = new THREE.Vector3();
    sunPos.setFromSphericalCoords(1, phi, theta);
    u['sunPosition'].value.copy(sunPos);
    if (this._sunLight) {
      this._sunLight.position.setFromSphericalCoords(300, phi, theta);
      const lc = {
        day: { color: 0xfff5e0, intensity: 1.0 }, golden_hour: { color: 0xff8c30, intensity: 0.85 },
        dusk: { color: 0xff5522, intensity: 0.35 }, dawn: { color: 0xffaa55, intensity: 0.45 },
        night: { color: 0x3344aa, intensity: 0.08 },
      }[hint] ?? { color: 0xfff5e0, intensity: 1.0 };
      this._sunLight.color.set(lc.color);
      this._sunLight.intensity = lc.intensity;
    }
    if (this._hemiLight) {
      const hc = {
        day: { sky: 0xcce8ff, ground: 0x886644 }, golden_hour: { sky: 0xff9944, ground: 0x553322 },
        dusk: { sky: 0xff4422, ground: 0x221108 }, dawn: { sky: 0xffaa66, ground: 0x332211 },
        night: { sky: 0x0a0a22, ground: 0x050508 },
      }[hint] ?? { sky: 0xcce8ff, ground: 0x886644 };
      this._hemiLight.color.set(hc.sky);
      this._hemiLight.groundColor.set(hc.ground);
      this._hemiLight.intensity = hint === 'night' ? 0.15 : 0.5;
    }
    if (this._currentSkyMode === 'procedural' || !this._hdriRaw) {
      this.viewer.scene.background = null;
      this.viewer.renderer.setClearColor(0x000000, 0);
    }
    if (this._currentSkyMode === 'procedural' || !this._hdriRaw) {
      const exposures = { day: 0.8, golden_hour: 0.65, dusk: 0.5, dawn: 0.6, night: 1.2 };
      this.viewer.renderer.toneMappingExposure = exposures[hint] ?? 0.8;
    }
    this._updateHorizonGlow(sunPos, sun.elevation);
    this._currentSkyHint = hint;
    console.log(`[PAL sky] applied: ${hint}, sun elevation: ${sun.elevation}`);
  }

  setSunFromTime(hour, latDeg, season = 'summer') {
    const decl = DECLINATION[season] ?? 0;
    const elevation = solarElevation(hour, latDeg, decl);
    const azimuth = solarAzimuth(hour, latDeg, decl);
    const isMorning = hour < 12;
    let descriptor;
    if (elevation > 20) descriptor = 'day';
    else if (elevation > 5) descriptor = 'golden_hour';
    else if (elevation > 0) descriptor = isMorning ? 'dawn' : 'dusk';
    else if (elevation > -6) descriptor = 'dusk';
    else descriptor = 'night';
    const saved = this._currentSkyHint;
    this._applySky(descriptor);
    const phi = THREE.MathUtils.degToRad(90 - elevation);
    const thetaR = THREE.MathUtils.degToRad(azimuth);
    const sunPos = new THREE.Vector3().setFromSphericalCoords(1, phi, thetaR);
    if (this.sky?.material?.uniforms['sunPosition']) {
      this.sky.material.uniforms['sunPosition'].value.copy(sunPos);
    }
    if (this._sunLight) {
      this._sunLight.position.setFromSphericalCoords(300, phi, thetaR);
      const t = THREE.MathUtils.clamp((elevation + 5) / 50, 0, 1);
      this._sunLight.intensity = THREE.MathUtils.lerp(0.05, 1.0, t);
      const warmCol = isMorning ? new THREE.Color(0xffaa66) : new THREE.Color(0xff5522);
      const coolCol = new THREE.Color(0xfff5e0);
      this._sunLight.color.lerpColors(warmCol, coolCol, THREE.MathUtils.clamp(elevation / 30, 0, 1));
    }
    if (this._hemiLight && elevation < 10) {
      if (isMorning) { this._hemiLight.color.set(0x8899cc); this._hemiLight.groundColor.set(0x332233); }
    }
    const elSlider = document.getElementById('sun-elevation');
    const azSlider = document.getElementById('sun-azimuth');
    if (elSlider) { elSlider.value = Math.round(elevation); document.getElementById('sun-elev-label').textContent = Math.round(elevation) + '\u00B0'; }
    if (azSlider) { azSlider.value = Math.round(azimuth); document.getElementById('sun-az-label').textContent = Math.round(azimuth) + '\u00B0'; }
    console.log(`[PAL sky] time ${hour.toFixed(2)}h → elevation ${elevation.toFixed(1)}° azimuth ${azimuth.toFixed(1)}° descriptor: ${descriptor}`);
    return { elevation, azimuth, descriptor };
  }

  setSkyMode(mode) {
    this._currentSkyMode = mode;
    switch (mode) {
      case 'procedural':
        if (this.sky) this.sky.visible = true;
        if (this._horizonMesh) this._horizonMesh.visible = true;
        this.viewer.scene.environment = null;
        this.viewer.scene.background = null;
        this.viewer.renderer.setClearColor(0x000000, 0);
        if (this._sunLight) { this._sunLight.intensity = this._sunLightBaseIntensity; this._sunLight.castShadow = true; }
        break;
      case 'hdri':
        if (this.sky) this.sky.visible = false;
        if (this._horizonMesh) this._horizonMesh.visible = false;
        if (this._hdriRaw) { this.viewer.scene.background = (this._hdriBackgroundVisible !== false) ? this._hdriRaw : null; this.viewer.scene.environment = this._hdriTexture; }
        if (this._sunLight) { this._sunLight.intensity = 0; this._sunLight.castShadow = false; }
        break;
      case 'hybrid':
        if (this.sky) this.sky.visible = false;
        if (this._horizonMesh) this._horizonMesh.visible = false;
        if (this._hdriRaw) { this.viewer.scene.background = (this._hdriBackgroundVisible !== false) ? this._hdriRaw : null; this.viewer.scene.environment = this._hdriTexture; }
        if (this._sunLight) { this._sunLight.intensity = this._sunLightBaseIntensity; this._sunLight.castShadow = true; }
        break;
    }
    console.log(`[PAL sky] mode: ${mode}`);
  }

  setHDRIIntensity(value) { this.viewer.renderer.toneMappingExposure = value; }

  setHDRIBackground(visible) {
    this._hdriBackgroundVisible = visible;
    if (this._hdriRaw) { this.viewer.scene.background = visible ? this._hdriRaw : null; }
  }

  async loadHDRI(fileHandle) {
    if (!this._hdriLoader) this._initHDRI();
    const file = await fileHandle.getFile();
    const name = file.name;
    if (this._hdriCache.has(name)) { const cached = this._hdriCache.get(name); this._applyHDRI(cached.raw, cached.texture); return; }
    const url = URL.createObjectURL(file);
    return new Promise((resolve, reject) => {
      this._hdriLoader.load(url, hdrTexture => {
        URL.revokeObjectURL(url);
        hdrTexture.mapping = THREE.EquirectangularReflectionMapping;
        const processed = this._pmremGen.fromEquirectangular(hdrTexture).texture;
        this._hdriCache.set(name, { raw: hdrTexture, texture: processed });
        this._applyHDRI(hdrTexture, processed);
        resolve();
      }, undefined, err => { URL.revokeObjectURL(url); reject(err); });
    });
  }

  async loadHDRIFromBlob(blob, filename = '') {
    if (!this._pmremGen) { this._pmremGen = new THREE.PMREMGenerator(this.viewer.renderer); this._pmremGen.compileEquirectangularShader(); }
    const url = URL.createObjectURL(blob);
    const isEXR = filename.toLowerCase().endsWith('.exr') || blob.type === 'image/x-exr';
    let loader;
    if (isEXR) { const { EXRLoader } = await import('three/addons/loaders/EXRLoader.js'); loader = new EXRLoader(); }
    else { if (!this._hdriLoader) this._initHDRI(); loader = this._hdriLoader; }
    return new Promise((resolve, reject) => {
      loader.load(url, hdr => {
        URL.revokeObjectURL(url);
        hdr.mapping = THREE.EquirectangularReflectionMapping;
        const processed = this._pmremGen.fromEquirectangular(hdr).texture;
        this._applyHDRI(hdr, processed);
        if (this._currentSkyMode === 'procedural') { this.setSkyMode('hybrid'); } else { this.setSkyMode(this._currentSkyMode); }
        console.log(`[PAL HDRI] loaded ${isEXR ? 'EXR' : 'HDR'}:`, hdr.image?.width, 'x', hdr.image?.height, 'mode:', this._currentSkyMode);
        resolve({ width: hdr.image?.width, height: hdr.image?.height });
      }, undefined, err => { URL.revokeObjectURL(url); reject(err || new Error(`${isEXR ? 'EXR' : 'RGBE'}Loader failed to parse file`)); });
    });
  }

  _applyHDRI(raw, texture) {
    this._hdriRaw = raw;
    this._hdriTexture = texture;
    this.viewer.scene.environment = texture;
    const bgVisible = this._hdriBackgroundVisible !== false;
    this.viewer.scene.background = bgVisible ? raw : null;
    if (this.sky) this.sky.visible = false;
    if (this._horizonMesh) this._horizonMesh.visible = false;
    if (this._currentSkyMode === 'procedural') { this._currentSkyMode = 'hybrid'; }
    console.log('[PAL HDRI] applied — env set, bg:', bgVisible, 'mode:', this._currentSkyMode);
  }

  setLensflare(enabled) {
    if (this._lensflare) { this._lensflare.visible = enabled && this.viewer.mode === 'camera'; }
    this._lensflareEnabled = enabled;
  }
  setLensflareSize(size) {
    if (this._lensflare && this._lensflare.children?.length) { const elements = this._lensflare.elements || []; if (elements[0]) elements[0].size = size; }
  }
  setLensflareIntensity(intensity) {
    if (this._lensflare) { const elements = this._lensflare.elements || []; for (const el of elements) { if (el.color) el.color.setScalar(intensity); } }
  }

  setViewportTheme(theme) {
    this.viewer._viewportTheme = theme;
    const colors = { dark: 0x1a1a18, grey: 0x333330 };
    const c = colors[theme] || colors.dark;
    this.viewer.renderer.setClearColor(c);
    this.viewer.scene.fog.color.set(c);
    if (!this.sky || !this._currentSkyHint) { this.viewer.scene.background = new THREE.Color(c); }
  }
}
