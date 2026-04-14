// frontend/pal/proxy_builders.js
// PAL — Individual proxy geometry builder functions. All sub-100 polygon.

import * as THREE from 'three';

export const COLORS = {
  cyan:       0x00d4d4,
  orange:     0xe8820c,
  yellow:     0xf5c400,
  grey:       0x888880,
  dark_grey:  0x444440,
  light_grey: 0xb4b2a8,
  green:      0x639922,
  blue:       0x3788dd,
  white:      0xddddd8,
};

export function mat(colorHint) {
  const hex = COLORS[colorHint] || COLORS.white;
  return new THREE.MeshStandardMaterial({
    color: hex, roughness: 0.82, metalness: 0.0,
    side: THREE.DoubleSide, shadowSide: THREE.FrontSide,
  });
}

export function wireMat(colorHint) {
  const hex = COLORS[colorHint] || COLORS.white;
  return new THREE.MeshBasicMaterial({ color: hex, wireframe: true, opacity: 0.4, transparent: true });
}

// ── Proxy geometry builders ─────────────────────────────────

export function humanStanding(c) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 1.2, 8), mat(c));
  body.position.y = 0.6;
  g.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 6), mat(c));
  head.position.y = 1.35;
  g.add(head);
  return g;
}

export function humanSeated(c) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.7, 8), mat(c));
  body.position.y = 0.65;
  g.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 6), mat(c));
  head.position.y = 1.15;
  g.add(head);
  const legs = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.15, 0.5), mat(c));
  legs.position.set(0, 0.08, 0.2);
  g.add(legs);
  return g;
}

export function vehicleCar(c) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(4, 1, 1.8), mat(c));
  body.position.y = 0.8;
  g.add(body);
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(2, 0.8, 1.6), mat(c));
  cabin.position.set(-0.3, 1.6, 0);
  g.add(cabin);
  const wheelGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.2, 8);
  const wheelMat = mat('dark_grey');
  const positions = [[-1.3,0.3,-0.9],[-1.3,0.3,0.9],[1.3,0.3,-0.9],[1.3,0.3,0.9]];
  for (const p of positions) {
    const w = new THREE.Mesh(wheelGeo, wheelMat);
    w.rotation.x = Math.PI / 2; w.position.set(...p); g.add(w);
  }
  return g;
}

export function vehicleLarge(c) { const m = new THREE.Mesh(new THREE.BoxGeometry(6, 3, 2.5), mat(c)); m.position.y = 1.5; return m; }

export function cameraRig(c) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.3, 0.35), mat(c));
  g.add(body);
  const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 0.35, 12), mat(c));
  lens.rotation.x = Math.PI / 2; lens.position.z = -0.35;
  g.add(lens);
  const glass = new THREE.Mesh(new THREE.CircleGeometry(0.08, 12), new THREE.MeshLambertMaterial({ color: 0x111122 }));
  glass.position.z = -0.53;
  g.add(glass);
  const finder = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.1, 0.12), mat(c));
  finder.position.set(0.1, 0.2, 0);
  g.add(finder);
  const magazine = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.32, 0.12), mat(c));
  magazine.position.z = 0.24;
  g.add(magazine);
  return g;
}

export function terrainPlane(c) {
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshStandardMaterial({ color: COLORS[c] || COLORS.grey, roughness: 0.95, metalness: 0, side: THREE.DoubleSide })
  );
  m.rotation.x = -Math.PI / 2;
  return m;
}

export function terrainCanyon(c) {
  const g = new THREE.Group();
  for (let i = 0; i < 4; i++) {
    const box = new THREE.Mesh(new THREE.BoxGeometry(4, 8, 8 - i * 1.5), mat(c));
    box.position.set(15 + i * 2, 4, 0); g.add(box);
    const box2 = box.clone();
    box2.position.set(-15 - i * 2, 4, 0); g.add(box2);
  }
  return g;
}

export function buildingGeneric(c) {
  const g = new THREE.Group();
  const solid = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat(c));
  g.add(solid);
  const wire = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), wireMat(c));
  g.add(wire);
  return g;
}

export function wallPlane(c) { return new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat(c)); }

