"""
Offscreen render pipeline using pygfx + rendercanvas.

Minimal first pass: load a single GLB/OBJ/FBX, frame it with a camera,
return a numpy beauty pass. Depth/normal passes and multi-object scenes
come in subsequent iterations.

Output convention matches ComfyUI IMAGE tensors:
    shape (1, H, W, 3), dtype float32, range [0, 1]
"""

from __future__ import annotations

import numpy as np


def render_model(
    model_path: str,
    width: int = 512,
    height: int = 512,
    camera_position: tuple[float, float, float] = (3.0, 3.0, 5.0),
    camera_target: tuple[float, float, float] = (0.0, 0.0, 0.0),
    fov: float = 45.0,
    background: tuple[float, float, float] = (0.1, 0.1, 0.12),
) -> dict[str, np.ndarray]:
    """Render a single model file to a beauty pass.

    Returns {'beauty': ndarray(1, H, W, 3) float32}.
    """
    # Imports are lazy so the node module still loads when pal_renderer
    # deps aren't installed — execute() can decide at runtime whether to
    # call the local renderer or fall back to the iframe round-trip.
    import pygfx as gfx
    from rendercanvas.offscreen import RenderCanvas

    canvas = RenderCanvas(size=(width, height), pixel_ratio=1)
    renderer = gfx.renderers.WgpuRenderer(canvas)

    scene = gfx.Scene()
    scene.add(gfx.AmbientLight(intensity=0.3))
    key_light = gfx.DirectionalLight(intensity=2.0)
    key_light.local.position = (5, 5, 5)
    scene.add(key_light)

    # Background colour
    renderer.blend_mode = "default"
    scene.add(gfx.Background.from_color(background))

    # Load model
    model = _load_model(model_path)
    scene.add(model)

    # Camera
    camera = gfx.PerspectiveCamera(fov, width / height)
    camera.local.position = camera_position
    camera.look_at(camera_target)

    canvas.request_draw(lambda: renderer.render(scene, camera))
    rgba = canvas.draw()  # (H, W, 4) uint8

    rgb = rgba[..., :3].astype(np.float32) / 255.0
    return {"beauty": rgb[np.newaxis, ...]}


def _load_model(path: str):
    """Load a 3D model from a file path. Returns a pygfx object ready to add to scene."""
    import pygfx as gfx

    lower = path.lower()
    if lower.endswith((".glb", ".gltf")):
        return gfx.load_gltf(path)
    # trimesh as fallback for OBJ, FBX, STL
    import trimesh
    tm = trimesh.load(path, force="scene")
    return _trimesh_to_pygfx(tm)


def _trimesh_to_pygfx(tm):
    """Convert a trimesh.Scene to a pygfx Group."""
    import pygfx as gfx
    import trimesh

    group = gfx.Group()

    # trimesh can return a Scene (multiple meshes) or a single Trimesh
    meshes = tm.dump(concatenate=False) if isinstance(tm, trimesh.Scene) else [tm]
    for tri in meshes:
        if not hasattr(tri, "vertices") or len(tri.vertices) == 0:
            continue
        geom = gfx.Geometry(
            positions=np.asarray(tri.vertices, dtype=np.float32),
            indices=np.asarray(tri.faces, dtype=np.int32).ravel(),
            normals=np.asarray(tri.vertex_normals, dtype=np.float32),
        )
        mat = gfx.MeshStandardMaterial(color=(0.8, 0.8, 0.8), roughness=0.6, metalness=0.1)
        group.add(gfx.Mesh(geom, mat))

    return group


if __name__ == "__main__":
    # python -m pal_renderer.render <model_path> [out.png]
    import sys
    from pathlib import Path

    if len(sys.argv) < 2:
        print("Usage: python -m pal_renderer.render <model_path> [out.png]", file=sys.stderr)
        sys.exit(2)

    src = sys.argv[1]
    dst = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("pal_render.png")

    result = render_model(src, width=512, height=512)
    beauty = (result["beauty"][0] * 255).clip(0, 255).astype(np.uint8)

    import imageio.v3 as iio
    iio.imwrite(dst, beauty)
    print(f"Rendered {src} -> {dst}")
