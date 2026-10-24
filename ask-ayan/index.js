#!/usr/bin/env node
'use strict';

/**
 * ASK-Ayan entry point: config validation, logging with redaction, transport
 * adapters (console + Meta Messenger Platform webhook), supervisor
 * (connect/reconnect/auth-health/shutdown) and the built-in self-test.
 *
 *   node index.js              start with config.json
 *   node index.js --console    force the local console adapter
 *   node index.js --self-test  run built-in tests (mock adapter, no network)
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { EventEmitter } = require('node:events');
const {
  MSG, TransportError, AuthGuard, isAuthKind, backoffDelay, sleep, makeTimeFormatter, createCommandHandler,
} = require('./core/handleCommand');

/* ============================== Configuration ============================== */
class ConfigError extends Error {
  constructor(errors) {
    super('Invalid configuration:\n - ' + errors.join('\n - '));
    this.name = 'ConfigError';
    this.errors = errors;
  }
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const SECRET_KEY_RE = /(token|secret|password|passwd|cookie|appstate|apikey|api_key|credential)/i;

function scanConfig(value, trail, errors, depth = 0) {
  if (depth > 6) { errors.push(`${trail}: nested too deeply`); return; }
  if (Array.isArray(value)) { value.forEach((v, i) => scanConfig(v, `${trail}[${i}]`, errors, depth + 1)); return; }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_KEYS.has(key)) errors.push(`${trail}.${key}: forbidden key`);
      else if (SECRET_KEY_RE.test(key) && typeof value[key] === 'string' && value[key].length > 0) {
        errors.push(`${trail}.${key}: secrets must come from environment variables, not config.json`);
      }
      scanConfig(value[key], `${trail}.${key}`, errors, depth + 1);
    }
  }
}

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); }
  return o;
}

