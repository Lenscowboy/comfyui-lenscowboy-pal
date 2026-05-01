PAL Layout Node v1.1.0 — animated sequences, ID matte, smoother integration.

Two big additions, plus a stack of UX fixes that came out of running v1.0 on real shots for a few weeks.

<!-- Drag your demo GIF here in the GitHub release editor before publishing -->

## What's new

### Animated sequence renders
A second IMAGE output mode that captures every frame of an animated PAL shot into a 4D batch tensor. Drop the node's outputs into a KSampler / Video Combine graph and render a whole sequence in one queue. Per-frame transports are uploaded to ComfyUI's input directory automatically — no prompt-body size limits, no inlined base64 to fight with.

### ID matte pass
A fifth IMAGE output, `id_matte_pass`. Each PAL object gets a deterministic unique solid colour, so you can mask any individual element downstream — feed it into a SAM2 segmentation prompt, drive per-object ControlNet weights, or composite cleanly. Available on both single-frame and animated-sequence renders. Multipass tier required.

### Live pass preview
The Camera-bar now has a passes button (hotkey **P**) that cycles the viewport between Beauty / Depth / Normal / Alpha / Matte. What you see on screen is exactly what the node will output — no need to render to verify.

## UX & reliability

- **Sequence transport** — frames upload to ComfyUI's `/api/upload/image` instead of inlining base64, so long sequences no longer hit the prompt body cap.
- **Manual queue** — closing the viewport no longer auto-runs the graph. Render → close → click Run when you're ready.
- **FBX scene persistence** — multiple FBX imports now survive viewport open/close cycles cleanly. Previously a second import could clear the first.
- **Native camera always visible** — the *Camera* entry shows up in the object list immediately on viewport open, before any model loads.
- **Director right-panel pan** — middle-click and Alt+middle-click now pan the shot camera in the right pane of the Director split, matching Camera-mode behaviour.
- **`LOAD TEXTURES`** — renamed from `UPLOAD TEXTURES`. Loads a folder of texture images into the viewport library; nothing leaves your machine.
- **Endpoint override** — `localStorage.setItem('lc_api_base', 'http://localhost:8000')` makes the iframe point at a local LensCowboy server. Useful if you're developing against the platform; harmless otherwise.

## Source DCC export — Blender notes

Animated cameras and constraint-driven aim need two specific Blender export settings that aren't on by default:
- **Bake Action** with *Visual Keying* ON, *Clean Curves* OFF
- **FBX Export** with *Use Space Transform* ON, *Simplify* = 0

Full step-by-step is in the platform docs at app.lenscowboy.com/docs/pal. Maya / C4D / Houdini / 3ds Max / Unreal guides are coming.

## Install

**ComfyUI Manager:** search for *PAL Layout*

**Manual:**
```
cd ComfyUI/custom_nodes
git clone https://github.com/Lenscowboy/comfyui-lenscowboy-pal.git
```
Restart ComfyUI.

## Highlights (cumulative)

- Full Three.js 3D viewport — orbit, pan, zoom, WASD fly mode
- Proxy library — humans, vehicles, horses, props, buildings, terrain
- Camera presets — eye level, low, overhead, OTS, POV
- Filmic HUD — frame lines, safe areas, DOF bar
- Real-time DOF from F-stop + focus distance
- Five IMAGE outputs: `beauty_pass`, `depth_pass`, `normal_pass`, `alpha_pass`, `id_matte_pass`
- Animated sequence batches feed straight into KSampler / Video Combine
- `scene_json` / `camera_json` / `sequence_json` for downstream tooling
- GLB / FBX / OBJ / USD import — drag-and-drop or via file path
- FBX camera import — full animation tracks (position, rotation, focal length, clip planes)
- Scene state persists across ComfyUI sessions

## Optional — LensCowboy Platform

A free LensCowboy API key unlocks higher-res beauty (>512px) and multi-pass renders (depth, normal, alpha, ID matte). Mint one at [app.lenscowboy.com/settings](https://app.lenscowboy.com/settings) → **Comfy API Keys**. Pure local use needs no key.

---

MIT licensed. Issues and PRs welcome at the [repo](https://github.com/Lenscowboy/comfyui-lenscowboy-pal).
