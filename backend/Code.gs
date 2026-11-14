/**
 * English Desk — серверная часть кабинета (Google Apps Script).
 *
 * Хранит данные в этой Google Таблице и проверяет, что каждый запрос
 * действительно пришёл из Telegram от конкретного человека.
 *
 * Настройка (один раз):
 *   1. Настройки проекта (шестерёнка) → Свойства скрипта → добавить
 *      BOT_TOKEN = токен от @BotFather.
 *   2. Начать развертывание → Новое развертывание → Веб-приложение,
 *      «Выполнять от имени: я», «Доступ: все».
 *   3. Первый человек, открывший кабинет в Telegram, становится учителем.
 *      Поэтому откройте его первой сами.
 *
 * Листы создаются автоматически. Их можно читать и править руками:
 * не меняйте только первую строку (названия колонок) и колонку id.
 */

var TABS = {
  students: 'Ученики',
  homework: 'Домашка',
  words: 'Слова',
  lessons: 'Занятия',
  payments: 'Оплаты',
  progress: 'Прогресс',
  hwprog: 'Ответы ДЗ',
  pending: 'Ожидают'
};
var COLS = {
  students: ['id', 'name', 'tg_id', 'tg_name', 'invite', 'created', 'lang', 'skin', 'modes_off'],
  homework: ['id', 'student', 'date', 'title', 'focus', 'url', 'checked', 'tasks'],
  words: ['id', 'student', 'word', 'meaning', 'ru', 'example', 'cloze', 'lesson'],
  lessons: ['id', 'student', 'date', 'kind', 'note'],
  payments: ['id', 'student', 'date', 'count', 'note'],
  progress: ['id', 'student', 'data', 'updated'],
  hwprog: ['id', 'student', 'hw', 'data', 'updated'],
  pending: ['id', 'tg_name', 'username', 'seen']
};
var CONTENT = ['homework', 'words', 'lessons', 'payments'];
var SKINS = ['doodle', 'game', 'elegant', 'sticker'];
// Режимы повторения слов: интервальное повторение и шесть игр.
var MODES = ['review', 'cards', 'context', 'speed', 'match', 'cross', 'spell'];
var MAX_AGE_SEC = 7 * 24 * 3600;

/* ---------------- HTTP ---------------- */

function doGet() {
  return ContentService.createTextOutput('English Desk: сервер работает.');
}

