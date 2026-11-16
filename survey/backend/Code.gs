/**
 * Last8 ライブ会場アンケート バックエンド（スプレッドシートにバインドされた Apps Script）。
 * シート: events / performers / responses / answers / links
 * 自由記述は先頭に ' を付けて書く（数式・日付・数値への自動変換を防ぐ）。読み戻しは String()。
 */
// エア投げ銭の段階（順序付き。実際の支払いは発生しない）
var LEVELS = [
  { amount: 100, label: "👍" },
  { amount: 500, label: "応援" },
  { amount: 1000, label: "最高！" },
  { amount: 5000, label: "感動！" },
  { amount: 10000, label: "伝説！" }
];
var TZ = "Asia/Tokyo";
var MAX_BODY = 16384;
var MAX_COMMENT = 300;
var MAX_RESPONSES = 2000;
var BASE_URL = "https://last8.jp/survey/";
var EVENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
var SUBMISSION_ID_RE = /^[A-Za-z0-9-]{16,64}$/;

var SHEET_COLUMNS = {
  events: ["event_id", "title", "status", "organizer_key"],
  performers: ["event_id", "performer_id", "name", "key", "sort"],
  responses: ["submission_id", "event_id", "submitted_at", "rating", "comment"],
  answers: ["submission_id", "event_id", "performer_id", "amount", "comment"],
  links: ["event_id", "種類", "名前", "URL"]
};
var COMMENT_COLUMN = "comment";

// ---------- メニュー・初期設定 ----------

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Last8")
    .addItem("初期設定", "setup")
    .addItem("鍵を発行してリンクを作る", "issueKeys")
    .addToUi();
}

function setup() {
  var ss = ss_();
  Object.keys(SHEET_COLUMNS).forEach(function (name) {
    if (ss.getSheetByName(name)) return;
    var sh = ss.insertSheet(name);
    var cols = SHEET_COLUMNS[name];
    sh.getRange(1, 1, 1, cols.length).setValues([cols]);
    sh.setFrozenRows(1);
  });
}

/** 空の status/organizer_key/performer_id/key を埋め、links を作り直す。既存の値は上書きしない。 */
function issueKeys() {
  setup();
  var events = readTable_("events");
  var performers = readTable_("performers");

  var validEvents = {};
  events.rows.forEach(function (r) {
    if (!r.event_id || !EVENT_ID_RE.test(r.event_id)) return;
    validEvents[r.event_id] = true;
    if (!r.status) setCell_(events, r._row, "status", "open");
    if (!r.organizer_key) setCell_(events, r._row, "organizer_key", newKey_());
  });

  var usedIds = {};
  performers.rows.forEach(function (r) {
    if (r.performer_id) usedIds[r.event_id + "/" + r.performer_id] = true;
  });
  performers.rows.forEach(function (r) {
    if (!validEvents[r.event_id] || !r.name) return;
    if (!r.performer_id) {
      var id;
      do { id = "p" + shortRandom_(); } while (usedIds[r.event_id + "/" + id]);
      usedIds[r.event_id + "/" + id] = true;
      setCell_(performers, r._row, "performer_id", id);
    }
    if (!r.key) setCell_(performers, r._row, "key", newKey_());
  });

  // 最新の値で links を作り直す
  events = readTable_("events");
  performers = readTable_("performers");
  var links = [];
  events.rows.forEach(function (ev) {
    if (!validEvents[ev.event_id]) return;
    links.push([ev.event_id, "回答", ev.title, BASE_URL + "?e=" + ev.event_id]);
    links.push([ev.event_id, "主催者", ev.title,
      BASE_URL + "r/?e=" + ev.event_id + "&k=" + ev.organizer_key]);
    performers.rows
      .filter(function (p) { return p.event_id === ev.event_id && p.name; })
      .sort(bySort_)
      .forEach(function (p) {
        links.push([ev.event_id, "出演者", p.name,
          BASE_URL + "r/?e=" + ev.event_id + "&k=" + p.key]);
      });
  });
  var sh = ss_().getSheetByName("links");
  sh.clear();
  var header = SHEET_COLUMNS.links;
  var out = [header].concat(links.map(function (l) {
    return [textCell_(l[0]), l[1], textCell_(l[2]), l[3]];
  }));
  sh.getRange(1, 1, out.length, header.length).setValues(out);
  return links.length;
}

