/**
 * devtools-ASTeroids — DevTools Registration Entrypoint
 *
 * Registers BOTH:
 * 1. Top-level DevTools Panel ("ASTeroids") — Inspector-style DOM + Scripts explorer with
 *    AST beautification, Hugging Face (`openai/gpt-oss-120b:cheapest`) semantic renaming,
 *    and SourceMap v3 generation + live Debugger injection.
 * 2. Native Inspector Sidebar Pane ("ASTeroids $0") — Inspects and humanizes the currently
 *    selected DOM node (`$0`), its inline handlers, and attached React/Vue component props.
 */

const extApi = typeof browser !== 'undefined' ? browser : chrome;

// 1. Create top-level DevTools panel ("ASTeroids")
// Note: Relative paths work across both Firefox and Chromium when resolved from root devtools.html
try {
  extApi.devtools.panels.create(
    'ASTeroids',
    'icons/icon-32.png',
    'panel/panel.html',
    (panel) => {
      if (panel && panel.onShown) {
        panel.onShown.addListener((panelWindow) => {
          if (panelWindow && typeof panelWindow.onASTeroidsPanelShown === 'function') {
            panelWindow.onASTeroidsPanelShown();
          }
        });
      }
    }
  );
} catch (err) {
  console.error('[ASTeroids] Failed to create main DevTools panel:', err);
}

// 2. Create native Inspector / Elements Sidebar Pane ("ASTeroids $0")
try {
  if (extApi.devtools.panels.elements && extApi.devtools.panels.elements.createSidebarPane) {
    extApi.devtools.panels.elements.createSidebarPane('ASTeroids $0', (sidebar) => {
      if (sidebar && sidebar.setPage) {
        sidebar.setPage('sidebar/sidebar.html');
      }
    });
  }
} catch (err) {
  console.error('[ASTeroids] Failed to create Inspector sidebar pane:', err);
}
