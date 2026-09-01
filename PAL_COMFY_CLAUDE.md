# PAL ComfyUI Node — Complete Reference

Single source of truth for the ComfyUI PAL Layout node. Covers architecture, inputs/outputs, postMessage bridge, plans & pricing, and implementation gotchas. Read this before touching any comfy node code.

## Overview

Custom ComfyUI node that embeds the full PAL SaaS 3D previsualisation viewport inside ComfyUI via iframe. Used for spatial layout, camera setup, and multipass render output (beauty, depth, normals, alpha, id matte).

**Architecture: iframe-first, with optional local-renderer path.** The node opens a full-screen modal containing an iframe to the PAL SaaS UI. Rendering happens either (a) in the iframe via Three.js and flows back as base64 passes through postMessage, or (b) directly in Python via `pal_renderer` (pygfx/wgpu) on the user's own GPU when `use_local_renderer=True`.

## Architecture

```
ComfyUI Graph
  PALLayoutNode (pal_node.py)
    ├─ INPUT: lc_api_key, project_id, shot_id, GLB, OBJ, model_3d, prompt,
    │        use_local_renderer, ...
    ├─ HIDDEN: _pal_scene_state (JSON string — scene + render passes)
    └─ OUTPUT: beauty_pass, depth_pass, normal_pass,
               scene_json, camera_json, frame_start, frame_end,
               sequence_json, alpha_pass, id_matte_pass

ComfyUI Browser
  pal_node.js (extension)
    ├─ Registers PALLayoutNode widget
    ├─ "Open Viewport" → full-screen modal with iframe
    ├─ <iframe src="/pal?comfy=1&token=...&project=...&client_id=...">
    ├─ postMessage bridge: pal:render-request, pal:get-state, pal:load-models
    ├─ Graph walk on iframe load: reads upstream Load3D model_file via
    │   ComfyUI /view, posts to iframe so viewport populates on first open
    ├─ Bridge: viewport state ↔ _pal_scene_state hidden widget
    └─ beforeQueuePrompt: blocks if passes not rendered (iframe mode)

PAL web viewport (served by the Lenscowboy platform)
  /pal?comfy=1&token=...
    ├─ Full viewport with all PAL features
    ├─ Listens for postMessage from ComfyUI parent
    └─ Sends pal:state and pal:render messages back

Local renderer (optional, comfy/pal_renderer/)
  execute() with use_local_renderer=True:
    ├─ Reads camera from _pal_scene_state
    ├─ Picks a model path from inputs (model_3d / GLB / OBJ / glb_path)
    ├─ Calls pal_renderer.render_model via pygfx/wgpu (Metal/Vulkan/DX12)
    └─ Returns numpy IMAGE tensors directly — no iframe round-trip, no
        15MB base64 cap, no Cloud Run cost
```

## Key Files

| File | Purpose |
|------|---------|
| `__init__.py` | Node registration: `NODE_CLASS_MAPPINGS`, `WEB_DIRECTORY` |
| `pal_node.py` | Python node class: `INPUT_TYPES`, `execute()`, pass decoding, local-renderer dispatch |
| `pal_merge.py` | Input resolver: LC platform data vs ComfyUI graph inputs |
| `pal_api.py` | API client: session auth, project load, scene save, pipeline write-back |
| `web_comfy/pal_node.js` | Frontend extension: widget, viewport modal, postMessage bridge, upstream graph walk |
| `pal_renderer/__init__.py` | Public API: `render_model()` |
| `pal_renderer/render.py` | pygfx-based multi-pass offscreen renderer |
| `pal_renderer/requirements.txt` | pygfx, rendercanvas, gltflib, trimesh, assimp-py, imageio, numpy |

## Node Inputs

All inputs are optional.

