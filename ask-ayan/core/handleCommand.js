'use strict';

/**
 * ASK-Ayan core: command discovery, safe parsing, authorization, cooldowns,
 * rate limits, fair bounded queue, and the guarded outbound path.
 *
 * COMMAND MODULE INTERFACE (scripts/cmds/*.js):
 *   module.exports = {
 *     config: {
 *       name: 'ping',                 // required, ^[a-z][a-z0-9_-]{0,31}$
 *       aliases: ['p'],               // optional, max 5, same pattern
 *       description: '...',           // required, <= 200 chars (Bengali)
 *       usage: '{p}ping',             // optional, {p} = prefix
 *       examples: ['{p}ping'],        // optional, max 5
 *       category: 'utility',          // optional
 *       role: 0,                      // 0 = everyone, 1 = admin only
 *       cooldown: 3                   // optional seconds (overrides cooldowns.defaultSeconds)
 *     },
 *     async onStart(ctx) {}           // ctx: see _execute()
 *   };
 * Commands are trusted local code. They must never pass args to a shell/eval.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

/* ------------------------------ Bengali copy ------------------------------ */
const MSG = Object.freeze({
  greeting: 'হেই! কেমন আছো? 😊 কীভাবে সাহায্য করতে পারি?',
  help: 'অবশ্যই বন্ধু! নিচে আমার কমান্ডগুলো দেওয়া আছে।',
  unknownCommand: (p) => `এই কমান্ডটা খুঁজে পেলাম না। ${p}help লিখে কমান্ডগুলো দেখে নাও।`,
  cooldown: 'একটু অপেক্ষা করো বন্ধু, তারপর আবার চেষ্টা করো। 😊',
  rateLimited: 'তুমি একটু বেশি দ্রুত মেসেজ পাঠাচ্ছো বন্ধু। কিছুক্ষণ থেমে আবার চেষ্টা করো। 😊',
  tempError: 'দুঃখিত, সাময়িক একটা সমস্যা হয়েছে। একটু পরে চেষ্টা করো।',
  authProblem: 'নিরাপত্তার কারণে বটের কার্যক্রম সাময়িকভাবে বন্ধ রাখা হয়েছে। অ্যাডমিনকে জানাও।',
  adminOnly: 'দুঃখিত বন্ধু, এই কমান্ডটা শুধু অ্যাডমিনদের জন্য।',
  tooLong: 'মেসেজটা একটু বড় হয়ে গেছে। ছোট করে লিখে আবার পাঠাও।',
  badArgs: (p) => `কমান্ডটা ঠিকমতো বুঝতে পারিনি। ${p}help লিখে ব্যবহারের নিয়ম দেখে নাও।`,
  opsAlert: (kind, when) =>
    `⚠️ [${when}] বটের অথেন্টিকেশনে সমস্যা ধরা পড়েছে (ধরন: ${kind})। নিরাপত্তার কারণে সব আউটবাউন্ড কার্যক্রম বন্ধ করা হয়েছে। ` +
    'অনুগ্রহ করে অনুমোদিত উপায়ে ক্রেডেনশিয়াল যাচাই বা নবায়ন করে বট রিস্টার্ট করুন। স্বয়ংক্রিয়ভাবে আর কোনো চেষ্টা করা হবে না।',
});

/* --------------------------------- Errors --------------------------------- */
const KINDS = new Set(['auth', 'checkpoint', 'permission', 'restriction', 'rate_limit', 'transient', 'invalid']);
const AUTH_KINDS = new Set(['auth', 'checkpoint', 'permission', 'restriction']);

class TransportError extends Error {
  constructor(kind, message, extra = {}) {
    super(message || kind);
    this.name = 'TransportError';
    this.kind = kind;
    this.status = extra.status;
    this.code = extra.code;
    this.subcode = extra.subcode;
    this.retryAfterMs = extra.retryAfterMs;
  }
}
const classify = (err) => (err && KINDS.has(err.kind) ? err.kind : 'transient');
const isAuthKind = (kind) => AUTH_KINDS.has(kind);

/* --------------------------------- Helpers -------------------------------- */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function withTimeout(promise, ms, makeError) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(makeError()), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Exponential backoff with "equal jitter": never zero, never synchronized. */
function backoffDelay(attempt, baseMs, maxMs, rand = Math.random) {
  const cap = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  return Math.floor(cap / 2 + rand() * (cap / 2));
}

