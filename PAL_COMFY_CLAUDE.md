# CLAUDE.md — ComfyUI PAL Layout Node

## Overview

Custom ComfyUI node that embeds the full PAL SaaS 3D previsualisation viewport inside ComfyUI via iframe. Used for spatial layout, camera setup, and multipass render output (beauty, depth, normals). Part of the LensCowboy AI content pipeline.

**Architecture: iframe only.** The node opens a full-screen modal containing an iframe to the PAL SaaS UI. All communication via postMessage. No standalone bundle.

## Architecture

```
ComfyUI Graph
  PALLayoutNode (pal_node.py)
    ├─ INPUT: lc_api_key, project_id, shot_id, glb_model, obj_model, prompt, ...
    ├─ HIDDEN: _pal_scene_state (JSON string — scene + render passes)
    └─ OUTPUT: beauty_pass (IMAGE), depth_pass (IMAGE), normal_pass (IMAGE),
              scene_json, camera_json, frame_start, frame_end, sequence_json

ComfyUI Browser
  pal_node.js (extension)
    ├─ Registers PALLayoutNode widget
    ├─ "Open Viewport" button → full-screen modal with iframe
    ├─ <iframe src="/pal?comfy=1&token=...&project=...&client_id=...">
    ├─ postMessage bridge: pal:render-request, pal:get-state, pal:load-models
    ├─ Bridge: viewport state ↔ _pal_scene_state hidden widget
    └─ beforeQueuePrompt: blocks if passes not rendered

PAL SaaS (iframe target — lives in lenscowboy-pipeline-saas repo)
  /pal?comfy=1&token=...
    ├─ Full viewport with all PAL features
    ├─ Listens for postMessage from ComfyUI parent
    └─ Sends pal:state and pal:render messages back
```

## Key Files

| File | Purpose |
|------|---------|
| `__init__.py` | Node registration: `NODE_CLASS_MAPPINGS`, `WEB_DIRECTORY` |
| `pal_node.py` | Python node class: `INPUT_TYPES`, `execute()`, pass decoding |
| `pal_merge.py` | Input resolver: LC platform data vs ComfyUI graph inputs |
| `pal_api.py` | API client: session auth, project load, scene save, pipeline write-back |
| `web_comfy/pal_node.js` | Frontend extension: widget, viewport modal, postMessage bridge |

## Node Inputs & Outputs

### Inputs (all optional)

| Input | Type | Purpose |
|-------|------|---------|
| `lc_api_key` | STRING | LensCowboy platform token — authenticates with PAL SaaS |
| `lc_project_id` | STRING | Platform project to load |
| `lc_shot_id` | STRING | Specific shot to load |
| `glb_path` | STRING | Legacy file path to a GLB model |
| `GLB` | FILE_3D_GLB / FILE_3D / MESH / STRING | 3D model from upstream node (Hunyuan3D, Tencent, Meshy, Rodin, Tripo) |
| `OBJ` | FILE_3D_OBJ / FILE_3D / MESH / STRING | 3D model from upstream node |
| `prompt` | STRING | Scene description for proxy generation |
| `camera_preset` | STRING | Camera height preset (eye_level, low_angle, etc.) |
| `frame_start` | INT | Animation start frame |
| `frame_end` | INT | Animation end frame |
| `render_width` | INT | Render resolution width (64–1024) |
| `render_height` | INT | Render resolution height (64–1024) |
| `scene_json_in` | STRING | Scene state from another PAL node |

### Hidden Input

| Input | Type | Purpose |
|-------|------|---------|
| `_pal_scene_state` | STRING | JSON blob containing scene state + base64 render passes. Updated by JS widget before queue. |

### Outputs (8)

| Output | Type | Purpose |
|--------|------|---------|
| `beauty_pass` | IMAGE | Rendered beauty/colour pass |
| `depth_pass` | IMAGE | Depth pass (single channel) |
| `normal_pass` | IMAGE | Normal map pass (RGB) |
| `scene_json` | STRING | Scene objects state (positions, rotations, scales) |
| `camera_json` | STRING | Camera position, rotation, FOV |
| `frame_start` | INT | Resolved start frame |
| `frame_end` | INT | Resolved end frame |
| `sequence_json` | STRING | Sequence export (array of shots with passes) |

## Execution Flow

1. `execute()` runs server-side (Python)
2. Parses `_pal_scene_state` JSON from the hidden widget
3. If `lc_api_key` provided: fetches project data from LC platform via `pal_api.py`
4. Resolves model inputs via `_resolve_models()` — reads files or accepts base64
5. Merges LC data + ComfyUI inputs via `PALInputResolver`
6. Decodes base64 render passes from state to numpy IMAGE arrays
7. Returns 8 outputs

## postMessage Bridge

PAL SaaS runs in an iframe. All communication via `window.postMessage`:

### ComfyUI → PAL iframe

| Message Type | Data | When |
|--------------|------|------|
| `pal:render-request` | — | User clicks "Render All" button |
| `pal:get-state` | — | User clicks "Save & Close" |
| `pal:load-models` | `{ models: [{id, name, format, data/path}] }` | After iframe loads, if model inputs connected |
| `pal:load-state` | `{ state }` | Shot switcher loads breakdown scene data |
| `pal:set-camera` | `{ camera }` | Shot switcher loads breakdown camera data |

