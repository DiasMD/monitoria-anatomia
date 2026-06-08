require('dotenv').config();
const express  = require('express');
const session  = require('express-session');
const multer   = require('multer');
const { DatabaseSync } = require('node:sqlite');
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

const MONITOR_USER   = process.env.MONITOR_USER   || 'monitores.ufma';
const MONITOR_PASS   = process.env.MONITOR_PASS   || 'monitoriatopografica123';
const SESSION_SECRET = process.env.SESSION_SECRET || 'ufma-anatomia-secret-2024';
const DATA_DIR    = process.env.ANATOMIA_DATA_DIR || path.join(require('os').homedir(), '.anatomia-data');
const DB_PATH     = process.env.DB_PATH        || path.join(DATA_DIR, 'data.db');
const UPLOADS_DIR = process.env.UPLOADS_PATH   || path.join(DATA_DIR, 'uploads');

// ── Pastas ────────────────────────────────────────────────
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ── Migração automática: move dados da pasta antiga (dentro do projeto) ──
(function migrateOldData() {
  const oldDb = path.join(__dirname, 'data.db');
  const oldUploads = path.join(__dirname, 'uploads');
  if (fs.existsSync(oldDb) && !fs.existsSync(DB_PATH)) {
    try { fs.copyFileSync(oldDb, DB_PATH); fs.unlinkSync(oldDb); } catch {}
  }
  if (fs.existsSync(oldUploads) && oldUploads !== UPLOADS_DIR) {
    try {
      for (const f of fs.readdirSync(oldUploads)) {
        const src = path.join(oldUploads, f);
        const dst = path.join(UPLOADS_DIR, f);
        if (!fs.existsSync(dst)) fs.copyFileSync(src, dst);
      }
    } catch {}
  }
})();

// ── Banco de dados ────────────────────────────────────────
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS modules (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    position   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    DEFAULT (datetime('now'))
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS questions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    position   INTEGER NOT NULL DEFAULT 0,
    image_url  TEXT    NOT NULL DEFAULT '',
    image_data TEXT    DEFAULT '',
    filename   TEXT    DEFAULT '',
    pin_x      REAL,
    pin_y      REAL,
    answer     TEXT    DEFAULT '',
    notes      TEXT    DEFAULT '',
    module_id  INTEGER,
    created_at TEXT    DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS students (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    UNIQUE NOT NULL,
    password_hash TEXT    NOT NULL,
    password_salt TEXT    NOT NULL,
    photo_url     TEXT    DEFAULT '',
    created_at    TEXT    DEFAULT (datetime('now'))
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS simulation_results (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id   INTEGER NOT NULL,
    question_id  INTEGER NOT NULL,
    correct      INTEGER NOT NULL DEFAULT 0,
    simulated_at TEXT    DEFAULT (datetime('now')),
    FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
  )
`);

// Migrações para instalações antigas
['module_id INTEGER', 'image_url TEXT DEFAULT ""', 'hint TEXT DEFAULT ""'].forEach(col => {
  try { db.exec(`ALTER TABLE questions ADD COLUMN ${col}`); } catch {}
});

// ── Migração: base64 → arquivo ────────────────────────────
// Converte imagens antigas (salvas como base64) para arquivos reais.
// Roda uma vez ao iniciar; questões já migradas são ignoradas.
function migrateBase64() {
  const rows = db.prepare(
    `SELECT id, image_data FROM questions
     WHERE (image_url IS NULL OR image_url = '')
       AND image_data IS NOT NULL AND image_data LIKE 'data:%'`
  ).all();
  if (!rows.length) return;
  console.log(`[migração] convertendo ${rows.length} imagem(ns) de base64 para arquivo...`);
  for (const row of rows) {
    try {
      const m   = row.image_data.match(/^data:([^;]+);base64,(.+)$/s);
      if (!m) continue;
      const ext      = (m[1].split('/')[1] || 'jpg').replace('jpeg', 'jpg');
      const filename = `img-${row.id}-${Date.now()}.${ext}`;
      fs.writeFileSync(path.join(UPLOADS_DIR, filename), Buffer.from(m[2], 'base64'));
      db.prepare(`UPDATE questions SET image_url=?, image_data='' WHERE id=?`)
        .run(`/uploads/${filename}`, row.id);
      console.log(`  ✓ questão ${row.id} → ${filename}`);
    } catch (err) {
      console.error(`  ✗ questão ${row.id}:`, err.message);
    }
  }
}
migrateBase64();

// ── Upload com multer ─────────────────────────────────────
const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `img-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } });

const photoStorage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `foto-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});
const photoUpload = multer({ storage: photoStorage, limits: { fileSize: 5 * 1024 * 1024 } });

// ── Hashing de senha ──────────────────────────────────────
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}
function verifyPassword(password, hash, salt) {
  try {
    const derived = crypto.scryptSync(password, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(derived, 'hex'), Buffer.from(hash, 'hex'));
  } catch { return false; }
}

// ── Middleware ────────────────────────────────────────────
app.use(express.json({ limit: '50mb' })); // menor agora — sem base64
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 },
}));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR)); // serve os arquivos de imagem

function requireMonitor(req, res, next) {
  if (req.session?.isMonitor) return next();
  res.status(401).json({ error: 'Não autorizado' });
}
function requireStudent(req, res, next) {
  if (req.session?.studentId) return next();
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
app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/me', (req, res) => res.json({ isMonitor: !!req.session?.isMonitor }));

// ── Módulos ───────────────────────────────────────────────
app.get('/api/modules', (req, res) => {
  const rows   = db.prepare('SELECT * FROM modules ORDER BY position ASC, id ASC').all();
  const counts = {};
  db.prepare('SELECT module_id, COUNT(*) as n FROM questions GROUP BY module_id')
    .all().forEach(r => { counts[r.module_id] = r.n; });
  res.json(rows.map(m => ({ ...m, question_count: counts[m.id] || 0 })));
});
app.post('/api/modules', requireMonitor, (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Nome obrigatório' });
  const { m } = db.prepare('SELECT COALESCE(MAX(position),-1) as m FROM modules').get();
  const r = db.prepare('INSERT INTO modules (name, position) VALUES (?,?)').run(name, m + 1);
  res.json(db.prepare('SELECT * FROM modules WHERE id=?').get(r.lastInsertRowid));
});
app.put('/api/modules/:id', requireMonitor, (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Nome obrigatório' });
  db.prepare('UPDATE modules SET name=? WHERE id=?').run(name, req.params.id);
  res.json(db.prepare('SELECT * FROM modules WHERE id=?').get(req.params.id));
});
app.delete('/api/modules/:id', requireMonitor, (req, res) => {
  db.prepare('UPDATE questions SET module_id=NULL WHERE module_id=?').run(req.params.id);
  db.prepare('DELETE FROM modules WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── Questions ─────────────────────────────────────────────
function rowToQuestion(row) {
  // image_url tem prioridade; fallback para base64 legado
  return { ...row, image_data: row.image_url || row.image_data };
}

app.get('/api/questions', (req, res) => {
  const { modules } = req.query;
  let sql = `SELECT id, position,
    CASE WHEN image_url != '' THEN image_url ELSE image_data END as image_data,
    filename, pin_x, pin_y, answer, notes, hint, module_id
    FROM questions`;
  const params = [];
  if (modules) {
    const ids = modules.split(',').map(Number).filter(Boolean);
    if (ids.length) {
      sql += ` WHERE module_id IN (${ids.map(() => '?').join(',')})`;
      params.push(...ids);
    }
  }
  sql += ' ORDER BY position ASC, id ASC';
  res.json(db.prepare(sql).all(...params));
});

// Upload de arquivo real (multipart/form-data)
app.post('/api/questions', requireMonitor, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Arquivo de imagem obrigatório' });
  const imageUrl = `/uploads/${req.file.filename}`;
  const { module_id, pin_x, pin_y, answer, notes, hint } = req.body;
  const { m } = db.prepare('SELECT COALESCE(MAX(position),-1) as m FROM questions').get();
  const result = db.prepare(
    `INSERT INTO questions (position, image_url, image_data, filename, pin_x, pin_y, answer, notes, hint, module_id)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(m + 1, imageUrl, '', req.file.originalname, pin_x ?? null, pin_y ?? null,
        answer || '', notes || '', hint || '', module_id ? parseInt(module_id) : null);
  res.json(rowToQuestion(db.prepare('SELECT * FROM questions WHERE id=?').get(result.lastInsertRowid)));
});

