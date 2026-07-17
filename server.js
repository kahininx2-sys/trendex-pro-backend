// ============================================================
// Tradeline Demo — Multi-User Backend Server (SQLite version)
// - Each visitor signs up / logs in with their own account
// - Each account has its own independent virtual balance & history
// - The candle engine runs continuously on the SERVER, 24/7
// - An admin endpoint lets the site owner see every user's data
// - All data lives in a real SQLite database (data/trendex.db)
// This is a DEMO ONLY — no real money, no real deposits.
// ============================================================

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'trendex.db');
const PAYOUT = 0.87;
const CANDLE_HISTORY_MAX = 300;

// Change this before deploying anywhere real people can reach it.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'jokernx2';

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------- DATABASE SETUP ----------------
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL'); // safer + faster under concurrent access

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    salt TEXT NOT NULL,
    hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_states (
    username TEXT PRIMARY KEY REFERENCES users(username),
    state_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS deposit_requests (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    amount REAL NOT NULL,
    txid TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    unlock_password TEXT,
    requested_at TEXT NOT NULL,
    approved_at TEXT
  );

  CREATE TABLE IF NOT EXISTS withdraw_requests (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    amount REAL NOT NULL,
    withdraw_number TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    requested_at TEXT NOT NULL,
    resolved_at TEXT
  );

  CREATE TABLE IF NOT EXISTS admin_messages (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    message TEXT NOT NULL,
    reply TEXT,
    replied_at TEXT,
    sent_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_deposit_username ON deposit_requests(username);
  CREATE INDEX IF NOT EXISTS idx_withdraw_username ON withdraw_requests(username);
  CREATE INDEX IF NOT EXISTS idx_messages_username ON admin_messages(username);
`);

// ---------------- PASSWORD HASHING ----------------
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 32).toString('hex');
}
function makeSalt() {
  return crypto.randomBytes(16).toString('hex');
}

// ---------------- USERS (SQL) ----------------
const stmtGetUser = db.prepare('SELECT * FROM users WHERE username = ?');
const stmtInsertUser = db.prepare('INSERT INTO users (username, salt, hash, created_at) VALUES (?, ?, ?, ?)');
const stmtAllUsers = db.prepare('SELECT username, created_at FROM users ORDER BY created_at ASC');

// ---------------- SESSIONS (in-memory; lost on server restart) ----------------
const sessions = {}; // token -> username
function makeToken() {
  return crypto.randomBytes(24).toString('hex');
}
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const username = token && sessions[token];
  if (!username) return res.status(401).json({ error: 'Not logged in' });
  req.username = username;
  next();
}

// ---------------- PER-USER TRADING STATE (SQL, JSON blob column) ----------------
const stmtGetState = db.prepare('SELECT state_json FROM user_states WHERE username = ?');
const stmtUpsertState = db.prepare(`
  INSERT INTO user_states (username, state_json, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(username) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at
`);

function defaultState() {
  return {
    balance: 0,
    walletBalance: 0,
    price: 1.0842,
    candles: [],
    candleStartTime: Date.now(),
    timeframeSeconds: 30,
    activeTrade: null,
    tradeHistory: [],
    balanceHistory: [],
  };
}

function seedCandles(state) {
  let p = state.price;
  const now = Date.now();
  for (let i = 60; i > 0; i--) {
    const o = p;
    const drift = (Math.random() - 0.5) * 0.0009;
    const c = +(o + drift).toFixed(5);
    const h = +Math.max(o, c, o + Math.random() * 0.0004).toFixed(5);
    const l = +Math.min(o, c, o - Math.random() * 0.0004).toFixed(5);
    state.candles.push({ o, h, l, c, t: now - i * state.timeframeSeconds * 1000 });
    p = c;
  }
  state.price = p;
}

function loadState(username) {
  const row = stmtGetState.get(username);
  if (row) {
    try { return JSON.parse(row.state_json); } catch (e) { /* fall through */ }
  }
  const fresh = defaultState();
  seedCandles(fresh);
  return fresh;
}

function persistState(username, state) {
  try {
    stmtUpsertState.run(username, JSON.stringify(state), new Date().toISOString());
  } catch (e) {
    console.error('Could not persist state for', username, e.message);
  }
}

// Keep every logged-in-at-least-once user's candles ticking in memory.
const liveStates = {}; // username -> state object
function getLiveState(username) {
  if (!liveStates[username]) liveStates[username] = loadState(username);
  return liveStates[username];
}

function pushBalanceHistory(state, delta, note) {
  state.balanceHistory.unshift({ delta, note, time: new Date().toISOString() });
  if (state.balanceHistory.length > 200) state.balanceHistory.length = 200;
}

function settleTrade(state) {
  const t = state.activeTrade;
  const win = (t.direction === 'UP' && state.price > t.entryPrice) ||
              (t.direction === 'DOWN' && state.price < t.entryPrice);
  if (win) {
    const payout = t.amount * (1 + PAYOUT);
    state.balance += payout;
    pushBalanceHistory(state, payout, `Trade won (${t.direction})`);
  }
  state.tradeHistory.unshift({
    direction: t.direction, entry: t.entryPrice, exit: state.price,
    amount: t.amount, win, time: new Date().toISOString()
  });
  if (state.tradeHistory.length > 200) state.tradeHistory.length = 200;
  state.activeTrade = null;
}

// ---------------- SIMULATION LOOP ----------------
setInterval(() => {
  Object.keys(liveStates).forEach(username => {
    const state = liveStates[username];
    const cur = state.candles[state.candles.length - 1];
    if (!cur) return;
    const move = (Math.random() - 0.5) * 0.00035;
    state.price = +(state.price + move).toFixed(5);
    cur.c = state.price;
    cur.h = Math.max(cur.h, state.price);
    cur.l = Math.min(cur.l, state.price);

    const elapsed = Date.now() - state.candleStartTime;
    if (elapsed >= state.timeframeSeconds * 1000) {
      const o = state.price;
      state.candles.push({ o, h: o, l: o, c: o, t: Date.now() });
      if (state.candles.length > CANDLE_HISTORY_MAX) state.candles.shift();
      state.candleStartTime = Date.now();
    }

    if (state.activeTrade && Date.now() >= state.activeTrade.expiresAt) {
      settleTrade(state);
    }
    persistState(username, state);
  });
}, 1000);

// ---------------- AUTH ROUTES ----------------
app.post('/api/signup', (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (username.length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters' });
  if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });

  if (stmtGetUser.get(username)) return res.status(409).json({ error: 'That username is already taken' });

  const salt = makeSalt();
  const hash = hashPassword(password, salt);
  stmtInsertUser.run(username, salt, hash, new Date().toISOString());

  const fresh = defaultState();
  seedCandles(fresh);
  persistState(username, fresh);
  liveStates[username] = fresh;

  const token = makeToken();
  sessions[token] = username;
  res.json({ token, username });
});

app.post('/api/login', (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const rec = stmtGetUser.get(username);
  if (!rec || hashPassword(password, rec.salt) !== rec.hash) {
    return res.status(401).json({ error: 'Incorrect username or password' });
  }
  const token = makeToken();
  sessions[token] = username;
  getLiveState(username);
  res.json({ token, username });
});

app.post('/api/logout', authMiddleware, (req, res) => {
  const token = (req.headers.authorization || '').slice(7);
  delete sessions[token];
  res.json({ ok: true });
});

// ---------------- USER TRADING ROUTES ----------------
app.get('/api/state', authMiddleware, (req, res) => {
  const state = getLiveState(req.username);
  res.json({
    balance: state.balance,
    walletBalance: state.walletBalance,
    price: state.price,
    candles: state.candles,
    timeframeSeconds: state.timeframeSeconds,
    activeTrade: state.activeTrade,
    tradeHistory: state.tradeHistory.slice(0, 30),
    balanceHistory: state.balanceHistory.slice(0, 30),
  });
});

app.post('/api/trade', authMiddleware, (req, res) => {
  const state = getLiveState(req.username);
  if (state.activeTrade) return res.status(409).json({ error: 'A trade is already open' });
  const { direction, amount, timeframeSeconds } = req.body;
  if (!['UP', 'DOWN'].includes(direction)) return res.status(400).json({ error: 'Invalid direction' });
  const amt = Number(amount);
  if (!amt || amt <= 0 || amt > state.balance) return res.status(400).json({ error: 'Invalid amount' });

  if (timeframeSeconds) state.timeframeSeconds = timeframeSeconds;
  state.balance -= amt;
  state.activeTrade = {
    direction, entryPrice: state.price, amount: amt,
    placedAt: Date.now(), expiresAt: Date.now() + state.timeframeSeconds * 1000
  };
  pushBalanceHistory(state, -amt, `Trade opened (${direction})`);
  persistState(req.username, state);
  res.json({ ok: true });
});

app.post('/api/deposit-request', authMiddleware, (req, res) => {
  const amount = Math.max(1, Number(req.body.amount) || 0);
  const txid = String(req.body.txid || '').trim();
  const id = 'DR' + Date.now() + Math.floor(Math.random() * 1000);
  db.prepare(`
    INSERT INTO deposit_requests (id, username, amount, txid, status, requested_at)
    VALUES (?, ?, ?, ?, 'pending', ?)
  `).run(id, req.username, amount, txid, new Date().toISOString());
  res.json({ ok: true, id });
});

app.get('/api/my-deposit-requests', authMiddleware, (req, res) => {
  const rows = db.prepare('SELECT * FROM deposit_requests WHERE username = ? ORDER BY requested_at DESC').all(req.username);
  res.json({ requests: rows });
});

app.post('/api/claim-deposit', authMiddleware, (req, res) => {
  const password = String(req.body.password || '').trim();
  const match = db.prepare(`
    SELECT * FROM deposit_requests WHERE username = ? AND status = 'approved' AND unlock_password = ?
  `).get(req.username, password);
  if (!match) return res.status(400).json({ error: 'Incorrect password, or no approved request matches it' });

  const state = getLiveState(req.username);
  state.walletBalance += match.amount;
  persistState(req.username, state);
  db.prepare(`UPDATE deposit_requests SET status = 'completed' WHERE id = ?`).run(match.id);
  res.json({ ok: true, amount: match.amount });
});

app.post('/api/withdraw-request', authMiddleware, (req, res) => {
  const state = getLiveState(req.username);
  const amount = Math.max(1, Number(req.body.amount) || 0);
  const withdrawNumber = String(req.body.withdrawNumber || '').trim();
  if (amount > state.walletBalance) return res.status(400).json({ error: 'Insufficient Wallet Balance' });

  state.walletBalance -= amount; // lock funds while pending
  persistState(req.username, state);

  const id = 'WR' + Date.now() + Math.floor(Math.random() * 1000);
  db.prepare(`
    INSERT INTO withdraw_requests (id, username, amount, withdraw_number, status, requested_at)
    VALUES (?, ?, ?, ?, 'pending', ?)
  `).run(id, req.username, amount, withdrawNumber, new Date().toISOString());
  res.json({ ok: true, id });
});

app.get('/api/my-withdraw-requests', authMiddleware, (req, res) => {
  const rows = db.prepare('SELECT * FROM withdraw_requests WHERE username = ? ORDER BY requested_at DESC').all(req.username);
  res.json({ requests: rows });
});

app.post('/api/message', authMiddleware, (req, res) => {
  const message = String(req.body.message || '').trim();
  if (!message) return res.status(400).json({ error: 'Message cannot be empty' });
  const id = 'MSG' + Date.now() + Math.floor(Math.random() * 1000);
  db.prepare(`INSERT INTO admin_messages (id, username, message, sent_at) VALUES (?, ?, ?, ?)`)
    .run(id, req.username, message, new Date().toISOString());
  res.json({ ok: true });
});

app.get('/api/my-messages', authMiddleware, (req, res) => {
  const rows = db.prepare('SELECT * FROM admin_messages WHERE username = ? ORDER BY sent_at ASC').all(req.username);
  res.json({ messages: rows });
});

app.post('/api/transfer-to-trade', authMiddleware, (req, res) => {
  const state = getLiveState(req.username);
  const amount = Math.max(1, Number(req.body.amount) || 0);
  if (amount > state.walletBalance) return res.status(400).json({ error: 'Insufficient Wallet Balance' });
  state.walletBalance -= amount;
  state.balance += amount;
  pushBalanceHistory(state, amount, 'Transferred from Wallet');
  persistState(req.username, state);
  res.json({ ok: true });
});

app.post('/api/transfer-to-wallet', authMiddleware, (req, res) => {
  const state = getLiveState(req.username);
  const amount = Math.max(1, Number(req.body.amount) || 0);
  if (amount > state.balance) return res.status(400).json({ error: 'Insufficient Trade Balance' });
  state.balance -= amount;
  state.walletBalance += amount;
  pushBalanceHistory(state, -amount, 'Moved to Wallet');
  persistState(req.username, state);
  res.json({ ok: true });
});

// ---------------- ADMIN ROUTES (password-protected) ----------------
function checkAdminPassword(pwd, res) {
  if (pwd !== ADMIN_PASSWORD) {
    res.status(401).json({ error: 'Incorrect admin password' });
    return false;
  }
  return true;
}

app.get('/api/admin/users', (req, res) => {
  if (!checkAdminPassword(req.query.password, res)) return;
  const users = stmtAllUsers.all();
  const list = users.map(u => {
    const state = liveStates[u.username] || loadState(u.username);
    return {
      username: u.username,
      createdAt: u.created_at,
      balance: state.balance,
      walletBalance: state.walletBalance,
      tradeCount: state.tradeHistory.length,
    };
  });
  res.json({ users: list });
});

app.get('/api/admin/deposit-requests', (req, res) => {
  if (!checkAdminPassword(req.query.password, res)) return;
  const rows = db.prepare('SELECT * FROM deposit_requests ORDER BY requested_at DESC').all();
  res.json({ requests: rows });
});

app.post('/api/admin/approve-deposit', (req, res) => {
  if (!checkAdminPassword(req.body.password, res)) return;
  const id = req.body.id;
  const unlockPassword = String(Math.floor(100000 + Math.random() * 900000));
  db.prepare(`UPDATE deposit_requests SET status = 'approved', unlock_password = ?, approved_at = ? WHERE id = ?`)
    .run(unlockPassword, new Date().toISOString(), id);
  res.json({ ok: true, unlockPassword });
});

app.post('/api/admin/reject-deposit', (req, res) => {
  if (!checkAdminPassword(req.body.password, res)) return;
  db.prepare(`UPDATE deposit_requests SET status = 'rejected', approved_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), req.body.id);
  res.json({ ok: true });
});

