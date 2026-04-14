import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutlinePass } from 'three/addons/postprocessing/OutlinePass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';

export class PALPostprocessing {
  constructor(viewer) {
    this.viewer = viewer;
    this.composer = null;
    this.ssaoPass = null;
    this.bloomPass = null;
    this.outlinePass = null;
    this.bokehPass = null;
    this._renderPass = null;
    this._webgpuPP = false;
  }

  // ── Init ────────────────────────────────────────────────────

  _initPostprocessing() {
    const w = this.viewer.canvas.clientWidth || 1;
    const h = this.viewer.canvas.clientHeight || 1;

    // WebGPU uses direct rendering — no EffectComposer
    // Post-processing on WebGPU would use node-based system (future)
    if (this.viewer._backend === 'webgpu') {
      this._webgpuPP = true;
      console.log('[PAL] WebGPU mode — post-processing via direct render');
      return;
    }

    this._webgpuPP = false;
    this.composer = new EffectComposer(this.viewer.renderer);

    // 1. Render pass
    const renderPass = new RenderPass(this.viewer.scene, this.viewer.activeCamera);
    this.composer.addPass(renderPass);
    this._renderPass = renderPass;

    // 2. SSAO pass (Task 8) — disabled by default, enabled via settings
    this.ssaoPass = new SSAOPass(this.viewer.scene, this.viewer.activeCamera, Math.max(1, w), Math.max(1, h));
    this.ssaoPass.kernelRadius = 8;
    this.ssaoPass.minDistance = 0.001;
    this.ssaoPass.maxDistance = 0.08;
    this.ssaoPass.output = SSAOPass.OUTPUT.Default;
    this.ssaoPass.enabled = false;
    this.composer.addPass(this.ssaoPass);

    // 3. Bloom pass (Task 9) — disabled by default, enabled via settings
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(Math.max(1, w), Math.max(1, h)), 0.3, 0.5, 0.85);
    this.bloomPass.enabled = false;
    this.composer.addPass(this.bloomPass);

    // 3b. Bokeh DOF pass — disabled by default, enabled via camera bar
    this.bokehPass = new BokehPass(this.viewer.scene, this.viewer.activeCamera, {
      focus: 5.0,
      aperture: 0.025,
      maxblur: 0.1,
    });
    this.bokehPass.enabled = false;
    this.composer.addPass(this.bokehPass);

    // 4. Outline pass
    this.outlinePass = new OutlinePass(new THREE.Vector2(w, h), this.viewer.scene, this.viewer.activeCamera);
    this.outlinePass.visibleEdgeColor.set(0x00d4d4);
    this.outlinePass.hiddenEdgeColor.set(0x004444);
    this.outlinePass.edgeStrength = 3.0;
    this.outlinePass.edgeThickness = 1.0;
    this.outlinePass.edgeGlow = 0.3;
    this.composer.addPass(this.outlinePass);