/** Whitelists every key: unknown keys are dropped, invalid values abort startup. */
function validateConfig(raw) {
  const errors = []; const warnings = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError(['config root must be a JSON object']);
  scanConfig(raw, 'config', errors);

  const section = (name) => {
    const s = raw[name];
    if (s && typeof s === 'object' && !Array.isArray(s)) return s;
    errors.push(`${name}: must be an object`);
    return {};
  };
  const field = (secName, sec) => ({
    int(k, min, max) {
      const v = sec[k];
      if (!Number.isInteger(v) || v < min || v > max) { errors.push(`${secName}.${k}: integer ${min}..${max} required`); return min; }
      return v;
    },
    bool(k) {
      const v = sec[k];
      if (typeof v !== 'boolean') { errors.push(`${secName}.${k}: boolean required`); return false; }
      return v;
    },
    str(k, min, max, re) {
      const v = sec[k];
      if (typeof v !== 'string' || v.length < min || v.length > max || (re && !re.test(v))) { errors.push(`${secName}.${k}: invalid string`); return ''; }
      return v;
    },
    oneOf(k, list) {
      const v = sec[k];
      if (!list.includes(v)) { errors.push(`${secName}.${k}: must be one of ${list.join(', ')}`); return list[0]; }
      return v;
    },
  });

  const root = field('config', raw);
  const botName = root.str('botName', 1, 32, /^[A-Za-z0-9][A-Za-z0-9 _-]*$/);
  const prefix = root.str('prefix', 1, 3, /^[^\s\w\u0980-\u09FF]{1,3}$/);
  const language = root.oneOf('language', ['bn']);
  const timezone = root.str('timezone', 1, 64);
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); } catch { errors.push('timezone: unknown IANA time zone'); }

  const adminUids = [];
  if (!Array.isArray(raw.adminUids) || raw.adminUids.length > 20) errors.push('adminUids: array with at most 20 entries required');
  else {
    for (const uid of raw.adminUids) {
      if (typeof uid === 'string' && /^\d{5,30}$/.test(uid)) { if (!adminUids.includes(uid)) adminUids.push(uid); }
      else if (typeof uid === 'string' && /^REPLACE_/i.test(uid)) warnings.push('adminUids holds a placeholder: admin commands stay unreachable until a real UID is set');
      else errors.push('adminUids: entries must be numeric ID strings');
    }
  }

  const tr = field('transport', section('transport'));
  const transport = {
    adapter: tr.oneOf('adapter', ['console', 'messenger']),
    host: tr.str('host', 1, 64, /^[A-Za-z0-9.:-]+$/),
    port: tr.int('port', 1, 65535),
    webhookPath: tr.str('webhookPath', 1, 64, /^\/[A-Za-z0-9_/-]{0,63}$/),
    graphApiVersion: tr.str('graphApiVersion', 4, 8, /^v\d{1,2}\.\d$/),
    requestTimeoutMs: tr.int('requestTimeoutMs', 1000, 60000),
  };
  if (transport.webhookPath === '/healthz') errors.push('transport.webhookPath: must not be /healthz');

  const cdf = field('cooldowns', section('cooldowns'));
  const cooldowns = { defaultSeconds: cdf.int('defaultSeconds', 0, 3600), perUserSeconds: cdf.int('perUserSeconds', 0, 3600), perThreadSeconds: cdf.int('perThreadSeconds', 0, 3600) };

  const rlf = field('rateLimit', section('rateLimit'));
  const rateLimit = {
    perUserMax: rlf.int('perUserMax', 1, 1000), perUserWindowSeconds: rlf.int('perUserWindowSeconds', 1, 3600),
    perThreadMax: rlf.int('perThreadMax', 1, 5000), perThreadWindowSeconds: rlf.int('perThreadWindowSeconds', 1, 3600),
  };

  const qf = field('queue', section('queue'));
  const queue = { capacity: qf.int('capacity', 1, 10000), concurrency: qf.int('concurrency', 1, 16), perThreadCapacity: qf.int('perThreadCapacity', 1, 10000) };
  if (queue.perThreadCapacity > queue.capacity) errors.push('queue.perThreadCapacity: must not exceed queue.capacity');

  const lf = field('limits', section('limits'));
  const limits = {
    maxMessageLength: lf.int('maxMessageLength', 1, 2000), maxArgs: lf.int('maxArgs', 0, 20), maxArgLength: lf.int('maxArgLength', 1, 500),
    maxReplyLength: lf.int('maxReplyLength', 100, 2000), commandTimeoutMs: lf.int('commandTimeoutMs', 1000, 60000),
  };

  const rf = field('retry', section('retry'));
  const retry = { maxAttempts: rf.int('maxAttempts', 1, 5), baseDelayMs: rf.int('baseDelayMs', 50, 10000), maxDelayMs: rf.int('maxDelayMs', 50, 60000), maxInlineWaitMs: rf.int('maxInlineWaitMs', 0, 30000) };
  if (retry.maxDelayMs < retry.baseDelayMs) errors.push('retry.maxDelayMs: must be >= baseDelayMs');

  const cbf = field('circuitBreaker', section('circuitBreaker'));
  const circuitBreaker = { failureThreshold: cbf.int('failureThreshold', 1, 100), resetSeconds: cbf.int('resetSeconds', 1, 3600) };

  const rcf = field('reconnect', section('reconnect'));
  const reconnect = { maxAttempts: rcf.int('maxAttempts', 1, 20), baseDelayMs: rcf.int('baseDelayMs', 100, 60000), maxDelayMs: rcf.int('maxDelayMs', 100, 600000) };
  if (reconnect.maxDelayMs < reconnect.baseDelayMs) errors.push('reconnect.maxDelayMs: must be >= baseDelayMs');

  const authHealth = { checkIntervalSeconds: field('authHealth', section('authHealth')).int('checkIntervalSeconds', 30, 86400) };

  const df = field('dedupe', section('dedupe'));
  const dedupe = { ttlSeconds: df.int('ttlSeconds', 10, 86400), maxEntries: df.int('maxEntries', 100, 100000) };

  const mf = field('maintenance', section('maintenance'));
  const maintenance = { enabled: mf.bool('enabled'), message: mf.str('message', 1, 300) };

  const features = { typingIndicator: field('features', section('features')).bool('typingIndicator') };
  const logging = { level: field('logging', section('logging')).oneOf('level', ['debug', 'info', 'warn', 'error']) };
  const shutdown = { timeoutMs: field('shutdown', section('shutdown')).int('timeoutMs', 1000, 60000) };

  if (errors.length) throw new ConfigError(errors);
  const config = {
    botName, prefix, language, timezone, adminUids, transport, cooldowns, rateLimit, queue, limits, retry,
    circuitBreaker, reconnect, authHealth, dedupe, maintenance, features, logging, shutdown,
  };
  return { config: deepFreeze(config), warnings };
}

/** Secrets come only from the environment. Error text names variables, never values. */
function readSecrets(env) {
  const errors = [];
  const get = (name, minLen) => {
    const v = env[name];
    if (typeof v !== 'string' || v.length < minLen || /\s/.test(v)) { errors.push(`${name}: environment variable missing or malformed`); return ''; }
    return v;
  };
  const secrets = { pageAccessToken: get('PAGE_ACCESS_TOKEN', 16), appSecret: get('APP_SECRET', 16), verifyToken: get('VERIFY_TOKEN', 8) };
  if (errors.length) throw new ConfigError(errors);
  return secrets;
}