// Importação via JSON (base64) — para arquivos exportados
app.post('/api/questions/import-json', requireMonitor, (req, res) => {
  const { image_data, filename, pin_x, pin_y, answer, notes, hint, module_id } = req.body;
  if (!image_data) return res.status(400).json({ error: 'image_data obrigatório' });

  // Converte base64 para arquivo
  let imageUrl = '';
  try {
    const match = image_data.match(/^data:([^;]+);base64,(.+)$/s);
    if (match) {
      const ext = (match[1].split('/')[1] || 'jpg').replace('jpeg', 'jpg');
      const fname = `img-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
      fs.writeFileSync(path.join(UPLOADS_DIR, fname), Buffer.from(match[2], 'base64'));
      imageUrl = `/uploads/${fname}`;
    }
  } catch {}

  const { m } = db.prepare('SELECT COALESCE(MAX(position),-1) as m FROM questions').get();
  const result = db.prepare(
    `INSERT INTO questions (position, image_url, image_data, filename, pin_x, pin_y, answer, notes, hint, module_id)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(m + 1, imageUrl, imageUrl ? '' : image_data, filename || '',
        pin_x ?? null, pin_y ?? null, answer || '', notes || '', hint || '',
        module_id ? parseInt(module_id) : null);
  res.json(rowToQuestion(db.prepare('SELECT * FROM questions WHERE id=?').get(result.lastInsertRowid)));
});

app.put('/api/questions/:id', requireMonitor, (req, res) => {
  const { pin_x, pin_y, answer, notes, hint, module_id } = req.body;
  db.prepare(
    'UPDATE questions SET pin_x=?, pin_y=?, answer=?, notes=?, hint=?, module_id=? WHERE id=?'
  ).run(pin_x ?? null, pin_y ?? null, answer || '', notes || '', hint || '',
        module_id !== undefined ? (module_id ? parseInt(module_id) : null) : null,
        req.params.id);
  res.json(rowToQuestion(db.prepare('SELECT * FROM questions WHERE id=?').get(req.params.id)));
});

function deleteImageFile(imageUrl) {
  if (!imageUrl?.startsWith('/uploads/')) return;
  try { fs.unlinkSync(path.join(UPLOADS_DIR, path.basename(imageUrl))); } catch {}
}

app.delete('/api/questions', requireMonitor, (req, res) => {
  db.prepare("SELECT image_url FROM questions WHERE image_url != ''").all()
    .forEach(r => deleteImageFile(r.image_url));
  db.prepare('DELETE FROM questions').run();
  res.json({ ok: true });
});

app.delete('/api/questions/:id', requireMonitor, (req, res) => {
  const q = db.prepare('SELECT image_url FROM questions WHERE id=?').get(req.params.id);
  deleteImageFile(q?.image_url);
  db.prepare('DELETE FROM questions WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/questions/reorder', requireMonitor, (req, res) => {
  const upd = db.prepare('UPDATE questions SET position=? WHERE id=?');
  db.exec('BEGIN');
  try {
    req.body.order.forEach(({ id, position }) => upd.run(position, id));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  res.json({ ok: true });
});

// ── Backup / Restore completo ────────────────────────────
// Exporta todas as questões com as imagens embutidas (base64)
// para que o backup seja auto-suficiente, independente de onde
// os arquivos estejam no servidor.
app.get('/api/backup', requireMonitor, (req, res) => {
  const questions = db.prepare(`
    SELECT id, position, image_url, image_data, filename,
           pin_x, pin_y, answer, notes, module_id
    FROM questions ORDER BY position ASC, id ASC
  `).all();

  const modules = db.prepare('SELECT * FROM modules ORDER BY position ASC').all();

  const enriched = questions.map(q => {
    let imageBase64 = q.image_data || '';

    // Se a imagem é um arquivo, lê e converte para base64
    if (q.image_url && q.image_url.startsWith('/uploads/')) {
      const filepath = path.join(UPLOADS_DIR, path.basename(q.image_url));
      try {
        const buf = fs.readFileSync(filepath);
        const ext = path.extname(q.image_url).replace('.', '') || 'jpg';
        const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
        imageBase64 = `data:${mime};base64,${buf.toString('base64')}`;
      } catch {}
    }

    return {
      filename:  q.filename,
      image_data: imageBase64,
      pin_x:     q.pin_x,
      pin_y:     q.pin_y,
      answer:    q.answer,
      notes:     q.notes,
      module_id: q.module_id,
    };
  });

  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Disposition', `attachment; filename="backup-anatomia-${stamp}.json"`);
  res.setHeader('Content-Type', 'application/json');
  res.json({ version: 3, createdAt: new Date().toISOString(), modules, questions: enriched });
});

// ── Alunos ────────────────────────────────────────────────
app.post('/api/alunos/registro', photoUpload.single('foto'), (req, res) => {
  const { username, password } = req.body;
  if (!username?.trim() || !password)
    return res.status(400).json({ error: 'Usuário e senha obrigatórios' });
  if (db.prepare('SELECT id FROM students WHERE username=?').get(username.trim()))
    return res.status(409).json({ error: 'Usuário já existe' });
  const { hash, salt } = hashPassword(password);
  const photoUrl = req.file ? `/uploads/${req.file.filename}` : '';
  const r = db.prepare(
    'INSERT INTO students (username, password_hash, password_salt, photo_url) VALUES (?,?,?,?)'
  ).run(username.trim(), hash, salt, photoUrl);
  req.session.studentId = Number(r.lastInsertRowid);
  req.session.studentUsername = username.trim();
  res.json({ ok: true, student: { id: Number(r.lastInsertRowid), username: username.trim(), photo_url: photoUrl } });
});

app.post('/api/alunos/login', (req, res) => {
  const { username, password } = req.body;
  const s = db.prepare('SELECT * FROM students WHERE username=?').get((username || '').trim());
  if (!s || !verifyPassword(password || '', s.password_hash, s.password_salt))
    return res.status(401).json({ error: 'Usuário ou senha incorretos' });
  req.session.studentId = s.id;
  req.session.studentUsername = s.username;
  res.json({ ok: true, student: { id: s.id, username: s.username, photo_url: s.photo_url } });
});

app.post('/api/alunos/logout', (req, res) => {
  delete req.session.studentId;
  delete req.session.studentUsername;
  res.json({ ok: true });
});

app.get('/api/alunos/me', (req, res) => {
  if (!req.session?.studentId) return res.json({ student: null });
  const s = db.prepare('SELECT id, username, photo_url FROM students WHERE id=?').get(req.session.studentId);
  res.json({ student: s || null });
});

app.get('/api/alunos', requireMonitor, (req, res) => {
  const rows = db.prepare(`
    SELECT s.id, s.username, s.photo_url, s.created_at,
           COUNT(CASE WHEN sr.correct = 1 THEN 1 END) as acertos,
           COUNT(sr.id) as total
    FROM students s
    LEFT JOIN simulation_results sr ON sr.student_id = s.id
    GROUP BY s.id
    ORDER BY s.username ASC
  `).all();
  res.json(rows);
});

app.put('/api/alunos/:id', requireMonitor, photoUpload.single('foto'), (req, res) => {
  const s = db.prepare('SELECT * FROM students WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Aluno não encontrado' });
  const newUsername = (req.body.username || '').trim() || s.username;
  if (newUsername !== s.username &&
      db.prepare('SELECT id FROM students WHERE username=? AND id!=?').get(newUsername, req.params.id))
    return res.status(409).json({ error: 'Usuário já existe' });
  const photoUrl = req.file ? `/uploads/${req.file.filename}` : s.photo_url;
  db.prepare('UPDATE students SET username=?, photo_url=? WHERE id=?').run(newUsername, photoUrl, req.params.id);
  res.json(db.prepare('SELECT id, username, photo_url FROM students WHERE id=?').get(req.params.id));
});

app.delete('/api/alunos/:id', requireMonitor, (req, res) => {
  const s = db.prepare('SELECT photo_url FROM students WHERE id=?').get(req.params.id);
  if (s?.photo_url) deleteImageFile(s.photo_url);
  db.prepare('DELETE FROM simulation_results WHERE student_id=?').run(req.params.id);
  db.prepare('DELETE FROM students WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── Resultados de simulação ───────────────────────────────
app.post('/api/simulacao/resultado', requireStudent, (req, res) => {
  const { resultados } = req.body;
  if (!Array.isArray(resultados) || !resultados.length)
    return res.status(400).json({ error: 'Resultados obrigatórios' });
  const insert = db.prepare('INSERT INTO simulation_results (student_id, question_id, correct) VALUES (?,?,?)');
  db.exec('BEGIN');
  try {
    for (const r of resultados) insert.run(req.session.studentId, r.question_id, r.correct ? 1 : 0);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  res.json({ ok: true });
});

app.get('/api/alunos/me/questoes-respondidas', requireStudent, (req, res) => {
  const rows = db.prepare(
    'SELECT DISTINCT question_id FROM simulation_results WHERE student_id=?'
  ).all(req.session.studentId);
  res.json(rows.map(r => r.question_id));
});

// ── Ranking ───────────────────────────────────────────────
app.get('/api/ranking', (req, res) => {
  const ranking = db.prepare(`
    SELECT s.id, s.username, s.photo_url,
           COUNT(CASE WHEN sr.correct = 1 THEN 1 END) as acertos,
           COUNT(sr.id) as total
    FROM students s
    LEFT JOIN simulation_results sr ON sr.student_id = s.id
    GROUP BY s.id
    ORDER BY acertos DESC, s.username ASC
  `).all();
  res.json(ranking);
});

// ── Páginas ───────────────────────────────────────────────
['painel', 'simulacao', 'login', 'aluno-login', 'ranking'].forEach(page => {
  app.get(`/${page}`, (_, res) =>
    res.sendFile(path.join(__dirname, `public/${page}.html`)));
});

app.listen(PORT, () => console.log(`Servidor em http://localhost:${PORT}`));
