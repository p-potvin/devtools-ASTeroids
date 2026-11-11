/**
 * devtools-ASTeroids — Hugging Face Inference Providers Client
 *
 * Targets `https://router.huggingface.co/v1/chat/completions` using the default model
 * `openai/gpt-oss-120b:cheapest` to produce semantic identifier rename maps.
 * Supports concurrent scope batching, deterministic fallback heuristics when offline/no-token,
 * and SHA-256 content-addressed caching.
 */

export const DEFAULT_HF_CONFIG = {
  endpoint: 'https://router.huggingface.co/v1/chat/completions',
  model: 'openai/gpt-oss-120b:cheapest',
  hfToken: '',
  concurrency: 3,
  chunkSize: 3200,
  temperature: 0.1
};

const SYSTEM_PROMPT = `You are ASTeroids, an expert JavaScript reverse-engineering and AST deobfuscation engine.
Given a JavaScript code snippet and a list of minified/obfuscated identifier names, infer the clearest, most accurate semantic camelCase name for each identifier based on its operations, DOM interactions, API calls, and control flow.
Rules:
1. Return ONLY a valid JSON object mapping each original minified identifier key to its new camelCase identifier string: {"e": "clickEvent", "t": "targetElement", "_0x1a": "authHeaders"}.
2. Every value MUST be a valid JavaScript identifier (camelCase or PascalCase for classes/components), never a reserved keyword.
3. Do NOT wrap the JSON in markdown fences or include prose explanations.`;

/**
 * Extracts a JSON object from an LLM response string even if the provider
 * wraps it in `<think>...</think>` tags or markdown code fences.
 */
export function parseRenameJsonFromLLM(rawText) {
  if (!rawText || typeof rawText !== 'string') return {};
  // Strip <think>...</think> reasoning blocks if emitted by reasoning models
  let cleaned = rawText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  // Strip markdown code fences if present
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch (_) {
    // Fallback: locate first `{...}` block
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch (_err) {
        return {};
      }
    }
  }
  return {};
}

/**
 * Requests a semantic rename map for a single scoped code chunk from Hugging Face Router.
 */
export async function requestChunkRenames({
  snippet,
  identifiers,
  config = DEFAULT_HF_CONFIG,
  signal
}) {
  if (!identifiers || identifiers.length === 0) return {};

  const mergedConfig = { ...DEFAULT_HF_CONFIG, ...config };
  if (!mergedConfig.hfToken || !mergedConfig.hfToken.trim()) {
    throw new Error(
      'Missing Hugging Face API token. Open the ASTeroids extension popup or Settings modal to add your hf_... token.'
    );
  }

  const userPrompt = [
    `Identifiers to rename (${identifiers.length}): ${JSON.stringify(identifiers)}`,
    '',
    'Code context:',
    '```javascript',
    snippet,
    '```',
    '',
    'Respond with ONLY the JSON object mapping each identifier above to its semantic camelCase name.'
  ].join('\n');

  const response = await fetch(mergedConfig.endpoint, {
    method: 'POST',
    signal,
    headers: {
      'Authorization': `Bearer ${mergedConfig.hfToken.trim()}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: mergedConfig.model || DEFAULT_HF_CONFIG.model,
      temperature: mergedConfig.temperature ?? 0.1,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt }
      ]
    })
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`Hugging Face Router HTTP ${response.status}: ${errBody.slice(0, 280)}`);
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content || '{}';
  return parseRenameJsonFromLLM(content);
}

/**
 * Runs batched, concurrent LLM inference across all scoped chunks of a script,
 * merging the resulting identifier rename maps and reporting progress via `onProgress`.
 */
export async function runBatchedSemanticRenames({
  chunks,
  config = DEFAULT_HF_CONFIG,
  onProgress,
  signal
}) {
  const mergedConfig = { ...DEFAULT_HF_CONFIG, ...config };
  const totalChunks = chunks.length;
  if (totalChunks === 0) return {};

  const combinedMap = {};
  let completed = 0;
  const concurrency = Math.max(1, Math.min(8, Number(mergedConfig.concurrency) || 3));
  let cursor = 0;

  const worker = async () => {
    while (cursor < totalChunks) {
      if (signal?.aborted) throw new Error('ASTeroids inference aborted by user.');
      const currentIdx = cursor++;
      const chunk = chunks[currentIdx];

      // Filter out identifiers already resolved by an earlier chunk
      const unresolvedIds = chunk.identifiers.filter((id) => !combinedMap[id]);
      if (unresolvedIds.length > 0) {
        const chunkMap = await requestChunkRenames({
          snippet: chunk.snippet,
          identifiers: unresolvedIds,
          config: mergedConfig,
          signal
        });
        for (const [oldId, newId] of Object.entries(chunkMap)) {
          if (unresolvedIds.includes(oldId) && typeof newId === 'string' && newId.trim()) {
            combinedMap[oldId] = newId.trim();
          }
        }
      }

      completed++;
      if (typeof onProgress === 'function') {
        onProgress({
          completed,
          total: totalChunks,
          percent: Math.round((completed / totalChunks) * 100),
          resolvedCount: Object.keys(combinedMap).length
        });
      }
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, totalChunks) }, () => worker());
  await Promise.all(workers);
  return combinedMap;
}

/**
 * Local heuristic semantic inferrer used when the user clicks "Instant Local AST Pass"
 * (or for testing before entering an HF token). Inspects adjacent DOM/fetch/event patterns
 * to suggest meaningful names in <20ms without network calls.
 */
export function inferHeuristicRenames(code, identifiers) {
  const map = {};
  const used = new Set();

  const pickUnique = (base) => {
    let candidate = base;
    let n = 2;
    while (used.has(candidate)) {
      candidate = `${base}${n++}`;
    }
    used.add(candidate);
    return candidate;
  };

  for (const id of identifiers) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    if (new RegExp(`\\b${escaped}\\.(?:preventDefault|stopPropagation|target|currentTarget|keyCode|clientX)\\b`).test(code)) {
      map[id] = pickUnique('domEvent');
    } else if (new RegExp(`\\b${escaped}\\.(?:querySelector|getElementById|appendChild|classList|style|setAttribute|addEventListener)\\b`).test(code)) {
      map[id] = pickUnique('elementNode');
    } else if (new RegExp(`\\b(?:fetch|axios)\\s*\\(\\s*${escaped}\\b`).test(code)) {
      map[id] = pickUnique('requestUrl');
    } else if (new RegExp(`\\b${escaped}\\.(?:json|text|status|ok|headers)\\b`).test(code)) {
      map[id] = pickUnique('httpResponse');
    } else if (new RegExp(`\\bcatch\\s*\\(\\s*${escaped}\\s*\\)`).test(code)) {
      map[id] = pickUnique('caughtError');
    } else if (new RegExp(`\\bfor\\s*\\(\\s*(?:let|var|const)?\\s*${escaped}\\s*=\\s*0\\b`).test(code)) {
      map[id] = pickUnique('loopIndex');
    } else if (new RegExp(`\\b${escaped}\\.(?:map|filter|reduce|forEach|push|slice|length)\\b`).test(code)) {
      map[id] = pickUnique('itemsList');
    } else if (new RegExp(`\\bJSON\\.stringify\\(\\s*${escaped}\\s*\\)`).test(code)) {
      map[id] = pickUnique('payloadData');
    } else if (/^_0x/i.test(id)) {
      map[id] = pickUnique(`deobfVar_${id.slice(-3)}`);
    }
  }

  return map;
}
