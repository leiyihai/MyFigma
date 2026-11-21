import { build } from 'esbuild';
await build({entryPoints:['code.ts'],bundle:true,outfile:'dist/code.js',target:'es2020'});
import {copyFile,rm} from 'node:fs/promises';
// Keep one canonical manifest at the plugin root; stale copies point at the wrong main path.
await rm('dist/manifest.json',{force:true});
await copyFile('ui.html','dist/ui.html');
