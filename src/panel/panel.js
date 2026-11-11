/**
 * devtools-ASTeroids — Main DevTools Panel Controller
 *
 * Works across both Firefox and Chromium:
 * - Collects live DOM snapshot, inline `<script>` tags, and external `<script src>` bundles
 *   using `devtools.inspectedWindow.eval` + `devtools.network.onRequestFinished` + background fetch
 *   (avoiding `devtools.inspectedWindow.getResources` which is unsupported in Firefox).
 * - Triggers either instant local AST unminification or Hugging Face (`openai/gpt-oss-120b:cheapest`)
 *   semantic renaming on button click or `Alt+Shift+U` shortcut.
 * - Generates forward and reverse SourceMap v3 payloads and can inject them into the page
 *   for live Firefox/Chrome Debugger breakpoint inspection.
 */

import {
  runASTeroidsPipeline,
  DEFAULT_HF_CONFIG,
  sha256Hex
} from '../engine/index.js';

const extApi = typeof browser !== 'undefined' ? browser : chrome;

// Built-in demo minified script so the panel is immediately testable even on blank tabs
const DEMO_MINIFIED_SCRIPT = `// ASTeroids Demo Bundle (Minified + Hex-Obfuscated Strings + Idioms)
!function(e,t){const n="\\x68\\x74\\x74\\x70\\x73\\x3a\\x2f\\x2f\\x61\\x70\\x69\\x2e\\x65\\x78\\x61\\x6d\\x70\\x6c\\x65\\x2e\\x63\\x6f\\x6d\\x2f\\x76\\x31\\x2f\\x74\\x65\\x6c\\x65\\x6d\\x65\\x74\\x72\\x79";function r(a,o){if(!a||void 0===o)return!1;const i=t.querySelector(a);if(!i)return!1;i.addEventListener("click",(function(c){c.preventDefault();const u={id:o,ts:Date.now(),active:!0,x:c.clientX,y:c.clientY};s(n,u).then((function(d){console.log("Telemetry ACK:",d)})).catch((function(l){console.error("Telemetry Error:",l)}))}));return!0}async function s(f,p){const m=await fetch(f,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(p)});if(!m.ok)throw new Error("HTTP "+m.status);return await m.json()}e.initASTeroidsDemo=r}(window,document);`;

// DOM Elements
const activeModelPill = document.getElementById('active-model-pill');
const btnScanPage = document.getElementById('btn-scan-page');
const btnInspectEl = document.getElementById('btn-Inspect-el');
const btnLocalAst = document.getElementById('btn-local-ast');
const btnLlmRun = document.getElementById('btn-llm-run');
const btnAbort = document.getElementById('btn-abort');
const btnInjectSourcemap = document.getElementById('btn-inject-sourcemap');
const btnSettings = document.getElementById('btn-settings');

const statusMessage = document.getElementById('status-message');
const progressWrap = document.getElementById('progress-wrap');
const progressBar = document.getElementById('progress-bar');
const metricIds = document.getElementById('metric-ids');
const metricChunks = document.getElementById('metric-chunks');
const metricVlq = document.getElementById('metric-vlq');

const resourceCount = document.getElementById('resource-count');
const resourceFilter = document.getElementById('resource-filter');
const resourceList = document.getElementById('resource-list');

const tabButtons = Array.from(document.querySelectorAll('.tab-btn'));
const codeSearch = document.getElementById('code-search');
const btnCopyCode = document.getElementById('btn-copy-code');
const btnDownloadJs = document.getElementById('btn-download-js');
const btnDownloadMap = document.getElementById('btn-download-map');
const lineNumbers = document.getElementById('line-numbers');
const codeEditor = document.getElementById('code-editor');

const renamedCount = document.getElementById('renamed-count');
const renameFilter = document.getElementById('rename-filter');
const btnReapplyMap = document.getElementById('btn-reapply-map');
const renameTableWrap = document.getElementById('rename-table-wrap');

const smFile = document.getElementById('sm-file');
const smNamesCount = document.getElementById('sm-names-count');
const smMappingsLen = document.getElementById('sm-mappings-len');

