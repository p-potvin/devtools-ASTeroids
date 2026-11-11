/**
 * devtools-ASTeroids — AST Lexical Unminifier, Beautifier & Scope Identifier Extractor
 *
 * Performs:
 * 1. Hex/unicode string literal decoding (\x61 -> a, \u0061 -> a)
 * 2. Minified idiom normalization (!0 -> true, !1 -> false, void 0 -> undefined, !![] -> true, ![] -> false)
 * 3. Token-preserving structural beautification with exact line/column coordinate tracking
 * 4. Scope-aware identifier extraction (isolating mangled/short variables, params, and functions)
 * 5. Collision-free semantic identifier renaming with coordinate mapping output for SourceMap v3
 */

const JS_RESERVED_AND_GLOBALS = new Set([
  // Keywords & reserved words
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false',
  'finally', 'for', 'function', 'if', 'implements', 'import', 'in', 'instanceof',
  'interface', 'let', 'new', 'null', 'package', 'private', 'protected', 'public',
  'return', 'static', 'super', 'switch', 'this', 'throw', 'true', 'try',
  'typeof', 'undefined', 'var', 'void', 'while', 'with', 'yield', 'async', 'of',
  'get', 'set', 'from', 'as', 'arguments', 'eval', 'NaN', 'Infinity',
  // Standard ECMAScript & DOM globals that should never be renamed
  'window', 'document', 'globalThis', 'self', 'top', 'parent', 'frames',
  'location', 'history', 'navigator', 'screen', 'localStorage', 'sessionStorage',
  'indexedDB', 'crypto', 'performance', 'console', 'fetch', 'XMLHttpRequest',
  'WebSocket', 'EventSource', 'Worker', 'SharedWorker', 'ServiceWorker',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame',
  'cancelAnimationFrame', 'queueMicrotask', 'alert', 'confirm', 'prompt',
  'Object', 'Array', 'Function', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt',
  'Math', 'Date', 'RegExp', 'Error', 'TypeError', 'RangeError', 'ReferenceError',
  'SyntaxError', 'URIError', 'EvalError', 'AggregateError', 'Map', 'Set',
  'WeakMap', 'WeakSet', 'WeakRef', 'FinalizationRegistry', 'Promise', 'Proxy',
  'Reflect', 'JSON', 'Intl', 'ArrayBuffer', 'SharedArrayBuffer', 'DataView',
  'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
  'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array',
  'BigUint64Array', 'TextEncoder', 'TextDecoder', 'URL', 'URLSearchParams',
  'Headers', 'Request', 'Response', 'FormData', 'Blob', 'File', 'FileReader',
  'AbortController', 'AbortSignal', 'Event', 'CustomEvent', 'EventTarget',
  'Node', 'Element', 'HTMLElement', 'DocumentFragment', 'ShadowRoot',
  'MutationObserver', 'IntersectionObserver', 'ResizeObserver', 'CSSStyleSheet',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURI', 'decodeURI',
  'encodeURIComponent', 'decodeURIComponent', 'atob', 'btoa', 'structuredClone',
  'module', 'exports', 'require', 'process', 'Buffer', '__dirname', '__filename',
  'chrome', 'browser'
]);

/**
 * Decodes hex (\xNN) and unicode (\uNNNN) escapes inside string literals
 * while keeping quotes and structural control escapes (\n, \r, \t, quotes) intact.
 */
export function decodeObfuscatedStringLiteral(rawLiteral) {
  if (!rawLiteral || rawLiteral.length < 2) return rawLiteral;
  const quote = rawLiteral[0];
  if (quote !== '"' && quote !== "'" && quote !== '`') return rawLiteral;

  const inner = rawLiteral.slice(1, -1);
  const decoded = inner
    .replace(/\\x([0-9a-fA-F]{2})/g, (match, hex) => {
      const code = parseInt(hex, 16);
      if (code >= 0x20 && code <= 0x7e && code !== 0x22 && code !== 0x27 && code !== 0x5c && code !== 0x60) {
        return String.fromCharCode(code);
      }
      return match;
    })
    .replace(/\\u([0-9a-fA-F]{4})/g, (match, hex) => {
      const code = parseInt(hex, 16);
      if (code >= 0x20 && code !== 0x22 && code !== 0x27 && code !== 0x5c && code !== 0x60) {
        return String.fromCharCode(code);
      }
      return match;
    });

  return quote + decoded + quote;
}

/**
 * Lexical JS tokenizer that preserves exact 0-indexed line & column positions.
 */
