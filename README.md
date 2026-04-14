# PAL Layout Node for ComfyUI

3D previsualisation and spatial layout node for ComfyUI by [LensCowboy](https://lenscowboy.com).

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
- Load shots from LCBE Breakdown
- Access project asset libraries from Google Drive
- Save scenes to cloud
- Write camera and frame data back to the Pipeline sheet
- Multi-shot sequence export

No API key needed for local use — the node is a fully capable standalone tool.

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

## License

MIT