const pseudonym = (id) => crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 8);

function clip(text, max) {
  if (text.length <= max) return text;
  let out = text.slice(0, max - 1);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1); // do not split a surrogate pair
  return out + '…';
}

function makeTimeFormatter(timeZone) {
  const opts = { timeZone, dateStyle: 'medium', timeStyle: 'short' };
  try { return new Intl.DateTimeFormat('bn-BD', opts); } catch { return new Intl.DateTimeFormat('en-GB', opts); }
}

const NAME_RE = /^[a-z0-9_-]{1,32}$/;            // names accepted from users
const REG_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;   // names accepted at registration
const FILE_RE = /^[A-Za-z0-9_-]+\.js$/;
const ID_RE = /^[\w:.=+/-]{1,256}$/;
const SAFE_ID_RE = /^[\w:.-]{1,64}$/;
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const GREETING_RE = /^(hi|hello|hey|হাই|হ্যালো|হেই)$/i;
const HARD_TEXT_LIMIT = 4000;

/**
 * Safe command parsing. Pure string splitting: nothing is evaluated, nothing
 * is passed to a shell, lookups later happen in a Map (no prototype access).
 */
function parseCommand(text, prefix, limits) {
  const body = text.slice(prefix.length).trim();
  if (body === '') return { error: 'empty' };
  const parts = body.split(/\s+/);
  const name = parts[0].toLowerCase();
  if (!NAME_RE.test(name)) return { error: 'bad_name' };
  const args = parts.slice(1);
  if (args.length > limits.maxArgs) return { error: 'too_many_args' };
  if (args.some((a) => a.length > limits.maxArgLength)) return { error: 'arg_too_long' };
  return { name, args, argsText: args.join(' ') };
}

