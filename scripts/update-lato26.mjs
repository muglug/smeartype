// Copy the Lato26 static TTFs into public/fonts/lato26 from a lato-source checkout.
import { cp, mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const source = resolve(process.argv[2] || '../lato-source/build/Lato26-Desktop/Lato26/TTF');
const fonts = (await readdir(source)).filter(name => /^Lato26-\w+\.ttf$/.test(name));
if (fonts.length !== 18) throw new Error(`Expected 18 Lato26 TTFs in ${source}, found ${fonts.length}.`);
await mkdir('public/fonts/lato26', { recursive: true });
for (const name of fonts) await cp(join(source, name), join('public/fonts/lato26', name));
console.log(`Copied ${fonts.length} fonts from ${source}`);
