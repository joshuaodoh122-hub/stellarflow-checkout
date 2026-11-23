test('transforms uint8array-extras ESM', () => {
  const {isUint8Array} = require('uint8array-extras');
  expect(isUint8Array(new Uint8Array(0))).toBe(true);
});