/* ------------------------- Bounded data structures ------------------------ */
class TtlMap {
  constructor(maxEntries) { this.max = maxEntries; this.map = new Map(); }
  set(key, ttlMs, now = Date.now()) {
    this.map.delete(key);
    this.map.set(key, now + ttlMs);
    if (this.map.size > this.max) this._evict(now);
  }
  remaining(key, now = Date.now()) {
    const expires = this.map.get(key);
    if (expires === undefined) return 0;
    if (expires <= now) { this.map.delete(key); return 0; }
    return expires - now;
  }
  has(key, now = Date.now()) { return this.remaining(key, now) > 0; }
  sweep(now = Date.now()) { for (const [k, e] of this.map) if (e <= now) this.map.delete(k); }
  _evict(now) {
    this.sweep(now);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
}

/** Fixed-window limiter (a burst of up to 2x max is possible across a window edge). */
class WindowLimiter {
  constructor(max, windowMs, maxKeys) { this.max = max; this.windowMs = windowMs; this.maxKeys = maxKeys; this.map = new Map(); }
  hit(key, now = Date.now()) {
    let e = this.map.get(key);
    if (!e || now >= e.start + this.windowMs) {
      e = { start: now, count: 0 };
      this.map.delete(key);
      this.map.set(key, e);
      if (this.map.size > this.maxKeys) this.sweep(now, true);
    }
    if (e.count >= this.max) return { allowed: false, retryAfterMs: e.start + this.windowMs - now };
    e.count++;
    return { allowed: true, retryAfterMs: 0 };
  }
  sweep(now = Date.now(), enforceMax = false) {
    for (const [k, e] of this.map) if (now >= e.start + this.windowMs) this.map.delete(k);
    while (enforceMax && this.map.size > this.maxKeys) this.map.delete(this.map.keys().next().value);
  }
}

/**
 * Bounded queue with fair scheduling: one FIFO per thread, threads served
 * round-robin, at most one in-flight job per thread (keeps per-thread order),
 * at most `concurrency` jobs overall.
 */
class FairQueue {
  constructor({ capacity, perKeyCapacity, concurrency, worker, onError }) {
    this.capacity = capacity; this.perKeyCapacity = perKeyCapacity; this.concurrency = concurrency;
    this.worker = worker; this.onError = onError;
    this.queues = new Map(); this.ready = []; this.size = 0; this.running = 0; this.idleWaiters = [];
  }
  push(key, job) {
    if (this.size >= this.capacity) return false;
    let q = this.queues.get(key);
    if (q && q.length >= this.perKeyCapacity) return false;
    if (!q) { q = []; this.queues.set(key, q); this.ready.push(key); }
    q.push(job);
    this.size++;
    this._pump();
    return true;
  }
  _pump() {
    while (this.running < this.concurrency && this.ready.length > 0) {
      const key = this.ready.shift();
      const q = this.queues.get(key);
      if (!q || q.length === 0) { this.queues.delete(key); continue; }
      const job = q.shift();
      this.size--; this.running++;
      Promise.resolve()
        .then(() => this.worker(job))
        .catch((err) => this.onError(err, job))
        .finally(() => {
          this.running--;
          if (q.length > 0) this.ready.push(key); else this.queues.delete(key);
          if (this.size === 0 && this.running === 0) { this.idleWaiters.splice(0).forEach((r) => r()); }
          this._pump();
        });
    }
  }
  idle() {
    if (this.size === 0 && this.running === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }
}

class CircuitBreaker {
  constructor({ failureThreshold, resetSeconds }) {
    this.threshold = failureThreshold; this.resetMs = resetSeconds * 1000;
    this.state = 'closed'; this.failures = 0; this.openedAt = 0; this.probing = false;
  }
  canRequest(now = Date.now()) {
    if (this.state === 'open' && now - this.openedAt >= this.resetMs) { this.state = 'half_open'; this.probing = false; }
    if (this.state === 'closed') return true;
    if (this.state === 'half_open' && !this.probing) { this.probing = true; return true; }
    return false;
  }
  success() { this.state = 'closed'; this.failures = 0; this.probing = false; }
  failure(now = Date.now()) {
    if (this.state === 'half_open') { this.state = 'open'; this.openedAt = now; this.probing = false; return; }
    this.failures++;
    if (this.failures >= this.threshold) { this.state = 'open'; this.openedAt = now; }
  }
}

/** Once suspended it stays suspended until the process is restarted by an operator. */
class AuthGuard extends EventEmitter {
  constructor() { super(); this.reason = null; this.since = 0; }
  isSuspended() { return this.reason !== null; }
  suspend(kind) {
    if (this.reason !== null) return false;
    this.reason = kind; this.since = Date.now();
    this.emit('suspended', kind);
    return true;
  }
}

/* ------------------------------ Outbound path ----------------------------- */
class Outbound {
  constructor({ adapter, config, logger, guard }) {
    this.adapter = adapter; this.cfg = config; this.logger = logger; this.guard = guard;
    this.breaker = new CircuitBreaker(config.circuitBreaker);
    this.pausedUntil = 0; // platform-imposed pause (Retry-After)
  }

  /** Returns true if delivered. Never throws. Never retries auth-class failures. */
  async send(threadId, text) {
    const { maxAttempts, baseDelayMs, maxDelayMs, maxInlineWaitMs } = this.cfg.retry;
    for (let attempt = 1; ; attempt++) {
      if (this.guard.isSuspended() || Date.now() < this.pausedUntil || !this.breaker.canRequest()) return false;
      try {
        await this.adapter.sendMessage(threadId, text);
        this.breaker.success();
        return true;
      } catch (err) {
        const kind = classify(err);
        this.logger.warn('send_failed', { kind, attempt, status: err && err.status, code: err && err.code });
        if (isAuthKind(kind)) { this.guard.suspend(kind); return false; }
        if (kind === 'invalid') { this.breaker.success(); return false; } // reachable, request rejected
        let waitMs;
        if (kind === 'rate_limit') {
          this.breaker.success();
          const retryAfter = err && err.retryAfterMs;
          waitMs = retryAfter > 0 ? retryAfter : backoffDelay(attempt, baseDelayMs, maxDelayMs);
          if (waitMs > maxInlineWaitMs) { this.pausedUntil = Date.now() + Math.min(waitMs, 3600000); return false; }
        } else {
          this.breaker.failure();
          waitMs = backoffDelay(attempt, baseDelayMs, maxDelayMs);
        }
        if (attempt >= maxAttempts) return false;
        await sleep(waitMs); // timer-based: does not block the event loop
      }
    }
  }

