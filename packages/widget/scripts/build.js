const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

const outdir = path.join(__dirname, '../dist');
if (!fs.existsSync(outdir)) fs.mkdirSync(outdir, { recursive: true });

esbuild.build({
  entryPoints: [path.join(__dirname, '../src/widget.js')],
  bundle: true,
  minify: true,
  outfile: path.join(outdir, 'stellarflow-widget.js'),
  format: 'iife',
  globalName: 'StellarFlow',
  platform: 'browser',
  target: ['es2018'],
}).then(() => {
  console.log('Widget built: dist/stellarflow-widget.js');
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