/* ================================== Logger ================================= */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const SENSITIVE_KEY_RE = /(token|secret|password|cookie|authorization|signature|appstate|^text$|^body$)/i;
const URL_SECRET_RE = /\b(access_token|token|secret|app_secret|client_secret)=[^&\s"']+/gi;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;

function createRedactor(secrets) {
  const list = secrets.filter((s) => typeof s === 'string' && s.length >= 6);
  const scrub = (s) => {
    let out = s;
    for (const secret of list) out = out.split(secret).join('[REDACTED]');
    return out.replace(URL_SECRET_RE, '$1=[REDACTED]').replace(BEARER_RE, 'Bearer [REDACTED]');
  };
  const walk = (v, depth) => {
    if (typeof v === 'string') return scrub(v);
    if (v instanceof Error) v = { name: v.name, kind: v.kind, code: v.code, status: v.status, message: v.message };
    if (v === null || typeof v !== 'object') return v;
    if (depth >= 4) return '[Truncated]';
    if (Array.isArray(v)) return v.slice(0, 20).map((x) => walk(x, depth + 1));
    const out = {};
    for (const k of Object.keys(v)) {
      if (k === '__proto__') continue;
      out[k] = SENSITIVE_KEY_RE.test(k) ? '[REDACTED]' : walk(v[k], depth + 1);
    }
    return out;
  };
  return (v) => walk(v, 0);
}

/** JSON lines on stderr. Message text is never logged; user IDs appear only as short hashes. */
function createLogger({ level, secrets = [], stream = process.stderr }) {
  const min = LEVELS[level];
  const redact = createRedactor(secrets);
  const emit = (lvl, msg, fields) => {
    if (LEVELS[lvl] < min) return;
    stream.write(JSON.stringify({ ...redact(fields || {}), t: new Date().toISOString(), lvl, msg }) + '\n');
  };
  return {
    debug: (m, f) => emit('debug', m, f), info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f), error: (m, f) => emit('error', m, f), redact,
  };
}

/* ================================= Adapters ================================ */
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha256(a), sha256(b));

