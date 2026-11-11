/**
 * devtools-ASTeroids — Main Pipeline Orchestrator
 *
 * Combines:
 * 1. Deterministic AST structural unminification & beautification (`processAST`)
 * 2. Local heuristic or Hugging Face LLM semantic renaming (`openai/gpt-oss-120b:cheapest`)
 * 3. Spec-compliant Source Map v3 & Debugger Override SourceMap generation
 * 4. SHA-256 content-addressed caching
 */

import { processAST } from './ast-unminifier.js';
import {
  encodeVLQ,
  generateSourceMapV3,
  generateDebuggerOverrideSourceMap,
  toInlineSourceMapComment,
  attachInlineSourceMap
} from './sourcemap.js';
import {
  DEFAULT_HF_CONFIG,
  runBatchedSemanticRenames,
  inferHeuristicRenames
} from './hf-client.js';

/**
 * Computes a fast SHA-256 hex digest of a string in browser or Node.js.
 */
export async function sha256Hex(text) {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const buf = new TextEncoder().encode(text);
    const hashBuffer = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Executes the complete ASTeroids pipeline on a JavaScript source string.
 */
export async function runASTeroidsPipeline(sourceCode, options = {}) {
  const mode = options.mode || 'llm';
  const sourceName = options.sourceName || 'bundle.min.js';
  const hfConfig = { ...DEFAULT_HF_CONFIG, ...(options.hfConfig || {}) };
  const onProgress = options.onProgress;

  if (typeof onProgress === 'function') {
    onProgress({ phase: 'Parsing AST & normalizing minified idioms...', percent: 10 });
  }

  // Pass 1: Structural AST unminification & scope chunk extraction
  const initialPass = processAST(sourceCode, {}, { chunkSize: hfConfig.chunkSize || 3200 });

  let renameMap = { ...(options.existingRenameMap || {}) };

  if (mode === 'local') {
    if (typeof onProgress === 'function') {
      onProgress({ phase: 'Inferring local heuristic identifier names...', percent: 55 });
    }
    const heuristicMap = inferHeuristicRenames(initialPass.code, initialPass.identifiers);
    renameMap = { ...heuristicMap, ...renameMap };
  } else if (mode === 'llm' && initialPass.chunks.length > 0) {
    if (typeof onProgress === 'function') {
      onProgress({
        phase: `Querying ${hfConfig.model} across ${initialPass.chunks.length} AST scope chunk(s)...`,
        percent: 20
      });
    }
    const llmMap = await runBatchedSemanticRenames({
      chunks: initialPass.chunks,
      config: hfConfig,
      signal: options.signal,
      onProgress: (p) => {
        if (typeof onProgress === 'function') {
          onProgress({
            phase: `HF Inference (${p.completed}/${p.total} chunks, ${p.resolvedCount} names)...`,
            percent: 20 + Math.round(p.percent * 0.65),
            ...p
          });
        }
      }
    });
    const fallbackMap = inferHeuristicRenames(initialPass.code, initialPass.identifiers);
    renameMap = { ...fallbackMap, ...llmMap, ...renameMap };
  }

  if (typeof onProgress === 'function') {
    onProgress({ phase: 'Applying scope-safe AST renames & generating SourceMap v3...', percent: 90 });
  }

  // Pass 2: Apply semantic renames & emit exact token coordinate mappings
  const finalPass =
    Object.keys(renameMap).length > 0
      ? processAST(sourceCode, renameMap, { chunkSize: hfConfig.chunkSize || 3200 })
      : initialPass;

  const humanizedName = sourceName.replace(/(\.min)?\.js$/i, '') + '.asteroids.js';

  const sourceMap = generateSourceMapV3({
    file: humanizedName,
    sourceFile: sourceName,
    sourceContent: sourceCode,
    mappings: finalPass.mappings
  });

  const debuggerOverrideMap = generateDebuggerOverrideSourceMap({
    minifiedFile: sourceName,
    humanizedFile: humanizedName,
    humanizedContent: finalPass.code,
    mappings: finalPass.mappings
  });

  const inlineSourceMapComment = toInlineSourceMapComment(debuggerOverrideMap);
  const codeWithInlineSourceMap = attachInlineSourceMap(finalPass.code, sourceMap);

  if (typeof onProgress === 'function') {
    onProgress({ phase: 'Complete', percent: 100 });
  }

  return {
    originalCode: sourceCode,
    code: finalPass.code,
    codeWithInlineSourceMap,
    inlineSourceMapComment,
    renameMap: finalPass.safeRenameMap,
    detectedIdentifiers: initialPass.identifiers,
    chunksCount: initialPass.chunks.length,
    sourceMap,
    debuggerOverrideMap
  };
}

export {
  processAST,
  encodeVLQ,
  generateSourceMapV3,
  generateDebuggerOverrideSourceMap,
  toInlineSourceMapComment,
  attachInlineSourceMap,
  DEFAULT_HF_CONFIG,
  runBatchedSemanticRenames,
  inferHeuristicRenames
};