export function treeGeneric(c) {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.2, 2, 6), mat('dark_grey'));
  trunk.position.y = 1;
  g.add(trunk);
  const canopy = new THREE.Mesh(new THREE.ConeGeometry(1.2, 3, 6), mat(c));
  canopy.position.y = 3.5;
  g.add(canopy);
  return g;
}

export function waterPlane(c) {
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshStandardMaterial({ color: COLORS[c] || COLORS.blue, roughness: 0.2, metalness: 0.1, transparent: true, opacity: 0.55, side: THREE.DoubleSide })
  );
  m.rotation.x = -Math.PI / 2;
  return m;
}

export function propGeneric(c) { return new THREE.Mesh(new THREE.IcosahedronGeometry(0.5, 0), mat(c)); }

// ── Expanded proxy types ────────────────────────────────────

export function horse(c) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.8, 0.7), mat(c));
  body.position.set(0, 1.2, 0); g.add(body);
  const neck = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.9, 0.4), mat(c));
  neck.position.set(0.8, 1.8, 0); neck.rotation.z = -0.3; g.add(neck);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.3, 0.3), mat(c));
  head.position.set(1.3, 2.2, 0); g.add(head);
  const legGeo = new THREE.CylinderGeometry(0.08, 0.08, 1.1, 6);
  [[-0.6,0.55,-0.25],[-0.6,0.55,0.25],[0.6,0.55,-0.25],[0.6,0.55,0.25]].forEach(p => {
    const l = new THREE.Mesh(legGeo, mat(c)); l.position.set(...p); g.add(l);
  });
  return g;
}

export function chariot(c) {
  const g = new THREE.Group();
  const floor = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.08, 0.9), mat(c));
  floor.position.set(0, 0.6, 0); g.add(floor);
  const back = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.6, 0.9), mat(c));
  back.position.set(0.6, 0.9, 0); g.add(back);
  const sideL = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.4, 0.06), mat(c));
  sideL.position.set(0, 0.8, 0.45); g.add(sideL);
  const sideR = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.4, 0.06), mat(c));
  sideR.position.set(0, 0.8, -0.45); g.add(sideR);
  const wGeo = new THREE.TorusGeometry(0.45, 0.04, 6, 12);
  const wMat = mat('dark_grey');
  [0.5, -0.5].forEach(z => { const w = new THREE.Mesh(wGeo, wMat); w.position.set(-0.8, 0.45, z); g.add(w); });
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 2.5, 4), mat(c));
  pole.rotation.z = Math.PI / 2; pole.position.set(-1.8, 0.55, 0); g.add(pole);
  return g;
}

export function houseSingle(c) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(3, 2.5, 3), mat(c));
  body.position.y = 1.25; g.add(body);
  const roof = new THREE.Mesh(new THREE.ConeGeometry(2.5, 1.2, 4), mat('dark_grey'));
  roof.position.y = 3.1; roof.rotation.y = Math.PI / 4; g.add(roof);
  const door = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.2, 0.05), mat('dark_grey'));
  door.position.set(0, 0.6, 1.53); g.add(door);
  return g;
}

export function houseTwoStory(c) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(4, 5, 4), mat(c));
  body.position.y = 2.5; g.add(body);
  const roof = new THREE.Mesh(new THREE.ConeGeometry(3.2, 1.5, 4), mat('dark_grey'));
  roof.position.y = 5.75; roof.rotation.y = Math.PI / 4; g.add(roof);
  return g;
}

export function tent(c) {
  const g = new THREE.Group();
  const cone = new THREE.Mesh(new THREE.ConeGeometry(1.5, 2.5, 6), mat(c));
  cone.position.y = 1.25; g.add(cone);
  return g;
}

export function boatSmall(c) {
  const g = new THREE.Group();
  const hull = new THREE.Mesh(new THREE.BoxGeometry(3, 0.6, 1.2), mat(c));
  hull.position.y = 0.3; g.add(hull);
  const bow = new THREE.Mesh(new THREE.ConeGeometry(0.6, 1.0, 4), mat(c));
  bow.rotation.z = Math.PI / 2; bow.position.set(2.0, 0.3, 0); g.add(bow);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 3, 4), mat('dark_grey'));
  mast.position.set(0, 2.1, 0); g.add(mast);
  return g;
}

