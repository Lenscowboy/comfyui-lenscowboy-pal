# CLAUDE.md — ComfyUI PAL Layout Node

## Overview

Custom ComfyUI node that embeds a full Three.js 3D previsualisation viewport inside ComfyUI. Used for spatial layout, camera setup, and multipass render output (beauty, depth, normals). Part of the LensCowboy AI content pipeline.

**Two operating modes:**
- **Standalone** (no API key): offline Three.js viewport via `pal_three_bundle.js` — free tier
- **Connected** (with API key): full PAL SaaS UI loaded in iframe via postMessage bridge — paid tiers

The connected iframe mode is the primary path. The standalone bundle is a fallback.

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
    ├─ "Open Viewport" button → full-screen modal
    ├─ Connected mode: <iframe src="/pal?comfy=1&token=...">
    │   └─ postMessage bridge: pal:render-request, pal:get-state, pal:load-models
    ├─ Standalone mode: loads pal_three_bundle.js into modal div
    ├─ Bridge: viewport state ↔ _pal_scene_state hidden widget
    └─ beforeQueuePrompt: blocks if passes not rendered

PAL SaaS (iframe target)
  /pal?comfy=1&token=...&project=...&client_id=...
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
| `build/entry.js` | Standalone Three.js viewport (fallback, not used in connected mode) |
| `web/` | Copied PAL viewport modules for standalone bundle |
| `build.sh` | Bundles standalone viewport via esbuild |

## Node Inputs & Outputs

### Inputs (all optional)

| Input | Type | Purpose |
|-------|------|---------|
| `lc_api_key` | STRING | LensCowboy platform token — enables connected mode |
| `lc_project_id` | STRING | Platform project to load |
| `lc_shot_id` | STRING | Specific shot to load |
| `glb_path` | STRING | Legacy file path to a GLB model |
| `glb_model` | STRING | GLB data from upstream node (file path or base64) |
| `obj_model` | STRING | OBJ data from upstream node (file path or base64) |
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

## postMessage Bridge (Connected Mode)

PAL SaaS runs in an iframe. Communication is via `window.postMessage`:

### ComfyUI → PAL iframe

| Message Type | Data | When |
|--------------|------|------|
| `pal:render-request` | — | User clicks "Render All" button |
| `pal:get-state` | — | User clicks "Save & Close" |
| `pal:load-models` | `{ models: [{id, name, format, data/path}] }` | After iframe loads, if model inputs connected |

### PAL iframe → ComfyUI

| Message Type | Data | When |
|--------------|------|------|
| `pal:state` | `{ state: { scene, camera } }` | On state change / save request |
| `pal:render` | `{ beauty, depth, normals }` (base64) | After render completes |

## Model Inputs (GLB/OBJ)

Accepts 3D models from upstream nodes (e.g. Hunyuan3D, TripoSR):

- **File path**: if the string is a valid file path, reads and base64-encodes the file
- **Base64 data**: if not a file path, treated as base64-encoded model data
- **Connected mode**: sends via `pal:load-models` postMessage → PAL uses `GLTFLoader.parse()` or `OBJLoader.parse()`
- **Standalone mode**: loaded directly in `entry.js` via `_loadImportedModels()`

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

| Plan | Features |
|------|----------|
| free | Viewport only, watermarked beauty pass |
| node_creator | + multipass, cloud save, no watermark |
| influencer | + project load, asset library, pipeline write-back |
| enterprise | + breakdown integration, sequence export |

Watermark: `_lcApplyWatermark()` draws subtle "lenscowboy.com" text on beauty pass for free tier.

## Building the Standalone Bundle

```bash
./build.sh
# Runs: npx esbuild build/entry.js --bundle --format=esm --outfile=web_comfy/pal_three_bundle.js
```

The bundle includes Three.js r171, GLTFLoader, OBJLoader, FBXLoader, Sky, OrbitControls, and 34 proxy builder types.

**Note:** The standalone bundle is a fallback only. Connected mode (iframe) is the primary path and uses the full PAL SaaS codebase — no bundle needed.

## Important Patterns

### IS_CHANGED returns NaN
```python
@classmethod
def IS_CHANGED(cls, **kwargs):
    return float("nan")
```
Forces ComfyUI to always re-execute the node (viewport state changes aren't detectable from inputs alone).

### beforeQueuePrompt blocks unrendered state
The JS extension blocks queue if the viewport has been opened but passes haven't been rendered yet. This prevents sending empty images downstream.

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
- `glb_model`/`obj_model` inputs accept STRING not MESH — ComfyUI has no standard 3D type
- The standalone bundle (`pal_three_bundle.js`) is ~694KB — only loaded if no API key is set

## Testing

1. Place node in ComfyUI graph
2. Without API key: click "Open Viewport" → standalone bundle loads
3. With API key: paste token → connection badge turns green → "Open Viewport" loads iframe
4. Connect Hunyuan3D output to `glb_model` input → model appears in viewport
5. Render passes → queue prompt → beauty/depth/normal flow downstream

## Deployment

Install as custom node:
```bash
cd ComfyUI/custom_nodes
git clone https://github.com/Lenscowboy/comfyui-lenscowboy-pal.git
pip install -r comfyui-lenscowboy-pal/requirements.txt
# Restart ComfyUI
```