// Settings Modal Elements
const settingsModal = document.getElementById('settings-modal');
const btnCloseModal = document.getElementById('btn-close-modal');
const modalHfToken = document.getElementById('modal-hf-token');
const modalModel = document.getElementById('modal-model');
const modalEndpoint = document.getElementById('modal-endpoint');
const modalChunkSize = document.getElementById('modal-chunk-size');
const modalConcurrency = document.getElementById('modal-concurrency');
const modalStatus = document.getElementById('modal-status');
const btnModalTest = document.getElementById('btn-modal-test');
const btnModalSave = document.getElementById('btn-modal-save');

// State
let resources = [
  {
    id: 'demo-bundle',
    name: 'asteroids-demo.min.js',
    kind: 'demo',
    size: DEMO_MINIFIED_SCRIPT.length,
    content: DEMO_MINIFIED_SCRIPT
  }
];
let selectedResourceId = 'demo-bundle';
let currentView = 'humanized';
let currentResult = null;
let activeAbortController = null;
let hfConfig = { ...DEFAULT_HF_CONFIG };

// synchronize line numbers with textarea
function updateLineNumbers() {
  const text = codeEditor.value || '';
  const count = text.split('\n').length;
  const nums = [];
  for (let i = 1; i <= count; i++) nums.push(i);
  lineNumbers.textContent = nums.join('\n');
}

codeEditor.addEventListener('scroll', () => {
  lineNumbers.scrollTop = codeEditor.scrollTop;
});
codeEditor.addEventListener('input', updateLineNumbers);

function setStatus(text, percent = null) {
  statusMessage.textContent = text;
  if (percent == null) {
    progressWrap.classList.add('hidden');
  } else {
    progressWrap.classList.remove('hidden');
    progressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  }
}

async function loadStoredConfig() {
  try {
    if (!extApi?.storage?.local) return;
    const data = await extApi.storage.local.get(['asteroidsConfig']);
    if (data?.asteroidsConfig) {
      hfConfig = { ...DEFAULT_HF_CONFIG, ...data.asteroidsConfig };
      activeModelPill.textContent = hfConfig.model;
    }
  } catch (err) {
    console.warn('[ASTeroids] Config load warning:', err);
  }
}

function renderResourceList() {
  const q = (resourceFilter.value || '').toLowerCase().trim();
  const filtered = resources.filter(
    (r) => !q || r.name.toLowerCase().includes(q) || r.kind.toLowerCase().includes(q)
  );
  resourceCount.textContent = String(filtered.length);
  resourceList.innerHTML = filtered
    .map(
      (r) => `
      <li class="resource-item ${r.id === selectedResourceId ? 'active' : ''}" data-id="${r.id}">
        <div class="res-title" title="${r.name}">${r.name}</div>
        <div class="res-meta">
          <span>${r.kind.toUpperCase()}</span>
          <span>${(r.size / 1024).toFixed(1)} KB</span>
        </div>
      </li>
    `
    )
    .join('');

  resourceList.querySelectorAll('.resource-item').forEach((li) => {
    li.addEventListener('click', () => {
      selectResource(li.getAttribute('data-id'));
    });
  });
}

resourceFilter.addEventListener('input', renderResourceList);

async function selectResource(id) {
  const res = resources.find((r) => r.id === id);
  if (!res) return;
  selectedResourceId = id;
  renderResourceList();

  // If external script content hasn't been fetched yet, fetch via background script
  if (!res.content && res.url) {
    setStatus(`Fetching external script ${res.name}...`, 25);
    try {
      const resp = await extApi.runtime.sendMessage({
        type: 'FETCH_EXTERNAL_SCRIPT',
        url: res.url
      });
      if (resp && resp.ok) {
        res.content = resp.content;
        res.size = resp.content.length;
        renderResourceList();
      } else {
        res.content = `// Failed to fetch ${res.url}: ${resp?.error || 'Blocked'}`;
      }
    } catch (err) {
      res.content = `// Error fetching ${res.url}: ${err.message}`;
    }
  }

  // Run instant AST structural pass (no LLM call) so the user immediately sees formatted code
  await runPassOnActiveCode('beautify-only', res.content || '', res.name);
}

/**
 * Scans the inspected window for:
 * 1. Live DOM + inline event handlers summary
 * 2. All inline `<script>` blocks
 * 3. All external `<script src="...">` bundles
 */