function verifySignature(rawBody, header, appSecret) {
  if (typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const given = Buffer.from(header.slice(7), 'hex'); // malformed hex yields a shorter buffer
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest();
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/** Local development adapter: stdin lines are messages, replies go to stdout. "@123456 .cmd" sends as user 123456. */
class ConsoleAdapter extends EventEmitter {
  constructor() { super(); this.name = 'console'; this.capabilities = { typing: false }; this._rl = null; this._closing = false; this._n = 0; }
  async connect() {
    this._closing = false;
    this._rl = readline.createInterface({ input: process.stdin });
    this._rl.on('line', (line) => {
      let senderId = 'local-user'; let text = line;
      const m = /^@(\w{1,32})\s+([\s\S]*)$/.exec(line);
      if (m) { senderId = m[1]; text = m[2]; }
      this.emit('message', { id: `console-${Date.now()}-${++this._n}`, threadId: 'console-thread', senderId, text, timestamp: Date.now() });
    });
    this._rl.on('close', () => { if (!this._closing) this.emit('closed'); });
  }
  async disconnect() { this._closing = true; if (this._rl) { this._rl.close(); this._rl = null; } }
  async sendMessage(threadId, text) { process.stdout.write(`\n[ASK-Ayan → ${threadId}]\n${text}\n\n`); }
  async checkAuth() { return { ok: true }; }
}

/**
 * Meta Messenger Platform adapter (Pages). Documented building blocks only:
 *  - webhook GET verification (hub.mode / hub.verify_token / hub.challenge)
 *  - webhook POST signed with X-Hub-Signature-256 (HMAC-SHA256 of the raw body with the app secret)
 *  - Send API: POST /{version}/me/messages  (recipient.id, messaging_type RESPONSE, message.text, sender_action)
 * Error-code mapping below is conservative; verify against Meta's current error reference.
 */
class MessengerAdapter extends EventEmitter {
  constructor({ config, secrets, logger, getHealth }) {
    super();
    this.name = 'messenger'; this.capabilities = { typing: true };
    this.logger = logger; this.getHealth = getHealth;
    const t = config.transport;
    this.host = t.host; this.port = t.port; this.path = t.webhookPath; this.version = t.graphApiVersion; this.timeoutMs = t.requestTimeoutMs;
    this.token = secrets.pageAccessToken; this.appSecret = secrets.appSecret; this.verifyToken = secrets.verifyToken;
    this.server = null; this._closing = false;
  }

  async connect() {
    this._closing = false;
    const server = http.createServer((req, res) => this._onRequest(req, res));
    server.requestTimeout = 15000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000;
    await new Promise((resolve, reject) => {
      const onError = (err) => reject(new TransportError('transient', `listen failed: ${err.code || err.name}`));
      server.once('error', onError);
      server.listen(this.port, this.host, () => { server.off('error', onError); resolve(); });
    });
    server.on('error', (err) => { this.logger.error('server_error', { err }); if (!this._closing) this.emit('disconnected', err); });
    this.server = server;
    this.logger.info('webhook_listening', { host: this.host, port: this.port, path: this.path });
  }

  async disconnect() {
    this._closing = true;
    const s = this.server; this.server = null;
    if (!s) return;
    await new Promise((resolve) => { s.close(() => resolve()); s.closeAllConnections(); });
  }

  async sendMessage(threadId, text) {
    await this._graph('/me/messages', 'POST', { recipient: { id: threadId }, messaging_type: 'RESPONSE', message: { text } });
  }
  async sendTyping(threadId, on) {
    await this._graph('/me/messages', 'POST', { recipient: { id: threadId }, sender_action: on ? 'typing_on' : 'typing_off' });
  }
  async checkAuth() {
    try { await this._graph('/me?fields=id', 'GET'); return { ok: true }; } catch (err) { return { ok: false, kind: (err && err.kind) || 'transient' }; }
  }

  async _graph(pathAndQuery, method, payload) {
    const url = new URL(`https://graph.facebook.com/${this.version}${pathAndQuery}`);
    url.searchParams.set('access_token', this.token);
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: payload ? { 'Content-Type': 'application/json' } : undefined,
        body: payload ? JSON.stringify(payload) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) { throw new TransportError('transient', `network error: ${err.name}`); } // message never contains the URL
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    if (!res.ok) throw this._toError(res.status, body, res.headers);
    return body;
  }

  _toError(status, body, headers) {
    const e = body && body.error ? body.error : {};
    const code = e.code; const sub = e.error_subcode;
    const ra = Number(headers.get('retry-after'));
    const retryAfterMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined;
    let kind;
    if (status === 429 || [4, 17, 32, 613].includes(code)) kind = 'rate_limit';
    else if (code === 190 || status === 401) kind = sub === 459 ? 'checkpoint' : 'auth';
    else if (code === 368) kind = 'restriction';
    else if (code === 10 && sub === 2018278) kind = 'invalid';          // recipient outside the messaging window: per-user, not account-level
    else if (code === 10 || (code >= 200 && code <= 299) || status === 403) kind = 'permission';
    else if (status >= 500 || code === 1 || code === 2) kind = 'transient';
    else kind = 'invalid';                                              // includes 400 and 404: NOT assumed to be a checkpoint
    return new TransportError(kind, `graph error status=${status} code=${code}`, { status, code, subcode: sub, retryAfterMs });
  }

  _end(res, status, text) {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
    res.end(text);
  }

  _onRequest(req, res) {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return this._end(res, 400, 'bad request'); }
    if (url.pathname === '/healthz' && req.method === 'GET') { const h = this.getHealth(); return this._end(res, h.ok ? 200 : 503, h.ok ? 'ok' : 'degraded'); }
    if (url.pathname !== this.path) return this._end(res, 404, 'not found');
    if (req.method === 'GET') {
      const token = url.searchParams.get('hub.verify_token') || '';
      const challenge = url.searchParams.get('hub.challenge') || '';
      if (url.searchParams.get('hub.mode') === 'subscribe' && safeEqual(token, this.verifyToken) && /^[\w.-]{1,128}$/.test(challenge)) return this._end(res, 200, challenge);
      return this._end(res, 403, 'forbidden');
    }
    if (req.method === 'POST') return this._receive(req, res);
    res.setHeader('Allow', 'GET, POST');
    return this._end(res, 405, 'method not allowed');
  }

  _receive(req, res) {
    const MAX_BODY = 256 * 1024;
    const chunks = []; let size = 0; let aborted = false;
    req.on('error', () => {});
    req.on('data', (c) => {
      if (aborted) return;
      size += c.length;
      if (size > MAX_BODY) { aborted = true; this._end(res, 413, 'too large'); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      const raw = Buffer.concat(chunks);
      if (!verifySignature(raw, req.headers['x-hub-signature-256'], this.appSecret)) { this.logger.warn('webhook_bad_signature'); return this._end(res, 401, 'unauthorized'); }
      let body;
      try { body = JSON.parse(raw.toString('utf8')); } catch { return this._end(res, 400, 'bad json'); }
      this._end(res, 200, 'EVENT_RECEIVED'); // acknowledge fast; processing is queued
      this._dispatch(body);
    });
  }

  _dispatch(body) {
    try {
      if (!body || body.object !== 'page') return;
      let count = 0;
      for (const entry of Array.isArray(body.entry) ? body.entry : []) {
        for (const ev of Array.isArray(entry && entry.messaging) ? entry.messaging : []) {
          if (++count > 100) return;
          const m = ev && ev.message;
          const sender = ev && ev.sender && ev.sender.id;
          if (!m || m.is_echo || typeof m.text !== 'string' || typeof m.mid !== 'string' || typeof sender !== 'string' || !/^\d{1,30}$/.test(sender)) continue;
          this.emit('message', { id: m.mid, threadId: sender, senderId: sender, text: m.text, timestamp: Number(ev.timestamp) || Date.now() });
        }
      }
    } catch (err) { this.logger.error('dispatch_failed', { err }); }
  }
}

function createAdapter(config, secrets, logger, getHealth) {
  switch (config.transport.adapter) {
    case 'messenger': return new MessengerAdapter({ config, secrets, logger, getHealth });
    default: return new ConsoleAdapter();
  }
}

/* ================================ Supervisor =============================== */
function createSupervisor({ adapter, guard, config, logger, sleepFn = sleep }) {
  let state = 'starting'; let stopping = false; let reconnecting = false; let checking = false;
  let healthTimer = null; let onFatal = () => {};
  const incidents = [];
  const fmt = makeTimeFormatter(config.timezone);
  const setState = (s) => { if (s !== state) { logger.info('connection_state', { from: state, to: s }); state = s; } };
  const safeDisconnect = async () => { try { await adapter.disconnect(); } catch { /* best effort */ } };
  const stopHealth = () => { if (healthTimer) { clearInterval(healthTimer); healthTimer = null; } };

  guard.on('suspended', (kind) => {
    setState('suspended');
    stopHealth();
    // Operational alert (Bengali). Outbound is already blocked; recovery is a manual, authorized restart.
    logger.error('auth_suspended', { kind, alert: MSG.opsAlert(kind, fmt.format(new Date())), userNotice: MSG.authProblem });
  });

  async function connectWithBackoff() {
    const { maxAttempts, baseDelayMs, maxDelayMs } = config.reconnect;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (stopping) return false;
      try {
        await adapter.connect();
        const auth = await adapter.checkAuth();
        if (!auth.ok) throw new TransportError(auth.kind || 'transient', 'auth health check failed');
        setState('connected');
        return true;
      } catch (err) {
        const kind = err && err.kind;
        logger.warn('connect_failed', { attempt, kind, err });
        await safeDisconnect();
        if (isAuthKind(kind)) { guard.suspend(kind); return false; } // never retried
        if (attempt < maxAttempts) { setState('reconnecting'); await sleepFn(backoffDelay(attempt, baseDelayMs, maxDelayMs)); }
      }
    }
    return false;
  }

  adapter.on('disconnected', (err) => {
    if (stopping) return;
    const now = Date.now();
    incidents.push(now);
    while (incidents.length && now - incidents[0] > 600000) incidents.shift();
    if (incidents.length > config.reconnect.maxAttempts) { logger.error('reconnect_flapping', { incidents: incidents.length }); onFatal('reconnect_flapping'); return; }
    if (reconnecting || guard.isSuspended()) return;
    reconnecting = true; setState('reconnecting');
    logger.warn('adapter_disconnected', { err });
    connectWithBackoff()
      .then((ok) => { reconnecting = false; if (!ok && !stopping) onFatal(guard.isSuspended() ? 'auth_suspended' : 'reconnect_exhausted'); })
      .catch((e) => { reconnecting = false; logger.error('reconnect_crashed', { err: e }); onFatal('reconnect_crashed'); });
  });

  async function healthCheck() {
    if (checking || guard.isSuspended() || state !== 'connected') return;
    checking = true;
    try {
      const r = await adapter.checkAuth();
      if (!r.ok && isAuthKind(r.kind)) guard.suspend(r.kind); // transient failures are only logged
      else if (!r.ok) logger.warn('auth_health_transient', { kind: r.kind });
    } catch (err) { logger.warn('auth_health_error', { err }); } finally { checking = false; }
  }

  return {
    async start(opts = {}) {
      onFatal = opts.onFatal || onFatal;
      const ok = await connectWithBackoff();
      if (ok) { healthTimer = setInterval(healthCheck, config.authHealth.checkIntervalSeconds * 1000); healthTimer.unref(); }
      return ok;
    },
    async stop() { stopping = true; setState('stopping'); stopHealth(); await safeDisconnect(); setState('stopped'); },
    health: () => ({ ok: state === 'connected' && !guard.isSuspended(), state }),
    get state() { return state; },
  };
}

