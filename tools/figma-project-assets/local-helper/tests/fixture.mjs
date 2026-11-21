import { mkdtemp, mkdir, readFile, rm, realpath, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
export const helperDir = fileURLToPath(new URL('../', import.meta.url));
export async function startHelper(dataDir) {
  const child = spawn(resolve(helperDir, 'target/debug/figma-assets-helper' + (process.platform === 'win32' ? '.exe' : '')), ['--data-dir', dataDir, '--port', '0'], {stdio:['ignore','pipe','pipe']});
  const port = await new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('helper startup timeout')); }, 10000);
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('helper exited: '+code)); });
    child.stdout.on('data', chunk => { text += chunk; const m = text.match(/LISTEN (\d+)/); if (m) { clearTimeout(timer); resolve(Number(m[1])); } });
  });
  const token = (await readFile(join(dataDir, 'token'), 'utf8')).trim();
  const base = 'http://127.0.0.1:'+port;
  return {base, token, child, async stop() { if(child.exitCode !== null || child.signalCode !== null) return; const done = new Promise(r=>child.once('exit',r)); child.kill(); await done; },
    async request(path, method='GET', body, headers={}) {
      return fetch(base+path, {method, headers:{Authorization:'Bearer '+token, ...(body ? {'Content-Type':'application/json'} : {}), ...headers}, body:body ? JSON.stringify(body):undefined});
    }};
}
export async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(),'atlas-issue2-')));
  const project = join(root,'project'), data = join(root,'data');
  await mkdir(project); await mkdir(data);
  await copyFile(join(helperDir,'examples/tiny.png'),join(project,'tiny.png'));
  await copyFile(join(helperDir,'examples/tiny.json'),join(project,'tiny.json'));
  const server = await startHelper(data);
  return {root,project,data,...server, async cleanup() {await server.stop(); await rm(root,{recursive:true,force:true});}};
}
