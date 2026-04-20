/**
 * PAL Layout Node — ComfyUI frontend extension.
 *
 * Responsibilities:
 * - Register the PAL node widget with ComfyUI's extension system
 * - Add "Open Viewport" button and scene summary display
 * - Launch full-screen viewport modal (iframe → full PAL SaaS UI)
 * - Bridge viewport scene state ↔ node hidden widget (_pal_scene_state)
 * - Block Queue Prompt via beforeQueuePrompt if passes not yet rendered
 * - Phase 2: connection badge, project/shot selector, feature gates, enriched summary
 * - Phase 3: breakdown sidebar, pipeline write-back, sequence export, shot switcher
 */

import { app } from "../../scripts/app.js";

const EXT_NAME = "LensCowboy.PALLayout";
const LC_API_BASE = (typeof window !== "undefined" && window.LC_API_BASE) || "https://app.lenscowboy.com";

/* ── Badge constants ─────────────────────────────────────────────── */
const BADGE = {
  disconnected: { label: "[ LC \u2014 ]",  color: "#666" },
  connected:    { label: "[ LC \u2713 ]",  color: "#3ddc84" },
  partial:      { label: "[ LC \u2191 ]",  color: "#f5a623" },
};

/* ── Feature helpers ─────────────────────────────────────────────── */
const FREE_FEATURES = new Set(["viewport", "beauty_512"]);

/* ── Upstream model resolution ──────────────────────────────────────
 * Reads models from upstream nodes connected to GLB / OBJ / model_3d
 * BEFORE the user has queued a prompt, so the viewport shows them on
 * first open. Only Load3D-style nodes (with a `model_file` widget) are
 * supported — upstream AI 3D generators (Hunyuan3D, Meshy, Tripo…)
 * flow through execute() → _palState and work on subsequent opens.
 */
const UPSTREAM_INPUT_NAMES = ["GLB", "OBJ", "model_3d"];

function _bytesToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function _collectUpstreamModels(node) {
  const models = [];
  if (!node?.inputs || !node?.graph) return models;

  for (const input of node.inputs) {
    if (!UPSTREAM_INPUT_NAMES.includes(input.name)) continue;
    if (input.link == null) continue;
    const link = node.graph.links?.[input.link];
    if (!link) continue;
    const origin = node.graph.getNodeById(link.origin_id);
    if (!origin) continue;

    // Load3D and similar nodes expose the selected file as a `model_file` widget
    const widget = origin.widgets?.find(w => w.name === "model_file");
    const value = widget?.value;
    if (!value || typeof value !== "string") continue;

    const modelFile = value.trim();
    if (!modelFile) continue;

    const slash = modelFile.lastIndexOf("/");
    const subfolder = slash >= 0 ? modelFile.slice(0, slash) : "3d";
    const filename = slash >= 0 ? modelFile.slice(slash + 1) : modelFile;
    const ext = filename.split(".").pop().toLowerCase();

    try {
      const url = `/view?filename=${encodeURIComponent(filename)}&type=input&subfolder=${encodeURIComponent(subfolder)}`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buf = await resp.arrayBuffer();
      models.push({
        id: `upstream_${input.name}_${origin.id}`,
        name: filename,
        format: ext,
        data: _bytesToBase64(buf),
      });
      console.log(`[PAL comfy] Fetched upstream ${input.name} from node ${origin.id}: ${filename}`);
    } catch (err) {
      console.warn(`[PAL comfy] Failed to fetch upstream model for ${input.name}:`, err);
    }
  }

  return models;
}

