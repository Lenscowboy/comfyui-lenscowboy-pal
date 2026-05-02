PAL Layout Node v1.1.1 — flush reliability patch.

Single bug fix on top of v1.1.0:

## What's new

### Save & Close no longer loses scenes
The LOAD-3D-SCENE flush logic could spuriously wipe `_userScenes` on viewport close when the iframe couldn't tag imported objects with their source filenames (most commonly seen with FBX imports — symptom: button counter shows correct count when viewport opens, drops to 0 on close, scenes vanish on next open).

Fix: trust signal for the flush is now an explicit `comfy_source_names` array in the iframe's `pal:state` response. Present (even when empty) means "iframe is up-to-date and the list is authoritative — trust it"; absent means "older deploy, preserve `_userScenes` to avoid wiping". Decoupled from the data so empty-list and missing-list cases no longer get conflated.

## Install / Update

**ComfyUI Manager:** update *PAL Layout* to v1.1.1.

**Manual:**
```
cd ComfyUI/custom_nodes/comfyui-lenscowboy-pal
git pull
```
Restart ComfyUI.

---

For the full feature set see [v1.1.0 release notes](https://github.com/Lenscowboy/comfyui-lenscowboy-pal/releases/tag/v1.1.0).

MIT licensed. Issues and PRs welcome at the [repo](https://github.com/Lenscowboy/comfyui-lenscowboy-pal).