app.get('/api/admin/withdraw-requests', (req, res) => {
  if (!checkAdminPassword(req.query.password, res)) return;
  const rows = db.prepare('SELECT * FROM withdraw_requests ORDER BY requested_at DESC').all();
  res.json({ requests: rows });
});

app.post('/api/admin/approve-withdraw', (req, res) => {
  if (!checkAdminPassword(req.body.password, res)) return;
  const row = db.prepare('SELECT * FROM withdraw_requests WHERE id = ?').get(req.body.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare(`UPDATE withdraw_requests SET status = 'approved', resolved_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), req.body.id);
  const state = liveStates[row.username] || loadState(row.username);
  state.balanceHistory = state.balanceHistory || [];
  state.balanceHistory.unshift({ delta: -row.amount, note: 'Withdraw approved', time: new Date().toISOString() });
  persistState(row.username, state);
  res.json({ ok: true });
});

app.post('/api/admin/reject-withdraw', (req, res) => {
  if (!checkAdminPassword(req.body.password, res)) return;
  const row = db.prepare('SELECT * FROM withdraw_requests WHERE id = ?').get(req.body.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare(`UPDATE withdraw_requests SET status = 'rejected', resolved_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), req.body.id);
  // refund the locked amount
  const state = liveStates[row.username] || loadState(row.username);
  state.walletBalance += row.amount;
  persistState(row.username, state);
  res.json({ ok: true });
});