function doPost(e) {
  var out;
  try {
    var req = JSON.parse(e.postData.contents);
    out = handle(req);
  } catch (err) {
    out = { error: String(err && err.message ? err.message : err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ---------------- Telegram check ---------------- */

function bytesToHex(bytes) {
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function verifyTelegram(initData) {
  var token = PropertiesService.getScriptProperties().getProperty('BOT_TOKEN');
  if (!token) throw new Error('setup: в свойствах скрипта нет BOT_TOKEN');
  if (!initData) throw new Error('auth: нет данных Telegram');
  var params = {};
  String(initData).split('&').forEach(function (pair) {
    if (!pair) return;
    var i = pair.indexOf('=');
    var k = decodeURIComponent(pair.slice(0, i).replace(/\+/g, '%20'));
    var v = decodeURIComponent(pair.slice(i + 1).replace(/\+/g, '%20'));
    params[k] = v;
  });
  var hash = params.hash;
  delete params.hash;
  var check = Object.keys(params).sort().map(function (k) { return k + '=' + params[k]; }).join('\n');
  var secret = Utilities.computeHmacSha256Signature(
    Utilities.newBlob(token).getBytes(), Utilities.newBlob('WebAppData').getBytes());
  var sig = Utilities.computeHmacSha256Signature(Utilities.newBlob(check).getBytes(), secret);
  if (!hash || bytesToHex(sig) !== String(hash).toLowerCase()) throw new Error('auth: подпись Telegram не совпала');
  var age = Math.floor(Date.now() / 1000) - Number(params.auth_date || 0);
  if (age > MAX_AGE_SEC) throw new Error('auth: сессия устарела, закройте и откройте кабинет заново');
  var user = JSON.parse(params.user || '{}');
  if (!user.id) throw new Error('auth: нет пользователя');
  return { user: user, start: params.start_param || '' };
}

/* ---------------- main ---------------- */

function handle(req) {
  var tg = verifyTelegram(req.initData);
  var uid = String(tg.user.id);
  var tgName = [tg.user.first_name, tg.user.last_name].filter(Boolean).join(' ');
  var props = PropertiesService.getScriptProperties();

  var teacherId = props.getProperty('TEACHER_ID');
  if (!teacherId) {
    withLock(function () {
      teacherId = props.getProperty('TEACHER_ID');
      if (!teacherId) { teacherId = uid; props.setProperty('TEACHER_ID', uid); }
    });
  }
  var isTeacher = uid === teacherId;
  var a = req.action;

  if (isTeacher) return teacherAction(a, req);

  var me = findBy('students', 'tg_id', uid);
  var code = tg.start || req.invite || '';
  if (!me && code) {
    withLock(function () {
      var inv = findBy('students', 'invite', code);
      if (inv && !inv.tg_id) {
        inv.tg_id = uid; inv.tg_name = tgName + (tg.user.username ? ' @' + tg.user.username : '');
        writeRow('students', inv);
        removeRow('pending', uid);
        me = inv;
      }
    });
  }
  if (!me) {
    withLock(function () {
      writeRow('pending', { id: uid, tg_name: tgName, username: tg.user.username || '', seen: new Date().toISOString() });
    });
    return { role: 'guest', name: tg.user.first_name || '' };
  }
  return studentAction(a, req, me);
}

function teacherAction(a, req) {
  if (a === 'me') return { role: 'teacher', students: listStudents(), pending: readAll('pending').map(clean) };
  if (a === 'load') return loadFor(mustStudent(req.student));
  if (a === 'addStudent') {
    var name = String(req.name || '').trim();
    if (!name) throw new Error('Нужно имя ученика');
    return withLock(function () {
      var s = { id: newId(), name: name, invite: newCode(), created: new Date().toISOString() };
      writeRow('students', s);
      return { student: clean(s), students: listStudents() };
    });
  }
  if (a === 'renameStudent') {
    return withLock(function () {
      var s = mustStudent(req.student); s.name = String(req.name || '').trim() || s.name;
      writeRow('students', s); return { students: listStudents() };
    });
  }
  if (a === 'setLang') {
    return withLock(function () {
      var s = mustStudent(req.student);
      s.lang = req.lang === 'ru' ? 'ru' : 'en';
      writeRow('students', s); return { students: listStudents() };
    });
  }
  if (a === 'setSkin') {
    return withLock(function () {
      var s = mustStudent(req.student);
      s.skin = SKINS.indexOf(req.skin) >= 0 ? req.skin : 'doodle';
      writeRow('students', s); return { students: listStudents() };
    });
  }
  if (a === 'setModes') {
    return withLock(function () {
      var s = mustStudent(req.student);
      s.modes_off = encodeModesOff(req.off);
      writeRow('students', s); return { students: listStudents() };
    });
  }
  if (a === 'resetInvite') {
    return withLock(function () {
      var s = mustStudent(req.student); s.tg_id = ''; s.tg_name = ''; s.invite = newCode();
      writeRow('students', s); return { students: listStudents() };
    });
  }
  if (a === 'link') {
    return withLock(function () {
      var s = mustStudent(req.student);
      var p = findBy('pending', 'id', String(req.tg));
      if (!p) throw new Error('Этот человек уже не в списке ожидающих');
      var other = findBy('students', 'tg_id', String(req.tg));
      if (other) { other.tg_id = ''; other.tg_name = ''; writeRow('students', other); }
      s.tg_id = String(p.id); s.tg_name = p.tg_name + (p.username ? ' @' + p.username : '');
      writeRow('students', s); removeRow('pending', p.id);
      return { students: listStudents(), pending: readAll('pending').map(clean) };
    });
  }
  if (a === 'dismissPending') {
    return withLock(function () { removeRow('pending', String(req.tg)); return { pending: readAll('pending').map(clean) }; });
  }
  if (a === 'add' || a === 'import') {
    var coll = mustContent(req.coll);
    var st = mustStudent(req.student);
    var items = a === 'add' ? [req.data] : (req.items || []);
    if (!items.length) throw new Error('Нечего добавлять');
    return withLock(function () {
      var out = items.map(function (d) {
        var rec = sanitize(d);
        rec.id = newId(); rec.student = st.id;
        writeRow(coll, rec);
        return clean(rec);
      });
      return a === 'add' ? { item: out[0] } : { items: out };
    });
  }
  if (a === 'update') {
    var c2 = mustContent(req.coll);
    return withLock(function () {
      var rec = findBy(c2, 'id', String(req.id));
      if (!rec) throw new Error('Запись не найдена');
      var d = sanitize(req.data);
      Object.keys(d).forEach(function (k) { rec[k] = d[k]; });
      writeRow(c2, rec);
      return { item: clean(rec) };
    });
  }
  if (a === 'del') {
    var c3 = mustContent(req.coll);
    return withLock(function () { removeRow(c3, String(req.id)); return { ok: true }; });
  }
  if (a === 'saveProgress' || a === 'saveHw') return { ok: true, ignored: true };
  throw new Error('Неизвестное действие: ' + a);
}

function studentAction(a, req, me) {
  if (a === 'me') return { role: 'student', student: publicStudent(me) };
  if (a === 'load') return loadFor(me);
  // Настройки кабинета: ученик меняет их сам (те же поля, что и учитель).
  if (a === 'setLang') {
    return withLock(function () {
      me.lang = req.lang === 'ru' ? 'ru' : 'en';
      writeRow('students', me); return { student: publicStudent(me) };
    });
  }
  if (a === 'setSkin') {
    return withLock(function () {
      me.skin = SKINS.indexOf(req.skin) >= 0 ? req.skin : 'doodle';
      writeRow('students', me); return { student: publicStudent(me) };
    });
  }
  if (a === 'setModes') {
    return withLock(function () {
      me.modes_off = encodeModesOff(req.off);
      writeRow('students', me); return { student: publicStudent(me) };
    });
  }
  if (a === 'saveProgress') {
    return withLock(function () {
      writeRow('progress', { id: me.id, student: me.id, data: req.data || {}, updated: new Date().toISOString() });
      return { ok: true };
    });
  }
  if (a === 'saveHw') {
    var hw = String(req.hw || '');
    if (!findBy('homework', 'id', hw)) throw new Error('Нет такого ДЗ');
    return withLock(function () {
      writeRow('hwprog', { id: me.id + '_' + hw, student: me.id, hw: hw, data: req.data || {}, updated: new Date().toISOString() });
      return { ok: true };
    });
  }
  throw new Error('Нет доступа');
}

function loadFor(s) {
  var out = { student: publicStudent(s) };
  CONTENT.forEach(function (c) {
    out[c] = readAll(c).filter(function (r) { return r.student === s.id; }).map(clean);
  });
  var p = findBy('progress', 'id', s.id);
  out.progress = p && p.data ? p.data : null;
  out.hwprog = {};
  readAll('hwprog').forEach(function (r) { if (r.student === s.id && r.data) out.hwprog[r.hw] = r.data; });
  return out;
}

/* ---------------- helpers ---------------- */

function listStudents() {
  return readAll('students').map(function (s) {
    return { id: s.id, name: s.name, invite: s.invite || '', linked: !!s.tg_id, tg_name: s.tg_name || '', lang: s.lang === 'ru' ? 'ru' : 'en', skin: skinOf(s), modes_off: modesOff(s) };
  });
}
function publicStudent(s) { return { id: s.id, name: s.name, lang: s.lang === 'ru' ? 'ru' : 'en', skin: skinOf(s), modes_off: modesOff(s) }; }
// Режимы повторения, которые выключены (в таблице — через запятую). Пусто = включено всё.
function modesOff(s) {
  return String(s.modes_off || '').split(',').filter(function (m) { return MODES.indexOf(m) >= 0; });
}
function encodeModesOff(list) {
  var off = (Array.isArray(list) ? list : []).filter(function (m, i, a) { return MODES.indexOf(m) >= 0 && a.indexOf(m) === i; });
  if (off.length >= MODES.length) off = []; // нельзя выключить всё
  return off.join(',');
}
function skinOf(s) { return SKINS.indexOf(s.skin) >= 0 ? s.skin : 'doodle'; }
function mustStudent(id) {
  var s = findBy('students', 'id', String(id || ''));
  if (!s) throw new Error('Ученик не найден');
  return s;
}
function mustContent(c) {
  if (CONTENT.indexOf(c) < 0) throw new Error('Неизвестный раздел: ' + c);
  return c;
}
function sanitize(d) {
  var o = {};
  Object.keys(d || {}).forEach(function (k) {
    if (k === 'id' || k === 'student' || k.charAt(0) === '_') return;
    if (!/^[A-Za-z][A-Za-z0-9_]{0,30}$/.test(k)) return;
    o[k] = d[k];
  });
  return o;
}
function clean(r) {
  var o = {};
  Object.keys(r).forEach(function (k) { if (k.charAt(0) !== '_') o[k] = r[k]; });
  return o;
}
function newId() { return Utilities.getUuid().replace(/-/g, '').slice(0, 12); }
function newCode() { return Utilities.getUuid().replace(/-/g, '').slice(0, 10); }
function withLock(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ---------------- sheet storage ---------------- */

var _cache = {};

function sheet(key) {
  var ss = SpreadsheetApp.getActive();
  var s = ss.getSheetByName(TABS[key]);
  if (!s) {
    s = ss.insertSheet(TABS[key]);
    var head = COLS[key];
    s.getRange(1, 1, s.getMaxRows(), 26).setNumberFormat('@');
    s.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
    s.setFrozenRows(1);
  }
  return s;
}

function decodeCell(h, x) {
  if (x instanceof Date) return Utilities.formatDate(x, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  if (h === 'checked') return x === true || String(x).toLowerCase() === 'true';
  if (h === 'count') return Number(x) || 0;
  var s = String(x);
  var c = s.charAt(0);
  if ((c === '{' || c === '[') && (h === 'tasks' || h === 'data' || h === 'o' || h === 'items')) {
    try { return JSON.parse(s); } catch (e) { return s; }
  }
  if (c === '{' || c === '[') { try { return JSON.parse(s); } catch (e2) { return s; } }
  return s;
}

function encodeCell(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  // Колонки размечены как «обычный текст», поэтому "=..." не станет формулой.
  return String(v);
}

function readAll(key) {
  if (_cache[key]) return _cache[key].rows;
  var s = sheet(key);
  var v = s.getDataRange().getValues();
  var head = (v[0] || []).map(String);
  var rows = [];
  for (var i = 1; i < v.length; i++) {
    var o = { _row: i + 1 };
    for (var j = 0; j < head.length; j++) {
      var h = head[j]; var x = v[i][j];
      if (!h || x === '' || x === null || x === undefined) continue;
      o[h] = decodeCell(h, x);
    }
    if (o.id !== undefined && o.id !== '') { o.id = String(o.id); rows.push(o); }
  }
  _cache[key] = { rows: rows, head: head };
  return rows;
}

function findBy(key, field, value) {
  if (value === undefined || value === null || value === '') return null;
  var rows = readAll(key);
  for (var i = 0; i < rows.length; i++) if (String(rows[i][field]) === String(value)) return rows[i];
  return null;
}

function writeRow(key, obj) {
  var s = sheet(key);
  readAll(key);
  var c = _cache[key];
  var head = c.head;
  Object.keys(obj).forEach(function (k) {
    if (k.charAt(0) === '_' || head.indexOf(k) >= 0) return;
    head.push(k);
    s.getRange(1, head.length, s.getMaxRows(), 1).setNumberFormat('@');
    s.getRange(1, head.length).setValue(k).setFontWeight('bold');
  });
  var row = head.map(function (h) { return h ? encodeCell(obj[h]) : ''; });
  var existing = findBy(key, 'id', obj.id);
  var r = existing ? existing._row : s.getLastRow() + 1;
  if (r > s.getMaxRows()) s.insertRowsAfter(s.getMaxRows(), 50);
  var range = s.getRange(r, 1, 1, row.length);
  range.setNumberFormat('@');
  range.setValues([row]);
  delete _cache[key];
}

function removeRow(key, id) {
  var rec = findBy(key, 'id', id);
  if (rec) { sheet(key).deleteRow(rec._row); delete _cache[key]; }
}

/** Можно запустить вручную из редактора: создаёт все листы заранее. */
function setupSheets() {
  Object.keys(TABS).forEach(sheet);
}
