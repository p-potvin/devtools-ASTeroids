/**
 * devtools-ASTeroids — Spec-Compliant Source Map Revision 3 Generator
 *
 * Implements Base64 VLQ encoding and generates synthetic v3 source maps mapping
 * ASTeroids-beautified & LLM-renamed identifiers back to the original script
 * so Firefox Debugger and Chrome DevTools Sources display semantic variable names
 * in hover tooltips, Scope panels, and call stacks.
 */

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Converts a signed integer to a VLQ (Variable-Length Quantity) signed representation
 * and encodes it as Base64 VLQ characters.
 */
export function encodeVLQ(value) {
  let vlq = value < 0 ? ((-value) << 1) + 1 : (value << 1);
  let encoded = '';
  do {
    let digit = vlq & 0x1f;
    vlq >>>= 5;
    if (vlq > 0) {
      digit |= 0x20; // continuation bit
    }
    encoded += BASE64_CHARS[digit];
  } while (vlq > 0);
  return encoded;
}

/**
 * Generates a Source Map v3 JSON object from ASTeroids token mappings.
 *
 * Each segment in `mappings` encodes up to 5 VLQ fields:
 * 1. Generated column (relative to previous generated column on the same line, reset on each new line)
 * 2. Source file index (relative, always 0 for single-file unminification)
 * 3. Original line (0-indexed, relative to previous original line)
 * 4. Original column (0-indexed, relative to previous original column)
 * 5. Name index in `names` array (relative to previous name index)
 *
 * Note: To make native browser debuggers show the LLM-humanized identifier name
 * when inspecting the original minified file OR when stepping through the unminified code,
 * we populate `names` with the semantic identifier (`newName || originalName`).
 */
export function generateSourceMapV3({
  file = 'asteroids-humanized.js',
  sourceFile = 'original.min.js',
  sourceContent = '',
  mappings = []
}) {
  const names = [];
  const nameToIndex = new Map();

  const getNameIndex = (name) => {
    if (!nameToIndex.has(name)) {
      nameToIndex.set(name, names.length);
      names.push(name);
    }
    return nameToIndex.get(name);
  };

  // Find max generated line
  let maxGenLine = 0;
  for (const m of mappings) {
    if (m.genLine > maxGenLine) maxGenLine = m.genLine;
  }

  // Group mappings by generated line
  const linesBuckets = Array.from({ length: maxGenLine + 1 }, () => []);
  for (const m of mappings) {
    linesBuckets[m.genLine].push(m);
  }

  let prevSourceIdx = 0;
  let prevOrigLine = 0;
  let prevOrigCol = 0;
  let prevNameIdx = 0;

  const encodedLines = [];

  for (let lineIdx = 0; lineIdx <= maxGenLine; lineIdx++) {
    const lineMappings = linesBuckets[lineIdx];
    let prevGenCol = 0;
    const segments = [];

    for (const m of lineMappings) {
      const genColDelta = m.genCol - prevGenCol;
      prevGenCol = m.genCol;

      const sourceIdxDelta = 0 - prevSourceIdx;
      prevSourceIdx = 0;

      const origLineDelta = m.origLine - prevOrigLine;
      prevOrigLine = m.origLine;

      const origColDelta = m.origCol - prevOrigCol;
      prevOrigCol = m.origCol;

      let segment =
        encodeVLQ(genColDelta) +
        encodeVLQ(sourceIdxDelta) +
        encodeVLQ(origLineDelta) +
        encodeVLQ(origColDelta);

      const identifierLabel = m.newName || m.originalName;
      if (identifierLabel) {
        const nameIdx = getNameIndex(identifierLabel);
        const nameIdxDelta = nameIdx - prevNameIdx;
        prevNameIdx = nameIdx;
        segment += encodeVLQ(nameIdxDelta);
      }

      segments.push(segment);
    }

    encodedLines.push(segments.join(','));
  }

  return {
    version: 3,
    file,
    sources: [sourceFile],
    sourcesContent: [sourceContent],
    names,
    mappings: encodedLines.join(';')
  };
}