function scanInspectedPage() {
  if (!extApi?.devtools?.inspectedWindow) {
    renderResourceList();
    return;
  }

  const evalScript = `
  (function() {
    const items = [];
    // 1. Collect all <script> tags
    const scripts = Array.from(document.querySelectorAll('script'));
    scripts.forEach((s, idx) => {
      if (s.src) {
        items.push({
          id: 'ext-' + idx + '-' + s.src.slice(-24),
          name: s.src.split('/').pop().split('?')[0] || s.src,
          url: s.src,
          kind: 'external-js',
          size: 0,
          content: ''
        });
      } else if (s.textContent && s.textContent.trim()) {
        const text = s.textContent.trim();
        items.push({
          id: 'inline-' + idx,
          name: 'inline-script-' + (idx + 1) + '.js',
          kind: 'inline-js',
          size: text.length,
          content: text
        });
      }
    });

    // 2. Collect Inspector DOM + Inline Handler Snapshot
    const domScripts = [];
    domScripts.push('// Page Title: ' + document.title);
    domScripts.push('// URL: ' + location.href);
    const interactiveEls = Array.from(document.querySelectorAll('[onclick],[onsubmit],[onchange],[oninput],[data-action]'));
    interactiveEls.forEach((el, idx) => {
      const tag = el.tagName.toLowerCase();
      const id = el.id ? '#' + el.id : '';
      Array.from(el.attributes).forEach((attr) => {
        if (attr.name.startsWith('on')) {
          domScripts.push('function dom_' + tag + '_' + idx + '_' + attr.name + '(e) { ' + attr.value + ' }');
        }
      });
    });

    const bodyPreview = (document.body ? document.body.innerHTML : '').slice(0, 6000);
    domScripts.push('/* DOM Body Snapshot:\\n' + bodyPreview.replace(/\\*\\//g, '* /') + '\\n*/');

    const domContent = domScripts.join('\\n\\n');
    items.unshift({
      id: 'dom-snapshot',
      name: 'inspector-dom-snapshot.js',
      kind: 'dom-inspector',
      size: domContent.length,
      content: domContent
    });

    return items;
  })()
  `;

  extApi.devtools.inspectedWindow.eval(evalScript, (result, exceptionInfo) => {
    if (!exceptionInfo && Array.isArray(result) && result.length > 0) {
      resources = [
        ...result,
        {
          id: 'demo-bundle',
          name: 'asteroids-demo.min.js',
          kind: 'demo',
          size: DEMO_MINIFIED_SCRIPT.length,
          content: DEMO_MINIFIED_SCRIPT
        }
      ];
      selectedResourceId = resources[0].id;
      renderResourceList();
      selectResource(selectedResourceId);
      setStatus(`Scanned page: found ${result.length} DOM/Script resource(s).`);
    } else {
      renderResourceList();
    }
  });
}

// Pull currently selected $0 element from native Inspector
btnInspectEl.addEventListener('click', () => {
  if (!extApi?.devtools?.inspectedWindow) return;
  const evalPull0 = `
  (function() {
    const el = $0;
    if (!el) return null;
    const tag = el.tagName ? el.tagName.toLowerCase() : 'node';
    const id = el.id ? '#' + el.id : '';
    const lines = ['// Pulled Inspector $0: <' + tag + id + '>'];
    if (tag === 'script' && el.textContent.trim()) {
      lines.push(el.textContent.trim());
    } else {
      if (el.attributes) {
        Array.from(el.attributes).forEach((attr) => {
          if (attr.name.startsWith('on')) {
            lines.push('function ' + tag + '_' + attr.name + '(e) { ' + attr.value + ' }');
          }
        });
      }
      const scripts = el.querySelectorAll ? Array.from(el.querySelectorAll('script')) : [];
      scripts.forEach((s, i) => {
        if (s.textContent.trim()) lines.push('// Child script #' + (i + 1) + '\\n' + s.textContent.trim());
      });
      lines.push('/* $0 OuterHTML:\\n' + (el.outerHTML || '').slice(0, 4000).replace(/\\*\\//g, '* /') + '\\n*/');
    }
    return {
      name: 'inspector-$0-' + tag + id + '.js',
      content: lines.join('\\n\\n')
    };
  })()
  `;
  extApi.devtools.inspectedWindow.eval(evalPull0, (res) => {
    if (!res) {
      setStatus('No element selected in Inspector ($0 is empty).');
      return;
    }
    const existingIdx = resources.findIndex((r) => r.id === 'inspector-$0');
    const item = {
      id: 'inspector-$0',
      name: res.name,
      kind: '$0-element',
      size: res.content.length,
      content: res.content
    };
    if (existingIdx >= 0) resources[existingIdx] = item;
    else resources.unshift(item);
    selectResource('inspector-$0');
  });
});