  /** Optional, best-effort, only while handling a real user's command. */
  async typing(threadId) {
    const a = this.adapter;
    if (!this.cfg.features.typingIndicator || typeof a.sendTyping !== 'function' || !(a.capabilities && a.capabilities.typing)) return;
    if (this.guard.isSuspended() || Date.now() < this.pausedUntil || this.breaker.state !== 'closed') return;
    try { await a.sendTyping(threadId, true); } catch (err) {
      const kind = classify(err);
      if (isAuthKind(kind)) this.guard.suspend(kind);
    }
  }
}

/* ----------------------------- Command handler ---------------------------- */
class CommandHandler {
  constructor({ config, logger, adapter, guard, commandsDir }) {
    this.config = config; this.logger = logger; this.guard = guard;
    this.commandsDir = commandsDir || path.join(__dirname, '..', 'scripts', 'cmds');
    this.outbound = new Outbound({ adapter, config, logger, guard });
    this.commands = new Map(); this.lookup = new Map(); this.publicList = [];
    this.adminSet = new Set(config.adminUids);
    this.dedupe = new TtlMap(config.dedupe.maxEntries);
    this.notices = new TtlMap(5000);
    this.userCd = new TtlMap(20000); this.threadCd = new TtlMap(20000); this.cmdCd = new TtlMap(20000);
    const rl = config.rateLimit;
    this.userLimiter = new WindowLimiter(rl.perUserMax, rl.perUserWindowSeconds * 1000, 20000);
    this.threadLimiter = new WindowLimiter(rl.perThreadMax, rl.perThreadWindowSeconds * 1000, 20000);
    this.queue = new FairQueue({
      capacity: config.queue.capacity, perKeyCapacity: config.queue.perThreadCapacity, concurrency: config.queue.concurrency,
      worker: (job) => this._process(job),
      onError: (err) => this.logger.error('job_failed', { err }),
    });
    this.closed = false;
    this.stats = { received: 0, processed: 0, dropped: 0, duplicate: 0, malformed: 0, rateLimited: 0 };
    this._lastDropLogged = 0;
    this.publicConfig = Object.freeze({ botName: config.botName, prefix: config.prefix, language: config.language, timezone: config.timezone });
    this.timeFmt = makeTimeFormatter(config.timezone);
    this.sweepTimer = setInterval(() => this._sweep(), 60000);
    this.sweepTimer.unref();
  }

  get queueSize() { return this.queue.size; }
  idle() { return this.queue.idle(); }

  /* ---- command registry ---- */
  registerCommand(mod, source = 'inline') {
    const fail = (why) => { throw new Error(`invalid command (${source}): ${why}`); };
    const c = mod && mod.config;
    if (!c || typeof c !== 'object' || typeof mod.onStart !== 'function') fail('needs a config object and an onStart function');
    if (typeof c.name !== 'string' || !REG_NAME_RE.test(c.name)) fail('config.name must match ^[a-z][a-z0-9_-]{0,31}$');
    const aliases = c.aliases === undefined ? [] : c.aliases;
    if (!Array.isArray(aliases) || aliases.length > 5 || !aliases.every((a) => typeof a === 'string' && REG_NAME_RE.test(a))) fail('config.aliases invalid');
    if (typeof c.description !== 'string' || c.description.length === 0 || c.description.length > 200) fail('config.description required (max 200 chars)');
    const role = c.role === undefined ? 0 : c.role;
    if (role !== 0 && role !== 1) fail('config.role must be 0 or 1');
    const cooldown = c.cooldown === undefined ? null : c.cooldown;
    if (cooldown !== null && !(Number.isFinite(cooldown) && cooldown >= 0 && cooldown <= 3600)) fail('config.cooldown invalid');
    const category = typeof c.category === 'string' && c.category.length > 0 && c.category.length <= 32 ? c.category : 'general';
    const usage = typeof c.usage === 'string' && c.usage.length <= 120 ? c.usage : `{p}${c.name}`;
    const examples = Array.isArray(c.examples) ? c.examples.filter((x) => typeof x === 'string' && x.length <= 120).slice(0, 5) : [];
    const names = [c.name, ...aliases];
    if (new Set(names).size !== names.length) fail('name and aliases must be unique');
    for (const n of names) if (this.lookup.has(n)) fail(`name or alias "${n}" already registered`);
    const meta = Object.freeze({
      name: c.name, aliases: Object.freeze([...aliases]), description: c.description, usage,
      examples: Object.freeze(examples), category, role,
    });
    const entry = Object.freeze({ name: c.name, role, cooldown, meta, onStart: mod.onStart.bind(mod) });
    this.commands.set(c.name, entry);
    for (const n of names) this.lookup.set(n, entry);
    this.publicList.push(meta);
    this.publicList.sort((a, b) => a.name.localeCompare(b.name));
    return meta;
  }