/* ==================================== Main ================================= */
async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) process.exit(await runSelfTest());

  let config; let warnings; let secrets = {};
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
    if (argv.includes('--console') && raw && raw.transport) raw.transport.adapter = 'console';
    ({ config, warnings } = validateConfig(raw));
    if (config.transport.adapter === 'messenger') secrets = readSecrets(process.env);
  } catch (err) {
    process.stderr.write(`[config] startup aborted: ${err instanceof ConfigError ? err.message : 'cannot read or parse config.json'}\n`);
    process.exit(1);
  }

  const logger = createLogger({ level: config.logging.level, secrets: Object.values(secrets) });
  warnings.forEach((w) => logger.warn('config_warning', { warning: w }));

  let supervisor;
  const guard = new AuthGuard();
  const adapter = createAdapter(config, secrets, logger, () => supervisor.health());
  const handler = createCommandHandler({ config, logger, adapter, guard });
  if (handler.loadCommands() === 0) logger.warn('no_commands_loaded');
  supervisor = createSupervisor({ adapter, guard, config, logger });

  adapter.on('message', (ev) => handler.onMessage(ev));

  let shuttingDown = false;
  async function shutdown(reason, exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutdown_begin', { reason });
    const killer = setTimeout(() => { logger.error('shutdown_timeout'); process.exit(1); }, config.shutdown.timeoutMs);
    killer.unref();
    await supervisor.stop();                                  // stop receiving first
    const result = await handler.stop(config.shutdown.timeoutMs); // then drain bounded in-flight work
    logger.info('shutdown_done', result);
    clearTimeout(killer);
    process.exit(exitCode);
  }

  adapter.on('closed', () => shutdown('stdin_closed', 0));
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) { try { process.on(sig, () => shutdown(sig, 0)); } catch { /* signal unsupported on this OS */ } }
  // Uncaught errors may leave state corrupted: log and terminate; a supervisor (systemd/pm2/docker) restarts us.
  process.on('uncaughtException', (err) => { logger.error('uncaught_exception', { err }); process.exit(1); });
  process.on('unhandledRejection', (err) => { logger.error('unhandled_rejection', { err }); process.exit(1); });

  logger.info('starting', { bot: config.botName, adapter: config.transport.adapter, node: process.version });
  const ok = await supervisor.start({ onFatal: (why) => shutdown(why, 1) });
  if (!ok) await shutdown('boot_failed', guard.isSuspended() ? 2 : 1);
  else logger.info('ready', { commands: handler.commands.size });
}

