// Ambient declarations for the WebExtension globals the extension scripts
// rely on. Intentionally `any`-typed: this gate (scripts/tsconfig.extension.json)
// exists to catch cross-file global redeclarations and structural JS errors
// (see bead archive-ph-safari-plugin-umg / bug 9k9), not to provide full
// WebExtension API typings.
declare var browser: any;
declare var chrome: any;
declare var importScripts: ((...urls: string[]) => void) | undefined;

// extension/archive-url.js assigns this via `globalThis.ArchiveUrl = {...}`
// inside an IIFE (see the file-level comment there for why); background.js,
// settings.js, and snapshot-probe.js all reference it as an ambient global
// rather than importing it (no module system -- see bead 9k9). Declared
// `any` here so this gate can see the name across files without needing
// full typings for its shape.
declare var ArchiveUrl: any;
