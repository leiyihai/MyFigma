import {build} from 'esbuild';
import {readFile,writeFile} from 'node:fs/promises';
await build({entryPoints:['src/api.ts'],outfile:'dist/api.mjs',bundle:true,platform:'neutral',format:'esm',target:'es2020'});
await build({entryPoints:['src/main.ts'],outfile:'dist/code.js',bundle:true,format:'iife',target:'es2020'});
const ui = await build({entryPoints:['src/ui.ts'],bundle:true,format:'iife',target:'es2020',write:false});
const html = (await readFile('src/ui.html','utf8')).replace('<!-- SCRIPT -->',()=>'<script>'+ui.outputFiles[0].text.replaceAll('</script','<\\/script')+'</script>');
await writeFile('dist/ui.html',html);
