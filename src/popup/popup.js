import { DEFAULT_HF_CONFIG } from '../engine/hf-client.js';

const extApi = typeof browser !== 'undefined' ? browser : chrome;

const form = document.getElementById('settings-form');
const hfTokenInput = document.getElementById('hfToken');
const modelInput = document.getElementById('model');
const endpointInput = document.getElementById('endpoint');
const chunkSizeInput = document.getElementById('chunkSize');
const concurrencyInput = document.getElementById('concurrency');
const toggleTokenBtn = document.getElementById('toggle-token');
const testBtn = document.getElementById('test-btn');
const clearCacheBtn = document.getElementById('clear-cache-btn');
const statusBanner = document.getElementById('status-banner');

function showStatus(text, isError = false) {
  statusBanner.textContent = text;
  statusBanner.className = `status-banner ${isError ? 'err' : 'ok'}`;
}

async function loadSettings() {
  try {
    const stored = await extApi.storage.local.get(['asteroidsConfig']);
    const cfg = { ...DEFAULT_HF_CONFIG, ...(stored?.asteroidsConfig || {}) };
    hfTokenInput.value = cfg.hfToken || '';
    modelInput.value = cfg.model || DEFAULT_HF_CONFIG.model;
    endpointInput.value = cfg.endpoint || DEFAULT_HF_CONFIG.endpoint;
    chunkSizeInput.value = cfg.chunkSize || DEFAULT_HF_CONFIG.chunkSize;
    concurrencyInput.value = cfg.concurrency || DEFAULT_HF_CONFIG.concurrency;
  } catch (err) {
    showStatus(`Failed to load settings: ${err.message}`, true);
  }
}

function readFormConfig() {
  return {
    hfToken: hfTokenInput.value.trim(),
    model: modelInput.value.trim() || DEFAULT_HF_CONFIG.model,
    endpoint: endpointInput.value.trim() || DEFAULT_HF_CONFIG.endpoint,
    chunkSize: Math.max(1000, parseInt(chunkSizeInput.value, 10) || 3200),
    concurrency: Math.max(1, Math.min(8, parseInt(concurrencyInput.value, 10) || 3))
  };
}

toggleTokenBtn.addEventListener('click', () => {
  hfTokenInput.type = hfTokenInput.type === 'password' ? 'text' : 'password';
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const config = readFormConfig();
    await extApi.storage.local.set({ asteroidsConfig: config });
    showStatus('Settings saved to storage.local.');
  } catch (err) {
    showStatus(`Save failed: ${err.message}`, true);
  }
});

testBtn.addEventListener('click', async () => {
  const config = readFormConfig();
  await extApi.storage.local.set({ asteroidsConfig: config });
  showStatus(`Testing ${config.model} via Hugging Face Router...`, false);
  testBtn.disabled = true;

  try {
    const response = await extApi.runtime.sendMessage({
      type: 'TEST_HF_CONNECTION',
      config
    });
    if (response && response.ok) {
      showStatus(`Connected to ${response.model}! Sample output: ${response.sample}`);
    } else {
      showStatus(`Router test failed: ${response?.error || 'Unknown error'}`, true);
    }
  } catch (err) {
    showStatus(`Router test error: ${err.message}`, true);
  } finally {
    testBtn.disabled = false;
  }
});

clearCacheBtn.addEventListener('click', async () => {
  try {
    await extApi.storage.local.remove(['asteroidsCache']);
    showStatus('Cleared cached AST rename maps.');
  } catch (err) {
    showStatus(`Failed to clear cache: ${err.message}`, true);
  }
});

loadSettings();
