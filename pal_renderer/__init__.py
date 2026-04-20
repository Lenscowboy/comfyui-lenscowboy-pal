"""
PAL local renderer — offscreen Python 3D renderer for the ComfyUI PAL node.

Replaces the iframe + postMessage + base64 render-pass round-trip with a
direct in-process render. Runs on the user's machine via wgpu (Metal on
macOS, Vulkan on Linux, DX12 on Windows). Zero cloud cost.

Public API:
    render_model(model_path, width, height, ...) -> dict[str, np.ndarray]

See render.py for the implementation.
"""

from .render import render_model

__all__ = ["render_model"]