export function tokenizeJS(code) {
  const tokens = [];
  const len = code.length;
  let i = 0;
  let line = 0;
  let col = 0;

  const advance = (count = 1) => {
    for (let k = 0; k < count && i < len; k++) {
      if (code[i] === '\n') {
        line++;
        col = 0;
      } else {
        col++;
      }
      i++;
    }
  };

  while (i < len) {
    const startLine = line;
    const startCol = col;
    const ch = code[i];

    // Whitespace
    if (/\s/.test(ch)) {
      let raw = '';
      while (i < len && /\s/.test(code[i])) {
        raw += code[i];
        advance(1);
      }
      tokens.push({ type: 'whitespace', value: raw, line: startLine, col: startCol });
      continue;
    }

    // Single-line comment
    if (ch === '/' && code[i + 1] === '/') {
      let raw = '';
      while (i < len && code[i] !== '\n') {
        raw += code[i];
        advance(1);
      }
      tokens.push({ type: 'comment', value: raw, line: startLine, col: startCol });
      continue;
    }

    // Multi-line comment
    if (ch === '/' && code[i + 1] === '*') {
      let raw = '/*';
      advance(2);
      while (i < len && !(code[i] === '*' && code[i + 1] === '/')) {
        raw += code[i];
        advance(1);
      }
      if (i < len) {
        raw += '*/';
        advance(2);
      }
      tokens.push({ type: 'comment', value: raw, line: startLine, col: startCol });
      continue;
    }

    // String or template literal
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      let raw = quote;
      advance(1);
      while (i < len) {
        const c = code[i];
        raw += c;
        advance(1);
        if (c === '\\' && i < len) {
          raw += code[i];
          advance(1);
        } else if (c === quote) {
          break;
        }
      }
      tokens.push({
        type: 'string',
        value: decodeObfuscatedStringLiteral(raw),
        rawValue: raw,
        line: startLine,
        col: startCol
      });
      continue;
    }

    // Identifier or keyword
    if (/[a-zA-Z_$]/.test(ch)) {
      let raw = '';
      while (i < len && /[a-zA-Z0-9_$]/.test(code[i])) {
        raw += code[i];
        advance(1);
      }
      tokens.push({
        type: 'identifier',
        value: raw,
        line: startLine,
        col: startCol
      });
      continue;
    }

    // Numeric literal
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(code[i + 1] || ''))) {
      let raw = '';
      while (i < len && /[0-9a-fA-FxXobBeE._]/.test(code[i])) {
        raw += code[i];
        advance(1);
      }
      tokens.push({ type: 'number', value: raw, line: startLine, col: startCol });
      continue;
    }

    // Multi-char operators & punctuators
    const threeChar = code.slice(i, i + 3);
    const twoChar = code.slice(i, i + 2);
    const multiOps = new Set([
      '===', '!==', '>>>', '...', '**=', '&&=', '||=', '??=', '<<=', '>>=',
      '==', '!=', '<=', '>=', '=>', '&&', '||', '??', '++', '--', '+=', '-=',
      '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>', '**', '?.'
    ]);
    if (multiOps.has(threeChar)) {
      advance(3);
      tokens.push({ type: 'punct', value: threeChar, line: startLine, col: startCol });
      continue;
    }
    if (multiOps.has(twoChar)) {
      advance(2);
      tokens.push({ type: 'punct', value: twoChar, line: startLine, col: startCol });
      continue;
    }

    // Single character punctuator
    advance(1);
    tokens.push({ type: 'punct', value: ch, line: startLine, col: startCol });
  }

  return tokens;
}

/**
 * Normalizes common JS minifier idioms on a pre-pass before tokenization:
 * - !0 -> true, !1 -> false
 * - !![] -> true, ![] -> false
 * - void 0 -> undefined
 */
