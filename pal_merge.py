"""
PAL Input Merge — priority resolver for hybrid LC + ComfyUI inputs.

LC platform data wins when present and non-empty.
Falls through to ComfyUI graph inputs, then to defaults.
Never raises — always returns a complete resolved dict.
"""


class PALInputResolver:
    def resolve(self, lc_data: dict, comfy_inputs: dict) -> dict:
        breakdown = lc_data.get("breakdown") or {}
        return {
            "assets":          lc_data.get("assets")       or self._parse_glb(comfy_inputs.get("glb_path", "")),
            "imported_models": comfy_inputs.get("imported_models", []),
            "prompt":          lc_data.get("shot_prompt")  or comfy_inputs.get("prompt", ""),
            "camera":          lc_data.get("camera")       or comfy_inputs.get("camera_preset", "eye_level"),
            "frame_start":     lc_data.get("frame_start")  or comfy_inputs.get("frame_start", 1),
            "frame_end":       lc_data.get("frame_end")    or comfy_inputs.get("frame_end", 24),
            "scene_state":     lc_data.get("scene_state")  or comfy_inputs.get("scene_json_in", "{}"),
            "shot_context":    breakdown,
            "plan":            lc_data.get("plan", "free"),
            "features":        lc_data.get("features", []),
            # Phase 3 — breakdown context fields passthrough
            "description":     breakdown.get("description", ""),
            "camera_notes":    breakdown.get("camera_notes", ""),
            "lighting_notes":  breakdown.get("lighting_notes", ""),
            "vfx_type":        breakdown.get("vfx_type", ""),
        }

    def _parse_glb(self, glb_path: str) -> list:
        """Convert a GLB file path to an asset manifest entry."""
        if not glb_path or not glb_path.strip():
            return []
        return [{"id": "glb_input", "name": glb_path.split("/")[-1], "path": glb_path, "type": "glb"}]
