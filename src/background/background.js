/**
 * devtools-ASTeroids — Cross-Browser MV3 Background Worker / Event Page
 *
 * Compatible with both:
 * - Firefox MV3 (`background.scripts` event page)
 * - Chrome/Edge MV3 (`background.service_worker`)
 *
 * Responsibilities:
 * 1. Cross-origin script fetching for external `<script src="...">` bundles (bypassing page CORS)
 * 2. Relaying keyboard shortcut commands (`Alt+Shift+U` / `trigger-asteroids`) to open DevTools panels
 * 3. Managing persistent HF configuration and SHA-256 rename cache in `storage.local`
 */

const extApi = typeof browser !== 'undefined' ? browser : chrome;

// Track connected DevTools panel ports by tabId
const panelPorts = new Map();

extApi.runtime.onConnect.addListener((port) => {
  if (port.name !== 'asteroids-devtools') return;
  let boundTabId = null;

  port.onMessage.addListener((msg) => {
    if (msg && msg.type === 'INIT_PANEL' && msg.tabId != null) {
      boundTabId = msg.tabId;
      panelPorts.set(boundTabId, port);
    }
  });

  port.onDisconnect.addListener(() => {
    if (boundTabId != null && panelPorts.get(boundTabId) === port) {
      panelPorts.delete(boundTabId);
    }
  });
});

// Relay keyboard shortcut (`Alt+Shift+U`) to active DevTools panel
if (extApi.commands && extApi.commands.onCommand) {
  extApi.commands.onCommand.addListener(async (command) => {
    if (command !== 'trigger-asteroids') return;
    try {
      const tabs = await extApi.tabs.query({ active: true, currentWindow: true });
      const activeTab = tabs && tabs[0];
      if (activeTab && panelPorts.has(activeTab.id)) {
        panelPorts.get(activeTab.id).postMessage({
          type: 'SHORTCUT_TRIGGER_ASTEROIDS',
          tabId: activeTab.id
        });
      }
    } catch (err) {
      console.warn('[ASTeroids] Failed to relay shortcut command:', err);
    }
  });
}

// Handle cross-origin script fetch requests and HF API proxy calls
extApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;

  if (message.type === 'FETCH_EXTERNAL_SCRIPT') {
    (async () => {
      try {
        const res = await fetch(message.url, { credentials: 'omit', cache: 'force-cache' });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} fetching ${message.url}`);
        }
        const text = await res.text();
        sendResponse({ ok: true, content: text });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true; // keep message channel open for async response
  }

  if (message.type === 'TEST_HF_CONNECTION') {
    (async () => {
      try {
        const { endpoint, model, hfToken } = message.config || {};
        if (!hfToken || !hfToken.trim()) {
          throw new Error('Hugging Face token is empty.');
        }
        const res = await fetch(endpoint || 'https://router.huggingface.co/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${hfToken.trim()}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: model || 'openai/gpt-oss-120b:cheapest',
            max_tokens: 32,
            temperature: 0,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: 'Return JSON only.' },
              { role: 'user', content: 'Rename minified var `e` in `addEventListener("click", e => {})`: {"e": "..."}' }
            ]
          })
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
        }
        const data = await res.json();
        sendResponse({
          ok: true,
          sample: data?.choices?.[0]?.message?.content || '{"status":"ok"}',
          model: data?.model || model
        });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  }

  return false;
});
