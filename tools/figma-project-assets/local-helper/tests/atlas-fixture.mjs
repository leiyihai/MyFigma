import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PNG } from 'pngjs';
import { startHelper } from './fixture.mjs';

// Synthetic project used by #3 scans: a registered game root whose private
// imageset tree is created by each test, so nested paths and odd frames are
// reproducible without the large sample package.
export async function projectFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'atlas-issue3-')));
  const project = join(root, 'project');
  const data = join(root, 'data');
  await mkdir(project);
  await mkdir(data);
  const server = await startHelper(data);
  return {
    root, project, data, ...server,
    async cleanup() { await server.stop(); await rm(root, { recursive: true, force: true }); }
  };
}

export async function writePng(path, width, height, pixels) {
  const png = new PNG({ width, height });
  png.data = Buffer.from(pixels);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, PNG.sync.write(png));
}

export function solid(width, height, [r, g, b, a = 255]) {
  return Array.from({ length: width * height }, () => [r, g, b, a]).flat();
}

// Object-style frames are the only shape the three sample projects use:
// {"frame":{"x","y","w","h"},"offset":{"x","y"},"sourceSize":{"w","h"}}
export async function writeAtlas(path, { image, frames, size = { w: 0, h: 0 }, meta = {} }) {
  const doc = {
    frames: Object.fromEntries(Object.entries(frames).map(([name, frame]) => [name, {
      frame: frame.frame,
      offset: frame.offset ?? { x: 0, y: 0 },
      sourceSize: frame.sourceSize ?? { w: frame.frame.w, h: frame.frame.h },
      ...(frame.rotated === undefined ? {} : { rotated: frame.rotated }),
      ...(frame.trimmed === undefined ? {} : { trimmed: frame.trimmed })
    }])),
    meta: { format: 'RGBA8888', scale: '1', type: 'frame', ...(image === undefined ? {} : { image }), size, ...meta }
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(doc));
}

export async function register(f, id = 'g1008', name = '起床战争') {
  const response = await f.request('/v1/projects', 'PUT', { id, name, path: f.project, maintained: true });
  if (response.status !== 200) throw new Error('registration failed: ' + await response.text());
}

export async function scan(f, projectId = 'g1008') {
  const response = await f.request('/v1/scan', 'POST', { projectId });
  if (response.status !== 200) throw new Error('scan failed: ' + await response.text());
  return response.json();
}

export function decode(pngBase64) {
  const image = PNG.sync.read(Buffer.from(pngBase64, 'base64'));
  return { width: image.width, height: image.height, data: [...image.data] };
}