async function runPassOnActiveCode(mode, explicitSource = null, explicitName = null) {
  await loadStoredConfig();
  const activeRes = resources.find((r) => r.id === selectedResourceId);
  const rawCode =
    explicitSource !== null
      ? explicitSource
      : currentResult?.originalCode || codeEditor.value || activeRes?.content || DEMO_MINIFIED_SCRIPT;
  const sourceName = explicitName || activeRes?.name || 'script.min.js';

  if (activeAbortController) {
    activeAbortController.abort();
  }
  activeAbortController = new AbortController();

  if (mode === 'llm') {
    btnAbort.classList.remove('hidden');
  }

  try {
    // Check SHA-256 cache in storage.local if running LLM pass
    let cachedMap = null;
    const codeHash = await sha256Hex(`${hfConfig.model}:${rawCode}`);
    if (mode === 'llm' && extApi?.storage?.local) {
      const store = await extApi.storage.local.get(['asteroidsCache']);
      cachedMap = store?.asteroidsCache?.[codeHash] || null;
    }

    const effectiveMode = cachedMap ? 'beautify-only' : mode;
    const result = await runASTeroidsPipeline(rawCode, {
      mode: effectiveMode,
      sourceName,
      hfConfig,
      existingRenameMap: cachedMap || {},
      signal: activeAbortController.signal,
      onProgress: (p) => {
        setStatus(p.phase, p.percent);
      }
    });

    // Save newly resolved LLM renames to cache
    if (mode === 'llm' && !cachedMap && Object.keys(result.renameMap).length > 0 && extApi?.storage?.local) {
      const store = await extApi.storage.local.get(['asteroidsCache']);
      const nextCache = { ...(store?.asteroidsCache || {}), [codeHash]: result.renameMap };
      await extApi.storage.local.set({ asteroidsCache: nextCache });
    }

    currentResult = result;
    updateWorkspaceFromResult(result, mode, Boolean(cachedMap));
  } catch (err) {
    setStatus(`ASTeroids Error: ${err.message}`, null);
  } finally {
    btnAbort.classList.add('hidden');
    activeAbortController = null;
  }
}

function updateWorkspaceFromResult(result, mode, fromCache = false) {
  metricIds.textContent = `${result.detectedIdentifiers.length} minified IDs`;
  metricChunks.textContent = `${result.chunksCount} scope chunk(s)`;
  metricVlq.textContent = `SourceMap v3 (${result.sourceMap.names.length} names)`;

  smFile.textContent = result.sourceMap.file;
  smNamesCount.textContent = `${result.sourceMap.names.length} identifiers`;
  smMappingsLen.textContent = `${result.sourceMap.mappings.length} VLQ chars`;

  renderCurrentEditorView();
  renderRenameTable(result.renameMap);

  const renamedTotal = Object.keys(result.renameMap).length;
  if (mode === 'beautify-only' && !fromCache) {
    setStatus(
      `AST formatted (${result.detectedIdentifiers.length} minified IDs found). Click "⚡ Fast AST Pass" or "✨ AI Humanize (Alt+Shift+U)" to rename.`,
      null
    );
  } else {
    setStatus(
      `Completed ${fromCache ? '(SHA-256 Cache Hit)' : mode.toUpperCase()}: renamed ${renamedTotal} identifier(s) & generated SourceMap v3.`,
      null
    );
  }
}

function renderCurrentEditorView() {
  if (!currentResult) return;
  if (currentView === 'humanized') {
    codeEditor.value = currentResult.code;
  } else if (currentView === 'inline-map') {
    codeEditor.value = currentResult.codeWithInlineSourceMap;
  } else if (currentView === 'sourcemap-json') {
    codeEditor.value = JSON.stringify(currentResult.sourceMap, null, 2);
  } else if (currentView === 'original') {
    codeEditor.value = currentResult.originalCode;
  }
  updateLineNumbers();
}

tabButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    tabButtons.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentView = btn.getAttribute('data-view');
    renderCurrentEditorView();
  });
});