// ---------- Web アプリ ----------

function doGet(e) {
  try {
    var p = (e && e.parameter) || {};
    if (p.action === "event") return json_(getEvent_(String(p.e || "")));
    if (p.action === "results") return json_(getResults_(String(p.e || ""), String(p.k || "")));
    return json_({ ok: false, error: "bad_request" });
  } catch (err) {
    return json_({ ok: false, error: "server_error" });
  }
}

function doPost(e) {
  try {
    var contents = e && e.postData && e.postData.contents;
    if (typeof contents !== "string") return json_({ ok: false, error: "bad_request" });
    if (contents.length > MAX_BODY) return json_({ ok: false, error: "too_large" });
    var body;
    try { body = JSON.parse(contents); } catch (x) { return json_({ ok: false, error: "bad_request" }); }
    return json_(submit_(body));
  } catch (err) {
    return json_({ ok: false, error: "server_error" });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------- GET ----------

function findEvent_(eventId) {
  if (!EVENT_ID_RE.test(eventId)) return null;
  var rows = readTable_("events").rows;
  for (var i = 0; i < rows.length; i++) if (rows[i].event_id === eventId) return rows[i];
  return null;
}

function performersOf_(eventId) {
  return readTable_("performers").rows
    .filter(function (r) { return r.event_id === eventId && r.performer_id && r.name; })
    .sort(bySort_);
}

function bySort_(a, b) {
  var x = Number(a.sort), y = Number(b.sort);
  if (isNaN(x)) x = 1e9;
  if (isNaN(y)) y = 1e9;
  return x - y || a._row - b._row;
}

function getEvent_(eventId) {
  var ev = findEvent_(eventId);
  if (!ev) return { ok: false, error: "not_found" };
  return {
    ok: true,
    event: {
      id: ev.event_id,
      title: ev.title,
      status: ev.status,
      performers: performersOf_(eventId).map(function (p) { return { id: p.performer_id, name: p.name }; }),
      levels: LEVELS.map(function (l) { return { amount: l.amount, label: l.label }; })
    }
  };
}

function safeEqual_(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  var d = 0;
  for (var i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function emptyDistribution_() {
  return LEVELS.map(function (l) { return { amount: l.amount, label: l.label, count: 0 }; });
}

function performerStats_(p, answers) {
  var dist = emptyDistribution_(), total = 0, count = 0, comments = [];
  answers.forEach(function (a) {
    if (a.performer_id !== p.performer_id) return;
    if (a.amount !== "") { // 空は未回答（Number("") は 0 になるので数えない）
      var amt = Number(a.amount);
      for (var i = 0; i < dist.length; i++) {
        if (dist[i].amount === amt) { dist[i].count++; count++; total += amt; break; }
      }
    }
    if (a.comment) comments.push(a.comment);
  });
  return { id: p.performer_id, name: p.name, total: total, count: count, distribution: dist, comments: comments };
}

/**
 * 集計に使う回答の行。送信は answers、responses の順に書くので、途中で失敗して再送されると
 * answers に同じ行が残る。完了した送信の行だけを、出演者ごとに1回ずつ数える。
 */
function countedAnswers_(eventId) {
  var done = {};
  readTable_("responses").rows.forEach(function (r) {
    if (r.event_id === eventId) done[r.submission_id] = true;
  });
  var seen = {};
  return readTable_("answers").rows.filter(function (a) {
    if (a.event_id !== eventId || done[a.submission_id] !== true) return false;
    var id = a.submission_id + "/" + a.performer_id;
    if (seen[id]) return false;
    seen[id] = true;
    return true;
  });
}

function getResults_(eventId, key) {
  var forbidden = { ok: false, error: "forbidden" };
  var ev = findEvent_(eventId);
  if (!ev || !key) return forbidden;
  var performers = performersOf_(eventId);
  var isOrganizer = safeEqual_(key, ev.organizer_key);
  var me = null;
  if (!isOrganizer) {
    var allPerformers = readTable_("performers").rows;
    for (var i = 0; i < allPerformers.length; i++) {
      var p = allPerformers[i];
      if (p.event_id === eventId && p.performer_id && safeEqual_(key, p.key)) { me = p; break; }
    }
    if (!me) return forbidden;
  }
  var answers = countedAnswers_(eventId);

  if (!isOrganizer) {
    return {
      ok: true,
      role: "performer",
      event: { id: ev.event_id, title: ev.title },
      performer: performerStats_(me, answers)
    };
  }
  var responses = readTable_("responses").rows.filter(function (r) { return r.event_id === eventId; });
  var ratings = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 };
  var sum = 0, n = 0, comments = [];
  responses.forEach(function (r) {
    var v = r.rating === "" ? NaN : Number(r.rating);
    if (v >= 1 && v <= 5 && v % 1 === 0) { ratings[String(v)]++; sum += v; n++; }
    if (r.comment) comments.push(r.comment);
  });
  return {
    ok: true,
    role: "organizer",
    event: { id: ev.event_id, title: ev.title },
    count: responses.length,
    overall: {
      ratings: ratings,
      average: n ? Math.round((sum / n) * 100) / 100 : null,
      comments: comments
    },
    performers: performers.map(function (p) { return performerStats_(p, answers); })
  };
}

// ---------- POST ----------

function cleanComment_(v) {
  if (typeof v !== "string") return null;
  var s = v.replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, "").trim();
  if (Array.from(s).length > MAX_COMMENT) return false;
  return s;
}

function isLevelAmount_(v) {
  if (typeof v !== "number") return false;
  return LEVELS.some(function (l) { return l.amount === v; });
}

/** 保存した送信日時（ISO文字列）を日本時間の yyyy.MM.dd にする。 */
function dateOf_(iso) {
  return Utilities.formatDate(new Date(iso), TZ, "yyyy.MM.dd");
}

function submit_(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "bad_request" };
  var eventId = body.event_id;
  if (typeof eventId !== "string") return { ok: false, error: "not_found" };
  var ev = findEvent_(eventId);
  if (!ev) return { ok: false, error: "not_found" };
  if (ev.status !== "open") return { ok: false, error: "closed" };

  var sid = body.submission_id;
  if (typeof sid !== "string" || !SUBMISSION_ID_RE.test(sid)) return { ok: false, error: "invalid_submission" };

  var rating = body.rating;
  if (rating !== null && (typeof rating !== "number" || rating % 1 !== 0 || rating < 1 || rating > 5)) {
    return { ok: false, error: "invalid_rating" };
  }

  var overallComment = cleanComment_(body.comment);
  if (overallComment === null) return { ok: false, error: "invalid_comment" };

  var performers = performersOf_(eventId);
  var answers = body.answers;
  if (!Array.isArray(answers) || answers.length !== performers.length) return { ok: false, error: "invalid_answers" };
  var expected = {};
  performers.forEach(function (p) { expected[p.performer_id] = true; });
  var seen = {};
  for (var i = 0; i < answers.length; i++) {
    var a = answers[i];
    if (!a || typeof a !== "object" || typeof a.performer_id !== "string" ||
        !Object.prototype.hasOwnProperty.call(expected, a.performer_id) ||
        Object.prototype.hasOwnProperty.call(seen, a.performer_id)) {
      return { ok: false, error: "invalid_answers" };
    }
    seen[a.performer_id] = true;
  }
  var cleaned = [];
  for (var j = 0; j < answers.length; j++) {
    var ans = answers[j];
    if (ans.amount !== null && !isLevelAmount_(ans.amount)) return { ok: false, error: "invalid_amount" };
    cleaned.push({ performer_id: ans.performer_id, amount: ans.amount, comment: ans.comment });
  }
  if (overallComment === false) return { ok: false, error: "comment_too_long" };
  for (var k = 0; k < cleaned.length; k++) {
    var c = cleanComment_(cleaned[k].comment);
    if (c === null) return { ok: false, error: "invalid_comment" };
    if (c === false) return { ok: false, error: "comment_too_long" };
    cleaned[k].comment = c;
  }
  var hasInput = rating !== null || overallComment !== "" ||
    cleaned.some(function (x) { return x.amount !== null || x.comment !== ""; });
  if (!hasInput) return { ok: false, error: "empty" };

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (err) {
    return { ok: false, error: "busy" };
  }
  try {
    var existing = readTable_("responses").rows.filter(function (r) { return r.event_id === eventId; });
    for (var m = 0; m < existing.length; m++) {
      if (existing[m].submission_id === sid) {
        return { ok: true, duplicate: true, number: m + 1, date: dateOf_(existing[m].submitted_at) };
      }
    }
    if (existing.length >= MAX_RESPONSES) return { ok: false, error: "full" };
    appendRows_("answers", cleaned.map(function (x) {
      return { submission_id: sid, event_id: textCell_(eventId), performer_id: textCell_(x.performer_id),
        amount: x.amount === null ? "" : x.amount, comment: textCell_(x.comment) };
    }));
    var now = new Date();
    appendRows_("responses", [{
      submission_id: sid, event_id: textCell_(eventId), submitted_at: textCell_(now.toISOString()),
      rating: rating === null ? "" : rating, comment: textCell_(overallComment)
    }]);
    // ロック解放より先に書き込みを確定する（次の送信が古い最終行へ上書きしないように）
    SpreadsheetApp.flush();
    return { ok: true, number: existing.length + 1, date: dateOf_(now.toISOString()) };
  } finally {
    lock.releaseLock();
  }
}

// ---------- シート入出力 ----------

function ss_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

/** 空でない文字列の先頭に ' を付ける（文字列として保存させる）。 */
function textCell_(v) {
  var s = String(v);
  return s === "" ? "" : "'" + s;
}

function newKey_() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, "");
}

