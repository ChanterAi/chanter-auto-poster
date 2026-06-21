'use strict';

const config = require('./config');

/**
 * There's no login system in this app yet, so every request is attributed
 * to the same placeholder user. The Firestore schema, the per-user queries
 * in storage.js, and firestore.rules are all already keyed on `userId` —
 * so adding real auth later (Firebase Auth, a session cookie, whatever)
 * means replacing the body of `attachUser` below with something that sets
 * `req.userId` to a verified value, and nothing else in the app changes.
 */
function attachUser(req, res, next) {
  req.userId = config.defaultUserId;
  next();
}

function resolveUserId(req) {
  return (req && req.userId) || config.defaultUserId;
}

function requireUser(req, res, next) {
  if (!req.userId) {
    res.status(401).json({ ok: false, reason: 'Authentication required' });
    return;
  }
  next();
}

module.exports = { attachUser, requireUser, resolveUserId, DEFAULT_USER_ID: config.defaultUserId };
