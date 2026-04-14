/**
 * PAL Layout Node — ComfyUI frontend extension.
 *
 * Responsibilities:
 * - Register the PAL node widget with ComfyUI's extension system
 * - Add "Open Viewport" button and scene summary display
 * - Launch the full-screen viewport modal (loads Three.js from pal_three_bundle.js)
 * - Bridge viewport scene state ↔ node hidden widget (_pal_scene_state)
 * - Block Queue Prompt via beforeQueuePrompt if passes not yet rendered
 * - Phase 2: connection badge, project/shot selector, watermark, enriched summary
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

/* ── Paid plan names that skip the watermark ─────────────────────── */
const PAID_PLANS = new Set(["node_pro", "creator", "studio", "enterprise"]);

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
            for (const s of shots) {
              const so = document.createElement("option");
              so.value = s.id;
              so.textContent = s.name || s.id;
              shotSelect.appendChild(so);
            }
          }
        });
        shotSelect.addEventListener("change", () => {
          nodeRef._lcSelectedShot = shotSelect.value || null;
        });

        // Pre-populate shots if a project is already selected
        if (this._lcSelectedProject) {
          (async () => {
            const shots = await this._lcFetchShots(this._lcSelectedProject);
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
      headerRight.innerHTML = `
        <button id="pal-comfy-render" style="padding:4px 12px;background:rgba(245,196,0,.1);border:1px solid rgba(245,196,0,.3);border-radius:4px;color:#f5c400;font-family:monospace;font-size:10px;cursor:pointer">Render All</button>
        <button id="pal-comfy-save" style="padding:4px 12px;background:#1a1a18;border:1px solid #2a2a26;border-radius:4px;color:#888;font-family:monospace;font-size:10px;cursor:pointer">Save & Close</button>
      `;

      header.appendChild(headerLeft);
      header.appendChild(headerRight);
      modal.appendChild(header);

      // Viewport container
      const container = document.createElement("div");
      container.id = "pal-comfy-viewport";
      container.style.cssText = "flex:1;position:relative;overflow:hidden;";
      modal.appendChild(container);

      document.body.appendChild(modal);

      // Initialise Three.js viewport (from bundled PALViewport)
      if (window.PALViewport && window.PALViewport.init) {
        const existingState = this._palState || {};
        window.PALViewport.init(container, {
          state: existingState,
          onStateChange: (state) => { this._palState = state; },
        });
      } else {
        container.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;font-family:monospace;font-size:12px;color:#555">
          PAL viewport bundle not loaded. Ensure pal_three_bundle.js is in the web/ directory.
        </div>`;
      }

      // Render All — capture passes (+ Phase 2 watermark for free tier)
      document.getElementById("pal-comfy-render").onclick = () => {
        if (window.PALViewport && window.PALViewport.renderPasses) {
          const passes = window.PALViewport.renderPasses();

          // Phase 2 — watermark on free tier
          const plan = this._lcSession?.plan || "free";
          if (!PAID_PLANS.has(plan) && passes.beauty) {
            passes.beauty = this._lcApplyWatermark(passes.beauty);
          }

          this._palState.beauty_b64 = passes.beauty;
          this._palState.depth_b64 = passes.depth;
          this._palState.normal_b64 = passes.normals;
          this._palRendered = true;
          this._updateSummary();
        }
      };

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

    /* ── Phase 2: watermark helper ──────────────────────────────── */
    nodeType.prototype._lcApplyWatermark = function (beautyB64) {
      try {
        const img = new Image();
        const canvas = document.createElement("canvas");
        // Synchronous path: decode base64 → draw → re-encode
        img.src = beautyB64.startsWith("data:") ? beautyB64 : `data:image/png;base64,${beautyB64}`;
        // We need the image loaded; for data-URIs this is synchronous in most browsers
        canvas.width = img.naturalWidth || img.width || 1024;
        canvas.height = img.naturalHeight || img.height || 1024;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);
        // Subtle semi-transparent text in the bottom-right
        ctx.save();
        ctx.font = "12px monospace";
        ctx.fillStyle = "rgba(255, 255, 255, 0.25)";
        ctx.textAlign = "right";
        ctx.textBaseline = "bottom";
        ctx.fillText("lenscowboy.com", canvas.width - 10, canvas.height - 8);
        ctx.restore();
        return canvas.toDataURL("image/png");
      } catch (_) {
        return beautyB64; // fail silently — don't break the render
      }
    };

    nodeType.prototype._saveAndClose = function (modal) {
      // Serialise scene state to hidden widget
      const stateJson = JSON.stringify(this._palState || {});
      const widget = this.widgets?.find(w => w.name === "_pal_scene_state");
      if (widget) widget.value = stateJson;
      this._updateSummary();

      // Cleanup viewport
      if (window.PALViewport && window.PALViewport.destroy) {
        window.PALViewport.destroy();
      }
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
