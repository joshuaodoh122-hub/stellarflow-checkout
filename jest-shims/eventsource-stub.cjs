/**
 * jest-shims/eventsource-stub.cjs
 *
 * Minimal CJS stub for the eventsource package (ESM-only in v4).
 * @stellar/stellar-sdk uses eventsource for Horizon streaming; that code
 * path is not exercised in our Jest tests (all Horizon calls are mocked),
 * so an empty export is sufficient.
 */
'use strict';

class EventSource {
  constructor() { throw new Error('EventSource is not available in test environment'); }
}

module.exports = EventSource;
module.exports.EventSource = EventSource;
module.exports.default = EventSource;