app.get('/api/admin/messages', (req, res) => {
  if (!checkAdminPassword(req.query.password, res)) return;
  const rows = db.prepare('SELECT * FROM admin_messages ORDER BY sent_at DESC').all();
  res.json({ messages: rows });
});

app.post('/api/admin/reply-message', (req, res) => {
  if (!checkAdminPassword(req.body.password, res)) return;
  db.prepare(`UPDATE admin_messages SET reply = ?, replied_at = ? WHERE id = ?`)
    .run(String(req.body.reply || '').trim(), new Date().toISOString(), req.body.id);
  res.json({ ok: true });
});

app.post('/api/admin/reset', (req, res) => {
  if (!checkAdminPassword(req.body.password, res)) return;
  const username = String(req.body.username || '').trim().toLowerCase();
  if (!username) return res.status(400).json({ error: 'Username required' });
  const fresh = defaultState();
  seedCandles(fresh);
  liveStates[username] = fresh;
  persistState(username, fresh);
  res.json({ ok: true });
});

// ---------------- STARTUP ----------------
app.listen(PORT, () => {
  console.log(`Tradeline multi-user demo server running on port ${PORT}`);
  console.log(`Database: ${DB_FILE}`);
  console.log(`Admin panel API: GET /api/admin/users?password=${ADMIN_PASSWORD}`);
});
