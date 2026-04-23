"""
Offscreen render pipeline using pygfx + rendercanvas.

Multi-pass output for ComfyUI:
    beauty, alpha, normal  — implemented
    depth, id_matte        — stubbed (zero tensors) until implementation lands

Output convention matches ComfyUI IMAGE tensors:
    shape (1, H, W, C), dtype float32, range [0, 1]
    C=3 for RGB, C=1 for single-channel masks
"""

from __future__ import annotations

from typing import Iterable

import numpy as np

ALL_PASSES = ("beauty", "alpha", "depth", "normal", "id_matte")
DEFAULT_PASSES = ("beauty", "alpha", "normal")


def render_model(
    model_path: str,
    width: int = 512,
    height: int = 512,
    camera_position: tuple[float, float, float] = (3.0, 3.0, 5.0),
    camera_target: tuple[float, float, float] = (0.0, 0.0, 0.0),
    fov: float = 45.0,
    passes: Iterable[str] = DEFAULT_PASSES,
) -> dict[str, np.ndarray]:
    """Render a model file into the requested passes.

    Returns dict mapping pass name -> ndarray(1, H, W, C) float32.
    """
    import pygfx as gfx
    from rendercanvas.offscreen import RenderCanvas

    passes = set(passes)
    unknown = passes - set(ALL_PASSES)
    if unknown:
        raise ValueError(f"Unknown passes: {unknown}. Valid: {ALL_PASSES}")

    canvas = RenderCanvas(size=(width, height), pixel_ratio=1)
    renderer = gfx.renderers.WgpuRenderer(canvas)

    camera = gfx.PerspectiveCamera(fov, width / height)
    camera.local.position = camera_position
    camera.look_at(camera_target)

    model = _load_model(model_path)

    results: dict[str, np.ndarray] = {}

    if passes & {"beauty", "alpha"}:
        rgba = _render_rgba(renderer, canvas, model, camera)
        if "beauty" in passes:
            results["beauty"] = _to_comfy_image(rgba[..., :3].astype(np.float32) / 255.0)
        if "alpha" in passes:
            a = rgba[..., 3:4].astype(np.float32) / 255.0
            results["alpha"] = _to_comfy_image(a)

    if "normal" in passes:
        rgba = _render_with_material(renderer, canvas, model, camera, gfx.MeshNormalMaterial())
        results["normal"] = _to_comfy_image(rgba[..., :3].astype(np.float32) / 255.0)

    if "depth" in passes:
        # TODO: pygfx has no MeshDepthMaterial; needs custom shader or depth-buffer readback
        results["depth"] = np.zeros((1, height, width, 1), dtype=np.float32)

    if "id_matte" in passes:
        # TODO: walk scene, render each object with a unique flat color
        results["id_matte"] = np.zeros((1, height, width, 3), dtype=np.float32)

    return results


def _to_comfy_image(arr: np.ndarray) -> np.ndarray:
    """Prepend batch dim to match ComfyUI IMAGE convention."""
    return arr[np.newaxis, ...]


def _render_rgba(renderer, canvas, model, camera) -> np.ndarray:
    """Standard lit render. Returns (H, W, 4) uint8 RGBA."""
    import pygfx as gfx

    scene = gfx.Scene()
    scene.add(gfx.AmbientLight(intensity=0.3))
    key = gfx.DirectionalLight(intensity=2.0)
    key.local.position = (5, 5, 5)
    scene.add(key)
    scene.add(model)
    canvas.request_draw(lambda: renderer.render(scene, camera))
    return canvas.draw()


def _render_with_material(renderer, canvas, model, camera, material) -> np.ndarray:
    """Render the model with all materials overridden to `material`. Restores after."""
    import pygfx as gfx

    saved = _swap_materials(model, material)
    try:
        scene = gfx.Scene()
        scene.add(model)
        canvas.request_draw(lambda: renderer.render(scene, camera))
        return canvas.draw()
    finally:
        _restore_materials(model, saved)


def _swap_materials(root, new_material) -> dict:
    """Recursively swap materials. Returns id->original_material for restore."""
    saved = {}
    for obj in root.iter():
        if hasattr(obj, "material") and obj.material is not None:
            saved[id(obj)] = obj.material
            obj.material = new_material
    return saved


def _restore_materials(root, saved: dict) -> None:
    for obj in root.iter():
        if id(obj) in saved:
            obj.material = saved[id(obj)]


def _load_model(path: str):
    """Load a 3D model from a file path. Returns a pygfx object ready to add to scene."""
    import pygfx as gfx

    lower = path.lower()
    if lower.endswith((".glb", ".gltf")):
        return gfx.load_gltf(path).scene

    if lower.endswith(".fbx"):
        return _load_with_assimp(path)

    import trimesh
    tm = trimesh.load(path, force="scene")
    return _trimesh_to_pygfx(tm)


def _load_with_assimp(path: str):
    """Load FBX (and other assimp-supported formats) via assimp-py."""
    try:
        import assimp_py as assimp
    except ImportError as e:
        raise ImportError(
            "FBX support requires assimp-py. Install with:\n"
            "    pip install assimp-py"
        ) from e

    import pygfx as gfx

    flags = (
        assimp.Process_Triangulate
        | assimp.Process_GenNormals
        | assimp.Process_JoinIdenticalVertices
    )
    scene = assimp.import_file(path, flags)

    group = gfx.Group()
    for m in scene.meshes:
        # assimp-py returns flat 1D arrays — reshape to Nx3
        positions = np.asarray(m.vertices, dtype=np.float32).reshape(-1, 3)
        indices = np.asarray(m.indices, dtype=np.int32).reshape(-1, 3)
        geom_kwargs = {"positions": positions, "indices": indices}

        if m.normals:
            normals = np.asarray(m.normals, dtype=np.float32).reshape(-1, 3)
            if len(normals) == len(positions):
                geom_kwargs["normals"] = normals

        geom = gfx.Geometry(**geom_kwargs)
        mat = gfx.MeshStandardMaterial(color=(0.8, 0.8, 0.8), roughness=0.6, metalness=0.1)
        group.add(gfx.Mesh(geom, mat))
    return group


def _trimesh_to_pygfx(tm):
    import pygfx as gfx
    import trimesh

    group = gfx.Group()
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
    # python -m pal_renderer.render <model_path> [out_prefix]
    import sys
    from pathlib import Path
    import imageio.v3 as iio

    if len(sys.argv) < 2:
        print("Usage: python -m pal_renderer.render <model_path> [out_prefix]", file=sys.stderr)
        sys.exit(2)

    src = sys.argv[1]
    prefix = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("pal_render")

    result = render_model(src, width=512, height=512, passes=ALL_PASSES)
    for name, arr in result.items():
        img = (arr[0] * 255).clip(0, 255).astype(np.uint8)
        if img.shape[-1] == 1:
            img = np.repeat(img, 3, axis=-1)
        out_path = prefix.with_name(f"{prefix.name}_{name}.png")
        iio.imwrite(out_path, img)
        print(f"  {name} -> {out_path}")
