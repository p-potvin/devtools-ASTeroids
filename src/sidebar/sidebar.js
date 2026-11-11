/**
 * devtools-ASTeroids — Native Inspector `$0` Sidebar Controller
 *
 * Tracks `devtools.panels.elements.onSelectionChanged`, extracts the selected DOM node's
 * inline handlers, embedded `<script>` content, and React/Vue component fiber props,
 * and unminifies/humanizes them on click.
 */

import { runASTeroidsPipeline, DEFAULT_HF_CONFIG } from '../engine/index.js';

const extApi = typeof browser !== 'undefined' ? browser : chrome;

const selectedNodeTag = document.getElementById('selected-node-tag');
const statusEl = document.getElementById('sidebar-status');
const codeOutput = document.getElementById('code-output');
const renameList = document.getElementById('rename-list');
const renameCount = document.getElementById('rename-count');
const btnLocalPass = document.getElementById('btn-local-pass');
const btnLlmPass = document.getElementById('btn-llm-pass');
const btnCopySidebar = document.getElementById('btn-copy-sidebar');

let currentRawSnippet = '';

const EVAL_EXTRACT_SELECTED_NODE = `
(function() {
  const el = $0;
  if (!el) return null;
  const tag = el.tagName ? el.tagName.toLowerCase() : 'node';
  const idPart = el.id ? '#' + el.id : '';
  const clsPart = (typeof el.className === 'string' && el.className.trim())
    ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.')
    : '';

  const parts = [];
  parts.push('// Selected DOM Element: <' + tag + idPart + clsPart + '>');

  // 1. If the selected node is a <script>, grab its code directly
  if (tag === 'script' && el.textContent && el.textContent.trim()) {
    parts.push(el.textContent.trim());
  } else {
    // 2. Collect inline event handler attributes (onclick, onsubmit, etc.)
    if (el.attributes) {
      for (let i = 0; i < el.attributes.length; i++) {
        const attr = el.attributes[i];
        if (/^on[a-z]+$/i.test(attr.name) || attr.value.includes('function') || attr.value.includes('=>')) {
          parts.push('function ' + attr.name + '_handler(e) { ' + attr.value + ' }');
        }
      }
    }

    // 3. Inspect React Fiber / Props or Vue instance attached to $0
    const ownKeys = Object.keys(el);
    for (const k of ownKeys) {
      if (k.startsWith('__reactProps$') || k.startsWith('__reactFiber$') || k.startsWith('__vue')) {
        const val = el[k];
        if (val && typeof val === 'object') {
          for (const [propName, propVal] of Object.entries(val)) {
            if (typeof propVal === 'function') {
              parts.push('// Bound prop: ' + propName + '\\nconst ' + propName + ' = ' + propVal.toString() + ';');
            }
          }
        }
      }
    }

    // 4. Include inner <script> tags if any, or formatted outerHTML preview
    const childScripts = el.querySelectorAll ? el.querySelectorAll('script') : [];
    if (childScripts.length > 0) {
      childScripts.forEach((s, idx) => {
        if (s.textContent.trim()) {
          parts.push('// Nested <script #' + (idx + 1) + '>\\n' + s.textContent.trim());
        }
      });
    } else {
      const htmlSnippet = (el.outerHTML || '').slice(0, 2400);
      parts.push('/* OuterHTML Preview:\\n' + htmlSnippet + '\\n*/');
    }
  }

  return {
    label: '<' + tag + idPart + clsPart + '>',
    code: parts.join('\\n\\n')
  };
})()
`;

function inspectCurrentSelection() {
  if (!extApi?.devtools?.inspectedWindow) return;
  extApi.devtools.inspectedWindow.eval(EVAL_EXTRACT_SELECTED_NODE, (result, exceptionInfo) => {
    if (exceptionInfo || !result) {
      selectedNodeTag.textContent = '<none>';
      codeOutput.textContent = '// Select an element in the Inspector tree to extract its scripts & bound functions.';
      return;
    }
    selectedNodeTag.textContent = result.label;
    currentRawSnippet = result.code || '';
    // Automatically run fast local AST formatting (<20ms, no network calls)
    executeSidebarPass('beautify-only');
  });
}

async function executeSidebarPass(mode) {
  if (!currentRawSnippet.trim()) return;
  try {
    const stored = await extApi.storage.local.get(['asteroidsConfig']);
    const hfConfig = { ...DEFAULT_HF_CONFIG, ...(stored?.asteroidsConfig || {}) };

    statusEl.textContent =
      mode === 'llm'
        ? `Running ${hfConfig.model} semantic pass...`
        : 'Running local AST unminifier...';

    const res = await runASTeroidsPipeline(currentRawSnippet, {
      mode,
      sourceName: 'inspector-$0.js',
      hfConfig,
      onProgress: (p) => {
        statusEl.textContent = p.phase;
      }
    });

    codeOutput.textContent = res.code;
    const entries = Object.entries(res.renameMap || {});
    renameCount.textContent = String(entries.length);
    renameList.innerHTML = entries
      .map(
        ([oldName, newName]) =>
          `<div class="rename-row"><span class="old-id">${oldName}</span><span>→</span><span class="new-id">${newName}</span></div>`
      )
      .join('');

    statusEl.textContent =
      mode === 'beautify-only'
        ? `AST formatted (${res.detectedIdentifiers.length} minified identifiers detected). Click "AI Humanize $0" or "Fast AST" to rename.`
        : `Humanized ${entries.length} identifier(s) (${mode.toUpperCase()} mode).`;
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  }
}

btnLocalPass.addEventListener('click', () => executeSidebarPass('local'));
btnLlmPass.addEventListener('click', () => executeSidebarPass('llm'));
btnCopySidebar.addEventListener('click', () => {
  navigator.clipboard.writeText(codeOutput.textContent || '');
  statusEl.textContent = 'Copied humanized $0 snippet to clipboard.';
});

if (extApi?.devtools?.panels?.elements?.onSelectionChanged) {
  extApi.devtools.panels.elements.onSelectionChanged.addListener(inspectCurrentSelection);
}

inspectCurrentSelection();
