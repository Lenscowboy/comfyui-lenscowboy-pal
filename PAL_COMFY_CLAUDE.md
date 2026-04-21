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

PAL SaaS iframe target (lenscowboy-pipeline-saas/pal/web)
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
| `lc_api_key` | STRING | LensCowboy platform token — authenticates with PAL SaaS |
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

## Plans & Pricing

ComfyUI users are 3D artists, not necessarily full LensCowboy SaaS subscribers. The node supports four plan states, resolved from the API key JWT (`plan` claim). No key = free tier (anonymous 24h JWT auto-injected via `comfy=1` param).

### Plan matrix

| Feature | Free | **COMFY PAL** | SaaS Subscriber (Creator / Influencer / Pro / Studio) | Enterprise |
|---|---|---|---|---|
| Viewport, proxies, GLB/OBJ/FBX import | ✓ | ✓ | ✓ | ✓ |
| Camera / animation (local to node) | ✓ | ✓ | ✓ | ✓ |
| Beauty render ≤ 512 | ✓ | ✓ | ✓ | ✓ |
| Beauty render > 512 (up to 2048) | ✗ | ✓ | ✓ | ✓ |
| Depth / Normal / Alpha / ID matte passes | ✗ | ✓ | ✓ | ✓ |
| Local renderer (`use_local_renderer`) | ✓ | ✓ | ✓ | ✓ |
| Save to Drive (render output) | ✗ | ✗ | ✓ | ✓ |
| Project load | ✗ | ✗ | ✓ | ✓ |
| Sequence export (multi-shot) | ✗ | ✗ | ✗ | ✓ |
| Pipeline writeback (Export to Pipeline) | ✗ | ✗ | ✗ | ✓ |
| Breakdown integration (Load from Breakdown) | ✗ | ✗ | ✗ | ✓ |

### Pricing

| Plan | Monthly | Annual | What it unlocks |
|---|---|---|---|
| Free | $0 | — | Try-before-you-buy: 512 beauty, viewport, import |
| **COMFY PAL** | **$7** | **$49 (42% off)** | Full-res beauty + all passes, comfy-node-only |
| Creator+ (SaaS plans) | (as per SaaS) | (as per SaaS) | Everything COMFY PAL offers + SaaS production pipeline |
| Enterprise | R1999 (founding, 2yr) | — | Everything + sequence export, breakdown, LCBE, delivery |

### Positioning rationale

COMFY PAL is a funnel tier, not a PAL-features-upgrade path to Enterprise. The product differentiation is:

- **COMFY PAL = a node.** For comfy users who want pro PAL passes inside their own graph.
- **SaaS Creator+ = the Daily pipeline.** Single-shot production runs driven by sheet config.
- **Enterprise = the full factory.** Script → breakdown → shot list → PAL layout → multi-vendor generation → color → music → delivery. Things ComfyUI fundamentally cannot do: multi-shot orchestration, script parsing, continuity, LCBE bidding, client-review workflows.

Don't compete with ComfyUI on PAL features. Differentiate by scope of production.

### Server-side plan → features mapping

Lives in [`app/pal_comfy.py`](../lenscowboy-pipeline-saas/app/pal_comfy.py) `_PLAN_FEATURES`:
```python
"free":          ["viewport", "beauty_512"]
"comfy_pal":     ["viewport", "beauty_512", "beauty_hires", "multipass"]
"creator":       ["viewport", "beauty_512", "beauty_hires", "multipass", "drive_save"]
"influencer":    ["viewport", "beauty_512", "beauty_hires", "multipass", "drive_save"]
"pro":           ["viewport", "beauty_512", "beauty_hires", "multipass", "drive_save"]
"studio":        ["viewport", "beauty_512", "beauty_hires", "multipass", "drive_save"]
"enterprise":    ["viewport", "beauty_512", "beauty_hires", "multipass", "drive_save",
                  "sequence_export", "breakdown", "pipeline_writeback"]
```

The iframe fetches this at boot via `GET /pal/comfy/features` (tolerant of missing auth — anonymous callers receive the free feature set). Results cached in `window._palFeatures` and used by the Render/Export dialog and the Load-from-Breakdown / Export-to-Pipeline buttons to lock UI up front rather than failing at submit with a 401.

### Admin & billing (SaaS-side)

Lives in `lenscowboy-pipeline-saas/app/`. Already wired:

- Paystack plan codes `PLN_45yu7i622128n7j` (monthly) and `PLN_amx7gja7evbrskw` (annual) map to internal plan `comfy_pal` in `billing.py:_map_paystack_plan`.
- Webhook activates `subscriptions.comfy_pal` on the hub client with `cadence` (`monthly` / `annual`) and `since` timestamp via `_apply_hub_comfy_pal_subscription`. Existing SaaS-tier tenants are NOT downgraded — COMFY PAL stacks as a parallel subscription.
- New tenants subscribing directly to COMFY PAL get `tenant.plan = "comfy_pal"` and a JWT unlocking multipass features.
- Hub admin client page (`app/hub/web/client.html`) shows the COMFY PAL row in the Subscriptions table with cadence and activation date.
- Schema entry in `app/hub_schema.py` under `subscriptions.comfy_pal`.

