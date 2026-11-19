// Generates the security-print tile (public/security/band.svg), deterministically.
//   node scripts/make-security-print.mjs
// Flat, like real cheque security print: three families of interlaced sine curves
// of the same frequency, a third of a cycle apart, constant line weight, regular
// repeat. No modulation, no perspective, no density changes. The file is a MASK
// tile (black strokes): CSS paints it with each person's tint and repeats it at a
// fixed size, so the line weight never scales with the header.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'security', 'band.svg');
const W = 160; // two periods per tile: tiles seamlessly left to right
const H = 40; // eight line spacings per tile: tiles seamlessly top to bottom
const PERIOD = 80;
const SPACING = 5;
const AMPLITUDE = 4;
const STROKE = 0.6;

const f = (n) => n.toFixed(1);
const paths = [];
for (const phase of [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3]) {
  // One line per spacing, plus one beyond each edge so the tile's border is covered.
  for (let j = -1; j <= H / SPACING + 1; j++) {
    const pts = [];
    for (let x = 0; x <= W; x += 2) pts.push(`${f(x)} ${f(j * SPACING + AMPLITUDE * Math.sin((2 * Math.PI * x) / PERIOD + phase))}`);
    paths.push(`<path d="M${pts.join('L')}"/>`);
  }
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" fill="none" stroke="#000" stroke-width="${STROKE}">${paths.join('')}</svg>\n`;
writeFileSync(OUT, svg);
console.log(`band.svg ${(svg.length / 1024).toFixed(1)} KB, ${paths.length} curves`);