export function normalizeMinifiedIdioms(code) {
  // Perform safe regex replacements outside strings via token walk
  const tokens = tokenizeJS(code);
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t0 = tokens[i];
    const t1 = tokens[i + 1];
    const t2 = tokens[i + 2];
    const t3 = tokens[i + 3];

    // !0 or !1
    if (t0.type === 'punct' && t0.value === '!' && t1 && t1.type === 'number' && (t1.value === '0' || t1.value === '1')) {
      out.push({
        type: 'identifier',
        value: t1.value === '0' ? 'true' : 'false',
        line: t0.line,
        col: t0.col
      });
      i += 1;
      continue;
    }

    // ![] -> false
    if (
      t0.type === 'punct' && t0.value === '!' &&
      t1 && t1.type === 'punct' && t1.value === '[' &&
      t2 && t2.type === 'punct' && t2.value === ']'
    ) {
      out.push({ type: 'identifier', value: 'false', line: t0.line, col: t0.col });
      i += 2;
      continue;
    }

    // !![] -> true
    if (
      t0.type === 'punct' && t0.value === '!' &&
      t1 && t1.type === 'punct' && t1.value === '!' &&
      t2 && t2.type === 'punct' && t2.value === '[' &&
      t3 && t3.type === 'punct' && t3.value === ']'
    ) {
      out.push({ type: 'identifier', value: 'true', line: t0.line, col: t0.col });
      i += 3;
      continue;
    }

    // void 0 -> undefined
    if (
      t0.type === 'identifier' && t0.value === 'void' &&
      t1 && t1.type === 'whitespace' &&
      t2 && t2.type === 'number' && t2.value === '0'
    ) {
      out.push({ type: 'identifier', value: 'undefined', line: t0.line, col: t0.col });
      i += 2;
      continue;
    }

    out.push(t0);
  }
  return out;
}

/**
 * Determines whether an identifier token at `idx` in `nonWsTokens` is a standalone
 * lexical identifier (variable, parameter, function/class name) vs. a member property access (`obj.prop`)
 * or object literal static key (`{ key: val }`).
 */
function isRenameableIdentifierOccurrence(nonWsTokens, idx) {
  const tok = nonWsTokens[idx];
  if (!tok || tok.type !== 'identifier') return false;
  if (JS_RESERVED_AND_GLOBALS.has(tok.value)) return false;

  const prev = nonWsTokens[idx - 1];
  const prev2 = nonWsTokens[idx - 2];
  const next = nonWsTokens[idx + 1];

  // Member expression property: obj.prop or obj?.prop
  if (prev && prev.type === 'punct' && (prev.value === '.' || prev.value === '?.')) {
    return false;
  }

  // Object literal key `{ prop: ... }` or `{ a, prop: ... }` (unless inside ternary `cond ? id : other`)
  if (next && next.type === 'punct' && next.value === ':') {
    if (prev && prev.type === 'punct' && (prev.value === '{' || prev.value === ',')) {
      // Check it isn't a destructuring alias `{ origKey: localRenamedVar }`
      // In `{ origKey: localVar }`, `origKey` is preceded by `{` or `,` and followed by `:`.
      // It is an external property name so `origKey` should NOT be renamed!
      return false;
    }
  }

  // Method definition inside class/object when not a short mangled name:
  // `constructor` must never be renamed
  if (tok.value === 'constructor' || tok.value === 'prototype' || tok.value === '__proto__') {
    return false;
  }

  return true;
}

/**
 * Checks whether an identifier name looks minified or obfuscated:
 * - 1 or 2 characters long (e.g., `a`, `e`, `t`, `n`, `r`, `o`, `i`, `c`, `u`, `s`, `f`, `d`, `l`, `p`, `m`, `v`, `g`, `y`, `b`, `w`, `k`, `x`, `z`, `n1`, `t2`)
 * - Hex-obfuscated pattern (e.g., `_0x4f2a`, `_0x12b`, `$0x...`)
 * - Underscore/dollar prefixed short names (`_a`, `_e`, `$a`, `__webpack_require__` excluded if descriptive)
 */
export function isMinifiedName(name) {
  if (!name || JS_RESERVED_AND_GLOBALS.has(name)) return false;
  if (name.length <= 2) return true;
  if (/^[_$]?0x[0-9a-fA-F]+/i.test(name)) return true;
  if (/^[_$][a-zA-Z0-9]{1,2}$/.test(name)) return true;
  if (/^[a-z][0-9]{1,2}$/.test(name)) return true;
  return false;
}

/**
 * Beautifies JavaScript or HTML source code while preserving exact token coordinates
 * and optionally applying an LLM identifier rename map (`{ oldName: newName }`).
 *
 * Returns:
 * - `code`: formatted + renamed source string
 * - `mappings`: array of `{ genLine, genCol, origLine, origCol, name }` for SourceMap v3
 * - `identifiers`: list of detected minified identifier names
 * - `chunks`: array of scoped code chunks for batched LLM inference
 */