function shortRandom_() {
  return Utilities.getUuid().replace(/-/g, "").slice(0, 8);
}

/** ヘッダー行から列位置を引いて、行をオブジェクトで返す。 */
function readTable_(name) {
  var cols = SHEET_COLUMNS[name];
  var sheet = ss_().getSheetByName(name);
  var pos = {};
  var rows = [];
  if (!sheet) return { sheet: null, pos: pos, rows: rows };
  var lastRow = sheet.getLastRow(), lastCol = sheet.getLastColumn();
  if (lastRow < 1 || lastCol < 1) return { sheet: sheet, pos: pos, rows: rows };
  var values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  var header = values[0].map(function (h) { return String(h).trim(); });
  cols.forEach(function (c) { pos[c] = header.indexOf(c); });
  for (var i = 1; i < values.length; i++) {
    var o = { _row: i + 1 };
    cols.forEach(function (c) {
      var s = pos[c] < 0 ? "" : String(values[i][pos[c]]);
      o[c] = c === COMMENT_COLUMN ? s : s.trim();
    });
    rows.push(o);
  }
  return { sheet: sheet, pos: pos, rows: rows };
}

function setCell_(table, row, col, value) {
  if (table.pos[col] === undefined || table.pos[col] < 0) throw new Error("missing column: " + col);
  table.sheet.getRange(row, table.pos[col] + 1).setValue(textCell_(value));
}

/** ロックの中で呼ばれるので、全行を読まず見出しだけで列の位置を決める。 */
function appendRows_(name, objs) {
  var sheet = ss_().getSheetByName(name);
  if (!sheet) throw new Error("missing sheet: " + name);
  var width = sheet.getLastColumn();
  var header = sheet.getRange(1, 1, 1, width).getValues()[0].map(function (h) { return String(h).trim(); });
  var out = objs.map(function (o) {
    var row = [];
    for (var i = 0; i < width; i++) row.push("");
    SHEET_COLUMNS[name].forEach(function (c) {
      var pos = header.indexOf(c);
      if (pos < 0) throw new Error("missing column: " + c);
      row[pos] = o[c];
    });
    return row;
  });
  sheet.getRange(sheet.getLastRow() + 1, 1, out.length, width).setValues(out);
}
