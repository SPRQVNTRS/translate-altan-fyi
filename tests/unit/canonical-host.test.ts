/**
 * The canonical-host 301, both directions.
 *
 * `server.ts` boots a listener, a database pool and the workflow orchestrator
 * at import, so it is not importable from a unit test. The decision it makes is
 * therefore a pure function, and this file tests that function: host and path
 * in, absolute target or null out.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { canonicalHostRedirect } from '#app/lib/canonical-host';

describe('canonical host redirect', () => {
  it('sends the legacy apex to the canonical apex, keeping path and query', () => {
    const target = canonicalHostRedirect({ host: 'translate.altan.fyi', path: '/?q=Feierabend' });
    assert.equal(target, 'https://kenning.altan.fyi/?q=Feierabend');
  });

  it('leaves a request already on the canonical host alone', () => {
    const target = canonicalHostRedirect({ host: 'kenning.altan.fyi', path: '/?q=Feierabend' });
    assert.equal(target, null);
  });

  it('maps the legacy stage host to the canonical stage host', () => {
    const target = canonicalHostRedirect({ host: 'stage.translate.altan.fyi', path: '/lists' });
    assert.equal(target, 'https://stage.kenning.altan.fyi/lists');
  });

  it('never redirects the health check, on either legacy host', () => {
    assert.equal(canonicalHostRedirect({ host: 'translate.altan.fyi', path: '/healthcheck' }), null);
    assert.equal(canonicalHostRedirect({ host: 'stage.translate.altan.fyi', path: '/healthcheck' }), null);
  });

  it('leaves a development host and a missing host alone', () => {
    assert.equal(canonicalHostRedirect({ host: 'localhost', path: '/' }), null);
    assert.equal(canonicalHostRedirect({ host: undefined, path: '/' }), null);
  });

  it('does not treat a look-alike host as ours', () => {
    // A bare `endsWith` would swap the suffix here and send a stranger's
    // readers to our site.
    assert.equal(canonicalHostRedirect({ host: 'nottranslate.altan.fyi', path: '/' }), null);
  });

  it('reads a host case insensitively, because a Host header carries what the client typed', () => {
    const target = canonicalHostRedirect({ host: 'TRANSLATE.ALTAN.FYI', path: '/history' });
    assert.equal(target, 'https://kenning.altan.fyi/history');
  });
});