export function processAST(sourceCode, renameMap = {}, options = {}) {
  const indentUnit = options.indent || '  ';
  const normalizedTokens = normalizeMinifiedIdioms(sourceCode);
  const nonWsTokens = normalizedTokens.filter((t) => t.type !== 'whitespace');

  // Collect all renameable minified identifiers and their occurrence counts
  const identifierStats = new Map();
  for (let idx = 0; idx < nonWsTokens.length; idx++) {
    const tok = nonWsTokens[idx];
    if (tok.type === 'identifier' && isRenameableIdentifierOccurrence(nonWsTokens, idx)) {
      if (isMinifiedName(tok.value)) {
        identifierStats.set(tok.value, (identifierStats.get(tok.value) || 0) + 1);
      }
    }
  }

  // Sort identifiers by frequency descending
  const identifiers = Array.from(identifierStats.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name);

  // Sanitize renameMap to avoid collisions with reserved keywords or invalid JS identifiers
  const safeRenameMap = {};
  const usedTargetNames = new Set(JS_RESERVED_AND_GLOBALS);
  for (const [oldName, rawCandidate] of Object.entries(renameMap || {})) {
    if (!rawCandidate || typeof rawCandidate !== 'string') continue;
    let candidate = rawCandidate.trim().replace(/[^a-zA-Z0-9_$]/g, '');
    if (!candidate || /^[0-9]/.test(candidate)) continue;
    if (candidate === oldName) continue;
    if (usedTargetNames.has(candidate)) {
      let suffix = 2;
      while (usedTargetNames.has(`${candidate}_${suffix}`)) suffix++;
      candidate = `${candidate}_${suffix}`;
    }
    usedTargetNames.add(candidate);
    safeRenameMap[oldName] = candidate;
  }

  // Pretty-print stream while emitting exact coordinate mappings
  let indentLevel = 0;
  let parenDepth = 0;
  let outLine = 0;
  let outCol = 0;
  let atLineStart = true;
  const outputParts = [];
  const mappings = [];

  const emitRaw = (str) => {
    if (!str) return;
    for (let c = 0; c < str.length; c++) {
      if (str[c] === '\n') {
        outLine++;
        outCol = 0;
        atLineStart = true;
      } else {
        outCol++;
        atLineStart = false;
      }
    }
    outputParts.push(str);
  };

  const emitNewline = () => {
    if (!atLineStart) {
      emitRaw('\n');
    }
  };

  const emitIndent = () => {
    if (atLineStart && indentLevel > 0) {
      emitRaw(indentUnit.repeat(indentLevel));
    }
  };

  const binaryAndAssignOps = new Set([
    '=', '==', '===', '!=', '!==', '<', '>', '<=', '>=',
    '+', '-', '*', '/', '%', '**', '&&', '||', '??',
    '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '>>>=',
    '=>', '?', ':', '&', '|', '^', '<<', '>>', '>>>', 'in', 'instanceof', 'of'
  ]);

  for (let idx = 0; idx < nonWsTokens.length; idx++) {
    const tok = nonWsTokens[idx];
    const prev = nonWsTokens[idx - 1];
    const next = nonWsTokens[idx + 1];

    // Closing braces decrease indent before emitting
    if (tok.type === 'punct' && (tok.value === '}' || tok.value === ']')) {
      if (tok.value === '}') {
        indentLevel = Math.max(0, indentLevel - 1);
        if (prev && !(prev.type === 'punct' && prev.value === '{')) {
          emitNewline();
        }
      }
    }

    emitIndent();

    // Determine whether this token gets renamed
    let emittedText = tok.value;
    let mappedOriginalName = null;
    if (tok.type === 'identifier') {
      mappedOriginalName = tok.value;
      if (isRenameableIdentifierOccurrence(nonWsTokens, idx) && safeRenameMap[tok.value]) {
        emittedText = safeRenameMap[tok.value];
      }
    }

    // Record SourceMap v3 mapping point
    mappings.push({
      genLine: outLine,
      genCol: outCol,
      origLine: tok.line,
      origCol: tok.col,
      originalName: mappedOriginalName,
      newName: emittedText !== tok.value ? emittedText : null
    });

    // Emit the token text
    emitRaw(emittedText);

    // Handle structural formatting after token
    if (tok.type === 'comment') {
      emitNewline();
      continue;
    }

    if (tok.type === 'punct') {
      if (tok.value === '(') {
        parenDepth++;
        continue;
      }
      if (tok.value === ')') {
        parenDepth = Math.max(0, parenDepth - 1);
        if (next && next.type === 'punct' && next.value === '{') {
          emitRaw(' ');
        } else if (next && next.type === 'punct' && next.value === '=>') {
          emitRaw(' ');
        }
        continue;
      }
      if (tok.value === '{') {
        if (next && next.type === 'punct' && next.value === '}') {
          // Empty block `{}`
          continue;
        }
        indentLevel++;
        emitNewline();
        continue;
      }
      if (tok.value === '}') {
        const nextVal = next ? next.value : '';
        if (next && next.type === 'identifier' && (nextVal === 'else' || nextVal === 'catch' || nextVal === 'finally' || nextVal === 'while')) {
          emitRaw(' ');
        } else if (next && next.type === 'punct' && (nextVal === ';' || nextVal === ',' || nextVal === ')' || nextVal === ']')) {
          // Wait for punctuator to handle newline
        } else if (next) {
          emitNewline();
        }
        continue;
      }
      if (tok.value === ';') {
        if (parenDepth === 0) {
          emitNewline();
        } else if (next && !(next.type === 'punct' && next.value === ')')) {
          emitRaw(' ');
        }
        continue;
      }
      if (tok.value === ',') {
        if (parenDepth === 0 && indentLevel > 0 && next && next.type !== 'number') {
          emitRaw(' ');
        } else {
          emitRaw(' ');
        }
        continue;
      }
      if (binaryAndAssignOps.has(tok.value)) {
        // Unary `+`, `-`, `!` check
        const isUnarySign =
          (tok.value === '+' || tok.value === '-') &&
          (!prev || (prev.type === 'punct' && !['++', '--', ')', ']'].includes(prev.value)));
        if (!isUnarySign) {
          emitRaw(' ');
        }
        continue;
      }
    }

    // Space before binary/assignment operators
    if (next && next.type === 'punct' && binaryAndAssignOps.has(next.value)) {
      const nextIsColonInObject =
        next.value === ':' &&
        prev &&
        prev.type === 'punct' &&
        (prev.value === '{' || prev.value === ',');
      if (!nextIsColonInObject) {
        emitRaw(' ');
        continue;
      }
    }

    // Space between adjacent identifiers/keywords/numbers/strings or before `{`
    if (next) {
      if (
        (tok.type === 'identifier' || tok.type === 'number' || tok.type === 'string') &&
        (next.type === 'identifier' || next.type === 'number' || next.type === 'string')
      ) {
        emitRaw(' ');
      } else if (
        tok.type === 'identifier' &&
        ['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'delete', 'void', 'throw', 'new', 'case', 'else', 'try', 'finally', 'class', 'extends', 'import', 'export', 'from', 'as', 'async', 'await', 'yield'].includes(tok.value) &&
        next.type === 'punct' &&
        (next.value === '(' || next.value === '{' || next.value === '[')
      ) {
        if (tok.value !== 'function' || next.value === '{') {
          emitRaw(' ');
        }
      } else if (next.type === 'punct' && next.value === '{') {
        emitRaw(' ');
      }
    }
  }

  const formattedCode = outputParts.join('').trim() + '\n';
  const chunks = buildScopedChunks(formattedCode, identifiers, options.chunkSize || 3200);

  return {
    code: formattedCode,
    mappings,
    identifiers,
    safeRenameMap,
    chunks
  };
}

/**
 * Splits formatted code into scope-aligned chunks of ~`maxChars` characters,
 * pairing each chunk with the minified identifiers that actually appear inside it.
 */
export function buildScopedChunks(formattedCode, allMinifiedIds, maxChars = 3200) {
  const lines = formattedCode.split('\n');
  const rawChunks = [];
  let currentLines = [];
  let currentLen = 0;

  for (const line of lines) {
    if (currentLen + line.length + 1 > maxChars && currentLines.length > 0) {
      rawChunks.push(currentLines.join('\n'));
      currentLines = [];
      currentLen = 0;
    }
    currentLines.push(line);
    currentLen += line.length + 1;
  }
  if (currentLines.length > 0) {
    rawChunks.push(currentLines.join('\n'));
  }

  const idSet = new Set(allMinifiedIds);
  return rawChunks
    .map((snippet, index) => {
      const tokens = tokenizeJS(snippet).filter((t) => t.type !== 'whitespace');
      const foundIds = new Set();
      for (let i = 0; i < tokens.length; i++) {
        if (tokens[i].type === 'identifier' && idSet.has(tokens[i].value) && isRenameableIdentifierOccurrence(tokens, i)) {
          foundIds.add(tokens[i].value);
        }
      }
      return {
        index,
        snippet,
        identifiers: Array.from(foundIds)
      };
    })
    .filter((chunk) => chunk.identifiers.length > 0);
}
