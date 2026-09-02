const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const outdir = path.join(__dirname, '../dist');
if (!fs.existsSync(outdir)) fs.mkdirSync(outdir, { recursive: true });

const outfile = path.join(outdir, 'stellarflow-widget.js');

esbuild.build({
  entryPoints: [path.join(__dirname, '../src/widget.js')],
  bundle: true,
  minify: true,
  outfile,
  format: 'iife',
  globalName: 'StellarFlow',
  platform: 'browser',
  target: ['es2020'],
  // The kit uses Web Components — these are browser globals, not bundleable
  // We bundle everything including the kit's JS but keep DOM APIs as-is
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  // Silence "use client" directives from dependencies
  logOverride: {
    'ignored-bare-import': 'silent',
  },
}).then(() => {
  // Generate SRI hash for the built bundle
  const content = fs.readFileSync(outfile);
  const hash = crypto.createHash('sha384').update(content).digest('base64');
  const sri = `sha384-${hash}`;

  // Write a companion manifest with the SRI hash
  const manifest = {
    file: 'stellarflow-widget.js',
    size: content.length,
    sri,
    builtAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(outdir, 'stellarflow-widget.manifest.json'),
    JSON.stringify(manifest, null, 2),
  );

  console.log('✅ Widget built:', outfile);
  console.log(`   Size: ${(content.length / 1024).toFixed(1)} kB`);
  console.log(`   SRI:  ${sri}`);
  console.log('');
  console.log('Use in your page:');
  console.log(`  <script src="stellarflow-widget.js" integrity="${sri}" crossorigin="anonymous"></script>`);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
