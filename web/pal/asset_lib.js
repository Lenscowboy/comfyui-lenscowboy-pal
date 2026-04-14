// frontend/pal/asset_lib.js
// PAL — Local asset library manager. Entirely client-side.
// Uses File System Access API (Chrome/Edge). No server calls for Phase 1 formats.
// Phase 2: IndexedDB GLB cache + FBX/USD conversion via server.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';

const SUPPORTED_EXTENSIONS = ['.glb', '.gltf', '.obj', '.fbx', '.usd', '.usda', '.usdz'];
const MANIFEST_KEY = 'pal_asset_manifest';

export const UNSUPPORTED_FORMATS = {
  '.blend':  { app: 'Blender',    guide: 'File → Export → glTF 2.0 (.glb)' },
  '.hip':    { app: 'Houdini',    guide: 'File → Export → FBX or USD' },
  '.hipnc':  { app: 'Houdini',    guide: 'File → Export → FBX or USD' },
  '.ma':     { app: 'Maya',       guide: 'File → Export All → FBX or USD' },
  '.mb':     { app: 'Maya',       guide: 'File → Export All → FBX or USD' },
  '.c4d':    { app: 'Cinema 4D',  guide: 'File → Export → FBX or glTF' },
  '.max':    { app: '3ds Max',    guide: 'File → Export → FBX' },
};

export function getUnsupportedInfo(filename) {
  const ext = '.' + filename.split('.').pop().toLowerCase();
  return UNSUPPORTED_FORMATS[ext] || null;
}

function getExtension(name) {
  return '.' + name.split('.').pop().toLowerCase();
}

function stripExtension(name) {
  return name.replace(/\.[^.]+$/, '');
}

// ── Asset Library ────────────────────────────────────────────

const _manifest = [];
let _dirHandle = null;

