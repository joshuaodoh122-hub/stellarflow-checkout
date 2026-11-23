/**
 * babel.config.js
 *
 * Used ONLY by Jest to transform ESM-only node_modules that
 * @stellar/stellar-sdk@17 depends on. TypeScript source files continue to
 * be handled by ts-jest — Babel is not used for them.
 */
module.exports = {
  presets: [
    ['@babel/preset-env', {
      targets: { node: 'current' },
      // Keep modules: 'auto' so Babel converts ESM export/import to CJS
      modules: 'auto',
    }],
  ],
};
