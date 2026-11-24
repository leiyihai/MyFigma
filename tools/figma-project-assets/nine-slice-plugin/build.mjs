import { build } from 'esbuild';
import { copyFile, readFile, rm, writeFile } from 'node:fs/promises';

await build({ entryPoints: ['code.ts'], bundle: true, outfile: 'dist/code.js', target: 'es2020' });

// Figma loads one HTML string, so the tested compaction core is bundled and
// injected instead of being loaded as a separate <script src>. This keeps the
// pixel algorithm in one tested TypeScript source for both Node and the UI.
const core = await build({
  entryPoints: ['../packages/nine-slice/src/compact.ts'],
  bundle: true, write: false, format: 'iife', globalName: 'NineSliceCompact', target: 'es2020'
});
const placeholder = '<!--__COMPACT_CORE__-->';
const source = await readFile('ui.html', 'utf8');
if (!source.includes(placeholder)) throw new Error('ui.html is missing the compaction core placeholder');
await writeFile('dist/ui.html', source.replace(placeholder, () => `<script>${core.outputFiles[0].text}</script>`));

// Keep one canonical manifest at the plugin root; stale copies point at the wrong main path.
await rm('dist/manifest.json', { force: true });
// Cache-busted entry points: Figma can keep an old dist/code.js after
// re-importing the same manifest path, even when the plugin name changes.
await copyFile('dist/code.js', 'dist/code-v4.js');
await copyFile('dist/ui.html', 'dist/ui-v4.html');
