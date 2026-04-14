/**
 * PAL Layout Node — ComfyUI frontend extension.
 *
 * Responsibilities:
 * - Register the PAL node widget with ComfyUI's extension system
 * - Add "Open Viewport" button and scene summary display
 * - Launch the full-screen viewport modal (loads Three.js from pal_three_bundle.js)
 * - Bridge viewport scene state ↔ node hidden widget (_pal_scene_state)
 * - Block Queue Prompt via beforeQueuePrompt if passes not yet rendered
 */

import { app } from "../../scripts/app.js";

const EXT_NAME = "LensCowboy.PALLayout";

app.registerExtension({
  name: EXT_NAME,

  async beforeRegisterNodeDef(nodeType, nodeData, app) {
    if (nodeData.name !== "PALLayoutNode") return;

    const origOnCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      origOnCreated?.apply(this, arguments);
      this._palRendered = false;
      this._palState = {};

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
      header.innerHTML = `
        <span style="color:#f5c400;letter-spacing:1px">PAL VIEWPORT</span>
        <div style="display:flex;gap:8px">
          <button id="pal-comfy-render" style="padding:4px 12px;background:rgba(245,196,0,.1);border:1px solid rgba(245,196,0,.3);border-radius:4px;color:#f5c400;font-family:monospace;font-size:10px;cursor:pointer">Render All</button>
          <button id="pal-comfy-save" style="padding:4px 12px;background:#1a1a18;border:1px solid #2a2a26;border-radius:4px;color:#888;font-family:monospace;font-size:10px;cursor:pointer">Save & Close</button>
        </div>
      `;
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

      // Render All — capture passes
      document.getElementById("pal-comfy-render").onclick = () => {
        if (window.PALViewport && window.PALViewport.renderPasses) {
          const passes = window.PALViewport.renderPasses();
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
      if (this._summaryWidget) {
        this._summaryWidget.value = `${objects} objects | camera: ${camera} | ${rendered}`;
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