function renderRenameTable(renameMap = {}) {
  const q = (renameFilter.value || '').toLowerCase().trim();
  const entries = Object.entries(renameMap).filter(
    ([oldId, newId]) => !q || oldId.toLowerCase().includes(q) || newId.toLowerCase().includes(q)
  );
  renamedCount.textContent = String(Object.keys(renameMap).length);

  if (entries.length === 0) {
    renameTableWrap.innerHTML = `<div class="empty-hint">No renamed identifiers match filter. Click <strong>⚡ Fast AST Pass</strong> or <strong>✨ AI Humanize</strong>.</div>`;
    return;
  }

  renameTableWrap.innerHTML = entries
    .map(
      ([oldId, newId]) => `
      <div class="rename-entry">
        <span class="rename-old" title="${oldId}">${oldId}</span>
        <span class="rename-arrow">→</span>
        <input type="text" class="rename-input" data-old="${oldId}" value="${newId}" spellcheck="false" />
      </div>
    `
    )
    .join('');
}

renameFilter.addEventListener('input', () => {
  if (currentResult) renderRenameTable(currentResult.renameMap);
});

// Allow manual tweaking of any identifier name and instant AST + SourceMap regeneration
btnReapplyMap.addEventListener('click', async () => {
  if (!currentResult) return;
  const customMap = { ...currentResult.renameMap };
  renameTableWrap.querySelectorAll('.rename-input').forEach((input) => {
    const oldId = input.getAttribute('data-old');
    const newId = input.value.trim();
    if (oldId && newId) customMap[oldId] = newId;
  });

  const activeRes = resources.find((r) => r.id === selectedResourceId);
  const updated = await runASTeroidsPipeline(currentResult.originalCode, {
    mode: 'beautify-only',
    sourceName: activeRes?.name || 'script.min.js',
    existingRenameMap: customMap
  });
  currentResult = updated;
  updateWorkspaceFromResult(updated, 'custom-map');
});

// Inject reverse Debugger Override SourceMap into the inspected page
btnInjectSourcemap.addEventListener('click', () => {
  if (!currentResult) return;
  if (!extApi?.devtools?.inspectedWindow) {
    navigator.clipboard.writeText(currentResult.inlineSourceMapComment);
    setStatus('Copied inline SourceMap v3 comment to clipboard.');
    return;
  }

  const payloadCode = JSON.stringify(currentResult.codeWithInlineSourceMap);
  const injectExpr = `
  (function() {
    const s = document.createElement('script');
    s.type = 'text/javascript';
    s.setAttribute('data-asteroids-sourcemap', 'true');
    s.textContent = ${payloadCode};
    document.head.appendChild(s);
    return true;
  })()
  `;
  extApi.devtools.inspectedWindow.eval(injectExpr, (_res, err) => {
    if (err) {
      navigator.clipboard.writeText(currentResult.inlineSourceMapComment);
      setStatus('Page CSP blocked live tag injection; copied inline SourceMap v3 URL to clipboard.');
    } else {
      setStatus('Injected humanized script + inline SourceMap v3 into page! Open Debugger tab to set breakpoints.');
    }
  });
});

// Toolbar buttons
btnScanPage.addEventListener('click', scanInspectedPage);
btnLocalAst.addEventListener('click', () => runPassOnActiveCode('local'));
btnLlmRun.addEventListener('click', () => runPassOnActiveCode('llm'));
btnAbort.addEventListener('click', () => {
  if (activeAbortController) activeAbortController.abort();
});

// Keyboard shortcut inside panel (`Alt+Shift+U`)
window.addEventListener('keydown', (e) => {
  if (e.altKey && e.shiftKey && e.key.toLowerCase() === 'u') {
    e.preventDefault();
    runPassOnActiveCode('llm');
  }
});

// Search in code editor
codeSearch.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const query = codeSearch.value;
    if (!query) return;
    const text = codeEditor.value;
    const nextIdx = text.toLowerCase().indexOf(query.toLowerCase(), codeEditor.selectionEnd);
    const matchIdx = nextIdx !== -1 ? nextIdx : text.toLowerCase().indexOf(query.toLowerCase());
    if (matchIdx !== -1) {
      codeEditor.focus();
      codeEditor.setSelectionRange(matchIdx, matchIdx + query.length);
    }
  }
});

// Copy & Download buttons
btnCopyCode.addEventListener('click', () => {
  navigator.clipboard.writeText(codeEditor.value || '');
  setStatus('Copied active editor buffer to clipboard.');
});

function downloadBlob(filename, content, mime = 'text/javascript') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

btnDownloadJs.addEventListener('click', () => {
  if (!currentResult) return;
  downloadBlob(currentResult.sourceMap.file, currentResult.codeWithInlineSourceMap);
});

