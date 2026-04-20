"""
PAL Layout Node — Python node class for ComfyUI.

Inputs: LC platform connection (optional), GLB path, prompt, camera preset,
        frame range, render resolution, scene state round-trip.
Outputs: beauty/depth/normal IMAGE passes, scene/camera JSON, frame range.

The viewport runs client-side (Three.js in browser). This execute() function
runs server-side and decodes the render passes from base64 widget state.
"""

import base64
import io
import json
import logging
import numpy as np
from PIL import Image

logger = logging.getLogger(__name__)

MAX_BASE64_BYTES = 30_000_000


class PALNode:
    CATEGORY = "LensCowboy/Layout"
    RETURN_TYPES = ("IMAGE", "IMAGE", "IMAGE", "STRING", "STRING", "INT", "INT", "STRING", "IMAGE", "IMAGE")
    RETURN_NAMES = (
        "beauty_pass", "depth_pass", "normal_pass",
        "scene_json", "camera_json",
        "frame_start", "frame_end",
        "sequence_json",
        "alpha_pass", "id_matte_pass",
    )
    FUNCTION = "execute"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": {
                "lc_api_key":    ("STRING", {"default": ""}),
                "lc_project_id": ("STRING", {"default": ""}),
                "lc_shot_id":    ("STRING", {"default": ""}),
                "glb_path":      ("STRING",  {"default": ""}),
                "GLB":           (("FILE_3D_GLB", "FILE_3D", "MESH", "STRING"),),
                "OBJ":           (("FILE_3D_OBJ", "FILE_3D", "MESH", "STRING"),),
                "model_3d":      ("FILE_3D",),
                "prompt":        ("STRING",  {"default": "", "multiline": True}),
                "camera_preset": ("STRING",  {"default": "eye_level"}),
                "frame_start":   ("INT",     {"default": 1, "min": 0, "max": 9999}),
                "frame_end":     ("INT",     {"default": 24, "min": 1, "max": 9999}),
                "render_width":  ("INT",     {"default": 512, "min": 64, "max": 2048, "step": 64}),
                "render_height": ("INT",     {"default": 512, "min": 64, "max": 2048, "step": 64}),
                "scene_json_in": ("STRING",  {"default": ""}),
                "use_local_renderer": ("BOOLEAN", {"default": False}),
                # Scene state carrier. Declared optional (not hidden) so
                # ComfyUI's queue serializer actually sends its widget value
                # back at execute time. JS hides the widget visually in
                # onNodeCreated so it doesn't clutter the node UI.
                "_pal_scene_state": ("STRING", {"default": "{}", "multiline": True}),
            },
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    def execute(self, lc_api_key="", lc_project_id="", lc_shot_id="",
                glb_path="", GLB=None, OBJ=None, model_3d=None,
                prompt="", camera_preset="eye_level",
                frame_start=1, frame_end=24, render_width=512, render_height=512,
                scene_json_in="", use_local_renderer=False, _pal_scene_state="{}"):

        render_width = min(max(render_width, 64), 2048)
        render_height = min(max(render_height, 64), 2048)

        try:
            state = json.loads(_pal_scene_state) if _pal_scene_state else {}
        except json.JSONDecodeError:
            state = {}

        # Merge inputs + resolve plan
        lc_data = {}
        plan = "free"
        if lc_api_key:
            try:
                from .pal_api import fetch_project_data
                lc_data = fetch_project_data(lc_api_key, lc_project_id, lc_shot_id)
                plan = lc_data.get("plan", "free")
            except Exception as e:
                logger.warning(f"[PAL Node] LC connection failed: {e}")

        # Gate: resolution capped to 512 for free tier
        if plan == "free":
            render_width = min(render_width, 512)
            render_height = min(render_height, 512)

        # Resolve model inputs — accept file paths or base64 data from upstream nodes
        try:
            imported_models = self._resolve_models(glb_path, GLB, OBJ, model_3d)
        except Exception as e:
            logger.warning(f"[PAL Node] Model resolve failed: {e}")
            imported_models = []

        from .pal_merge import PALInputResolver
        resolved = PALInputResolver().resolve(lc_data, {
            "glb_path": glb_path, "prompt": prompt,
            "camera_preset": camera_preset,
            "frame_start": frame_start, "frame_end": frame_end,
            "scene_json_in": scene_json_in,
            "imported_models": imported_models,
        })

        # Gate: depth/normal passes require paid plan (multipass feature)
        has_multipass = plan != "free"

        # Pass generation — two paths:
        #  1. Local renderer (pygfx, offscreen) — direct render, no iframe needed
        #  2. Iframe round-trip — decode base64 passes from _pal_scene_state
        alpha = self._blank(render_width, render_height, 1)
        id_matte = self._blank(render_width, render_height)

        if use_local_renderer:
            model_path = self._pick_local_model_path(glb_path, model_3d, GLB, OBJ)
            camera_kwargs = self._camera_from_state(state.get("camera"))
            try:
                from .pal_renderer import render_model
                passes_wanted = ["beauty", "alpha", "normal"]
                if has_multipass:
                    passes_wanted += ["depth", "id_matte"]
                result = render_model(
                    model_path, width=render_width, height=render_height,
                    passes=passes_wanted, **camera_kwargs,
                )
                beauty = result.get("beauty", self._blank(render_width, render_height))
                alpha = result.get("alpha", alpha)
                normals = result.get("normal", self._blank(render_width, render_height))
                depth = result.get("depth", self._blank(render_width, render_height, 1)) if has_multipass else self._blank(render_width, render_height, 1)
                id_matte = result.get("id_matte", id_matte) if has_multipass else id_matte
            except Exception as e:
                logger.warning(f"[PAL Node] Local renderer failed, falling back to iframe state: {e}")
                use_local_renderer = False  # fall through to iframe decode below

        if not use_local_renderer:
            beauty = self._decode_pass(state.get("beauty_b64"), render_width, render_height)
            depth = self._decode_pass(state.get("depth_b64"), render_width, render_height, channels=1) if has_multipass else self._blank(render_width, render_height, 1)
            normals = self._decode_pass(state.get("normal_b64"), render_width, render_height) if has_multipass else self._blank(render_width, render_height)
            alpha = self._decode_pass(state.get("alpha_b64"), render_width, render_height, channels=1) if has_multipass else self._blank(render_width, render_height, 1)

        scene_data = state.get("scene", resolved.get("scene_state", {}))
        if isinstance(scene_data, str):
            try: scene_data = json.loads(scene_data)
            except Exception: scene_data = {}
        if imported_models:
            scene_data["imported_models"] = imported_models
            # Also inject into state so JS widget picks them up on next viewport open
            if "scene" not in state:
                state["scene"] = {}
            state["scene"]["imported_models"] = imported_models
        scene_json = json.dumps(scene_data)
        camera_json = json.dumps(state.get("camera", {}))

        # Phase 3 — sequence export output
        sequence_json = ""
        if state.get("sequence"):
            sequence_json = json.dumps(state["sequence"])

        return (beauty, depth, normals, scene_json, camera_json,
                resolved.get("frame_start", frame_start),
                resolved.get("frame_end", frame_end),
                sequence_json,
                alpha, id_matte)

    def _decode_pass(self, b64_str, width, height, channels=3):
        if not b64_str or len(b64_str) > MAX_BASE64_BYTES:
            return self._blank(width, height, channels)
        try:
            img = Image.open(io.BytesIO(base64.b64decode(b64_str)))
            if channels == 1:
                arr = np.array(img.convert("L"), dtype=np.float32)[..., np.newaxis] / 255.0
            else:
                arr = np.array(img.convert("RGB"), dtype=np.float32) / 255.0
            return arr[np.newaxis, ...]
        except Exception:
            return self._blank(width, height, channels)

    def _resolve_models(self, glb_path="", glb_input=None, obj_input=None, model_3d_input=None):
        """Build imported_models list from inputs. Accepts file paths, base64 strings, or bytes."""
        import os
        models = []

        # glb_path — legacy file path input
        if glb_path and isinstance(glb_path, str) and glb_path.strip():
            path = glb_path.strip()
            if os.path.isfile(path):
                with open(path, "rb") as f:
                    models.append({"id": "glb_path", "name": os.path.basename(path),
                                   "format": "glb", "data": base64.b64encode(f.read()).decode()})
            else:
                models.append({"id": "glb_path", "name": os.path.basename(path),
                               "format": "glb", "path": path})

        # GLB — from upstream node (file path, base64 string, or bytes)
        if glb_input is not None:
            models.append(self._coerce_model(glb_input, "glb_input", "glb"))

        # OBJ — from upstream node (file path, base64 string, or bytes)
        if obj_input is not None:
            models.append(self._coerce_model(obj_input, "obj_input", "obj"))

        # model_3d — generic FILE_3D input (e.g. from native Load3D). Format from extension.
        if model_3d_input is not None:
            fmt = self._detect_3d_format(model_3d_input)
            models.append(self._coerce_model(model_3d_input, "model_3d_input", fmt))

        return [m for m in models if m]

    def _detect_3d_format(self, value):
        """Detect 3D file format from a path string's extension. Defaults to glb."""
        import os
        if isinstance(value, str):
            ext = os.path.splitext(value.strip())[1].lower().lstrip(".")
            if ext in ("glb", "gltf", "obj", "fbx", "stl", "usdz"):
                return ext
        return "glb"

    def _coerce_model(self, value, model_id, fmt):
        """Convert any upstream node output to a model dict with base64 data."""
        import os
        if isinstance(value, bytes):
            return {"id": model_id, "name": f"model.{fmt}", "format": fmt,
                    "data": base64.b64encode(value).decode()}
        if isinstance(value, str):
            val = value.strip()
            if not val:
                return None
            if os.path.isfile(val):
                with open(val, "rb") as f:
                    return {"id": model_id, "name": os.path.basename(val), "format": fmt,
                            "data": base64.b64encode(f.read()).decode()}
            # Assume base64
            return {"id": model_id, "name": f"model.{fmt}", "format": fmt, "data": val}
        # Unknown type — try to convert
        try:
            raw = bytes(value)
            return {"id": model_id, "name": f"model.{fmt}", "format": fmt,
                    "data": base64.b64encode(raw).decode()}
        except Exception:
            logger.warning(f"[PAL Node] Could not coerce {type(value).__name__} to model data")
            return None

    def _blank(self, w, h, c=3):
        return np.zeros((1, h, w, c), dtype=np.float32)

    def _pick_local_model_path(self, glb_path, model_3d, glb_input, obj_input):
        """Choose the first usable on-disk model path for the local renderer."""
        import os
        candidates = [model_3d, glb_input, obj_input, glb_path]
        for c in candidates:
            if isinstance(c, str) and c.strip() and os.path.isfile(c.strip()):
                return c.strip()
        raise FileNotFoundError(
            "use_local_renderer=True but no on-disk model path found on any "
            "3D input (model_3d, GLB, OBJ, glb_path). Connect Load3D's model_3d "
            "output, or pass a file path via glb_path."
        )

    def _camera_from_state(self, cam):
        """Parse camera dict from _pal_scene_state into render_model kwargs. Defensive."""
        if not isinstance(cam, dict):
            return {}
        kwargs = {}
        pos = cam.get("position")
        if isinstance(pos, dict):
            kwargs["camera_position"] = (float(pos.get("x", 3)), float(pos.get("y", 3)), float(pos.get("z", 5)))
        elif isinstance(pos, (list, tuple)) and len(pos) >= 3:
            kwargs["camera_position"] = (float(pos[0]), float(pos[1]), float(pos[2]))
        tgt = cam.get("target")
        if isinstance(tgt, dict):
            kwargs["camera_target"] = (float(tgt.get("x", 0)), float(tgt.get("y", 0)), float(tgt.get("z", 0)))
        elif isinstance(tgt, (list, tuple)) and len(tgt) >= 3:
            kwargs["camera_target"] = (float(tgt[0]), float(tgt[1]), float(tgt[2]))
        fov = cam.get("fov")
        if isinstance(fov, (int, float)):
            kwargs["fov"] = float(fov)
        return kwargs