/**
 * Generates a reverse SourceMap (where the original minified file is the "generated" script
 * running in the page and the ASTeroids humanized code is the mapped `sourcesContent[0]`).
 * When injected into a live script via `//# sourceMappingURL=data:...`, Firefox Debugger and
 * Chrome Sources immediately display the ASTeroids humanized source file and variable names!
 */
export function generateDebuggerOverrideSourceMap({
  minifiedFile = 'bundle.min.js',
  humanizedFile = 'bundle.asteroids.js',
  humanizedContent = '',
  mappings = []
}) {
  const names = [];
  const nameToIndex = new Map();

  const getNameIndex = (name) => {
    if (!nameToIndex.has(name)) {
      nameToIndex.set(name, names.length);
      names.push(name);
    }
    return nameToIndex.get(name);
  };

  let maxMinLine = 0;
  for (const m of mappings) {
    if (m.origLine > maxMinLine) maxMinLine = m.origLine;
  }

  const linesBuckets = Array.from({ length: maxMinLine + 1 }, () => []);
  for (const m of mappings) {
    linesBuckets[m.origLine].push(m);
  }

  let prevSourceIdx = 0;
  let prevHumLine = 0;
  let prevHumCol = 0;
  let prevNameIdx = 0;

  const encodedLines = [];

  for (let lineIdx = 0; lineIdx <= maxMinLine; lineIdx++) {
    const lineMappings = linesBuckets[lineIdx].sort((a, b) => a.origCol - b.origCol);
    let prevMinCol = 0;
    const segments = [];

    for (const m of lineMappings) {
      const minColDelta = m.origCol - prevMinCol;
      prevMinCol = m.origCol;

      const sourceIdxDelta = 0 - prevSourceIdx;
      prevSourceIdx = 0;

      const humLineDelta = m.genLine - prevHumLine;
      prevHumLine = m.genLine;

      const humColDelta = m.genCol - prevHumCol;
      prevHumCol = m.genCol;

      let segment =
        encodeVLQ(minColDelta) +
        encodeVLQ(sourceIdxDelta) +
        encodeVLQ(humLineDelta) +
        encodeVLQ(humColDelta);

      const identifierLabel = m.newName || m.originalName;
      if (identifierLabel) {
        const nameIdx = getNameIndex(identifierLabel);
        const nameIdxDelta = nameIdx - prevNameIdx;
        prevNameIdx = nameIdx;
        segment += encodeVLQ(nameIdxDelta);
      }

      segments.push(segment);
    }

    encodedLines.push(segments.join(','));
  }

  return {
    version: 3,
    file: minifiedFile,
    sources: [`asteroids://${humanizedFile}`],
    sourcesContent: [humanizedContent],
    names,
    mappings: encodedLines.join(';')
  };
}

/**
 * Encodes a UTF-8 string to Base64 across both browser and Node.js environments.
 */
export function utf8ToBase64(str) {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(str, 'utf8').toString('base64');
  }
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Converts a Source Map v3 object into an inline `//# sourceMappingURL=data:...` comment.
 */
export function toInlineSourceMapComment(sourceMapObj) {
  const json = JSON.stringify(sourceMapObj);
  const b64 = utf8ToBase64(json);
  return `//# sourceMappingURL=data:application/json;charset=utf-8;base64,${b64}`;
}

/**
 * Appends an inline Source Map comment to code, replacing any existing `sourceMappingURL`.
 */
export function attachInlineSourceMap(code, sourceMapObj) {
  const cleaned = code.replace(/\/\/[#@]\s*sourceMappingURL=.*$/gm, '').trimEnd();
  return `${cleaned}\n${toInlineSourceMapComment(sourceMapObj)}\n`;
}
