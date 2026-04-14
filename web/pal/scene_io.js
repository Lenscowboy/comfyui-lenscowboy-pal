// frontend/pal/scene_io.js
// PAL — Event bus and API connector.
// All inter-module communication goes through PALBus events.

export const PALBus = new EventTarget();

function authHeaders() {
  const token = localStorage.getItem('pal_jwt') ?? '';
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function getActiveProjectId() {
  return localStorage.getItem('pal_active_project') || '';
}

export function getActiveClientId() {
  return localStorage.getItem('pal_active_client_id') || '';
}

export function getActiveProjectName() {
  return localStorage.getItem('pal_active_project_name') || '';
}

export async function parseAndLoadScene(description, shotId = null, lcbeShot = null) {
  PALBus.dispatchEvent(new CustomEvent('pal:loading', { detail: { loading: true } }));
  try {
    const body = { description, shot_id: shotId };
    if (lcbeShot) body.lcbe_shot = lcbeShot;
    // Include AI engine preference from settings
    const aiEngine = document.getElementById('ps-ai-engine')?.value;
    if (aiEngine) body.ai_engine = aiEngine;
    const res = await fetch('/pal/parse-scene', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      credentials: 'include',
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`API ${res.status}: ${err}`);
    }
    const data = await res.json();
    console.log('[PAL parseAndLoadScene] shot:', shotId, 'objects:', data.scene?.objects?.length, 'types:', data.scene?.objects?.map(o => o.proxy_type));
    console.log('[PAL parseAndLoadScene] env:', data.extraction?.environment?.subtype, 'subjects:', data.extraction?.subjects?.length);
    // Show parse warnings to user (truncation, keyword fallback, etc.)
    if (data.warnings?.length) {
      console.warn('[PAL parse warnings]', data.warnings);
      PALBus.dispatchEvent(new CustomEvent('pal:parse-warning', { detail: { warnings: data.warnings } }));
    }
    PALBus.dispatchEvent(new CustomEvent('pal:scene-loaded', { detail: data }));
    return data;
  } catch (e) {
    PALBus.dispatchEvent(new CustomEvent('pal:error', { detail: { error: e.message } }));
    throw e;
  } finally {
    PALBus.dispatchEvent(new CustomEvent('pal:loading', { detail: { loading: false } }));
  }
}

export async function saveShot(shotData) {
  const res = await fetch('/pal/shots', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    credentials: 'include',
    body: JSON.stringify(shotData),
  });
  if (!res.ok) throw new Error(`Save failed: ${res.status}`);
  const data = await res.json();
  PALBus.dispatchEvent(new CustomEvent('pal:save', { detail: { shotId: shotData.shot_id } }));
  return data;
}

export async function loadShot(shotId) {
  const res = await fetch(`/pal/shots/${shotId}`, {
    headers: authHeaders(),
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`Load failed: ${res.status}`);
  return await res.json();
}

export async function deleteShot(shotId) {
  const res = await fetch(`/pal/shots/${shotId}`, {
    method: 'DELETE',
    headers: authHeaders(),
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
  return await res.json();
}
