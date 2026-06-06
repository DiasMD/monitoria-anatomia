require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const MONITOR_USER   = process.env.MONITOR_USER   || 'monitores.ufma';
const MONITOR_PASS   = process.env.MONITOR_PASS   || 'monitoriatopografica123';
const SESSION_SECRET = process.env.SESSION_SECRET || 'ufma-anatomia-secret-2024';
const DB_PATH        = process.env.DB_PATH        || path.join(__dirname, 'data.db');

// ── Database ──────────────────────────────────────────────
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS questions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    position   INTEGER NOT NULL DEFAULT 0,
    image_data TEXT    NOT NULL,
    filename   TEXT    DEFAULT '',
    pin_x      REAL,
    pin_y      REAL,
    answer     TEXT    DEFAULT '',
    notes      TEXT    DEFAULT '',
    created_at TEXT    DEFAULT (datetime('now'))
  )
`);

// ── Middleware ────────────────────────────────────────────
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));

function requireMonitor(req, res, next) {
  if (req.session?.isMonitor) return next();
  res.status(401).json({ error: 'Não autorizado' });
}

// ── Auth ──────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === MONITOR_USER && password === MONITOR_PASS) {
    req.session.isMonitor = true;
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: 'Usuário ou senha incorretos' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  res.json({ isMonitor: !!req.session?.isMonitor });
});

// ── Questions ─────────────────────────────────────────────
app.get('/api/questions', (req, res) => {
  res.json(
    db.prepare(
      'SELECT id, position, image_data, filename, pin_x, pin_y, answer, notes FROM questions ORDER BY position ASC, id ASC'
    ).all()
  );
});

app.post('/api/questions', requireMonitor, (req, res) => {
  const { image_data, filename, pin_x, pin_y, answer, notes } = req.body;
  if (!image_data) return res.status(400).json({ error: 'image_data obrigatório' });
  const { m } = db.prepare('SELECT COALESCE(MAX(position), -1) as m FROM questions').get();
  const result = db.prepare(
    'INSERT INTO questions (position, image_data, filename, pin_x, pin_y, answer, notes) VALUES (?,?,?,?,?,?,?)'
  ).run(m + 1, image_data, filename || '', pin_x ?? null, pin_y ?? null, answer || '', notes || '');
  res.json(db.prepare('SELECT * FROM questions WHERE id = ?').get(result.lastInsertRowid));
});

app.put('/api/questions/:id', requireMonitor, (req, res) => {
  const { pin_x, pin_y, answer, notes } = req.body;
  db.prepare(
    'UPDATE questions SET pin_x=?, pin_y=?, answer=?, notes=? WHERE id=?'
  ).run(pin_x ?? null, pin_y ?? null, answer || '', notes || '', req.params.id);
  res.json(db.prepare('SELECT * FROM questions WHERE id=?').get(req.params.id));
});

app.delete('/api/questions', requireMonitor, (req, res) => {
  db.prepare('DELETE FROM questions').run();
  res.json({ ok: true });
});

app.delete('/api/questions/:id', requireMonitor, (req, res) => {
  db.prepare('DELETE FROM questions WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/questions/reorder', requireMonitor, (req, res) => {
  const upd = db.prepare('UPDATE questions SET position=? WHERE id=?');
  db.exec('BEGIN');
  try {
    req.body.order.forEach(({ id, position }) => upd.run(position, id));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  res.json({ ok: true });
});

// ── Page routes ───────────────────────────────────────────
['painel', 'simulacao', 'login'].forEach(page => {
  app.get(`/${page}`, (_, res) =>
    res.sendFile(path.join(__dirname, `public/${page}.html`))
  );
});

app.listen(PORT, () => console.log(`Servidor em http://localhost:${PORT}`));