btnDownloadMap.addEventListener('click', () => {
  if (!currentResult) return;
  downloadBlob(`${currentResult.sourceMap.file}.map`, JSON.stringify(currentResult.sourceMap, null, 2), 'application/json');
});

// In-Panel Settings Modal
btnSettings.addEventListener('click', async () => {
  await loadStoredConfig();
  modalHfToken.value = hfConfig.hfToken || '';
  modalModel.value = hfConfig.model || DEFAULT_HF_CONFIG.model;
  modalEndpoint.value = hfConfig.endpoint || DEFAULT_HF_CONFIG.endpoint;
  modalChunkSize.value = hfConfig.chunkSize || 3200;
  modalConcurrency.value = hfConfig.concurrency || 3;
  modalStatus.textContent = '';
  settingsModal.classList.remove('hidden');
});

btnCloseModal.addEventListener('click', () => {
  settingsModal.classList.add('hidden');
});

btnModalSave.addEventListener('click', async () => {
  hfConfig = {
    hfToken: modalHfToken.value.trim(),
    model: modalModel.value.trim() || DEFAULT_HF_CONFIG.model,
    endpoint: modalEndpoint.value.trim() || DEFAULT_HF_CONFIG.endpoint,
    chunkSize: Math.max(1000, parseInt(modalChunkSize.value, 10) || 3200),
    concurrency: Math.max(1, Math.min(8, parseInt(modalConcurrency.value, 10) || 3))
  };
  activeModelPill.textContent = hfConfig.model;
  if (extApi?.storage?.local) {
    await extApi.storage.local.set({ asteroidsConfig: hfConfig });
  }
  modalStatus.textContent = 'Saved configuration!';
  setTimeout(() => settingsModal.classList.add('hidden'), 500);
});

btnModalTest.addEventListener('click', async () => {
  modalStatus.textContent = 'Testing connection to Hugging Face Router...';
  const testConfig = {
    hfToken: modalHfToken.value.trim(),
    model: modalModel.value.trim() || DEFAULT_HF_CONFIG.model,
    endpoint: modalEndpoint.value.trim() || DEFAULT_HF_CONFIG.endpoint
  };
  try {
    const resp = await extApi.runtime.sendMessage({
      type: 'TEST_HF_CONNECTION',
      config: testConfig
    });
    if (resp && resp.ok) {
      modalStatus.textContent = `Success (${resp.model}): ${resp.sample}`;
    } else {
      modalStatus.textContent = `Error: ${resp?.error || 'Connection failed'}`;
    }
  } catch (err) {
    modalStatus.textContent = `Error: ${err.message}`;
  }
});

// Connect to background script for global shortcut relay (`Alt+Shift+U`)
try {
  if (extApi?.runtime?.connect && extApi?.devtools?.inspectedWindow) {
    const port = extApi.runtime.connect({ name: 'asteroids-devtools' });
    port.postMessage({
      type: 'INIT_PANEL',
      tabId: extApi.devtools.inspectedWindow.tabId
    });
    port.onMessage.addListener((msg) => {
      if (msg && msg.type === 'SHORTCUT_TRIGGER_ASTEROIDS') {
        runPassOnActiveCode('llm');
      }
    });
  }
} catch (_err) {
  // Ignore when previewed outside DevTools context
}

// Listen for dynamically loaded scripts via devtools.network
try {
  if (extApi?.devtools?.network?.onRequestFinished) {
    extApi.devtools.network.onRequestFinished.addListener((req) => {
      const url = req?.request?.url || '';
      const mime = req?.response?.content?.mimeType || '';
      if ((url.endsWith('.js') || mime.includes('javascript')) && !url.startsWith('moz-extension') && !url.startsWith('chrome-extension')) {
        const shortName = url.split('/').pop().split('?')[0] || url;
        const id = `net-${shortName}-${resources.length}`;
        if (!resources.some((r) => r.url === url)) {
          resources.push({
            id,
            name: shortName,
            url,
            kind: 'network-js',
            size: req?.response?.bodySize || 0,
            content: ''
          });
          renderResourceList();
        }
      }
    });
  }
} catch (_err) {
  // Ignore if network API unavailable
}

// Initialize panel
(async function initPanel() {
  await loadStoredConfig();
  renderResourceList();
  await selectResource('demo-bundle');
  scanInspectedPage();
})();
