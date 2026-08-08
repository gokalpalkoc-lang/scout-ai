const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

/**
 * Lets the web bundle include `expo-sqlite`'s WebAssembly build.
 *
 * Without this, bundling for web fails outright on
 * `expo-sqlite/web/wa-sqlite/wa-sqlite.wasm`. Android and iOS are unaffected —
 * they use the native driver and never touch this file.
 *
 * Note: SQLite-on-WASM is faster when the page is cross-origin isolated
 * (COOP/COEP, which unlocks SharedArrayBuffer), but it is not required — the
 * dev server serves no such headers and the app runs fine.
 */
config.resolver.assetExts.push('wasm');

module.exports = config;
