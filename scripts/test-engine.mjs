#!/usr/bin/env node
/**
 * devtools-ASTeroids — Automated Engine & SourceMap v3 Verification Suite
 */

import assert from 'node:assert/strict';
import {
  runASTeroidsPipeline,
  encodeVLQ
} from '../src/engine/index.js';
import { parseRenameJsonFromLLM } from '../src/engine/hf-client.js';

async function runTests() {
  console.log('Running devtools-ASTeroids engine verification...');

  // 1. Verify VLQ encoding against SourceMap v3 standard values
  assert.equal(encodeVLQ(0), 'A');
  assert.equal(encodeVLQ(1), 'C');
  assert.equal(encodeVLQ(-1), 'D');
  assert.equal(encodeVLQ(16), 'gB');

  // 2. Verify full AST unminification + local heuristic renaming + SourceMap v3 generation
  const sampleMinified = `!function(e,t){const n="\\x68\\x74\\x74\\x70\\x73\\x3a\\x2f\\x2f\\x61\\x70\\x69";function r(a){if(!a)return!1;const o=t.querySelector(a);o.addEventListener("click",(function(c){c.preventDefault();fetch(n).then((function(u){return u.json()}))}));return!0}e.run=r}(window,document);`;

  const result = await runASTeroidsPipeline(sampleMinified, {
    mode: 'local',
    sourceName: 'test.min.js'
  });

  // Check hex string decoding
  assert.ok(result.code.includes('"https://api"'), 'Hex string literal should be decoded');
  // Check boolean idiom normalization
  assert.ok(result.code.includes('return false;') || result.code.includes('return true;'), '!0 and !1 should normalize to true/false');
  // Check heuristic semantic renaming (`c.preventDefault()` -> `domEvent`, `t.querySelector` -> `elementNode`)
  assert.equal(result.renameMap.c, 'domEvent');
  assert.equal(result.renameMap.t, 'elementNode');
  // Check SourceMap v3 structure
  assert.equal(result.sourceMap.version, 3);
  assert.ok(result.sourceMap.names.includes('domEvent'), 'SourceMap v3 names array must include renamed identifiers');
  assert.ok(result.sourceMap.mappings.length > 20, 'SourceMap v3 VLQ mappings must be populated');
  assert.ok(result.inlineSourceMapComment.startsWith('//# sourceMappingURL=data:application/json;charset=utf-8;base64,'));

  // 3. Verify LLM JSON parser handles <think> tags and code fences
  const noisyLLMOutput = `<think>Analyzing scope identifiers...</think>\n\`\`\`json\n{"e": "windowGlobal", "n": "endpointUrl"}\n\`\`\``;
  const parsed = parseRenameJsonFromLLM(noisyLLMOutput);
  assert.deepEqual(parsed, { e: 'windowGlobal', n: 'endpointUrl' });

  console.log('✔ All ASTeroids engine & SourceMap v3 tests passed!');
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
