'use strict';

process.env.ADMIN_PASSWORD = 'test-admin-password-123';
process.env.ADMIN_SESSION_HOURS = '12';
process.env.ENABLE_INSTAGRAM = 'false';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { csrfOriginCheck } = require('../src/auth');

function fakeRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    }
  };
  return res;
}

function run(method, headers) {
  const req = { method, headers: headers || {} };
  const res = fakeRes();
  let nextCalled = false;
  csrfOriginCheck(req, res, () => {
    nextCalled = true;
  });
  return { res, nextCalled };
}

test('csrfOriginCheck lets safe methods through without headers', () => {
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    const { nextCalled, res } = run(method, {});
    assert.equal(nextCalled, true, `${method} should pass`);
    assert.equal(res.statusCode, null);
  }
});

test('csrfOriginCheck allows same-host Origin on POST', () => {
  const { nextCalled } = run('POST', {
    host: 'localhost:3000',
    origin: 'http://localhost:3000'
  });
  assert.equal(nextCalled, true);
});

test('csrfOriginCheck rejects cross-origin POST with 403', () => {
  const { nextCalled, res } = run('POST', {
    host: 'localhost:3000',
    origin: 'https://evil.example.com'
  });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.match(String(res.body), /Origin mismatch/);
});

test('csrfOriginCheck rejects POST with no Origin and no Referer', () => {
  const { nextCalled, res } = run('POST', { host: 'localhost:3000' });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

test('csrfOriginCheck rejects POST missing Host header', () => {
  const { nextCalled, res } = run('POST', {
    origin: 'http://localhost:3000'
  });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

test('csrfOriginCheck falls back to same-host Referer when Origin absent', () => {
  const { nextCalled } = run('POST', {
    host: 'localhost:3000',
    referer: 'http://localhost:3000/private/autoposter'
  });
  assert.equal(nextCalled, true);
});

test('csrfOriginCheck rejects cross-host Referer', () => {
  const { nextCalled, res } = run('POST', {
    host: 'localhost:3000',
    referer: 'https://evil.example.com/attack'
  });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.match(String(res.body), /Referer mismatch/);
});

// Regression lock: the middleware must stay globally mounted in server.js,
// BEFORE the routes, so every state-changing route is covered. server.js
// cannot be required in tests (its start() fails fast without Firebase
// config), so this asserts the wiring statically.
test('csrfOriginCheck is globally wired in server.js before routes', () => {
  const serverSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'server.js'),
    'utf8'
  );

  const mountIndex = serverSource.indexOf('app.use(csrfOriginCheck)');
  assert.notEqual(
    mountIndex,
    -1,
    'server.js must contain app.use(csrfOriginCheck) — global CSRF wiring was removed!'
  );

  const routesIndex = serverSource.indexOf("app.use('/', routes)");
  assert.notEqual(routesIndex, -1, 'server.js should mount routes at app.use(\'/\', routes)');
  assert.ok(
    mountIndex < routesIndex,
    'csrfOriginCheck must be mounted BEFORE the routes so all POST routes are protected'
  );
});