app.registerExtension({
  name: EXT_NAME,

  async beforeRegisterNodeDef(nodeType, nodeData, app) {
    if (nodeData.name !== "PALLayoutNode") return;

    const origOnCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      origOnCreated?.apply(this, arguments);
      this._palRendered = false;
      this._palState = {};

      // Phase 2 session cache
      this._lcSession = null;          // { plan, features, project_list }
      this._lcBadgeState = "disconnected";
      this._lcSelectedProject = null;
      this._lcSelectedShot = null;

      // Phase 3 state
      this._lcBreakdown = null;        // { description, camera_notes, lighting_notes, vfx_type }
      this._lcShotList = [];           // cached shots for sequence export

      // Add Open Viewport button widget
      const btn = this.addWidget("button", "Open Viewport", "open_viewport", () => {
        this._openViewport();
      });
      btn.serialize = false;

      // Scene summary widget (read-only text)
      this._summaryWidget = this.addWidget("text", "scene_summary", "No scene loaded", () => {}, {
        serialize: false,
        multiline: false,
      });

      // Phase 2 — check connection on creation if api_key already set
      const apiKeyWidget = this.widgets?.find(w => w.name === "lc_api_key");
      if (apiKeyWidget?.value) {
        this._lcCheckSession(apiKeyWidget.value);
      }
    };

    /* ── Phase 2: session validation ─────────────────────────────── */
    nodeType.prototype._lcCheckSession = async function (apiKey) {
      if (!apiKey) {
        this._lcBadgeState = "disconnected";
        this._lcSession = null;
        this._updateSummary();
        app.graph?.setDirtyCanvas(true);
        return;
      }
      try {
        const res = await fetch(`${LC_API_BASE}/pal/session`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ api_key: apiKey }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        this._lcSession = {
          plan: data.plan || "free",
          features: data.features || [],
          project_list: data.project_list || [],
        };
        this._lcBadgeState = "connected";
      } catch (_err) {
        this._lcSession = null;
        this._lcBadgeState = "partial";
      }
      this._updateSummary();
      app.graph?.setDirtyCanvas(true);
    };

    /* ── Phase 2: draw connection badge in node header ────────── */
    const origDrawFg = nodeType.prototype.onDrawForeground;
    nodeType.prototype.onDrawForeground = function (ctx) {
      origDrawFg?.apply(this, arguments);
      const badge = BADGE[this._lcBadgeState] || BADGE.disconnected;
      ctx.save();
      ctx.font = "bold 10px monospace";
      ctx.fillStyle = badge.color;
      const tw = ctx.measureText(badge.label).width;
      ctx.fillText(badge.label, this.size[0] - tw - 8, -6);
      ctx.restore();
    };

    /* ── Phase 2: fetch shots for a project ───────────────────── */
    nodeType.prototype._lcFetchShots = async function (projectId) {
      const apiKeyWidget = this.widgets?.find(w => w.name === "lc_api_key");
      if (!apiKeyWidget?.value) return [];
      try {
        const res = await fetch(`${LC_API_BASE}/pal/projects/${projectId}/shots`, {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            "X-Api-Key": apiKeyWidget.value,
          },
        });
        if (!res.ok) return [];
        const data = await res.json();
        return data.shots || [];
      } catch (_) {
        return [];
      }
    };

    /* ── Phase 3: fetch breakdown data for a shot ─────────────── */
    nodeType.prototype._lcFetchBreakdown = async function (projectId, shotId) {
      const apiKeyWidget = this.widgets?.find(w => w.name === "lc_api_key");
      if (!apiKeyWidget?.value || !projectId || !shotId) return null;
      try {
        const res = await fetch(`${LC_API_BASE}/pal/comfy/project/${projectId}`, {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            "X-Api-Key": apiKeyWidget.value,
          },
        });
        if (!res.ok) return null;
        const data = await res.json();
        const shots = data.shots || [];
        const shot = shots.find(s => s.id === shotId);
        if (!shot) return null;
        return {
          description: shot.description || "",
          camera_notes: shot.camera_notes || "",
          lighting_notes: shot.lighting_notes || "",
          vfx_type: shot.vfx_type || "",
          scene_state: shot.scene_state || null,
          camera: shot.camera || null,
        };
      } catch (_) {
        return null;
      }
    };

    /* ── Phase 3: pipeline write-back from viewport ────────────── */
    nodeType.prototype._lcPipelineWriteback = async function () {
      const apiKeyWidget = this.widgets?.find(w => w.name === "lc_api_key");
      if (!apiKeyWidget?.value || !this._lcSelectedProject || !this._lcSelectedShot) return false;
      const state = this._palState || {};
      const cameraJson = JSON.stringify(state.camera || {});
      const frameStart = state.frame_start || 1;
      const frameEnd = state.frame_end || 24;
      try {
        const res = await fetch(`${LC_API_BASE}/pal/comfy/project/${this._lcSelectedProject}/pipeline-writeback`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Api-Key": apiKeyWidget.value,
          },
          body: JSON.stringify({
            shot_id: this._lcSelectedShot,
            camera_json: cameraJson,
            frame_start: frameStart,
            frame_end: frameEnd,
          }),
        });
        return res.ok;
      } catch (_) {
        return false;
      }
    };

    /* ── Phase 3: show toast notification in viewport ──────────── */
    nodeType.prototype._lcShowToast = function (container, message, isError) {
      const toast = document.createElement("div");
      toast.style.cssText = `
        position:absolute;bottom:24px;left:50%;transform:translateX(-50%);
        padding:8px 20px;border-radius:6px;font-family:monospace;font-size:11px;
        z-index:10001;pointer-events:none;transition:opacity .5s;
        background:${isError ? "rgba(220,50,50,.9)" : "rgba(61,220,132,.9)"};
        color:#fff;
      `;
      toast.textContent = message;
      container.appendChild(toast);
      setTimeout(() => { toast.style.opacity = "0"; }, 2000);
      setTimeout(() => { toast.remove(); }, 2600);
    };

    /* ── Plan-gate modal: clearer than a toast, has upgrade CTA ─── */
    nodeType.prototype._lcShowUpgradeModal = function (feature, requiredPlan) {
      // De-dupe: don't stack if already open
      if (document.getElementById("pal-comfy-upgrade-modal")) return;

      const overlay = document.createElement("div");
      overlay.id = "pal-comfy-upgrade-modal";
      overlay.style.cssText = `
        position:fixed;inset:0;z-index:10002;
        background:rgba(0,0,0,.72);backdrop-filter:blur(4px);
        display:flex;align-items:center;justify-content:center;
        font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      `;

      const card = document.createElement("div");
      card.style.cssText = `
        background:#161614;border:1px solid #2a2a26;border-radius:10px;
        padding:28px 32px;max-width:440px;color:#ddd;
        box-shadow:0 20px 60px rgba(0,0,0,.6);
      `;
      card.innerHTML = `
        <div style="color:#f5c400;font-size:11px;letter-spacing:1.5px;font-family:monospace;margin-bottom:10px">LENSCOWBOY</div>
        <h2 style="margin:0 0 10px;font-size:20px;font-weight:600;color:#fff">${feature} requires ${requiredPlan}</h2>
        <p style="margin:0 0 20px;font-size:13px;line-height:1.55;color:#aaa">
          You're on the Free tier. Upgrade to ${requiredPlan} to unlock depth, normal,
          alpha and ID matte passes — all rendered locally on your own machine.
        </p>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <a href="https://lenscowboy.com/pricing" target="_blank" rel="noopener"
             style="flex:1;min-width:150px;display:inline-block;text-align:center;
                    padding:10px 18px;border-radius:6px;text-decoration:none;
                    background:#f5c400;color:#111;font-weight:600;font-size:13px">
            View pricing
          </a>
          <button id="pal-comfy-upgrade-close"
             style="flex:0 0 auto;padding:10px 18px;border-radius:6px;cursor:pointer;
                    background:transparent;color:#888;border:1px solid #2a2a26;font-size:13px">
            Dismiss
          </button>
        </div>
      `;

      overlay.appendChild(card);
      document.body.appendChild(overlay);

      const close = () => overlay.remove();
      overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
      card.querySelector("#pal-comfy-upgrade-close").addEventListener("click", close);
      document.addEventListener("keydown", function esc(e) {
        if (e.key === "Escape") { close(); document.removeEventListener("keydown", esc); }
      });
    };

    nodeType.prototype._openViewport = function () {
      // Create fullscreen modal
      const modal = document.createElement("div");
      modal.id = "pal-comfy-modal";
      modal.style.cssText = `
        position: fixed; inset: 0; z-index: 10000;
        background: #0a0a09; display: flex; flex-direction: column;
      `;

      // Header bar
      const header = document.createElement("div");
      header.style.cssText = `
        height: 40px; background: #111110; border-bottom: 1px solid #222;
        display: flex; align-items: center; justify-content: space-between;
        padding: 0 16px; font-family: monospace; font-size: 11px; color: #888;
        flex-shrink: 0;
      `;
      // Left side: title + project/shot selector
      const headerLeft = document.createElement("div");
      headerLeft.style.cssText = "display:flex;align-items:center;gap:12px";
      headerLeft.innerHTML = `<span style="color:#f5c400;letter-spacing:1px">PAL VIEWPORT</span>`;

      // Phase 2 — project/shot selector (only when connected)
      if (this._lcBadgeState === "connected" && this._lcSession?.project_list?.length) {
        const projSelect = document.createElement("select");
        projSelect.id = "pal-comfy-project";
        projSelect.style.cssText = "padding:2px 6px;background:#1a1a18;border:1px solid #2a2a26;border-radius:4px;color:#ccc;font-family:monospace;font-size:10px;cursor:pointer;max-width:160px";
        const defaultOpt = document.createElement("option");
        defaultOpt.value = "";
        defaultOpt.textContent = "— project —";
        projSelect.appendChild(defaultOpt);
        for (const proj of this._lcSession.project_list) {
          const opt = document.createElement("option");
          opt.value = proj.id;
          opt.textContent = proj.name || proj.id;
          if (this._lcSelectedProject === proj.id) opt.selected = true;
          projSelect.appendChild(opt);
        }
        headerLeft.appendChild(projSelect);

        const shotSelect = document.createElement("select");
        shotSelect.id = "pal-comfy-shot";
        shotSelect.style.cssText = "padding:2px 6px;background:#1a1a18;border:1px solid #2a2a26;border-radius:4px;color:#ccc;font-family:monospace;font-size:10px;cursor:pointer;max-width:140px";
        const shotDefault = document.createElement("option");
        shotDefault.value = "";
        shotDefault.textContent = "— shot —";
        shotSelect.appendChild(shotDefault);
        headerLeft.appendChild(shotSelect);

        // Wire up project change → fetch shots
        const nodeRef = this;
        projSelect.addEventListener("change", async () => {
          nodeRef._lcSelectedProject = projSelect.value || null;
          nodeRef._lcSelectedShot = null;
          shotSelect.innerHTML = "";
          const sd = document.createElement("option");
          sd.value = "";
          sd.textContent = "— shot —";
          shotSelect.appendChild(sd);
          if (projSelect.value) {
            const shots = await nodeRef._lcFetchShots(projSelect.value);
            nodeRef._lcShotList = shots; // Phase 3 — cache for sequence export
            for (const s of shots) {
              const so = document.createElement("option");
              so.value = s.id;
              so.textContent = s.name || s.id;
              shotSelect.appendChild(so);
            }
          }
        });
        // Phase 3 — shot switcher: load breakdown + scene data on shot change
        shotSelect.addEventListener("change", async () => {
          nodeRef._lcSelectedShot = shotSelect.value || null;
          if (!shotSelect.value || !projSelect.value) {
            // Clear breakdown sidebar
            sidebar.style.width = "0";
            shotDescBar.style.height = "0";
            shotDescBar.textContent = "";
            nodeRef._lcBreakdown = null;
            return;
          }
          // Fetch breakdown data
          const bd = await nodeRef._lcFetchBreakdown(projSelect.value, shotSelect.value);
          nodeRef._lcBreakdown = bd;
          if (bd) {
            // Show sidebar with breakdown fields
            sidebar.style.width = "240px";
            const descEl = document.getElementById("pal-bd-description");
            const camEl = document.getElementById("pal-bd-camera");
            const lightEl = document.getElementById("pal-bd-lighting");
            const vfxEl = document.getElementById("pal-bd-vfx");
            if (descEl) descEl.textContent = bd.description || "—";
            if (camEl) camEl.textContent = bd.camera_notes || "—";
            if (lightEl) lightEl.textContent = bd.lighting_notes || "—";
            if (vfxEl) vfxEl.textContent = bd.vfx_type || "—";

            // Show shot description below viewport
            if (bd.description) {
              shotDescBar.textContent = bd.description;
              shotDescBar.style.height = "28px";
              shotDescBar.style.padding = "6px 16px";
            } else {
              shotDescBar.style.height = "0";
              shotDescBar.style.padding = "0 16px";
            }

            // If shot has scene_state, load it into viewport via iframe
            if (bd.scene_state) {
              const iframe = container?.querySelector("iframe") || document.querySelector("#pal-comfy-modal iframe");
              if (iframe?.contentWindow) iframe.contentWindow.postMessage({ type: "pal:load-state", state: bd.scene_state }, "*");
              nodeRef._palState = { ...nodeRef._palState, scene: bd.scene_state };
            }

            // If shot has camera data, update viewport camera via iframe
            if (bd.camera) {
              const iframe = container?.querySelector("iframe") || document.querySelector("#pal-comfy-modal iframe");
              if (iframe?.contentWindow) iframe.contentWindow.postMessage({ type: "pal:set-camera", camera: bd.camera }, "*");
              nodeRef._palState = { ...nodeRef._palState, camera: bd.camera };
            }

            // Use description to populate the prompt if no scene_state
            if (!bd.scene_state && bd.description) {
              const promptWidget = nodeRef.widgets?.find(w => w.name === "prompt");
              if (promptWidget) promptWidget.value = bd.description;
              // Also store in state for graph passthrough
              nodeRef._palState = { ...nodeRef._palState, breakdown: bd };
            }

            // Store breakdown context in node state for graph flow
            nodeRef._palState = { ...nodeRef._palState, breakdown: bd };
          } else {
            sidebar.style.width = "0";
            shotDescBar.style.height = "0";
            shotDescBar.style.padding = "0 16px";
          }
        });

        // Pre-populate shots if a project is already selected
        if (this._lcSelectedProject) {
          (async () => {
            const shots = await this._lcFetchShots(this._lcSelectedProject);
            this._lcShotList = shots; // Phase 3 — cache for sequence export
            for (const s of shots) {
              const so = document.createElement("option");
              so.value = s.id;
              so.textContent = s.name || s.id;
              if (this._lcSelectedShot === s.id) so.selected = true;
              shotSelect.appendChild(so);
            }
          })();
        }
      }

      // Right side: action buttons
      const headerRight = document.createElement("div");
      headerRight.style.cssText = "display:flex;gap:8px";

      const btnStyle = "padding:4px 12px;border-radius:4px;font-family:monospace;font-size:10px;cursor:pointer;";

      // Render All lives inside the iframe's native PAL toolbar — don't
      // duplicate it in the comfy wrapper. headerRight starts empty and
      // only gains buttons for comfy-specific actions (Send to Pipeline,
      // Export Sequence) that the iframe doesn't own.
      headerRight.innerHTML = "";

      // Phase 3 — Send to Pipeline button (gated by features)
      const features = this._lcSession?.features || [];
      if (features.includes("pipeline_writeback") && this._lcBadgeState === "connected") {
        const wbBtn = document.createElement("button");
        wbBtn.id = "pal-comfy-writeback";
        wbBtn.textContent = "Send to Pipeline";
        wbBtn.style.cssText = `${btnStyle}background:rgba(61,220,132,.1);border:1px solid rgba(61,220,132,.3);color:#3ddc84`;
        headerRight.appendChild(wbBtn);
      }

      // Phase 3 — Export Sequence button (gated by features)
      if (features.includes("sequence_export") && this._lcBadgeState === "connected") {
        const seqBtn = document.createElement("button");
        seqBtn.id = "pal-comfy-sequence";
        seqBtn.textContent = "Export Sequence";
        seqBtn.style.cssText = `${btnStyle}background:rgba(100,140,255,.1);border:1px solid rgba(100,140,255,.3);color:#648cff`;
        headerRight.appendChild(seqBtn);
      }

      const saveBtn = document.createElement("button");
      saveBtn.id = "pal-comfy-save";
      saveBtn.textContent = "Save & Close";
      saveBtn.style.cssText = `${btnStyle}background:#1a1a18;border:1px solid #2a2a26;color:#888`;
      headerRight.appendChild(saveBtn);

      header.appendChild(headerLeft);
      header.appendChild(headerRight);
      modal.appendChild(header);

      // Phase 3 — viewport + sidebar layout
      const viewportRow = document.createElement("div");
      viewportRow.style.cssText = "flex:1;display:flex;overflow:hidden;";

      // Viewport container
      const container = document.createElement("div");
      container.id = "pal-comfy-viewport";
      container.style.cssText = "flex:1;position:relative;overflow:hidden;";
      viewportRow.appendChild(container);

      // Phase 3 — Breakdown sidebar (shown when a shot is selected)
      const sidebar = document.createElement("div");
      sidebar.id = "pal-comfy-sidebar";
      sidebar.style.cssText = `
        width:0;overflow:hidden;background:#111110;border-left:1px solid #222;
        font-family:monospace;font-size:10px;color:#aaa;
        transition:width .2s;flex-shrink:0;
      `;
      sidebar.innerHTML = `
        <div style="padding:12px;display:flex;flex-direction:column;gap:10px;min-width:220px">
          <div style="color:#f5c400;font-size:11px;letter-spacing:1px;margin-bottom:4px">SHOT BREAKDOWN</div>
          <div>
            <label style="color:#666;display:block;margin-bottom:2px">Description</label>
            <div id="pal-bd-description" style="color:#ccc;white-space:pre-wrap;max-height:120px;overflow-y:auto;padding:4px 6px;background:#0a0a09;border:1px solid #2a2a26;border-radius:3px">—</div>
          </div>
          <div>
            <label style="color:#666;display:block;margin-bottom:2px">Camera Notes</label>
            <div id="pal-bd-camera" style="color:#ccc;white-space:pre-wrap;max-height:80px;overflow-y:auto;padding:4px 6px;background:#0a0a09;border:1px solid #2a2a26;border-radius:3px">—</div>
          </div>
          <div>
            <label style="color:#666;display:block;margin-bottom:2px">Lighting Notes</label>
            <div id="pal-bd-lighting" style="color:#ccc;white-space:pre-wrap;max-height:80px;overflow-y:auto;padding:4px 6px;background:#0a0a09;border:1px solid #2a2a26;border-radius:3px">—</div>
          </div>
          <div>
            <label style="color:#666;display:block;margin-bottom:2px">VFX Type</label>
            <div id="pal-bd-vfx" style="color:#ccc;padding:4px 6px;background:#0a0a09;border:1px solid #2a2a26;border-radius:3px">—</div>
          </div>
        </div>
      `;
      viewportRow.appendChild(sidebar);
      modal.appendChild(viewportRow);

      // Phase 3 — Shot description bar below viewport
      const shotDescBar = document.createElement("div");
      shotDescBar.id = "pal-comfy-shot-desc";
      shotDescBar.style.cssText = `
        height:0;overflow:hidden;background:#111110;border-top:1px solid #222;
        font-family:monospace;font-size:10px;color:#999;padding:0 16px;
        transition:height .2s;flex-shrink:0;
      `;
      modal.appendChild(shotDescBar);

      document.body.appendChild(modal);

      const apiKeyWidget = this.widgets?.find(w => w.name === "lc_api_key");
      const projectWidget = this.widgets?.find(w => w.name === "lc_project_id");
      const palToken = apiKeyWidget?.value || "";

      // ── Iframe mode: full PAL SaaS UI ──────────────────
      // comfy=1 ensures viewport loads even without auth (free tier)
      // token= passes API key for authenticated features
      const palProject = projectWidget?.value || "";
      let palUrl = `${LC_API_BASE}/pal?comfy=1`;
      if (palToken) palUrl += `&token=${encodeURIComponent(palToken)}`;
      if (palProject) palUrl += `&project=${encodeURIComponent(palProject)}`;
      if (this._lcSession) {
        const proj = this._lcSession.project_list?.find(p => p.id === palProject);
        if (proj) {
          palUrl += `&project_name=${encodeURIComponent(proj.name || palProject)}`;
          if (proj.client_id) palUrl += `&client_id=${encodeURIComponent(proj.client_id)}`;
        }
      }

      const iframe = document.createElement("iframe");
      iframe.src = palUrl;
      iframe.style.cssText = "width:100%;height:100%;border:none;";
      container.appendChild(iframe);

      // Listen for postMessage from PAL iframe
      const _iframeHandler = (e) => {
        if (e.source !== iframe.contentWindow) return;
        const msg = e.data;
        if (!msg || !msg.type) return;
        if (msg.type === "pal:state") this._palState = msg.state || {};
        if (msg.type === "pal:render") {
          const features = new Set(this._lcSession?.features || [...FREE_FEATURES]);
          this._palState.beauty_b64 = msg.beauty;
          // Gate: depth/normal/alpha require multipass feature
          this._palState.depth_b64  = features.has("multipass") ? (msg.depth   || "") : "";
          this._palState.normal_b64 = features.has("multipass") ? (msg.normals || "") : "";
          this._palState.alpha_b64  = features.has("multipass") ? (msg.alpha   || "") : "";
          this._palRendered = true;
          // Flush to the hidden widget immediately so the queue reads current
          // state even if the user queues without re-entering the modal.
          const widget = this.widgets?.find(w => w.name === "_pal_scene_state");
          if (widget) widget.value = JSON.stringify(this._palState || {});
          this._updateSummary();
          if (!features.has("multipass") && (msg.depth || msg.normals)) {
            this._lcShowUpgradeModal("Depth / Normal passes", "COMFY PAL");
          }
        }
      };
      window.addEventListener("message", _iframeHandler);
      this._iframeCleanup = () => window.removeEventListener("message", _iframeHandler);

      // Send imported models to PAL iframe after it loads
      iframe.addEventListener("load", async () => {
        // Models from graph connections are in _palState after execute()
        const stateModels = this._palState?.scene?.imported_models || [];
        const glbPath = this.widgets?.find(w => w.name === "glb_path")?.value || "";
        // Walk graph for upstream models so the viewport shows them on first open,
        // before the user has queued a prompt (which is what populates _palState).
        const upstreamModels = await _collectUpstreamModels(this);
        const models = [...stateModels, ...upstreamModels];
        if (glbPath) models.push({ id: "glb_path", name: glbPath.split("/").pop(), format: "glb", path: glbPath });
        if (models.length && iframe.contentWindow) {
          // Small delay to let PAL init complete
          setTimeout(() => {
            iframe.contentWindow.postMessage({ type: "pal:load-models", models }, "*");
          }, 1500);
        }
      });

      // Phase 3 — Send to Pipeline handler
      const wbBtnEl = document.getElementById("pal-comfy-writeback");
      if (wbBtnEl) {
        wbBtnEl.onclick = async () => {
          if (!this._lcSelectedProject || !this._lcSelectedShot) {
            this._lcShowToast(container, "Select a project and shot first", true);
            return;
          }
          wbBtnEl.disabled = true;
          wbBtnEl.textContent = "Sending...";
          const ok = await this._lcPipelineWriteback();
          wbBtnEl.disabled = false;
          wbBtnEl.textContent = "Send to Pipeline";
          this._lcShowToast(container, ok ? "Sent to Pipeline" : "Write-back failed", !ok);
        };
      }

      // Phase 3 — Export Sequence handler
      const seqBtnEl = document.getElementById("pal-comfy-sequence");
      if (seqBtnEl) {
        seqBtnEl.onclick = async () => {
          if (!this._lcSelectedProject) {
            this._lcShowToast(container, "Select a project first", true);
            return;
          }
          const shots = this._lcShotList.length ? this._lcShotList : await this._lcFetchShots(this._lcSelectedProject);
          if (!shots.length) {
            this._lcShowToast(container, "No shots found in project", true);
            return;
          }

          seqBtnEl.disabled = true;
          const sequence = [];
          const total = shots.length;

          // Progress indicator
          const progress = document.createElement("div");
          progress.style.cssText = `
            position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
            padding:16px 24px;background:rgba(0,0,0,.85);border:1px solid #333;
            border-radius:8px;font-family:monospace;font-size:12px;color:#ccc;z-index:10002;
          `;
          container.appendChild(progress);

          for (let i = 0; i < shots.length; i++) {
            const shot = shots[i];
            progress.textContent = `Exporting ${i + 1} / ${total}: ${shot.name || shot.id}`;

            // Load shot scene state via iframe
            const bd = await this._lcFetchBreakdown(this._lcSelectedProject, shot.id);
            const iframe = container.closest("#pal-comfy-modal")?.querySelector("iframe");
            if (bd?.scene_state && iframe?.contentWindow) {
              iframe.contentWindow.postMessage({ type: "pal:load-state", state: bd.scene_state }, "*");
            }
            if (bd?.camera && iframe?.contentWindow) {
              iframe.contentWindow.postMessage({ type: "pal:set-camera", camera: bd.camera }, "*");
            }

            // Request render passes from iframe
            let passes = { beauty: null, depth: null, normals: null };
            if (iframe?.contentWindow) {
              iframe.contentWindow.postMessage({ type: "pal:render-request" }, "*");
              // Wait for render response
              passes = await new Promise(resolve => {
                const handler = (e) => {
                  if (e.source === iframe.contentWindow && e.data?.type === "pal:render") {
                    window.removeEventListener("message", handler);
                    resolve({ beauty: e.data.beauty, depth: e.data.depth, normals: e.data.normals });
                  }
                };
                window.addEventListener("message", handler);
                setTimeout(() => { window.removeEventListener("message", handler); resolve({ beauty: null, depth: null, normals: null }); }, 5000);
              });
              // Gate: blank out depth/normal for free tier
              const features = new Set(this._lcSession?.features || [...FREE_FEATURES]);
              if (!features.has("multipass")) {
                passes.depth = null;
                passes.normals = null;
              }
            }

            sequence.push({
              shot_id: shot.id,
              beauty_b64: passes.beauty || "",
              depth_b64: passes.depth || "",
              normal_b64: passes.normals || "",
              camera_json: JSON.stringify(bd?.camera || {}),
            });

            // Yield to UI
            await new Promise(r => setTimeout(r, 50));
          }

          progress.remove();
          seqBtnEl.disabled = false;

          // Store sequence in state for Python node output
          this._palState.sequence = sequence;
          this._lcShowToast(container, `Exported ${sequence.length} shots`, false);
        };
      }

      // Save & Close
      document.getElementById("pal-comfy-save").onclick = () => {
        this._saveAndClose(modal);
      };

      // ESC to close
      const escHandler = (e) => {
        if (e.key === "Escape") { this._saveAndClose(modal); document.removeEventListener("keydown", escHandler); }
      };
      document.addEventListener("keydown", escHandler);
    };

    nodeType.prototype._saveAndClose = function (modal) {
      // Request state from iframe
      const iframe = modal.querySelector("iframe");
      if (iframe?.contentWindow) {
        iframe.contentWindow.postMessage({ type: "pal:get-state" }, "*");
      }

      // Serialise scene state to hidden widget
      const stateJson = JSON.stringify(this._palState || {});
      const widget = this.widgets?.find(w => w.name === "_pal_scene_state");
      if (widget) widget.value = stateJson;
      this._updateSummary();

      // Cleanup
      if (this._iframeCleanup) { this._iframeCleanup(); this._iframeCleanup = null; }
      modal.remove();
    };

    nodeType.prototype._updateSummary = function () {
      const state = this._palState || {};
      const objects = state.scene?.objects?.length || 0;
      const camera = state.camera?.position ? "set" : "default";
      const rendered = this._palRendered ? "rendered" : "not rendered";

      // Phase 2 — connection status suffix
      let lcSuffix = "LC: \u2014";
      if (this._lcBadgeState === "connected" && this._lcSession) {
        const planLabel = (this._lcSession.plan || "free").replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
        lcSuffix = `LC: ${planLabel} \u2713`;
      }

      if (this._summaryWidget) {
        this._summaryWidget.value = `${objects} objects | camera: ${camera} | ${rendered} | ${lcSuffix}`;
      }
    };
  },

  // Block Queue Prompt if passes not rendered
  async beforeQueuePrompt(graph) {
    const palNodes = graph._nodes?.filter(n => n.type === "PALLayoutNode") || [];
    for (const node of palNodes) {
      // Flush the latest _palState into the hidden widget on every queue.
      // Otherwise users who render via the iframe dialog and queue without
      // clicking "Save & Close" get stale/empty widget content, execute()
      // decodes blanks, and Video Combine sees nothing.
      const widget = node.widgets?.find(w => w.name === "_pal_scene_state");
      if (widget) widget.value = JSON.stringify(node._palState || {});

      if (node._palState && Object.keys(node._palState).length > 0 && !node._palRendered) {
        // State exists but passes not rendered — warn user
        const msg = "PAL viewport has unsaved renders. Click 'Render All' in the viewport before queuing.";
        if (typeof app.ui?.dialog?.show === "function") {
          app.ui.dialog.show(msg);
        } else {
          alert(msg);
        }
        return false; // block queue
      }
    }
    return true;
  },
});
