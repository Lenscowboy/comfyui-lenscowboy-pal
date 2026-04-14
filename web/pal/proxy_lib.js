// frontend/pal/proxy_lib.js
// PAL — Proxy geometry registry + public API.
// Individual builders live in proxy_builders.js.

import * as THREE from 'three';
import {
  humanStanding, humanSeated, vehicleCar, vehicleLarge, cameraRig,
  terrainPlane, terrainCanyon, buildingGeneric, wallPlane, treeGeneric,
  waterPlane, propGeneric, horse, chariot, houseSingle, houseTwoStory,
  tent, boatSmall, boatLarge, throne, altar, bridge, wallFortified,
  gateArch, column, torch, rockLarge, stairsWide, tableSimple,
  campfire, fenceSection, cart, barrel, crate, buildCompound,
  COLORS, mat,
} from './proxy_builders.js';

// ── Registry ─────────────────────────────────────────────────

const BUILDERS = {
  human_standing:   humanStanding,
  human_seated:     humanSeated,
  vehicle_car:      vehicleCar,
  vehicle_large:    vehicleLarge,
  camera_rig:       cameraRig,
  terrain_plane:    terrainPlane,
  terrain_canyon:   terrainCanyon,
  building_generic: buildingGeneric,
  wall_plane:       wallPlane,
  tree_generic:     treeGeneric,
  water_plane:      waterPlane,
  prop_generic:     propGeneric,
  horse:            horse,
  chariot:          chariot,
  house_single:     houseSingle,
  house_two_story:  houseTwoStory,
  tent:             tent,
  boat_small:       boatSmall,
  boat_large:       boatLarge,
  throne:           throne,
  altar:            altar,
  bridge:           bridge,
  wall_fortified:   wallFortified,
  gate_arch:        gateArch,
  column:           column,
  torch:            torch,
  rock_large:       rockLarge,
  stairs_wide:      stairsWide,
  table_simple:     tableSimple,
  campfire:         campfire,
  fence_section:    fenceSection,
  cart:             cart,
  barrel:           barrel,
  crate:            crate,
};

// ── Keyword mapping (per-project, loaded from settings) ──────

let _keywordMap = {};  // e.g. { "stallion": "horse", "sedan": "vehicle_car" }

export const ProxyLib = {
  types: Object.keys(BUILDERS),
  TYPES: BUILDERS,

  setKeywordMap(map) { _keywordMap = map || {}; },
  getKeywordMap() { return { ..._keywordMap }; },

  resolveType(keyword) {
    const k = (keyword || '').toLowerCase().replace(/[\s-]+/g, '_');
    if (_keywordMap[k]) return _keywordMap[k];
    if (BUILDERS[k]) return k;
    for (const type of Object.keys(BUILDERS)) {
      if (k.includes(type) || type.includes(k)) return type;
    }
    return 'prop_generic';
  },

  build(proxyType, colorHint) {
    const fn = BUILDERS[proxyType] || BUILDERS.prop_generic;
    const mesh = fn(colorHint || 'white');
    mesh.traverse(child => {
      if (child.isMesh) { child.castShadow = true; child.receiveShadow = true; }
    });
    mesh.userData.proxyType = proxyType;
    mesh.userData.colorHint = colorHint || 'white';
    return mesh;
  },

  buildCompound(recipe, colorHint) {
    return buildCompound(recipe, colorHint);
  },
};

// ── Frustum helper ───────────────────────────────────────────

export function buildFrustumHelper(fovDeg, aspect = 1.78, near = 0.5, far = 8.0) {
  const fovRad = THREE.MathUtils.degToRad(fovDeg);
  const hHalf = Math.tan(fovRad / 2) * far;
  const wHalf = hHalf * aspect;
  const points = [
    new THREE.Vector3(-wHalf, -hHalf, -far),
    new THREE.Vector3(wHalf, -hHalf, -far),
    new THREE.Vector3(wHalf, hHalf, -far),
    new THREE.Vector3(-wHalf, hHalf, -far),
  ];
  const geo = new THREE.BufferGeometry();
  const verts = [];
  const origin = new THREE.Vector3(0, 0, 0);
  points.forEach(p => { verts.push(origin.x, origin.y, origin.z, p.x, p.y, p.z); });
  for (let i = 0; i < 4; i++) {
    const a = points[i], b = points[(i + 1) % 4];
    verts.push(a.x, a.y, a.z, b.x, b.y, b.z);
  }
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  const lineMat = new THREE.LineBasicMaterial({ color: 0xf5c400, opacity: 0.6, transparent: true, depthTest: false });
  const lines = new THREE.LineSegments(geo, lineMat);
  lines.renderOrder = 998;
  return lines;
}

// Re-export for backward compat
export { COLORS, mat };
