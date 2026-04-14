"""
PAL API client — LensCowboy platform connection for ComfyUI node.

Handles: session auth, project load, scene save, pipeline write-back.
All calls are optional — the node works fully without a connection.
"""

import json
import logging
import urllib.request
import urllib.error

logger = logging.getLogger(__name__)

LC_API_BASE = "https://app.lenscowboy.com"


def _request(method, path, api_key, body=None, timeout=15):
    """Make an authenticated request to the LensCowboy API."""
    url = f"{LC_API_BASE}{path}"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    data = json.dumps(body).encode("utf-8") if body else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)

    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        logger.warning(f"[PAL API] {method} {path} → {e.code}: {e.reason}")
        return None
    except Exception as e:
        logger.warning(f"[PAL API] {method} {path} failed: {e}")
        return None


def validate_session(api_key: str) -> dict | None:
    """POST /pal/session — validate API key and get session context."""
    return _request("POST", "/pal/session", api_key, {"api_key": api_key})


def fetch_project_data(api_key: str, project_id: str = "", shot_id: str = "") -> dict:
    """
    Fetch project context from the LensCowboy platform.
    Returns merged dict with assets, shots, scene state, etc.
    Returns empty dict on any failure (graceful degradation).
    """
    if not api_key:
        return {}

    result = {}

    # Validate session first
    session = validate_session(api_key)
    if not session:
        return {}

    result["plan"] = session.get("plan", "free")
    result["features"] = session.get("features", [])

    # Load project if specified
    if project_id:
        project = _request("GET", f"/pal/project/{project_id}", api_key)
        if project:
            result["assets"] = project.get("asset_manifest", [])
            result["shots"] = project.get("shots", [])
            result["scene_state"] = project.get("scene_state")

            # Load specific shot if specified
            if shot_id and project.get("shots"):
                shot = next((s for s in project["shots"] if s.get("id") == shot_id), None)
                if shot:
                    result["shot_prompt"] = shot.get("prompt", "")
                    result["camera"] = shot.get("camera_preset")
                    result["frame_start"] = shot.get("frame_start")
                    result["frame_end"] = shot.get("frame_end")
                    result["breakdown"] = shot

    return result


def save_scene(api_key: str, project_id: str, shot_id: str, scene_json: str) -> bool:
    """PUT /pal/project/{id}/scene — save scene state to Firestore."""
    resp = _request("PUT", f"/pal/project/{project_id}/scene", api_key, {
        "shot_id": shot_id,
        "scene_json": scene_json,
    })
    return resp is not None


def pipeline_writeback(api_key: str, project_id: str, shot_id: str,
                       camera_json: str, frame_start: int, frame_end: int) -> bool:
    """POST /pal/project/{id}/pipeline-writeback — write camera/frames to Pipeline sheet."""
    resp = _request("POST", f"/pal/project/{project_id}/pipeline-writeback", api_key, {
        "shot_id": shot_id,
        "camera_json": camera_json,
        "frame_start": frame_start,
        "frame_end": frame_end,
    })
    return resp is not None