export const AssetLib = {
  async mountFolder() {
    try {
      _dirHandle = await window.showDirectoryPicker({ mode: 'read' });
    } catch (e) {
      if (e.name === 'AbortError') return []; // user cancelled
      throw e;
    }

    _manifest.length = 0;

    for await (const entry of _dirHandle.values()) {
      if (entry.kind !== 'file') continue;
      const ext = getExtension(entry.name);
      if (!SUPPORTED_EXTENSIONS.includes(ext)) continue;
      _manifest.push({ name: stripExtension(entry.name), handle: entry, ext });
    }

    // Persist names only (handles can't be serialised)
    const names = _manifest.map(m => ({ name: m.name, ext: m.ext }));
    localStorage.setItem(MANIFEST_KEY, JSON.stringify(names));

    return _manifest;
  },

  // Build a LoadingManager that resolves sibling texture files from the mounted dir
  _makeLocalManager() {
    const dirHandle = _dirHandle;
    const urlCache = new Map(); // filename -> blob URL
    const manager = new THREE.LoadingManager();
    manager.setURLModifier((url) => {
      // If it's already a blob URL, pass through
      if (url.startsWith('blob:')) return url;
      // Extract filename from any path
      const filename = url.split('/').pop().split('\\').pop();
      if (urlCache.has(filename)) return urlCache.get(filename);
      // Return placeholder — actual resolve happens in resolveURL
      return url;
    });
    // Pre-resolve textures from mounted folder
    manager._resolveFile = async (filename) => {
      if (!dirHandle || urlCache.has(filename)) return urlCache.get(filename) || null;
      try {
        const fh = await dirHandle.getFileHandle(filename, { create: false });
        const f = await fh.getFile();
        const blobUrl = URL.createObjectURL(f);
        urlCache.set(filename, blobUrl);
        return blobUrl;
      } catch { return null; }
    };
    manager._cleanup = () => { urlCache.forEach(u => URL.revokeObjectURL(u)); urlCache.clear(); };
    return manager;
  },

  async loadAsset(handle) {
    const file = await handle.getFile();
    const url = URL.createObjectURL(file);
    const ext = getExtension(handle.name);

    try {
      if (ext === '.glb' || ext === '.gltf') {
        const loader = new GLTFLoader();
        return await new Promise((resolve, reject) => {
          loader.load(url, (gltf) => resolve(gltf.scene), undefined, reject);
        });
      }
      if (ext === '.obj') {
        // Try to load .mtl file if it exists alongside the .obj
        const baseName = stripExtension(handle.name);
        const mtlName = baseName + '.mtl';
        let materials = null;
        if (_dirHandle) {
          try {
            const mtlHandle = await _dirHandle.getFileHandle(mtlName, { create: false });
            const mtlFile = await mtlHandle.getFile();
            const mtlUrl = URL.createObjectURL(mtlFile);
            const manager = this._makeLocalManager();
            // Pre-resolve texture files referenced in MTL
            const mtlText = await mtlFile.text();
            const texRefs = mtlText.match(/map_\w+\s+(.+)/gi) || [];
            for (const line of texRefs) {
              const texFile = line.split(/\s+/).pop().split('/').pop().split('\\').pop();
              await manager._resolveFile(texFile);
            }
            const mtlLoader = new MTLLoader(manager);
            materials = await new Promise((resolve, reject) => {
              mtlLoader.load(mtlUrl, (mtl) => { mtl.preload(); resolve(mtl); }, undefined, () => resolve(null));
            });
            URL.revokeObjectURL(mtlUrl);
          } catch { /* no .mtl file — load without materials */ }
        }
        const loader = new OBJLoader();
        if (materials) loader.setMaterials(materials);
        return await new Promise((resolve, reject) => {
          loader.load(url, resolve, undefined, reject);
        });
      }
      if (ext === '.fbx') {
        const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js');
        // FBX embeds texture paths — use local manager to resolve from mounted folder
        const manager = _dirHandle ? this._makeLocalManager() : undefined;
        const loader = new FBXLoader(manager);
        const result = await new Promise((resolve, reject) => {
          loader.load(url, resolve, undefined, reject);
        });
        // Try to resolve any missing textures
        if (_dirHandle) {
          const texPromises = [];
          result.traverse(c => {
            if (c.isMesh && c.material) {
              const mats = Array.isArray(c.material) ? c.material : [c.material];
              for (const mat of mats) {
                if (mat.map && !mat.map.image) {
                  const texName = mat.map.name || mat.map.sourceFile || '';
                  if (texName) texPromises.push(this._resolveTexture(mat, 'map', texName));
                }
              }
            }
          });
          if (texPromises.length) await Promise.allSettled(texPromises);
        }
        return result;
      }
      if (ext === '.usd' || ext === '.usda' || ext === '.usdz') {
        // USD requires server-side conversion to GLB
        URL.revokeObjectURL(url);
        const formData = new FormData();
        formData.append('file', file, handle.name);
        const token = localStorage.getItem('pal_jwt') || '';
        const headers = token ? { Authorization: 'Bearer ' + token } : {};
        const resp = await fetch('/pal/export-geo/usd', { method: 'POST', headers, credentials: 'include', body: formData });
        if (!resp.ok) throw new Error('USD conversion failed: ' + resp.status);
        const glbBlob = await resp.blob();
        const glbUrl = URL.createObjectURL(glbBlob);
        const loader = new GLTFLoader();
        try {
          return await new Promise((resolve, reject) => {
            loader.load(glbUrl, (gltf) => resolve(gltf.scene), undefined, reject);
          });
        } finally { URL.revokeObjectURL(glbUrl); }
      }
      throw new Error(`Unsupported extension: ${ext}`);
    } finally {
      URL.revokeObjectURL(url);
    }
  },

  async _resolveTexture(mat, slot, texName) {
    if (!_dirHandle) return;
    const filename = texName.split('/').pop().split('\\').pop();
    try {
      const fh = await _dirHandle.getFileHandle(filename, { create: false });
      const f = await fh.getFile();
      const texUrl = URL.createObjectURL(f);
      const tex = new THREE.TextureLoader().load(texUrl);
      tex.flipY = false;
      mat[slot] = tex;
      mat.needsUpdate = true;
    } catch { /* texture file not found */ }
  },

  getManifest() {
    return [..._manifest];
  },

  isMounted() {
    return _dirHandle !== null;
  },
};

// ── Project Folder Mount ────────────────────────────────────

export const ProjectFolder = {
  _rootHandle: null,
  _manifest: { objects: [], hdri: [], ref: [] },

  async mount() {
    try {
      this._rootHandle = await window.showDirectoryPicker({ mode: 'read', id: 'pal-project-folder' });
      await this._scan();
      localStorage.setItem('pal_project_folder_name', this._rootHandle.name);
      return this._manifest;
    } catch (e) {
      if (e.name !== 'AbortError') console.error('[PAL folder]', e);
      return null;
    }
  },

  async _scan() {
    this._manifest = { objects: [], hdri: [], ref: [] };
    const dirs = {
      'source_objects': this._manifest.objects,
      'source_hdri': this._manifest.hdri,
      'source_ref': this._manifest.ref,
    };
    for (const [dirName, target] of Object.entries(dirs)) {
      try {
        const dirHandle = await this._rootHandle.getDirectoryHandle(dirName, { create: false });
        for await (const entry of dirHandle.values()) {
          if (entry.kind !== 'file') continue;
          const name = entry.name.toLowerCase();
          const isValid = (
            (dirName === 'source_objects' && /\.(glb|gltf|obj|fbx|usd)$/.test(name)) ||
            (dirName === 'source_hdri' && /\.(hdr|exr)$/.test(name)) ||
            (dirName === 'source_ref' && /\.(jpg|jpeg|png|webp)$/.test(name))
          );
          if (isValid) {
            target.push({ name: entry.name, handle: entry, dir: dirName, thumbnail: null });
          }
        }
      } catch {
        console.log(`[PAL folder] no ${dirName}/ found — skipping`);
      }
    }
    console.log(`[PAL folder] scanned: ${this._manifest.objects.length} objects, ${this._manifest.hdri.length} HDRIs, ${this._manifest.ref.length} refs`);
  },

  async getFileHandle(dirName, filename) {
    if (!this._rootHandle) return null;
    try {
      const dir = await this._rootHandle.getDirectoryHandle(dirName, { create: false });
      return await dir.getFileHandle(filename);
    } catch { return null; }
  },

  isMounted() { return this._rootHandle !== null; },
  getManifest() { return this._manifest; },
  getFolderName() { return this._rootHandle?.name ?? null; },
};