/* ================================ Self-test ================================ */
class MockAdapter extends EventEmitter {
  constructor() {
    super();
    this.name = 'mock'; this.capabilities = { typing: false };
    this.sent = []; this.attempts = 0; this.sendErrors = []; this.connectErrors = 0; this.connectCalls = 0;
  }
  async connect() { this.connectCalls++; if (this.connectErrors > 0) { this.connectErrors--; throw new TransportError('transient', 'mock connect failure'); } }
  async disconnect() {}
  async sendMessage(threadId, text) { this.attempts++; const e = this.sendErrors.shift(); if (e) throw e; this.sent.push({ threadId, text }); }
  async checkAuth() { return { ok: true }; }
}

async function runSelfTest() {
  const assert = require('node:assert/strict');
  const baseRaw = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  const { parseCommand, CircuitBreaker } = require('./core/handleCommand');
  const ADMIN = '1000000001'; const USER = '2000000001';
  const quiet = { debug() {}, info() {}, warn() {}, error() {} };
  const mkConfig = (patch) => {
    const raw = JSON.parse(JSON.stringify(baseRaw));
    raw.transport.adapter = 'console'; raw.adminUids = [ADMIN];
    Object.assign(raw.cooldowns, { defaultSeconds: 0, perUserSeconds: 0, perThreadSeconds: 0 });
    Object.assign(raw.retry, { baseDelayMs: 50, maxDelayMs: 50 });
    if (patch) patch(raw);
    return validateConfig(raw).config;
  };
  let n = 0;
  const ev = (text, who = USER, thread = who) => ({ id: `t${++n}`, threadId: thread, senderId: who, text, timestamp: Date.now() });
  const rig = (patch) => {
    const config = mkConfig(patch); const adapter = new MockAdapter(); const guard = new AuthGuard();
    const handler = createCommandHandler({ config, logger: quiet, adapter, guard });
    const probe = { adminRuns: 0, running: 0, max: 0 };
    handler.loadCommands();
    handler.registerCommand({ config: { name: 'adminping', description: 'test', role: 1 }, async onStart({ reply }) { probe.adminRuns++; await reply('pong'); } }, 'selftest');
    handler.registerCommand({ config: { name: 'slow', description: 'test' }, async onStart({ reply }) { probe.running++; probe.max = Math.max(probe.max, probe.running); await sleep(20); probe.running--; await reply('ok'); } }, 'selftest');
    return { config, adapter, guard, handler, probe };
  };

  let failed = 0;
  const t = async (name, fn) => { try { await fn(); console.log(`  PASS  ${name}`); } catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e.message}`); } };
  console.log('ASK-Ayan self-test (mock adapter, no network)');

  await t('malformed events are dropped; parser is inert', async () => {
    const { handler, adapter } = rig();
    for (const bad of [null, {}, { id: 1 }, ev(''), { ...ev('.help'), senderId: '../../x' }, ev('x'.repeat(5000))]) assert.equal(handler.onMessage(bad), 'malformed');
    await handler.idle(); assert.equal(adapter.sent.length, 0);
    const limits = baseRaw.limits;
    assert.deepEqual(parseCommand('.help ; rm -rf /', '.', limits).args, [';', 'rm', '-rf', '/']);
    assert.equal(parseCommand('.', '.', limits).error, 'empty');
    assert.equal(parseCommand('.a b c d e f g h i j k', '.', limits).error, 'too_many_args');
  });

  await t('unknown commands incl. __proto__/constructor get the Bengali reply', async () => {
    const { handler, adapter } = rig();
    for (const c of ['.nosuch', '.__proto__', '.constructor', '.toString']) handler.onMessage(ev(c, USER, `${USER}${n}`));
    await handler.idle();
    assert.equal(adapter.sent.length, 4);
    assert.ok(adapter.sent.every((m) => m.text.includes('খুঁজে পেলাম না')));
  });

  await t('help works; admin commands hidden from non-admins', async () => {
    const { handler, adapter } = rig();
    handler.onMessage(ev('.help', USER)); handler.onMessage(ev('.help', ADMIN)); await handler.idle();
    const [u, a] = [adapter.sent.find((m) => m.threadId === USER), adapter.sent.find((m) => m.threadId === ADMIN)];
    assert.ok(u.text.includes('ASK-Ayan') && u.text.includes('.help') && !u.text.includes('adminping'));
    assert.ok(a.text.includes('.adminping'));
  });

  await t('unauthorized admin command is denied; admin is allowed', async () => {
    const { handler, adapter, probe } = rig();
    handler.onMessage(ev('.adminping', USER)); await handler.idle();
    assert.equal(probe.adminRuns, 0); assert.ok(adapter.sent[0].text.includes('অ্যাডমিন'));
    handler.onMessage(ev('.adminping', ADMIN)); await handler.idle();
    assert.equal(probe.adminRuns, 1);
  });

  await t('cooldown message on rapid repeat', async () => {
    const { handler, adapter } = rig((r) => { r.cooldowns.defaultSeconds = 5; });
    handler.onMessage(ev('.help')); handler.onMessage(ev('.help')); await handler.idle();
    assert.equal(adapter.sent.length, 2); assert.equal(adapter.sent[1].text, MSG.cooldown);
  });

  await t('rate limit: excess dropped, one notice only', async () => {
    const { handler, adapter } = rig((r) => { r.rateLimit.perUserMax = 2; });
    for (let i = 0; i < 5; i++) handler.onMessage(ev('.help'));
    await handler.idle();
    assert.equal(handler.stats.rateLimited, 3); assert.equal(adapter.sent.length, 3);
  });

  await t('duplicate event ids are ignored', async () => {
    const { handler, adapter } = rig(); const e = ev('.help');
    assert.equal(handler.onMessage(e), 'accepted'); assert.equal(handler.onMessage(e), 'duplicate');
    await handler.idle(); assert.equal(adapter.sent.length, 1);
  });

  await t('concurrency never exceeds the configured limit', async () => {
    const { handler, adapter, probe } = rig((r) => { r.queue.concurrency = 2; });
    for (let i = 0; i < 6; i++) handler.onMessage(ev('.slow', `30000000${i}`));
    await handler.idle();
    assert.equal(adapter.sent.length, 6); assert.ok(probe.max <= 2 && probe.max >= 1);
  });

  await t('queue overflow is bounded and counted', async () => {
    const { handler } = rig((r) => { r.queue.capacity = 3; r.queue.perThreadCapacity = 2; r.queue.concurrency = 1; });
    for (let i = 0; i < 8; i++) { handler.onMessage(ev('.slow', `40000000${i}`)); assert.ok(handler.queueSize <= 3); }
    await handler.idle();
    assert.ok(handler.stats.dropped > 0); assert.equal(handler.stats.processed + handler.stats.dropped, 8);
  });

  await t('transient send failures are retried with backoff', async () => {
    const { handler, adapter } = rig();
    adapter.sendErrors = [new TransportError('transient'), new TransportError('transient')];
    handler.onMessage(ev('.help')); await handler.idle();
    assert.equal(adapter.attempts, 3); assert.equal(adapter.sent.length, 1);
  });

  await t('auth failure suspends outbound, no retry, inbound ignored', async () => {
    const { handler, adapter, guard } = rig();
    adapter.sendErrors = [new TransportError('auth')];
    handler.onMessage(ev('.help')); await handler.idle();
    assert.equal(adapter.attempts, 1); assert.ok(guard.isSuspended());
    assert.equal(handler.onMessage(ev('.help')), 'ignored'); assert.equal(adapter.attempts, 1);
  });

  await t('invalid (e.g. HTTP 404) is not treated as a checkpoint', async () => {
    const { handler, adapter, guard } = rig();
    adapter.sendErrors = [new TransportError('invalid', 'not found', { status: 404 })];
    handler.onMessage(ev('.help')); await handler.idle();
    assert.equal(adapter.attempts, 1); assert.ok(!guard.isSuspended());
  });

  await t('long Retry-After pauses all sends instead of retrying', async () => {
    const { handler, adapter } = rig();
    adapter.sendErrors = [new TransportError('rate_limit', 'slow down', { retryAfterMs: 60000 })];
    assert.equal(await handler.outbound.send('1', 'x'), false);
    assert.equal(await handler.outbound.send('1', 'y'), false);
    assert.equal(adapter.attempts, 1);
  });

  await t('circuit breaker opens, half-opens, closes', async () => {
    const b = new CircuitBreaker({ failureThreshold: 2, resetSeconds: 10 });
    b.failure(0); b.failure(0);
    assert.equal(b.canRequest(1000), false);
    assert.equal(b.canRequest(11000), true); assert.equal(b.canRequest(11001), false);
    b.success(); assert.equal(b.canRequest(11002), true);
  });

  await t('reconnect attempts are bounded; auth failures are never retried', async () => {
    const config = mkConfig((r) => { r.reconnect = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 200 }; });
    const a1 = new MockAdapter(); a1.connectErrors = 99;
    const s1 = createSupervisor({ adapter: a1, guard: new AuthGuard(), config, logger: quiet, sleepFn: async () => {} });
    assert.equal(await s1.start(), false); assert.equal(a1.connectCalls, 3);
    const a2 = new MockAdapter(); a2.connect = async function () { this.connectCalls++; throw new TransportError('auth'); };
    const g2 = new AuthGuard();
    const s2 = createSupervisor({ adapter: a2, guard: g2, config, logger: quiet, sleepFn: async () => {} });
    assert.equal(await s2.start(), false); assert.equal(a2.connectCalls, 1); assert.ok(g2.isSuspended());
  });

  await t('flapping connections end in a fatal stop, not an endless loop', async () => {
    const config = mkConfig((r) => { r.reconnect = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 200 }; });
    const a = new MockAdapter(); const fatal = [];
    const s = createSupervisor({ adapter: a, guard: new AuthGuard(), config, logger: quiet, sleepFn: async () => {} });
    await s.start({ onFatal: (w) => fatal.push(w) });
    for (let i = 0; i < 4; i++) a.emit('disconnected', new Error('x'));
    assert.ok(fatal.includes('reconnect_flapping')); await s.stop();
  });

  await t('secrets are redacted from logs', async () => {
    const redact = createRedactor(['mysecretvalue']);
    const out = JSON.stringify(redact({ access_token: 'abc123', nested: { authorization: 'Bearer xyz789' }, text: 'private hello', note: 'u?access_token=SECRET123 mysecretvalue', err: new Error('Bearer tok999') }));
    for (const leaked of ['abc123', 'xyz789', 'private hello', 'SECRET123', 'mysecretvalue', 'tok999']) assert.ok(!out.includes(leaked), `leaked ${leaked}`);
  });

  await t('unsafe configuration is rejected at startup', async () => {
    assert.throws(() => mkConfig((r) => { r.transport.pageAccessToken = 'abc'; }), /secrets must come/);
    assert.throws(() => mkConfig((r) => { r.transport.adapter = 'evil'; }), /transport\.adapter/);
    assert.throws(() => mkConfig((r) => { r.queue.capacity = 0; }), /queue\.capacity/);
    assert.throws(() => validateConfig(JSON.parse('{"__proto__":{"x":1},"botName":"x"}')), /forbidden key/);
    const raw = JSON.parse(JSON.stringify(baseRaw));
    const res = validateConfig(raw);
    assert.equal(res.config.adminUids.length, 0); assert.equal(res.warnings.length, 1);
  });

  await t('webhook signature check (HMAC-SHA256)', async () => {
    const body = Buffer.from('{"a":1}'); const secret = 'topsecret-topsecret';
    const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
    assert.ok(verifySignature(body, sig, secret));
    assert.ok(!verifySignature(body, 'sha256=' + '0'.repeat(64), secret));
    assert.ok(!verifySignature(body, undefined, secret)); assert.ok(!verifySignature(body, 'md5=abc', secret));
  });

  await t('graceful shutdown drains in-flight work and refuses new events', async () => {
    const { handler, adapter } = rig();
    handler.onMessage(ev('.slow'));
    const r = await handler.stop(2000);
    assert.equal(r.drained, true); assert.equal(adapter.sent.length, 1);
    assert.equal(handler.onMessage(ev('.help')), 'ignored');
  });

  console.log(failed === 0 ? '\nAll self-tests passed.' : `\n${failed} self-test(s) FAILED.`);
  return failed === 0 ? 0 : 1;
}

main().catch((err) => { process.stderr.write(`[fatal] ${err && err.name}\n`); process.exit(1); });