| Input | Type | Purpose |
|-------|------|---------|
| `lc_api_key` | STRING | Lenscowboy platform token — authenticates with PAL SaaS |
| `lc_project_id` | STRING | Platform project to load |
| `lc_shot_id` | STRING | Specific shot to load |
| `glb_path` | STRING | Legacy file path to a GLB model |
| `GLB` | tuple(FILE_3D_GLB, FILE_3D, MESH, STRING) | 3D model from upstream node |
| `OBJ` | tuple(FILE_3D_OBJ, FILE_3D, MESH, STRING) | 3D model from upstream node |
| `model_3d` | FILE_3D | Generic 3D input — matches native ComfyUI Load3D's `model_3d` output io_type exactly |
| `prompt` | STRING | Scene description for proxy generation |
| `camera_preset` | STRING | Camera height preset (eye_level, low_angle, etc.) |
| `frame_start` / `frame_end` | INT | Animation frame range |
| `render_width` / `render_height` | INT | Render resolution (64–2048) |
| `scene_json_in` | STRING | Scene state from another PAL node |
| `use_local_renderer` | BOOLEAN | When true, render via pygfx instead of iframe |
| `_pal_scene_state` | STRING (optional, multiline) | Scene state carrier — hidden widget, round-trips render passes + keyframes + camera + settings |

### Notes on state carrier
Declared `optional` (not `hidden`) so ComfyUI's queue serializer actually forwards the widget value to Python's `execute()`. Frontend finds it by name and collapses to zero draw size. Wholesale replacement of `_palState` on `pal:state` events was wiping previously-captured render passes — the in-modal listener + `_saveAndClose` merge path now preserve the passes, scene, camera, settings, and cameraSystem dicts.

### Hidden input

| Input | Type | Purpose |
|-------|------|---------|
| `_pal_scene_state` | STRING | JSON blob: scene state + base64 render passes. Updated by JS widget before queue. |

## Node Outputs (10)

| Output | Type | Purpose |
|--------|------|---------|
| `beauty_pass` | IMAGE | Rendered beauty / colour pass |
| `depth_pass` | IMAGE | Depth pass (grayscale replicated to RGB for PreviewImage compatibility) |
| `normal_pass` | IMAGE | Normal map pass (RGB) |
| `scene_json` | STRING | Scene objects state (positions, rotations, scales) |
| `camera_json` | STRING | Camera position, rotation, FOV |
| `frame_start` | INT | Resolved start frame |
| `frame_end` | INT | Resolved end frame |
| `sequence_json` | STRING | Sequence export (array of shots with passes) — Enterprise only |
| `alpha_pass` | IMAGE | Alpha / matte pass (single channel) |
| `id_matte_pass` | IMAGE | Per-object ID matte (RGB) — stubbed, returns zeros until implementation lands |

## Execution Flow

1. `execute()` runs server-side (Python)
2. Parses `_pal_scene_state` JSON from the optional widget (declared `optional`, visually collapsed)
3. If `lc_api_key` provided: fetches project data from LC platform via `pal_api.py`
4. Resolves model inputs via `_resolve_models()` — reads files, accepts base64 from upstream, detects format from extension for `model_3d`
5. Merges LC data + ComfyUI inputs via `PALInputResolver`
6. **Render branch:**
   - `use_local_renderer=True`: picks first on-disk model path, reads camera from state, calls `pal_renderer.render_model()` → numpy arrays (wrapped as torch tensors for output). Falls back to iframe decode on any exception.
   - `use_local_renderer=False` (default): decodes base64 passes from state (iframe path).
7. **Output typing:** every IMAGE output goes through `_to_image_tensor` → `torch.Tensor (1, H, W, 3)` float32 [0, 1]. Depth / alpha grayscale replicated to RGB so PreviewImage / downstream nodes can `.cpu().numpy()` without TypeError.
8. **Dimension matching:** blank-fallback passes (empty `*_b64` in state) mirror the actual beauty tensor's shape so all 5 outputs align whether real or zero-filled.
9. Returns 10 outputs (5 images + scene_json + camera_json + frame_start/end + sequence_json).

## postMessage Bridge

PAL SaaS runs in an iframe. All communication via `window.postMessage`.

