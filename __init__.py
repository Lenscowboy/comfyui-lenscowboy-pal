"""
PAL Layout Node for ComfyUI — Lenscowboy 3D Previsualisation

Embeds a full Three.js 3D viewport inside ComfyUI for spatial layout,
camera setup, and multipass render output (beauty, depth, normals).

Local-first: works fully offline with no server dependency.
Optional Lenscowboy platform connection for project/shot integration.
"""

from .pal_node import PALNode

NODE_CLASS_MAPPINGS = {
    "PALLayoutNode": PALNode
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PALLayoutNode": "PAL Layout (Lenscowboy)"
}

WEB_DIRECTORY = "./web_comfy"
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
