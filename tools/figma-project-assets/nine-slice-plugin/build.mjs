import { build } from 'esbuild';
await build({entryPoints:['code.ts'],bundle:true,outfile:'dist/code.js',target:'es2020'});
import {copyFile,rm} from 'node:fs/promises';
// Keep one canonical manifest at the plugin root; stale copies point at the wrong main path.
await rm('dist/manifest.json',{force:true});
await copyFile('ui.html','dist/ui.html');
// Cache-busted entry points: Figma can keep an old dist/code.js after
// re-importing the same manifest path, even when the plugin name changes.
await copyFile('dist/code.js','dist/code-v3.js');
await copyFile('dist/ui.html','dist/ui-v3.html');