export function boatLarge(c) {
  const g = new THREE.Group();
  const hull = new THREE.Mesh(new THREE.BoxGeometry(8, 1.5, 3), mat(c));
  hull.position.y = 0.75; g.add(hull);
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(3, 1.5, 2.5), mat(c));
  cabin.position.set(-1, 2.25, 0); g.add(cabin);
  return g;
}

export function throne(c) {
  const g = new THREE.Group();
  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.1, 0.7), mat(c));
  seat.position.y = 0.45; g.add(seat);
  const bk = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.2, 0.1), mat(c));
  bk.position.set(0, 1.05, -0.3); g.add(bk);
  const armL = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.4, 0.6), mat(c));
  armL.position.set(-0.4, 0.65, 0); g.add(armL);
  const armR = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.4, 0.6), mat(c));
  armR.position.set(0.4, 0.65, 0); g.add(armR);
  const legGeo = new THREE.CylinderGeometry(0.05, 0.05, 0.45, 4);
  [[-0.35,0.22,-0.25],[-0.35,0.22,0.25],[0.35,0.22,-0.25],[0.35,0.22,0.25]].forEach(p => {
    const l = new THREE.Mesh(legGeo, mat(c)); l.position.set(...p); g.add(l);
  });
  return g;
}

export function altar(c) {
  const g = new THREE.Group();
  const slab = new THREE.Mesh(new THREE.BoxGeometry(2, 0.15, 1), mat(c));
  slab.position.y = 1.0; g.add(slab);
  const base = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.95, 0.8), mat(c));
  base.position.y = 0.475; g.add(base);
  return g;
}

export function bridge(c) {
  const g = new THREE.Group();
  const deck = new THREE.Mesh(new THREE.BoxGeometry(8, 0.2, 2), mat(c));
  deck.position.y = 2; g.add(deck);
  const arch = new THREE.Mesh(new THREE.TorusGeometry(2, 0.2, 6, 12, Math.PI), mat(c));
  arch.rotation.z = Math.PI; arch.rotation.y = Math.PI / 2;
  arch.position.set(0, 2, 0); g.add(arch);
  return g;
}

export function wallFortified(c) {
  const g = new THREE.Group();
  const wall = new THREE.Mesh(new THREE.BoxGeometry(10, 3, 0.6), mat(c));
  wall.position.y = 1.5; g.add(wall);
  for (let i = -4; i <= 4; i += 2) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.6, 0.6), mat(c));
    m.position.set(i, 3.3, 0); g.add(m);
  }
  return g;
}

export function gateArch(c) {
  const g = new THREE.Group();
  const colL = new THREE.Mesh(new THREE.BoxGeometry(0.6, 4, 0.6), mat(c));
  colL.position.set(-1.5, 2, 0); g.add(colL);
  const colR = new THREE.Mesh(new THREE.BoxGeometry(0.6, 4, 0.6), mat(c));
  colR.position.set(1.5, 2, 0); g.add(colR);
  const archTop = new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.3, 6, 8, Math.PI), mat(c));
  archTop.position.y = 4; g.add(archTop);
  return g;
}

export function column(c) {
  const g = new THREE.Group();
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.25, 3, 8), mat(c));
  shaft.position.y = 1.5; g.add(shaft);
  const cap = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.15, 0.6), mat(c));
  cap.position.y = 3.075; g.add(cap);
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.15, 0.6), mat(c));
  base.position.y = 0.075; g.add(base);
  return g;
}

export function torch(c) {
  const g = new THREE.Group();
  const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.04, 1.2, 4), mat('dark_grey'));
  stick.position.y = 0.6; g.add(stick);
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.3, 6), mat('orange'));
  flame.position.y = 1.35; g.add(flame);
  return g;
}

export function rockLarge(c) { const g = new THREE.Mesh(new THREE.DodecahedronGeometry(1.2, 0), mat(c)); g.position.y = 0.8; g.rotation.set(0.3, 0.5, 0.2); return g; }