  /** Auto-discovers every scripts/cmds/<name>.js; adding a file needs no handler change. */
  loadCommands(dir = this.commandsDir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) {
      this.logger.error('commands_dir_unreadable', { err });
      return 0;
    }
    let loaded = 0;
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (!e.isFile() || !FILE_RE.test(e.name)) continue;
      try { this.registerCommand(require(path.join(dir, e.name)), e.name); loaded++; } catch (err) {
        this.logger.error('command_load_failed', { file: e.name, err });
      }
    }
    this.logger.info('commands_loaded', { count: loaded });
    return loaded;
  }

  visibleCommands(isAdmin) { return this.publicList.filter((c) => isAdmin || c.role === 0); }

  /* ---- ingress (synchronous, cheap, never throws) ---- */
  onMessage(event) {
    try {
      if (this.closed || this.guard.isSuspended()) return 'ignored';
      const ev = this._validateEvent(event);
      if (!ev) { this.stats.malformed++; return 'malformed'; }
      const now = Date.now();
      if (this.dedupe.has(ev.id, now)) { this.stats.duplicate++; return 'duplicate'; }
      this.dedupe.set(ev.id, this.config.dedupe.ttlSeconds * 1000, now);
      if (!ev.text.startsWith(this.config.prefix) && !GREETING_RE.test(ev.text.trim())) return 'ignored';
      this.stats.received++;
      const u = this.userLimiter.hit(ev.senderId, now);
      const t = u.allowed ? this.threadLimiter.hit(ev.threadId, now) : u;
      if (!u.allowed || !t.allowed) {
        this.stats.rateLimited++;
        const nk = `rl:${ev.senderId}`; // tell the user once per window, then stay silent
        if (this.notices.remaining(nk, now) === 0) {
          this.notices.set(nk, Math.max(1000, t.retryAfterMs), now);
          this.queue.push(ev.threadId, { kind: 'notice', threadId: ev.threadId, text: MSG.rateLimited });
        }
        return 'rate_limited';
      }
      if (!this.queue.push(ev.threadId, { kind: 'message', ev })) { this.stats.dropped++; return 'dropped'; }
      return 'accepted';
    } catch (err) {
      this.logger.error('on_message_failed', { err });
      return 'error';
    }
  }

  _validateEvent(e) {
    if (!e || typeof e !== 'object') return null;
    const { id, threadId, senderId, text } = e;
    if (typeof id !== 'string' || !ID_RE.test(id)) return null;
    if (typeof threadId !== 'string' || !SAFE_ID_RE.test(threadId)) return null;
    if (typeof senderId !== 'string' || !SAFE_ID_RE.test(senderId)) return null;
    if (typeof text !== 'string' || text.length === 0 || text.length > HARD_TEXT_LIMIT) return null;
    return { id, threadId, senderId, text: text.normalize('NFKC').replace(CONTROL_RE, '') };
  }

