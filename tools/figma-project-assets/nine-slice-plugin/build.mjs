import { build } from 'esbuild';
await build({entryPoints:['code.ts'],bundle:true,outfile:'dist/code.js',target:'es2020'});
import {copyFile} from 'node:fs/promises';
await Promise.all(['ui.html','manifest.json'].map(file=>copyFile(file,`dist/${file}`)));