export function stairsWide(c) {
  const g = new THREE.Group();
  for (let i = 0; i < 6; i++) {
    const step = new THREE.Mesh(new THREE.BoxGeometry(3, 0.2, 0.4), mat(c));
    step.position.set(0, i * 0.2 + 0.1, -i * 0.4); g.add(step);
  }
  return g;
}

export function tableSimple(c) {
  const g = new THREE.Group();
  const top = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.06, 0.8), mat(c));
  top.position.y = 0.75; g.add(top);
  const legGeo = new THREE.CylinderGeometry(0.04, 0.04, 0.75, 4);
  [[-0.65,0.375,-0.3],[-0.65,0.375,0.3],[0.65,0.375,-0.3],[0.65,0.375,0.3]].forEach(p => {
    const l = new THREE.Mesh(legGeo, mat(c)); l.position.set(...p); g.add(l);
  });
  return g;
}

export function campfire(c) {
  const g = new THREE.Group();
  const logGeo = new THREE.CylinderGeometry(0.06, 0.06, 0.8, 4);
  for (let i = 0; i < 4; i++) {
    const log = new THREE.Mesh(logGeo, mat('dark_grey'));
    log.rotation.z = Math.PI / 2; log.rotation.y = (i * Math.PI) / 4;
    log.position.y = 0.06; g.add(log);
  }
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.25, 0.6, 6), mat('orange'));
  flame.position.y = 0.4; g.add(flame);
  return g;
}

export function fenceSection(c) {
  const g = new THREE.Group();
  const rail = new THREE.Mesh(new THREE.BoxGeometry(3, 0.06, 0.06), mat(c));
  rail.position.y = 0.9; g.add(rail);
  const rail2 = new THREE.Mesh(new THREE.BoxGeometry(3, 0.06, 0.06), mat(c));
  rail2.position.y = 0.5; g.add(rail2);
  for (let i = -1.4; i <= 1.4; i += 0.7) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1, 4), mat(c));
    post.position.set(i, 0.5, 0); g.add(post);
  }
  return g;
}

export function cart(c) {
  const g = new THREE.Group();
  const bed = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.1, 1.0), mat(c));
  bed.position.y = 0.55; g.add(bed);
  const wGeo = new THREE.CylinderGeometry(0.35, 0.35, 0.1, 8);
  const wMat = mat('dark_grey');
  [[-0.6,0.35,-0.55],[-0.6,0.35,0.55],[0.6,0.35,-0.55],[0.6,0.35,0.55]].forEach(p => {
    const w = new THREE.Mesh(wGeo, wMat); w.rotation.x = Math.PI / 2; w.position.set(...p); g.add(w);
  });
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.5, 4), mat(c));
  handle.rotation.z = Math.PI / 2; handle.position.set(-1.7, 0.45, 0); g.add(handle);
  return g;
}

export function barrel(c) { const g = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.28, 0.8, 8), mat(c)); g.position.y = 0.4; return g; }
export function crate(c) { const g = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 0.6), mat(c)); g.position.y = 0.3; return g; }

export function buildCompound(recipe, colorHint) {
  const g = new THREE.Group();
  const SHAPES = {
    box: (s) => new THREE.BoxGeometry(s[0]||1, s[1]||1, s[2]||1),
    cylinder: (s) => new THREE.CylinderGeometry(s[0]||0.5, s[1]||s[0]||0.5, s[2]||1, 8),
    cone: (s) => new THREE.ConeGeometry(s[0]||0.5, s[1]||1, 6),
    sphere: (s) => new THREE.SphereGeometry(s[0]||0.5, 8, 6),
    torus: (s) => new THREE.TorusGeometry(s[0]||0.5, s[1]||0.05, 6, 12),
  };
  for (const part of (recipe.parts || [])) {
    const shapeFn = SHAPES[part.shape];
    if (!shapeFn) continue;
    const geo = shapeFn(part.size || [1,1,1]);
    const m = new THREE.Mesh(geo, mat(part.color || colorHint));
    if (part.position) m.position.set(...part.position);
    if (part.rotation) m.rotation.set(...part.rotation.map(THREE.MathUtils.degToRad));
    g.add(m);
  }
  return g;
}
