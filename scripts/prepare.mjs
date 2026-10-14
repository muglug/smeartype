import { mkdir, cp, rm } from 'node:fs/promises';
await mkdir('vendor', { recursive: true });
await cp('node_modules/@zkl2333/freetype-wasm/dist', 'vendor/freetype', { recursive: true });
await cp('node_modules/opentype.js/dist/opentype.mjs', 'vendor/opentype.mjs');
await cp('node_modules/opentype.js/LICENSE', 'vendor/OPENTYPE-LICENSE');
if (process.argv.includes('--build')) {
  await rm('dist', { recursive: true, force: true });
  await mkdir('dist');
  for (const name of ['index.html', 'src', 'public', 'vendor']) await cp(name, `dist/${name}`, { recursive: true });
  console.log('Built self-contained static app in dist/');
}
