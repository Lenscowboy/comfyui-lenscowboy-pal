# PAL Layout Node for ComfyUI

3D previsualisation and spatial layout node for ComfyUI by [LensCowboy](https://lenscowboy.com).

<img width="1024" height="576" alt="comfyPalGif" src="https://github.com/user-attachments/assets/45268975-94be-4094-ba81-4fc7afc24289" />


Set up camera angles, position subjects, light your scene, then render beauty, depth, and normal passes directly into your ComfyUI workflow. Feed depth maps to ControlNet, use beauty passes as references, export camera data for consistent shot generation.

## Features

- Full Three.js 3D viewport with orbit, pan, zoom controls
- Camera presets and manual positioning (eye level, low angle, overhead, rear view, OTS, POV)
- Proxy geometry library (humans, vehicles, horses, props, buildings, terrain)
- WASD fly mode (Unreal-style) for first-person camera navigation
- Filmic HUD overlay (frame lines, safe areas, DOF bar)
- Real-time DOF from F-Stop and focus distance
- Shot list and timeline
- Beauty, depth, and normal pass renders as IMAGE outputs
- Scene state persistence across ComfyUI sessions
- GLB asset import via file path or drag-and-drop

## Optional: LensCowboy Platform Integration

Connect with a LensCowboy API key to unlock:
- Multi-pass renders (depth, normal, alpha, ID matte)
- Higher-resolution beauty pass (above 512px)
- Project asset library browsing

No API key needed for local use — the node is a fully capable standalone tool with a free-tier 512px beauty pass.

> **v1.0** ships single-frame rendering. Animated sequence renders (IMAGE batches for KSampler / Video Combine), Load from LCBE Breakdown, and write-back to the Pipeline sheet are coming in **v1.1**.

### Get an API Key

1. Log into [app.lenscowboy.com/settings](https://app.lenscowboy.com/settings)
2. Open the **Comfy API Keys** tab
3. Click **+ Generate New Key** (optionally label it, e.g. `home-pc`)
4. Copy it and paste into the PAL node's `lc_api_key` field

Features unlock based on your subscription plan. If you downgrade, existing keys automatically lose the dropped features — no remint required. Keys expire after 365 days. Up to 5 keys per account; revoke any of them from the same page.

## Install

### ComfyUI Manager
Search for "PAL Layout" in ComfyUI Manager.

### Manual
```bash
cd ComfyUI/custom_nodes
git clone https://github.com/lenscowboy/comfyui-lenscowboy-pal.git
# Restart ComfyUI
```

## Outputs

| Output | Type | Use with |
|---|---|---|
| beauty_pass | IMAGE | Preview, reference, img2img |
| depth_pass | IMAGE | ControlNet depth, Marigold |
| normal_pass | IMAGE | ControlNet normals |
| scene_json | STRING | Scene state for iteration |
| camera_json | STRING | Camera data for pipeline |
| frame_start | INT | Timeline range |
| frame_end | INT | Timeline range |

## Schema Synchronization

This repo vendors a pinned copy of the `LCBE_LAYOUT` JSON Schema from the canonical [lcbe-layout-schema](https://github.com/Lenscowboy/lcbe-layout-schema) repository. The schema defines the wire format that PAL emits when it talks to other LCBE-ecosystem nodes (notably [comfyui-lenscowboy-lcbe](https://github.com/Lenscowboy/comfyui-lenscowboy-lcbe)).

Files:

- `schemas/PINNED_VERSION` — the semver of the upstream tag this repo is pinned to (e.g. `1.0.0`).
- `schemas/lcbe_layout.schema.json` — vendored copy of the upstream schema at the pinned version.
- `schemas/.sha256` — SHA-256 of the upstream schema, used by CI to detect drift.

A GitHub Actions check (`.github/workflows/schema-check.yml`) runs on every PR and main push and fails if the local schema diverges from the pinned upstream version.

### Bumping the pinned schema version

1. Edit `schemas/PINNED_VERSION` to the new semver (e.g. `1.0.1` or `1.1.0`).
2. Run `bash scripts/sync-schema.sh` — this fetches the upstream schema at the new tag and updates `schemas/lcbe_layout.schema.json` and `schemas/.sha256`.
3. Commit all three files: `git add schemas/PINNED_VERSION schemas/lcbe_layout.schema.json schemas/.sha256 && git commit -m "Bump LCBE_LAYOUT schema to vX.Y.Z"`.
4. Push and confirm `Schema sync check` passes.

Never edit `schemas/lcbe_layout.schema.json` directly — the canonical source is upstream. Local edits are detected by the CI check and rejected.

## License

MIT