### PAL iframe → ComfyUI

| Message Type | Data | When |
|--------------|------|------|
| `pal:state` | `{ state: { scene, camera } }` | On state change / save request |
| `pal:render` | `{ beauty, depth, normals }` (base64) | After render completes |

## Model Inputs (GLB/OBJ)

Accepts 3D models from upstream nodes (e.g. Hunyuan3D, TripoSR):

- **File path**: if the string is a valid file path, reads and base64-encodes the file
- **Base64 data**: if not a file path, treated as base64-encoded model data
- Sends via `pal:load-models` postMessage → PAL uses `GLTFLoader.parse()` or `OBJLoader.parse()`

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

## Plan Tiers & Feature Gates

ComfyUI users are 3D artists, not LCBE/Pipeline users. No Firestore save,
no project load, no pipeline write-back. Scene state persists locally in the
`_pal_scene_state` hidden widget (saved with the ComfyUI workflow file).

### Feature Gate Matrix

| Feature | Free | Creator+ | Enterprise |
|---------|------|----------|------------|
| Viewport + proxies | Yes | Yes | Yes |
| GLB/OBJ import | Yes | Yes | Yes |
| Camera + animation (local to node) | Yes | Yes | Yes |
| Beauty render ≤512 | Clean | Clean | Clean |
| Beauty render >512 | Blocked | Clean | Clean |
| Depth/Normal/Alpha passes | Blocked | Yes | Yes |
| Sequence export | No | No | Yes |
| Breakdown integration | No | No | Yes |

### Gate behaviour
- **No watermark** on any tier — 512 cap is the free tier limit
- Locked features: button visible but dimmed with lock icon
- Click locked feature → toast: "{Feature} requires {Plan} plan" with pricing link
- Never blocks the viewport or basic workflow
- Plan resolved from API key JWT (`plan` claim). No key = free tier.

### Server-side plan → features mapping (`pal_comfy.py`)
```python
"free":        ["viewport", "beauty_512"]
"creator":     ["viewport", "beauty_512", "beauty_hires", "multipass"]
"influencer":  ["viewport", "beauty_512", "beauty_hires", "multipass"]
"pro":         ["viewport", "beauty_512", "beauty_hires", "multipass"]
"studio":      ["viewport", "beauty_512", "beauty_hires", "multipass"]
"enterprise":  ["viewport", "beauty_512", "beauty_hires", "multipass", "sequence_export", "breakdown"]
```

## Important Patterns

### IS_CHANGED returns NaN
```python
@classmethod
def IS_CHANGED(cls, **kwargs):
    return float("nan")
```
Forces ComfyUI to always re-execute the node (viewport state changes aren't detectable from inputs alone).

### beforeQueuePrompt blocks unrendered state
The JS extension blocks queue if the viewport has been opened but passes haven't been rendered yet.

### Hidden widget round-trip
Scene state lives in `_pal_scene_state` (JSON string). The JS widget updates this before queue via:
```javascript
const stateJson = JSON.stringify(this._palState || {});
const widget = this.widgets?.find(w => w.name === "_pal_scene_state");
if (widget) widget.value = stateJson;
```

### Max base64 size guard
`MAX_BASE64_BYTES = 15_000_000` — passes larger than ~15MB are replaced with blank images to prevent memory issues.

## Common Gotchas

- `WEB_DIRECTORY = "./web_comfy"` — ComfyUI serves this as `/extensions/comfyui-lenscowboy-pal/`
- The iframe src must include `comfy=1` param so PAL knows it's in iframe mode
- Token auth via `?token=` URL param — iframe can't set headers or cookies cross-origin
- GLB/OBJ inputs accept `FILE_3D_GLB`, `FILE_3D_OBJ`, `FILE_3D`, `MESH`, `STRING` — matches Hunyuan3D, Tencent, Meshy, Rodin, Tripo, Load3D nodes
- No standalone bundle — iframe only. Deleted all bundle code April 2026.
- Free tier gets anonymous 24h JWT auto-injected via `comfy=1` param
- `/pal/static/*` has no auth gate — client-side JS/CSS, not data
- Camera ID is `CAM` everywhere — never use `__camera__` (Firestore reserved field)
- Python changes require ComfyUI restart; JS changes require hard browser refresh (Cmd+Shift+R)
- The symlink from `ComfyUI/custom_nodes/comfyui-lenscowboy-pal` → this repo means edits here are live

## Testing

1. Place node in ComfyUI graph
2. Paste API key → connection badge turns green → "Open Viewport" loads iframe
3. Connect Hunyuan3D output to `glb_model` input → model appears in viewport
4. Render passes → queue prompt → beauty/depth/normal flow downstream

## Deployment

Install as custom node (symlink for development):
```bash
cd ComfyUI/custom_nodes
ln -s /path/to/comfyui-lenscowboy-pal .
pip install -r comfyui-lenscowboy-pal/requirements.txt
# Restart ComfyUI
```
