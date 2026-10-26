// Stage 1 skeleton entry point, now re-exporting the full application.
// Keeping this file (and its createApp signature) means the Stage 1
// server tests continue to run against the same /health, /ready, 404 and
// security-header behaviour, now implemented in app.js.
export { createApp } from './app.js';
