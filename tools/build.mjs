// Builds the static site Vercel serves: public/ + shared/ + just the Three.js modules the game imports.
import { cp, rm, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const OUT = 'dist';
const THREE = 'node_modules/three';
await rm(OUT, { recursive: true, force: true });
await cp('public', OUT, { recursive: true, filter: (src) => !src.includes(`${path.sep}_tmp`) });
await cp('shared', path.join(OUT, 'shared'), { recursive: true });

// Copy three.module.min.js plus the example modules we use and everything they import relatively.
const copied = new Set();
async function copyModule(rel) {
  if (copied.has(rel)) return;
  copied.add(rel);
  const src = path.join(THREE, rel);
  const dest = path.join(OUT, 'vendor', 'three', rel);
  await mkdir(path.dirname(dest), { recursive: true });
  await cp(src, dest);
  if (!rel.endsWith('.js')) return;
  const code = await readFile(src, 'utf8');
  for (const [, spec] of code.matchAll(/from\s+['"](\.{1,2}\/[^'"]+)['"]/g)) {
    await copyModule(path.posix.join(path.posix.dirname(rel), spec));
  }
}
await copyModule('build/three.module.min.js');
for (const entry of [
  'examples/jsm/loaders/GLTFLoader.js',
  'examples/jsm/utils/BufferGeometryUtils.js',
  'examples/jsm/utils/SkeletonUtils.js',
  'examples/jsm/postprocessing/EffectComposer.js',
  'examples/jsm/postprocessing/RenderPass.js',
  'examples/jsm/postprocessing/ShaderPass.js',
  'examples/jsm/postprocessing/OutputPass.js',
  'examples/jsm/postprocessing/UnrealBloomPass.js',
]) await copyModule(entry);
console.log(`Built ${OUT}/ with ${copied.size} Three.js modules`);