### ComfyUI → PAL iframe

| Type | Data | When |
|------|------|------|
| `pal:render-request` | — | Programmatic render trigger (legacy — in-iframe Render/Export button is the canonical UX) |
| `pal:get-state` | — | `_saveAndClose` — awaits `pal:state` reply before destroying the modal |
| `pal:load-models` | `{ models: [{id, name, format, data/path}] }` | Iframe load — posts in-memory state models + upstream graph-walked models (Load3D etc.) |
| `pal:load-state` | `{ state: { scene?, settings?, cameraSystem? } }` | Iframe load — restores keyframes + viewport settings + camera system (body/lens/focal/aperture/focus/aspect). **Does NOT include scene.objects** — models come via pal:load-models; re-serializing them would race the async FBX loader and create placeholder tetrahedra. |
| `pal:set-camera` | `{ camera: { position, rotation?, quaternion?, fov } }` | Iframe load — restores shotCam transform |

### PAL iframe → ComfyUI

| Type | Data | When |
|------|------|------|
| `pal:state` | `{ state: { scene: { objects, keyframes }, camera, settings, cameraSystem } }` | Response to `pal:get-state`. `settings` = localStorage `pal_*` snapshot + `render-resolution` dropdown. `cameraSystem` = `CameraSystem.toJSON()` (body / lens / focal / aperture / focus / extraction aspect). |
| `pal:render` | `{ beauty, depth, normals, alpha }` (base64) | After Render/Export finishes. Node auto-queues the ComfyUI graph 80ms later so Preview updates in one click. |

### State merge invariants (comfy side)

- `pal:render` handler writes `beauty_b64` / `depth_b64` / `normal_b64` / `alpha_b64` onto `_palState` and flushes the widget immediately.
- `pal:state` listener (during viewport session) **merges** `scene / camera / settings / cameraSystem` into `_palState` — never replaces. Wholesale replacement was wiping the render passes.
- `_saveAndClose` awaits the `pal:state` reply before flushing the widget and destroying the iframe. Synchronous close was dropping the response.
- `beforeQueuePrompt` flushes `_palState` → widget on every Run — backup in case state was changed without a Save & Close round-trip.

## Model Inputs (GLB/OBJ/FBX/model_3d)

Accepts 3D models from upstream nodes (Load3D, Load3DAnimation, Hunyuan3D, Meshy, Tripo, Rodin, TripoSR).

- **File path (STRING)**: read and base64-encoded for transport
- **Base64 data**: passed through directly
- **model_3d (FILE_3D)**: matches native Load3D output io_type exactly
- Transport: `pal:load-models` postMessage → iframe uses GLTFLoader/OBJLoader/FBXLoader/STLLoader
- **On-open graph walk** (pal_node.js) reads upstream `model_file` widget via ComfyUI `/view` so the viewport populates without requiring a prior queue run

**Loader matrix inside the iframe** (`pal:load-models` handler):
| Format | Loader | Notes |
|---|---|---|
| GLB / GLTF | GLTFLoader.parse(ArrayBuffer) | Native |
| OBJ | OBJLoader.parse(text) | Falls back to neutral gray if no material |
| FBX | FBXLoader.parse(ArrayBuffer) | Replaces broken texture materials with neutral gray |
| STL | STLLoader.parse(ArrayBuffer) + Mesh + gray material | |
| USDZ | — | TODO — requires server-side conversion |

**Loader matrix in `pal_renderer` (local):**
| Format | Path | Notes |
|---|---|---|
| GLB / GLTF | `pygfx.load_gltf(path).scene` | Requires `gltflib` |
| FBX | `assimp_py.import_file(...)` → pygfx Group | Flat 1D vertex arrays reshaped to Nx3 |
| OBJ / others | `trimesh.load()` → pygfx Group | trimesh does not do FBX natively |

## Input Priority (pal_merge.py)

LC platform data wins when present and non-empty. Falls through to ComfyUI graph inputs, then defaults:

```
LC platform assets  →  glb_path proxy  →  []
LC shot_prompt      →  prompt widget   →  ""
LC camera           →  camera_preset   →  "eye_level"
LC frame_start      →  frame_start     →  1
LC frame_end        →  frame_end       →  24
```

`imported_models` always passes through (not overridden by LC data).

## API Key — `lc_api_key` input

Paid-tier users generate a long-lived JWT at [app.lenscowboy.com/settings](https://app.lenscowboy.com/settings) → **Comfy API Keys** tab, then paste into the node's `lc_api_key` field.

Token properties (JWT claims):
- `kind: "comfy"` — distinguishes these from sheet/session tokens
- `jti` — UUID used for revocation
- `plan` — baked at mint time, but downgraded to current tenant plan at decode time
- `exp` — 365 days from mint

Revocation: user deletes the key in Settings → Firestore doc removed → next auth call on the SaaS side (within ~60s due to in-process cache TTL) returns 401. No client-side handling beyond showing the 401 to the user.

No API key → node runs in free tier (24h anonymous JWT auto-minted via `?comfy=1`). Viewport + beauty ≤512 only.

## Tier behaviour in the UI

- No watermark on any tier — the 512px cap is the free-tier limit
- Locked features: button visible but dimmed with lock icon
- Click locked feature → modal: "{Feature} requires {Plan} plan" with upgrade CTA + pricing link
- Never blocks the viewport or basic workflow

## Important Patterns

### IS_CHANGED returns NaN
```python
@classmethod
def IS_CHANGED(cls, **kwargs):
    return float("nan")
```
Forces ComfyUI to always re-execute the node (viewport state changes aren't detectable from inputs alone).

### beforeQueuePrompt blocks unrendered state
The JS extension blocks queue if the viewport has been opened but passes haven't been rendered yet — iframe path only. Irrelevant when `use_local_renderer=True`.

### Hidden widget round-trip
Scene state lives in `_pal_scene_state` (JSON string). The JS widget updates this before queue via:
```javascript
const stateJson = JSON.stringify(this._palState || {});
const widget = this.widgets?.find(w => w.name === "_pal_scene_state");
if (widget) widget.value = stateJson;
```

**Critical: hydrate `_palState` from the widget in `onNodeCreated`.** The widget's JSON survives workflow save/load and node re-creation, but `_palState` resets to `{}` on every node instance. Without hydration, keyframes/settings/cameraSystem evaporate on viewport reopen because the reopen-load handler reads `_palState.scene.keyframes` and finds nothing.

```javascript
this._palState = {};
const saved = this.widgets?.find(w => w.name === "_pal_scene_state")?.value;
if (saved && saved.length > 2) {
  try { this._palState = JSON.parse(saved); } catch {}
}
```

**Critical: declare `_pal_scene_state` as single-line STRING, NOT `multiline: True`.** Multiline STRINGs render as a DOM textarea on the Vue frontend; LiteGraph's `widget.hidden = true` / `computeSize = () => [0, -4]` tricks don't hide DOM textareas. User sees a huge JSON blob on the node. Single-line STRING renders as a LiteGraph widget we CAN collapse.

### Max base64 size guard
`MAX_BASE64_BYTES = 15_000_000` — iframe-delivered passes larger than ~15MB are replaced with blank images to prevent memory issues. Local renderer has no such cap.

### SaaS shadowing, not branching
The iframe is the SaaS PAL UI. Do not fork SaaS features for comfy — reuse. Acceptable SaaS edits: hide/tweak controls when `_palComfyMode=true`, extend the existing comfy-only `pal:load-models` handler. Forbidden: parallel loader code paths, comfy-only duplicates of existing SaaS components.

### Vue frontend quirks (Templates v0.9.59+)

The modern ComfyUI frontend broke several LiteGraph patterns that worked fine in the classic frontend. What works and what doesn't:

| Pattern | Works? | Notes |
|---|---|---|
| `addWidget("button", ...)` click handler | ✓ | Reliable. Use this for any button that needs to respond to clicks. |
| `addDOMWidget(name, "div", el, opts)` — display | ✓ | Renders HTML inside the node body. Good for brand strips, status displays, passive UI. |
| `addDOMWidget` — click handling | ✗ | Canvas intercepts pointer events. Cursor becomes crosshair over the element; click never fires. Use the classic button widget + trigger DOM work from its callback. |
| `widget.draw = ...` (canvas override) | ✗ | No-op. The Vue frontend skips LiteGraph canvas widget draw for certain widget types. Amber button styling tried via this path is ignored. |
| `nodeType.prototype.onDrawForeground = ...` | ✗ | No-op for the same reason. Canvas brand overlays don't paint. |
| `this.widgets.splice(idx, 1); this.widgets.unshift(w)` | ☠ | Reorders the positional widget array. ComfyUI maps widget values to INPUT_TYPES by position, so splicing corrupts every optional input — `render_width` gets `api_key`'s empty string, `_pal_scene_state` shifts too, session + keyframes silently break. **Never splice widgets.** Accept whatever order `addWidget` / `addDOMWidget` gives. |
| Multiline STRING widget hidden via `hidden=true` | ✗ | DOM textarea ignores LiteGraph flags. Declare as single-line STRING if you want to hide it. |
| File picker inside iframe (`showDirectoryPicker`) | ✗ | Cross-origin iframe SecurityError. Put file pickers on the top-level ComfyUI node side (`<input type="file">`), send results to iframe via postMessage. |

### Texture harvest + manual upload

`pal_node.js` collects upstream models in `_collectUpstreamModels()` (runs in the top-level ComfyUI window, reaches `127.0.0.1:8188/view`). For glTF and OBJ models, it also harvests sidecar textures:

- **glTF**: parses the JSON, collects `images[].uri` + `buffers[].uri`, fetches each via `/view?type=input&subfolder=<same>&filename=<uri>`, base64-encodes, attaches as `model.resources: [{name, data, mime}]`.
- **OBJ**: scans the geometry for `mtllib <file>.mtl`, fetches that, parses `map_Kd / map_Bump / map_Ks / norm / disp / decal / refl` for texture filenames, fetches each.
- **GLB**: no action — textures embedded in the binary. Three.js GLTFLoader handles them.
- **FBX**: no auto-harvest (binary format, texture refs vary wildly). Users manually upload via the **UPLOAD TEXTURES** button — a classic LiteGraph button widget that opens a top-level `<input type="file" multiple>` picker; selected files are base64-encoded and stored on `node._userTextures`, merged into every model's resources at viewport-open time.

**Iframe-side consumer** (in `pal/web/index.html` `pal:load-models` handler): `_buildResourceMap(model.resources)` turns each resource into a blob URL; `_makeManager(urlMap)` builds a `THREE.LoadingManager` with a URL modifier that maps texture URIs to those blobs. Case-insensitive filename-leaf matching handles mixed case, backslash paths from FBX-embedded Windows refs, and URL-percent-encoded names. Warns `[PAL comfy] URL modifier: no match for ...` when it can't find a match — useful debugging signal.

### CORS required for the node's cross-origin calls

`pal_node.js::_lcCheckSession` POSTs to `app.lenscowboy.com/pal/session` from ComfyUI's origin (`127.0.0.1:8188`), so the request is cross-origin and needs CORS to succeed. Without it the preflight fails, `_lcSession` stays null, and every client-side feature check falls back to FREE_FEATURES.

### Session refresh on api_key paste

`_lcCheckSession` needs to run whenever the `lc_api_key` widget changes value — not just on node creation. Otherwise pasting the key after dropping the node leaves `_lcSession = null` and features resolve to free tier. Pattern: wrap the widget's `callback` to invoke `_lcCheckSession(value)`, plus a defensive refresh in `_openViewport` if the token is set but session hasn't loaded.

## Common Gotchas

- `WEB_DIRECTORY = "./web_comfy"` — ComfyUI serves this as `/extensions/comfyui-lenscowboy-pal/`
- The iframe src must include `comfy=1` param so PAL knows it's in iframe mode
- Token auth via `?token=` URL param — iframe can't set headers or cookies cross-origin
- GLB/OBJ/model_3d inputs accept a union of types — declare with tuple or explicit `FILE_3D` — see Node Inputs section
- Camera ID is `CAM` everywhere — never use `__camera__` (Firestore reserved field)
- Python changes require ComfyUI restart; JS changes require hard browser refresh (Cmd+Shift+R)
- The symlink from `~/Documents/ComfyUI/custom_nodes/comfyui-lenscowboy-pal` → this repo means edits here are live
- Free-tier gets anonymous 24h JWT auto-injected via `comfy=1` param
- `pal_renderer` deps are installed separately; pal_node.py loads even without them (lazy imports)
- Iframe `allow="fullscreen; clipboard-read; clipboard-write"` attribute set on `<iframe>` lets the viewport use clipboard and fullscreen — but `showDirectoryPicker` stays blocked (hard browser rule for cross-origin iframes). Use node-side file pickers instead.
- Output socket names use spaces not underscores (`beauty pass` not `beauty_pass`) — matches the docs aesthetic but means any rename breaks saved workflow wires.
- Widget default INT values require `{"min": N}` below the desired default; omitting `min` lets ComfyUI send empty strings → Python `int('')` → `ValueError`.

## Testing

### Manual
1. Place node in ComfyUI graph
2. Paste API key → connection badge turns green → "Open Viewport" loads iframe
3. Connect Load3D / Hunyuan3D output to `model_3d` input → model appears in viewport on open (graph walk)
4. Render passes via iframe, OR enable `use_local_renderer` for direct Python render
5. Queue prompt → beauty/depth/normal/alpha/id_matte flow downstream

### TODO — ComfyUI node integration test
We've had multiple rounds of "no frame reaches Video Combine" bugs caused by Python/JS widget-serialization mismatches that are invisible until you queue a real prompt. Needs a headless integration test: spin up ComfyUI in CI, load a workflow JSON with `PALLayoutNode` → `PreviewImage`, seed `_pal_scene_state` with a known beauty base64, POST to `/prompt`, assert the output image is non-blank and matches expected pixel hash. Catches widget-wiring, INPUT_TYPES drift, and decode-path regressions automatically.

## Deployment

Install as custom node (symlink / junction for development):

**macOS / Linux:**
```bash
cd ~/Documents/ComfyUI/custom_nodes
ln -s /path/to/comfyui-lenscowboy-pal .
~/Documents/ComfyUI/.venv/bin/python -m pip install -r comfyui-lenscowboy-pal/requirements.txt
~/Documents/ComfyUI/.venv/bin/python -m pip install -r comfyui-lenscowboy-pal/pal_renderer/requirements.txt
```

**Windows (from PowerShell) with the repo on D: and ComfyUI on D:\ComfyUI:**
```powershell
# Install comfy-cli, create workspace on D:\
py -3.12 -m pip install --upgrade comfy-cli
py -3.12 -m comfy_cli --workspace "D:\ComfyUI" install
# Junction from custom_nodes to the repo (no admin needed)
mklink /J "D:\ComfyUI\custom_nodes\comfyui-lenscowboy-pal" "D:\Projects\comfyui-lenscowboy-pal"
# Requires Git for Windows on PATH (comfy-cli uses GitPython)
# Launch
py -3.12 -m comfy_cli launch
```

**Cross-OS git hygiene** (editing from WSL, running on Windows):
```bash
git config core.filemode false   # NTFS reports every file as 0755
git config core.autocrlf false
git config core.eol lf
```
Plus a committed `.gitattributes` with `* text=auto eol=lf` so the policy travels with the repo.

Restart ComfyUI after any Python change. Hard-refresh the browser (Ctrl+Shift+R, or right-click reload → Empty Cache and Hard Reload) after any JS change.