// ── Drag-and-drop helper ─────────────────────────────────────

export function setupDropZone(canvasEl, viewer, onUnsupported) {
  canvasEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });

  canvasEl.addEventListener('drop', async (e) => {
    e.preventDefault();
    const files = [...e.dataTransfer.files];
    if (!files.length) return;

    for (const file of files) {
      const ext = getExtension(file.name);

      // Check unsupported
      const info = getUnsupportedInfo(file.name);
      if (info) {
        onUnsupported(file.name, info);
        continue;
      }

      // Check supported
      if (!SUPPORTED_EXTENSIONS.includes(ext)) continue;

      const url = URL.createObjectURL(file);
      try {
        let mesh;
        if (ext === '.glb' || ext === '.gltf') {
          const loader = new GLTFLoader();
          const gltf = await new Promise((resolve, reject) => {
            loader.load(url, resolve, undefined, reject);
          });
          mesh = gltf.scene;
        } else if (ext === '.obj') {
          const loader = new OBJLoader();
          mesh = await new Promise((resolve, reject) => {
            loader.load(url, resolve, undefined, reject);
          });
        }
        if (mesh && viewer) {
          mesh.position.set(0, 0, 0);
          viewer.addExternalMesh(mesh, `drop_${Date.now()}`);
        }
      } finally {
        URL.revokeObjectURL(url);
      }
    }
  });
}


// ── Phase 2: IndexedDB GLB Cache ─────────────────────────

const DB_NAME = 'pal_asset_cache';
const DB_VERSION = 1;
const STORE = 'glb_cache';
const TTL_DAYS = 30;

function openCacheDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => { e.target.result.createObjectStore(STORE, { keyPath: 'hash' }); };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

async function hashFile(arrayBuffer) {
  const digest = await crypto.subtle.digest('SHA-256', arrayBuffer);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export const GLBCache = {
  async get(hash) {
    const db = await openCacheDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(hash);
      req.onsuccess = () => {
        const entry = req.result;
        if (!entry) { resolve(null); return; }
        const age = (Date.now() - entry.cachedAt) / 86400000;
        if (age > TTL_DAYS) { this.delete(hash); resolve(null); return; }
        resolve(entry.glbBuffer);
      };
      req.onerror = () => resolve(null);
    });
  },
  async set(hash, glbBuffer) {
    const db = await openCacheDB();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ hash, glbBuffer, cachedAt: Date.now() });
  },
  async delete(hash) {
    const db = await openCacheDB();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(hash);
  },
  async purgeExpired() {
    const db = await openCacheDB();
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const req = store.getAll();
    req.onsuccess = () => {
      for (const entry of req.result || []) {
        if ((Date.now() - entry.cachedAt) / 86400000 > TTL_DAYS) store.delete(entry.hash);
      }
    };
  },
};

function _loadGLBBuffer(buffer) {
  const blob = new Blob([buffer], { type: 'model/gltf-binary' });
  const url = URL.createObjectURL(blob);
  const loader = new GLTFLoader();
  return new Promise((resolve, reject) => {
    loader.load(url, gltf => { URL.revokeObjectURL(url); resolve(gltf.scene); }, undefined, reject);
  });
}

// Load a file that needs server-side conversion (FBX, USD)
export async function loadConvertedAsset(file) {
  const buffer = await file.arrayBuffer();
  const hash = await hashFile(buffer);

  const cached = await GLBCache.get(hash);
  if (cached) return _loadGLBBuffer(cached);

  const formData = new FormData();
  formData.append('file', new Blob([buffer]), file.name);
  const token = localStorage.getItem('pal_jwt') || '';
  const headers = token ? { Authorization: 'Bearer ' + token } : {};
  const resp = await fetch('/pal/convert-asset', { method: 'POST', headers, body: formData });
  if (!resp.ok) throw new Error(`Conversion failed: ${resp.status}`);
  const glbBuffer = await resp.arrayBuffer();

  await GLBCache.set(hash, glbBuffer);
  return _loadGLBBuffer(glbBuffer);
}
