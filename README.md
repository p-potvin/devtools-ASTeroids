# devtools-ASTeroids (`ASTeroids`)

**Humanize code right in your browser's DevTools using Performance Enhancing Decompilers, just like your favourite Olympic programmers.**

`devtools-ASTeroids` (**ASTeroids**) is a cross-browser Manifest V3 WebExtension for **Firefox (121+)** and **Chrome/Chromium (121+)** that unminifies, beautifies, and semantically renames obfuscated JavaScript and DOM scripts using a deterministic AST pre-pass paired with Hugging Face Inference Providers (`openai/gpt-oss-120b:cheapest`) and synthetic **Source Map v3** generation.

## Key Features

- **Dual DevTools Integration**:
  1. **`ASTeroids` Top-Level DevTools Tab**: 3-column Inspector & Decompiler workspace featuring a live DOM + Scripts resource tree on the left, multi-view code editor in the center (`Humanized Code`, `Code + Inline SourceMap`, `SourceMap v3 JSON`, `Original Minified`), and an interactive Semantic Rename Map on the right.
  2. **`ASTeroids $0` Native Inspector Sidebar**: Sits directly inside the browser's native **Inspector / Elements** tab. Select any DOM node (`$0`) to extract its inline event handlers, nested scripts, and attached React Fiber (`__reactFiber$`, `__reactProps$`) or Vue component props, and humanize them on click.
- **AST-First + LLM Identifier Mapping Architecture**:
  - **Local AST Pre-Pass (`<50ms`)**: Decodes hex (`\xNN`) and unicode (`\uNNNN`) string literals, normalizes minifier idioms (`!0` → `true`, `!1` → `false`, `void 0` → `undefined`, `!![]` → `true`, `![]` → `false`), formats nested blocks, and extracts scope-bound minified identifiers while preserving standard browser globals and property accesses.
  - **On-Demand Hugging Face Semantic Pass (`Alt+Shift+U`)**: Chunks scopes and queries `https://router.huggingface.co/v1/chat/completions` (`openai/gpt-oss-120b:cheapest`) for a structured JSON identifier map (`{"a": "userId", "b": "sendTelemetry"}`), applying renames safely onto the AST and caching results by SHA-256 hash in `storage.local`.
- **Synthetic SourceMap v3 & Live Debugger Injection**:
  - Generates spec-compliant **Source Map Revision 3** files with Base64 VLQ coordinate mappings and populated `names` arrays.
  - Includes one-click **🗺️ Inject Debugger SourceMap** to inject the humanized script and inline `//# sourceMappingURL=data:application/json;charset=utf-8;base64,...` into the inspected page so native Firefox Debugger and Chrome Sources resolve semantic variable names during live breakpoint debugging.
- **Cross-Browser MV3 Single Codebase**:
  - Uses both `background.scripts` (Firefox event page) and `background.service_worker` (Chromium service worker) alongside `browser_specific_settings.gecko`.
  - Avoids Chrome-only `devtools.inspectedWindow.getResources()` by combining `inspectedWindow.eval` DOM/script collection with `devtools.network.onRequestFinished` and background CORS-free fetching.

## Quick Start & Build Pipeline

```bash
# Run engine & SourceMap v3 verification suite
npm test

# Build unpacked extension into dist/
npm run build

# Automatically bump patch version, sync manifest.json, and package zip into release/
npm run dist
```

Running `npm run dist` automatically increments the patch version in `package.json` and `src/manifest.json`, builds `dist/`, and outputs `release/devtools-asteroids-vX.Y.Z.zip`.

## Loading the Extension

### Firefox
1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on...** and select either `dist/manifest.json` or the packaged `release/devtools-asteroids-vX.Y.Z.zip`.

### Chrome / Edge / Brave
1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select the `dist/` folder (or drag-and-drop the `release/devtools-asteroids-vX.Y.Z.zip` archive).

## Configuring Your Hugging Face Token

1. Click the **ASTeroids** toolbar icon (or click **⚙️ HF Token** inside the DevTools `ASTeroids` tab).
2. Paste your Hugging Face token (`hf_...`) with Inference Providers permission.
3. Keep the default model `openai/gpt-oss-120b:cheapest` (or switch to `:fastest`, `:groq`, `:cerebras`, etc.) and click **Test HF Router** → **Save Settings**.

## License

Mozilla Public License Version 2.0 (`MPL-2.0`) — see [LICENSE](./LICENSE).
