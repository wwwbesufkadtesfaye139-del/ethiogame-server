/**
 * instrument.js — Sentry bootstrap for the game server.
 *
 * MUST be the very first `require` in index.js, before express, mongoose,
 * socket.io, or anything else. Sentry's Node SDK patches those modules as
 * they're loaded, so initializing after they're already imported means
 * losing their automatic instrumentation.
 *
 * Phase 0 of the architecture overhaul: this file only adds visibility.
 * It does not change any game, wallet, or socket behavior.
 */

require('dotenv').config();
const Sentry = require('@sentry/node');

const SENTRY_DSN = process.env.SENTRY_DSN;

if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    // Railway can inject the git commit SHA — ties an error to the exact
    // deploy that shipped it. Falls back cleanly if it's not set.
    release: process.env.RAILWAY_GIT_COMMIT_SHA || undefined,

    // This server holds live room/turn state for real-money games — keep
    // the SDK's own overhead minimal rather than adding tracing/profiling
    // here. That's a separate, deliberate decision for a later phase.
    tracesSampleRate: 0,
  });
  console.log('[Sentry] Server error reporting enabled.');
} else {
  console.warn('[Sentry] SENTRY_DSN not set — server error reporting disabled.');
}

module.exports = Sentry;
