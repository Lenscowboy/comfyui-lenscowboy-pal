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
    RETURN_TYPES = ("IMAGE", "IMAGE", "IMAGE", "IMAGE", "IMAGE", "STRING", "STRING", "INT", "INT", "STRING")
    RETURN_NAMES = (
        "beauty pass", "alpha pass", "depth pass", "normal pass", "id matte pass",
        "scene json", "camera json",
        "frame start", "frame end",
        "sequence json",
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
                # Single-line STRING (not multiline) so ComfyUI renders a
                # LiteGraph widget we can collapse, not a DOM textarea.
                "_pal_scene_state": ("STRING", {"default": "{}"}),
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
        # id_matte is overwritten by the iframe path below when the matte
        # base64 arrives; only the local-renderer path leaves this default
        # in place when the renderer returns no id_matte.
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
                # Local renderer returns numpy arrays — convert to torch
                # tensors so downstream nodes (.cpu().numpy()) don't choke.
                _beauty_np = result.get("beauty")
                _alpha_np  = result.get("alpha")
                _normal_np = result.get("normal")
                _depth_np  = result.get("depth")
                _idm_np    = result.get("id_matte")
                beauty = self._to_image_tensor(_beauty_np) if _beauty_np is not None else self._blank(render_width, render_height)
                alpha = self._to_image_tensor(_alpha_np) if _alpha_np is not None else alpha
                normals = self._to_image_tensor(_normal_np) if _normal_np is not None else self._blank(render_width, render_height)
                if has_multipass:
                    depth = self._to_image_tensor(_depth_np) if _depth_np is not None else self._blank(render_width, render_height, 1)
                    id_matte = self._to_image_tensor(_idm_np) if _idm_np is not None else id_matte
                else:
                    depth = self._blank(render_width, render_height, 1)
            except Exception as e:
                logger.warning(f"[PAL Node] Local renderer failed, falling back to iframe state: {e}")
                use_local_renderer = False  # fall through to iframe decode below

        if not use_local_renderer:
            beauty = self._decode_pass(state.get("beauty_b64"), render_width, render_height)
            # Use the ACTUAL beauty dimensions for blank/missing passes so
            # we don't end up with a 512×288 beauty next to a 512×512 normal.
            # Beauty tensor shape is (1, H, W, 3).
            try:
                _bh = int(beauty.shape[1])
                _bw = int(beauty.shape[2])
            except Exception:
                _bh, _bw = render_height, render_width
            depth = self._decode_pass(state.get("depth_b64"), _bw, _bh, channels=1) if has_multipass else self._blank(_bw, _bh, 1)
            normals = self._decode_pass(state.get("normal_b64"), _bw, _bh) if has_multipass else self._blank(_bw, _bh)
            alpha = self._decode_pass(state.get("alpha_b64"), _bw, _bh, channels=1) if has_multipass else self._blank(_bw, _bh, 1)
            # id_matte_b64 ride-along — paid plans only, sized to match beauty.
            if has_multipass and state.get("id_matte_b64"):
                id_matte = self._decode_pass(state.get("id_matte_b64"), _bw, _bh)
            else:
                id_matte = self._blank(_bw, _bh)

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

        return (beauty, alpha, depth, normals, id_matte,
                scene_json, camera_json,
                resolved.get("frame_start", frame_start),
                resolved.get("frame_end", frame_end),
                sequence_json)

    def _decode_pass(self, b64_str, width, height, channels=3):
        if not b64_str or len(b64_str) > MAX_BASE64_BYTES:
            return self._blank(width, height, channels)
        try:
            raw = base64.b64decode(b64_str)
            img = Image.open(io.BytesIO(raw))
            if channels == 1:
                # ComfyUI IMAGE expects (H,W,3) RGB even for grayscale passes.
                # PIL.Image.fromarray can't handle (H,W,1). Replicate grayscale
                # across RGB so downstream preview/ControlNet depth nodes work.
                gray = np.array(img.convert("L"), dtype=np.float32) / 255.0
                arr = np.stack([gray, gray, gray], axis=-1)
            else:
                arr = np.array(img.convert("RGB"), dtype=np.float32) / 255.0
            return self._to_image_tensor(arr[np.newaxis, ...])
        except Exception as e:
            logger.warning(f"[PAL Node] _decode_pass exception: {e}")
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
        # ComfyUI IMAGE must be (B,H,W,3) — force RGB even when caller
        # requested a single channel (depth / alpha gates during free tier).
        return self._to_image_tensor(np.zeros((1, h, w, 3), dtype=np.float32))

    @staticmethod
    def _to_image_tensor(arr):
        """Wrap a (1,H,W,C) float32 numpy array as a torch.Tensor — ComfyUI's
        IMAGE type is torch, and downstream nodes call `.cpu().numpy()` which
        fails on raw ndarrays."""
        try:
            import torch
            if not isinstance(arr, torch.Tensor):
                return torch.from_numpy(np.ascontiguousarray(arr))
            return arr
        except ImportError:
            # torch should always be available in ComfyUI, but keep the
            # numpy fallback for any stand-alone / test environments.
            return arr

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