**Still TODO (nice-to-haves, not blocking launch):**
- **Cancel flow**: Paystack `subscription.disable` webhook currently calls `suspend_tenant` globally. For COMFY PAL cancellation on a tenant who also has a SaaS tier, we should just flip `subscriptions.comfy_pal.active = False` without suspending the tenant or clearing `tenant.plan`.
- **Admin "cancel COMFY PAL" button**: manual off-switch in `client.html` that flips the flag without touching other subscriptions.
- **Feature overrides panel**: `app/hub/web/admin.html` currently lets admins grant/revoke individual features against videobot tiers; extend to `comfy_pal` so per-tenant exceptions are possible.
- **Usage metrics**: track render count per COMFY PAL tenant (cheap — just increment a counter on each `/pal/comfy/features` hit or render). Useful for validating $7 pricing once there's user data.

### Gate behaviour

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

### Max base64 size guard
`MAX_BASE64_BYTES = 15_000_000` — iframe-delivered passes larger than ~15MB are replaced with blank images to prevent memory issues. Local renderer has no such cap.

### SaaS shadowing, not branching
The iframe is the SaaS PAL UI. Do not fork SaaS features for comfy — reuse. Acceptable SaaS edits: hide/tweak controls when `_palComfyMode=true`, extend the existing comfy-only `pal:load-models` handler. Forbidden: parallel loader code paths, comfy-only duplicates of existing SaaS components.

## Common Gotchas

- `WEB_DIRECTORY = "./web_comfy"` — ComfyUI serves this as `/extensions/comfyui-lenscowboy-pal/`
- The iframe src must include `comfy=1` param so PAL knows it's in iframe mode
- Token auth via `?token=` URL param — iframe can't set headers or cookies cross-origin
- GLB/OBJ/model_3d inputs accept a union of types — declare with tuple or explicit `FILE_3D` — see Node Inputs section
- Camera ID is `CAM` everywhere — never use `__camera__` (Firestore reserved field)
- Python changes require ComfyUI restart; JS changes require hard browser refresh (Cmd+Shift+R)
- The symlink from `~/Documents/ComfyUI/custom_nodes/comfyui-lenscowboy-pal` → this repo means edits here are live
- Free-tier gets anonymous 24h JWT auto-injected via `comfy=1` param
- `/pal/static/*` has no auth gate — client-side JS/CSS, not data
- `pal_renderer` deps are installed separately; pal_node.py loads even without them (lazy imports)

## Testing

### Manual
1. Place node in ComfyUI graph
2. Paste API key → connection badge turns green → "Open Viewport" loads iframe
3. Connect Load3D / Hunyuan3D output to `model_3d` input → model appears in viewport on open (graph walk)
4. Render passes via iframe, OR enable `use_local_renderer` for direct Python render
5. Queue prompt → beauty/depth/normal/alpha/id_matte flow downstream

### TODO — ComfyUI node integration test
We've had multiple rounds of "no frame reaches Video Combine" bugs caused by Python/JS widget-serialization mismatches that are invisible until you queue a real prompt. Needs a headless integration test: spin up ComfyUI in CI, load a workflow JSON with `PALLayoutNode` → `PreviewImage`, seed `_pal_scene_state` with a known beauty base64, POST to `/prompt`, assert the output image is non-blank and matches expected pixel hash. Catches widget-wiring, INPUT_TYPES drift, decode path regressions automatically. Complementary SaaS-side Playwright todo is in `lenscowboy-pipeline-saas/CLAUDE.md` under "Testing Changes → TODO".

## Deployment

Install as custom node (symlink for development):
```bash
cd ~/Documents/ComfyUI/custom_nodes
ln -s /path/to/comfyui-lenscowboy-pal .
# Main node deps (minimal)
~/Documents/ComfyUI/.venv/bin/python -m pip install -r comfyui-lenscowboy-pal/requirements.txt
# Local renderer deps (optional — only needed for use_local_renderer=True)
~/Documents/ComfyUI/.venv/bin/python -m pip install -r comfyui-lenscowboy-pal/pal_renderer/requirements.txt
# Restart ComfyUI
```

## Related memory

- `project_local_renderer.md` — pygfx vs alternatives, Blender bpy as premium deferred path
- `feedback_comfy_shadows_saas.md` — rule: iframe shadows SaaS, don't branch
- `project_assethub_multi_object.md` — assethub.io multi-object workflow inspiration for future 3D pipeline rethink