    // 5. Output pass
    this.composer.addPass(new OutputPass());
  }

  // ── SSAO (Task 8) ──────────────────────────────────────────

  setSSAO(enabled, radius = 8) {
    if (this.ssaoPass) {
      this.ssaoPass.enabled = enabled;
      this.ssaoPass.kernelRadius = radius;
    }
  }

  // ── Bloom (Task 9) ─────────────────────────────────────────

  setBloom(enabled, strength = 0.3) {
    if (this.bloomPass) {
      this.bloomPass.enabled = enabled;
      this.bloomPass.strength = strength;
    }
  }

  // ── Depth of Field (BokehPass) ──────────────────────────────

  setDOF(enabled) {
    if (this.bokehPass) this.bokehPass.enabled = enabled;
  }

  updateDOF(focusDistance, fStop, focalLength) {
    if (!this.bokehPass) return;
    // BokehPass 'focus' is in world units (metres in our scene)
    this.bokehPass.uniforms['focus'].value = focusDistance;
    // Physical aperture diameter in mm: focalLength / fStop
    // BokehPass 'aperture' controls blur intensity — higher = more blur
    // Scale factor tuned so 50mm f/2.8 gives subtle blur, 200mm f/1.2 gives heavy blur
    const apertureDiameter = focalLength / fStop; // mm
    const apertureVal = apertureDiameter / 500; // normalise: 50mm/2.8=17.8→0.036, 200mm/1.2=167→0.33
    this.bokehPass.uniforms['aperture'].value = Math.max(0.0001, apertureVal);
    // maxblur not capped here — controlled by slider in settings
  }

  // ── Tone Mapping ────────────────────────────────────────────

  setToneMapping(mode) {
    const modes = {
      'none':     THREE.NoToneMapping,
      'linear':   THREE.LinearToneMapping,
      'reinhard': THREE.ReinhardToneMapping,
      'cineon':   THREE.CineonToneMapping,
      'aces':     THREE.ACESFilmicToneMapping,
      'agx':      THREE.AgXToneMapping,
      'neutral':  THREE.NeutralToneMapping,
    };
    this.viewer.renderer.toneMapping = modes[mode] ?? THREE.ACESFilmicToneMapping;
    // Materials need recompile after tonemapping change
    this.viewer.scene.traverse(obj => {
      if (obj.material) obj.material.needsUpdate = true;
    });
    console.log(`[PAL] toneMapping: ${mode}`);
  }

  // ── Shadow Quality (Task 12) ────────────────────────────────

  setShadowQuality(quality) {
    const settings = {
      off:    { enabled: false, size: 512,  radius: 1, bias: -0.0005, frustum: 200 },
      low:    { enabled: true,  size: 1024, radius: 4, bias: -0.001,  frustum: 200 },
      medium: { enabled: true,  size: 2048, radius: 3, bias: -0.0005, frustum: 150 },
      high:   { enabled: true,  size: 4096, radius: 2, bias: -0.0003, frustum: 120 },
      ultra:  { enabled: true,  size: 8192, radius: 1, bias: -0.0001, frustum: 100 },
    };
    const s = settings[quality] ?? settings['medium'];
    this.viewer.renderer.shadowMap.enabled = s.enabled;
    this.viewer.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    if (this.viewer.groundPlane) this.viewer.groundPlane.visible = s.enabled;
    if (this.viewer.lighting._sunLight) {
      this.viewer.lighting._sunLight.castShadow = s.enabled;
      this.viewer.lighting._sunLight.shadow.mapSize.set(s.size, s.size);
      this.viewer.lighting._sunLight.shadow.radius = s.radius;
      this.viewer.lighting._sunLight.shadow.bias = s.bias;
      // Tighter frustum at higher quality = more shadow texels per unit
      this.viewer.lighting._sunLight.shadow.camera.left = -s.frustum;
      this.viewer.lighting._sunLight.shadow.camera.right = s.frustum;
      this.viewer.lighting._sunLight.shadow.camera.top = s.frustum;
      this.viewer.lighting._sunLight.shadow.camera.bottom = -s.frustum;
      this.viewer.lighting._sunLight.shadow.camera.updateProjectionMatrix();
      if (this.viewer.lighting._sunLight.shadow.map) {
        this.viewer.lighting._sunLight.shadow.map.dispose();
        this.viewer.lighting._sunLight.shadow.map = null;
      }
    }
    this.viewer.renderer.shadowMap.needsUpdate = true;
  }

  // ── Viewport Presets (Task 11) ──────────────────────────────

  applyViewportPreset(presetName) {
    const p = PALPostprocessing.VIEWPORT_PRESETS[presetName];
    if (!p) return;
    this.setShadowQuality(p.shadows);
    this.setSSAO(p.ssao, p.ssaoRadius);
    this.setBloom(p.bloom, p.bloomStr);
    this.viewer.setLensflare(p.lensflare);
    this.viewer.renderer.setPixelRatio(p.pixelRatio);
    this.viewer.setHDRIIntensity(p.hdriIntensity);
    this.viewer._currentPreset = presetName;
    localStorage.setItem('pal_viewport_preset', presetName);
    document.querySelectorAll('.pal-preset-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.preset === presetName);
    });
    console.log(`[PAL viewport] preset: ${presetName}`);
  }

  // ── Grid ────────────────────────────────────────────────────

  setGridVisible(visible) {
    if (this.viewer.grid) this.viewer.grid.visible = visible;
  }

  // ── Aspect Ratio ────────────────────────────────────────────

  setAspectRatio(ratio) {
    this.viewer.shotCam.aspect = ratio;
    this.viewer.shotCam.updateProjectionMatrix();
  }

  // ── Static Presets ──────────────────────────────────────────

  static VIEWPORT_PRESETS = {
    performance: { shadows: 'off', ssao: false, ssaoRadius: 4, bloom: false, bloomStr: 0.2, lensflare: false, pixelRatio: 1.0, hdriIntensity: 0.8 },
    balanced:    { shadows: 'medium', ssao: true, ssaoRadius: 8, bloom: true, bloomStr: 0.3, lensflare: false, pixelRatio: 1.0, hdriIntensity: 0.8 },
    quality:     { shadows: 'high', ssao: true, ssaoRadius: 12, bloom: true, bloomStr: 0.4, lensflare: true, pixelRatio: Math.min(window.devicePixelRatio, 2), hdriIntensity: 0.9 },
    export:      { shadows: 'ultra', ssao: true, ssaoRadius: 16, bloom: true, bloomStr: 0.35, lensflare: false, pixelRatio: 2.0, hdriIntensity: 0.9 },
  };
}