  /* ---- worker ---- */
  async _process(job) {
    if (job.kind === 'notice') { await this.outbound.send(job.threadId, job.text); return; }
    const ev = job.ev;
    const cfg = this.config;
    this.stats.processed++;
    const isAdmin = this.adminSet.has(ev.senderId);
    const reply = (text) => this.outbound.send(ev.threadId, clip(String(text), cfg.limits.maxReplyLength));

    if (ev.text.length > cfg.limits.maxMessageLength) { await reply(MSG.tooLong); return; }
    if (cfg.maintenance.enabled && !isAdmin) { await reply(cfg.maintenance.message); return; }
    if (!ev.text.startsWith(cfg.prefix)) { await reply(MSG.greeting); return; }

    const parsed = parseCommand(ev.text, cfg.prefix, cfg.limits);
    if (parsed.error === 'empty') { await reply(MSG.greeting); return; }
    if (parsed.error === 'too_many_args' || parsed.error === 'arg_too_long') { await reply(MSG.badArgs(cfg.prefix)); return; }
    const cmd = parsed.error ? undefined : this.lookup.get(parsed.name);
    if (!cmd) { await reply(MSG.unknownCommand(cfg.prefix)); return; } // never echoes user input

    if (cmd.role > 0 && !isAdmin) {
      this.logger.warn('unauthorized_admin_attempt', { command: cmd.name, user: pseudonym(ev.senderId) });
      await reply(MSG.adminOnly);
      return;
    }

    if (!isAdmin) {
      const now = Date.now();
      const cmdKey = `${cmd.name}\u0000${ev.senderId}`;
      const rem = Math.max(this.userCd.remaining(ev.senderId, now), this.threadCd.remaining(ev.threadId, now), this.cmdCd.remaining(cmdKey, now));
      if (rem > 0) {
        const nk = `cd:${ev.senderId}`;
        if (this.notices.remaining(nk, now) === 0) { this.notices.set(nk, rem, now); await reply(MSG.cooldown); }
        return;
      }
      const cd = cfg.cooldowns;
      if (cd.perUserSeconds > 0) this.userCd.set(ev.senderId, cd.perUserSeconds * 1000, now);
      if (cd.perThreadSeconds > 0) this.threadCd.set(ev.threadId, cd.perThreadSeconds * 1000, now);
      const cmdMs = (cmd.cooldown === null ? cd.defaultSeconds : cmd.cooldown) * 1000;
      if (cmdMs > 0) this.cmdCd.set(cmdKey, cmdMs, now);
    }

    await this._execute(cmd, parsed, ev, isAdmin, reply);
  }

  async _execute(cmd, parsed, ev, isAdmin, reply) {
    const ac = new AbortController();
    const ctx = Object.freeze({
      botName: this.config.botName,
      prefix: this.config.prefix,
      args: Object.freeze(parsed.args.slice()),
      argsText: parsed.argsText,
      threadId: ev.threadId,
      user: Object.freeze({ id: ev.senderId, isAdmin }),
      commands: this.visibleCommands(isAdmin),      // metadata only, role-filtered
      config: this.publicConfig,                    // no admin list, no secrets
      signal: ac.signal,                            // aborted on timeout/failure
      reply,                                        // async (text) => boolean
      formatTime: (d = new Date()) => this.timeFmt.format(d),
      log: (msg, fields) => this.logger.info(msg, { command: cmd.name, ...fields }),
    });
    try {
      await this.outbound.typing(ev.threadId);
      await withTimeout(Promise.resolve(cmd.onStart(ctx)), this.config.limits.commandTimeoutMs, () => new Error('command_timeout'));
    } catch (err) {
      ac.abort();
      this.logger.error('command_failed', { command: cmd.name, user: pseudonym(ev.senderId), err });
      await reply(MSG.tempError);
    }
  }

  _sweep() {
    const now = Date.now();
    [this.dedupe, this.notices, this.userCd, this.threadCd, this.cmdCd].forEach((m) => m.sweep(now));
    this.userLimiter.sweep(now); this.threadLimiter.sweep(now);
    if (this.stats.dropped > this._lastDropLogged) {
      this.logger.warn('queue_overflow', { dropped: this.stats.dropped - this._lastDropLogged });
      this._lastDropLogged = this.stats.dropped;
    }
  }

  /** Stop accepting new events, then wait (bounded) for in-flight work. */
  async stop(timeoutMs) {
    this.closed = true;
    clearInterval(this.sweepTimer);
    try {
      await withTimeout(this.queue.idle(), timeoutMs, () => new Error('drain_timeout'));
      return { drained: true };
    } catch {
      return { drained: false, pending: this.queue.size + this.queue.running };
    }
  }
}

function createCommandHandler(opts) { return new CommandHandler(opts); }

module.exports = {
  MSG, TransportError, AuthGuard, AUTH_KINDS, isAuthKind, classify,
  sleep, withTimeout, backoffDelay, pseudonym, makeTimeFormatter, parseCommand,
  TtlMap, WindowLimiter, FairQueue, CircuitBreaker, Outbound, createCommandHandler,
};
