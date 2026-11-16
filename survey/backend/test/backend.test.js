import test from "node:test";
import assert from "node:assert/strict";
import { seedEnv, createGas } from "./gas_mock.mjs";

let n = 0;
const sid = () => "test-submission-" + String(++n).padStart(6, "0");

function setup() {
  const g = seedEnv();
  const ev = g.get({ action: "event", e: "demo" }).event;
  const keys = {
    organizer: g.rows("events")[0][3],
    performers: g.rows("performers").map((r) => ({ id: r[1], name: r[2], key: r[3] })),
  };
  const body = (over = {}) => ({
    event_id: "demo", submission_id: sid(), rating: 4, comment: "全体コメント",
    answers: ev.performers.map((p) => ({ performer_id: p.id, amount: 1000, comment: "c-" + p.name })),
    ...over,
  });
  const withAmount = (amt, idx = 0) => {
    const b = body();
    b.answers[idx].amount = amt;
    return b;
  };
  return { g, ev, keys, body, withAmount };
}
const stored = (g) => g.rows("responses").length + g.rows("answers").length;

test("正常系: 保存され organizer 結果に集計される", () => {
  const { g, body, keys } = setup();
  const res = g.post(body());
  assert.equal(res.ok, true);
  assert.equal(res.number, 1);
  assert.match(res.date, /^\d{4}\.\d{2}\.\d{2}$/);
  assert.equal(g.rows("responses").length, 1);
  assert.equal(g.rows("answers").length, 3);
  const r = g.get({ action: "results", e: "demo", k: keys.organizer });
  assert.equal(r.role, "organizer");
  assert.equal(r.count, 1);
  assert.equal(r.overall.average, 4);
  assert.equal(r.performers[0].total, 1000);
  assert.equal(r.performers[0].count, 1);
  assert.deepEqual(r.performers[0].distribution.map((d) => d.count), [0, 0, 1, 0, 0]);
  assert.deepEqual(r.performers[0].distribution.map((d) => [d.amount, d.label]),
    [[100, "👍"], [500, "応援"], [1000, "最高！"], [5000, "感動！"], [10000, "伝説！"]]);
});

test("途中で失敗した送信の再送と、完了していない送信の行は集計に入らない", () => {
  const { g, body, keys } = setup();
  assert.equal(g.post(body()).ok, true);
  const rows = g.ss.getSheetByName("answers").data;
  const written = rows.slice(1).map((r) => r.slice());
  rows.push(...written.map((r) => r.slice())); // 1回目が answers だけ書いて失敗し、再送で同じ行が増えた状態
  rows.push(...written.map((r) => ["orphan-submission-0001", ...r.slice(1)])); // responses に対応が無い行
  const r = g.get({ action: "results", e: "demo", k: keys.organizer });
  assert.equal(r.count, 1);
  assert.equal(r.performers[0].total, 1000);
  assert.equal(r.performers[0].count, 1);
  assert.equal(r.performers[0].comments.length, 1);
  const mine = g.get({ action: "results", e: "demo", k: keys.performers[0].key });
  assert.equal(mine.performer.total, 1000);
  assert.equal(mine.performer.comments.length, 1);
});

test("段階にない金額・不正型は invalid_amount で何も保存されない", () => {
  const { g, withAmount } = setup();
  for (const bad of [0, 3000, 10001, 10500, 100000, "10000", 500.5, 250, 700, -500, -1, undefined]) {
    const res = g.post(withAmount(bad, 1));
    assert.deepEqual(res, { ok: false, error: "invalid_amount" }, `amount=${String(bad)}`);
  }
  assert.equal(stored(g), 0);
});

test("amount 未指定は invalid_amount", () => {
  const { g, body } = setup();
  const b = body();
  delete b.answers[0].amount;
  assert.deepEqual(g.post(b), { ok: false, error: "invalid_amount" });
  assert.equal(stored(g), 0);
});

test("null と段階の金額は受理される", () => {
  const { g, withAmount } = setup();
  for (const a of [null, 100, 500, 1000, 5000, 10000]) assert.equal(g.post(withAmount(a)).ok, true, String(a));
});

test("分布は段階ごとに集計され、null は合計・人数・分布に入らない", () => {
  const { g, withAmount, keys } = setup();
  for (const a of [null, null, 100, 500, 500, 1000, 5000, 10000, 10000]) assert.equal(g.post(withAmount(a)).ok, true);
  const org = g.get({ action: "results", e: "demo", k: keys.organizer });
  const st = org.performers[0];
  assert.deepEqual(st.distribution.map((d) => d.count), [1, 2, 1, 1, 2]);
  assert.equal(st.count, 7);
  assert.equal(st.total, 100 + 1000 + 1000 + 5000 + 20000);
  assert.equal(org.count, 9, "主催者の count は送信数");
  const per = g.get({ action: "results", e: "demo", k: keys.performers[0].key }).performer;
  assert.deepEqual(per.distribution, st.distribution);
  assert.equal(per.count, 7);
});

test("全員 null の出演者は 0 人・合計 0・分布すべて 0", () => {
  const { g, body, keys } = setup();
  const b = body();
  b.answers.forEach((a) => (a.amount = null));
  assert.equal(g.post(b).ok, true);
  const st = g.get({ action: "results", e: "demo", k: keys.organizer }).performers[0];
  assert.equal(st.count, 0);
  assert.equal(st.total, 0);
  assert.deepEqual(st.distribution.map((d) => d.count), [0, 0, 0, 0, 0]);
  assert.equal(g.ss.getSheetByName("answers").data[1][3], "", "null の金額はセルが空");
});

test("rating null は受理され、平均・分布に入らない", () => {
  const { g, body, keys } = setup();
  assert.equal(g.post(body({ rating: null })).ok, true);
  let r = g.get({ action: "results", e: "demo", k: keys.organizer });
  assert.equal(r.count, 1);
  assert.equal(r.overall.average, null);
  assert.deepEqual(Object.values(r.overall.ratings), [0, 0, 0, 0, 0]);
  assert.equal(g.post(body({ rating: 5 })).ok, true);
  assert.equal(g.post(body({ rating: 3 })).ok, true);
  r = g.get({ action: "results", e: "demo", k: keys.organizer });
  assert.equal(r.count, 3);
  assert.equal(r.overall.average, 4);
  assert.deepEqual(Object.values(r.overall.ratings), [0, 0, 1, 0, 1]);
});

test("何も入力がなければ empty、コメントだけ・金額だけ・評価だけなら受理", () => {
  const { g, body } = setup();
  const blank = () => {
    const b = body({ rating: null, comment: "  " });
    b.answers.forEach((a) => { a.amount = null; a.comment = ""; });
    return b;
  };
  assert.deepEqual(g.post(blank()), { ok: false, error: "empty" });
  assert.equal(stored(g), 0);
  const c = blank(); c.comment = "x";
  assert.equal(g.post(c).ok, true);
  const d = blank(); d.answers[2].comment = "y";
  assert.equal(g.post(d).ok, true);
  const e = blank(); e.answers[1].amount = 500;
  assert.equal(g.post(e).ok, true);
  const f = blank(); f.rating = 1;
  assert.equal(g.post(f).ok, true);
});

test("number は送信順に採番され、再送は元の number と date を返す", () => {
  const { g, body } = setup();
  const b1 = body(), b2 = body(), b3 = body();
  const r1 = g.post(b1), r2 = g.post(b2), r3 = g.post(b3);
  assert.deepEqual([r1.number, r2.number, r3.number], [1, 2, 3]);
  assert.deepEqual(g.post(b2), { ok: true, duplicate: true, number: 2, date: r2.date });
  assert.deepEqual(g.post(b1), { ok: true, duplicate: true, number: 1, date: r1.date });
  assert.equal(g.rows("responses").length, 3);
});

test("number はイベントごとに採番される", () => {
  const { g, body } = setup();
  g.addEvent("other", "別イベント");
  g.addPerformer("other", "別人", 1);
  g.run("issueKeys");
  assert.equal(g.post(body()).number, 1);
  assert.equal(g.post(body()).number, 2);
  const pid = g.rows("performers")[3][1];
  const res = g.post({ event_id: "other", submission_id: sid(), rating: 3, comment: "", answers: [{ performer_id: pid, amount: null, comment: "" }] });
  assert.equal(res.number, 1);
});

test("date は保存した送信日時の日本時間（yyyy.MM.dd）", () => {
  const { g, body } = setup();
  const RealDate = Date;
  const fixed = new RealDate("2026-11-08T16:30:00Z"); // JST では 11/09
  g.ctx.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [fixed.getTime()])); } };
  const b = body();
  assert.equal(g.post(b).date, "2026.11.09");
  assert.equal(g.post(b).date, "2026.11.09");
});

test("不正な rating は拒否", () => {
  const { g, body } = setup();
  for (const bad of [0, 6, 2.5, "3", -1, undefined]) {
    assert.equal(g.post(body({ rating: bad })).error, "invalid_rating", String(bad));
  }
  assert.equal(stored(g), 0);
});

test("出演者の過不足・重複・未知IDは invalid_answers", () => {
  const { g, body, ev } = setup();
  const full = body().answers;
  assert.equal(g.post(body({ answers: full.slice(1) })).error, "invalid_answers");
  assert.equal(g.post(body({ answers: [...full, full[0]] })).error, "invalid_answers");
  assert.equal(g.post(body({ answers: [full[0], full[0], full[1]] })).error, "invalid_answers");
  assert.equal(g.post(body({ answers: [{ ...full[0], performer_id: "nope" }, full[1], full[2]] })).error, "invalid_answers");
  assert.equal(g.post(body({ answers: "x" })).error, "invalid_answers");
  assert.equal(g.post(body({ answers: [] })).error, "invalid_answers");
  assert.equal(stored(g), 0);
  assert.equal(ev.performers.length, 3);
});

test("コメントは300文字超で拒否（全体・出演者とも）、300文字ちょうどは可、文字列以外は拒否", () => {
  const { g, body } = setup();
  assert.equal(g.post(body({ comment: "あ".repeat(301) })).error, "comment_too_long");
  const b = body();
  b.answers[2].comment = "a".repeat(301);
  assert.equal(g.post(b).error, "comment_too_long");
  assert.equal(g.post(body({ comment: 123 })).error, "invalid_comment");
  assert.equal(stored(g), 0);
  assert.equal(g.post(body({ comment: "あ".repeat(300) })).ok, true);
  assert.equal(g.post(body({ comment: " ".repeat(10) + "x".repeat(300) + " " })).ok, true, "trim 後で判定");
});

test("制御文字は改行以外除去される", () => {
  const { g, body, keys } = setup();
  g.post(body({ comment: "a\u0000b\u0007c\nd\re\u001bf" }));
  const r = g.get({ action: "results", e: "demo", k: keys.organizer });
  assert.deepEqual(r.overall.comments, ["abc\ndef"]);
});

test("closed / 不存在イベント / 不正な submission_id / 大きすぎる本文", () => {
  const { g, body } = setup();
  g.ss.getSheetByName("events").data[1][2] = "closed";
  assert.equal(g.post(body()).error, "closed");
  assert.equal(g.post(body({ event_id: "nothing" })).error, "not_found");
  assert.equal(g.post(body({ event_id: 5 })).error, "not_found");
  g.ss.getSheetByName("events").data[1][2] = "open";
  assert.equal(g.post(body({ submission_id: "short" })).error, "invalid_submission");
  assert.equal(g.post(body({ submission_id: "x".repeat(65) })).error, "invalid_submission");
  assert.equal(g.post(body({ submission_id: "abc def ghi jkl mno" })).error, "invalid_submission");
  assert.equal(g.post("{not json").error, "bad_request");
  assert.equal(g.post(JSON.stringify(body({ comment: "x".repeat(17000) }))).error, "too_large");
  assert.equal(stored(g), 0);
});

test("同じ submission_id の再送は二重計上されない", () => {
  const { g, body, keys } = setup();
  const b = body();
  const first = g.post(b);
  assert.equal(first.ok, true);
  assert.deepEqual(g.post(b), { ok: true, duplicate: true, number: 1, date: first.date });
  assert.deepEqual(g.post(b), { ok: true, duplicate: true, number: 1, date: first.date });
  assert.equal(g.rows("responses").length, 1);
  assert.equal(g.rows("answers").length, 3);
  assert.equal(g.get({ action: "results", e: "demo", k: keys.organizer }).performers[0].total, 1000);
});

test("ロックが取れなければ busy、取れた場合は必ず解放", () => {
  const { g, body } = setup();
  g.state.lockFail = true;
  assert.equal(g.post(body()).error, "busy");
  assert.equal(stored(g), 0);
  g.state.lockFail = false;
  g.post(body());
  assert.equal(g.state.lockHeld, g.state.lockReleased);
});

test("イベントあたり 2000 件で full", () => {
  const { g, body } = setup();
  const sh = g.ss.getSheetByName("responses");
  for (let i = 0; i < 2000; i++) sh.data.push(["pre-" + String(i).padStart(16, "0"), "demo", "t", 3, ""]);
  assert.equal(g.post(body()).error, "full");
  assert.equal(g.rows("answers").length, 0);
});

test("出演者鍵の応答に他の出演者・全体感想・全体件数が一切含まれない", () => {
  const { g, body, keys } = setup();
  g.post(body({ comment: "SECRET-OVERALL", rating: 5 }));
  const b2 = body({ comment: "SECRET-OVERALL-2" });
  b2.answers[0].amount = 1000; b2.answers[1].amount = 5000; b2.answers[1].comment = "OTHER-COMMENT-B";
  b2.answers[2].comment = "OTHER-COMMENT-C";
  g.post(b2);
  const me = keys.performers[0];
  const res = g.get({ action: "results", e: "demo", k: me.key });
  assert.equal(res.role, "performer");
  assert.equal(res.performer.name, me.name);
  assert.equal(res.performer.total, 2000);
  assert.equal(res.performer.count, 2);
  const s = JSON.stringify(res);
  for (const o of keys.performers.slice(1)) {
    assert.ok(!s.includes(o.name), "他出演者名: " + o.name);
    assert.ok(!s.includes(o.id), "他出演者ID");
    assert.ok(!s.includes(o.key), "他出演者鍵");
  }
  for (const w of ["OTHER-COMMENT", "SECRET-OVERALL", "overall", "ratings", "average", keys.organizer]) {
    assert.ok(!s.includes(w), "含まれてはならない: " + w);
  }
  assert.ok(!("count" in res), "全体件数なし");
  assert.ok(!("performers" in res));
});

test("コメントに日時・submission_id を付けず、金額と紐付けない", () => {
  const { g, body, keys } = setup();
  const b = body();
  g.post(b);
  const s = JSON.stringify(g.get({ action: "results", e: "demo", k: keys.organizer }));
  assert.ok(!s.includes(b.submission_id));
  assert.ok(!/submitted_at|20\d\d-\d\d-\d\dT/.test(s));
  const r = g.get({ action: "results", e: "demo", k: keys.organizer });
  assert.ok(r.performers[0].comments.every((c) => typeof c === "string"));
});

test("不正な鍵・他イベントの鍵・空の鍵は forbidden", () => {
  const { g, keys } = setup();
  g.run("setup");
  g.addEvent("other", "別イベント");
  g.addPerformer("other", "別人", 1);
  g.run("issueKeys");
  const otherOrg = g.rows("events")[1][3];
  const otherPerf = g.rows("performers")[3][3];
  const forb = { ok: false, error: "forbidden" };
  assert.deepEqual(g.get({ action: "results", e: "demo", k: "wrong" }), forb);
  assert.deepEqual(g.get({ action: "results", e: "demo", k: otherOrg }), forb);
  assert.deepEqual(g.get({ action: "results", e: "demo", k: otherPerf }), forb);
  assert.deepEqual(g.get({ action: "results", e: "demo", k: "" }), forb);
  assert.deepEqual(g.get({ action: "results", e: "demo" }), forb);
  assert.deepEqual(g.get({ action: "results", e: "nothing", k: keys.organizer }), forb);
  assert.deepEqual(g.get({ action: "results", e: "demo", k: keys.organizer.slice(0, -1) }), forb);
  assert.equal(g.get({ action: "results", e: "demo", k: keys.organizer }).ok, true);
});

test("空 k が空の key にマッチしない（organizer_key/performer key が空でも）", () => {
  const { g } = setup();
  g.ss.getSheetByName("events").data[1][3] = "";
  g.ss.getSheetByName("performers").data[1][3] = "";
  for (const k of ["", " "]) {
    assert.equal(g.get({ action: "results", e: "demo", k }).error, "forbidden");
  }
});

test("?action=event の応答に鍵が含まれない", () => {
  const { g, keys } = setup();
  const res = g.get({ action: "event", e: "demo" });
  const s = JSON.stringify(res);
  assert.equal(res.ok, true);
  assert.deepEqual(res.event.levels.map((l) => l.amount), [100, 500, 1000, 5000, 10000]);
  assert.deepEqual(res.event.levels.map((l) => l.label), ["👍", "応援", "最高！", "感動！", "伝説！"]);
  assert.ok(!("coins" in res.event) && !("max_amount" in res.event));
  assert.ok(!("amounts" in res.event));
  assert.equal(res.event.status, "open");
  assert.equal(res.event.performers.length, 3);
  assert.ok(!s.includes(keys.organizer));
  keys.performers.forEach((p) => assert.ok(!s.includes(p.key)));
  assert.ok(!/key/i.test(s));
  assert.deepEqual(g.get({ action: "event", e: "nope" }), { ok: false, error: "not_found" });
  assert.deepEqual(g.get({ action: "event", e: "../x" }), { ok: false, error: "not_found" });
});

test("数式・日付・数値に見えるコメントが文字列のまま戻る", () => {
  const { g, body, keys } = setup();
  const tricky = ['=IMPORTXML("x")', "11/8", "100", "'quote", "+1", "@SUM(1)", "-5"];
  tricky.forEach((t) => {
    const b = body({ comment: t });
    b.answers.forEach((a) => (a.comment = t));
    assert.equal(g.post(b).ok, true, t);
  });
  const org = g.get({ action: "results", e: "demo", k: keys.organizer });
  assert.deepEqual(org.overall.comments, tricky);
  assert.deepEqual(org.performers[0].comments, tricky);
  const per = g.get({ action: "results", e: "demo", k: keys.performers[1].key });
  assert.deepEqual(per.performer.comments, tricky);
});

test("モック自体が素の書き込みを化けさせる（テストの前提確認）", () => {
  const g = createGas();
  g.run("setup");
  const sh = g.ss.getSheetByName("events");
  sh.getRange(2, 1, 1, 3).setValues([["=IMPORTXML(\"x\")", "11/8", "100"]]);
  const [f, d, num] = sh.getRange(2, 1, 1, 3).getValues()[0];
  assert.notEqual(String(f), '=IMPORTXML("x")');
  assert.ok(d instanceof Date);
  assert.equal(typeof num, "number");
});

test("issueKeys は冪等（2回実行しても鍵・ID が変わらない）", () => {
  const { g } = setup();
  const snap = () => JSON.stringify([g.rows("events"), g.rows("performers"), g.rows("links")]);
  const before = snap();
  g.run("issueKeys");
  g.run("issueKeys");
  assert.equal(snap(), before);
  const ev = g.rows("events")[0];
  assert.equal(ev[2], "open");
  assert.match(ev[3], /^[0-9a-f]{64}$/);
  g.rows("performers").forEach((p) => {
    assert.match(String(p[1]), /^p[0-9a-f]{8}$/);
    assert.match(p[3], /^[0-9a-f]{64}$/);
  });
});

test("issueKeys は新しい行だけ埋め、links を作り直す", () => {
  const { g, keys } = setup();
  g.addPerformer("demo", "新人", 4);
  g.addEvent("live-2", "二つ目");
  g.addEvent("bad id!", "不正ID");
  g.run("issueKeys");
  assert.equal(g.rows("events")[0][3], keys.organizer);
  assert.equal(g.rows("performers")[0][3], keys.performers[0].key);
  assert.ok(g.rows("performers")[3][3]);
  assert.equal(g.rows("events")[2][2], "", "不正IDの行は触らない");
  const links = g.rows("links");
  assert.equal(links.length, 8, "demo: 回答+主催者+出演者4, live-2: 回答+主催者");
});

test("links の URL 形式", () => {
  const { g, keys } = setup();
  const links = g.rows("links");
  assert.deepEqual(links[0].slice(0, 2), ["demo", "回答"]);
  assert.equal(links[0][3], "https://last8.jp/survey/?e=demo");
  assert.equal(links[1][3], `https://last8.jp/survey/r/?e=demo&k=${keys.organizer}`);
  assert.equal(links[2][3], `https://last8.jp/survey/r/?e=demo&k=${keys.performers[0].key}`);
});

test("setup は既存シートに何もしない / onOpen はメニューを作る", () => {
  const { g } = setup();
  const before = JSON.stringify(g.rows("events"));
  g.run("setup");
  assert.equal(JSON.stringify(g.rows("events")), before);
  g.run("onOpen");
  assert.equal(g.ss.menus[0].title, "Last8");
  assert.deepEqual(g.ss.menus[0].items.map((i) => i[1]), ["setup", "issueKeys"]);
});

test("ヘッダー列の順序が違っても名前で引ける", () => {
  const g = createGas();
  g.run("setup");
  const sh = g.ss.getSheetByName("events");
  sh.data[0] = ["organizer_key", "status", "title", "event_id"];
  sh.data.push(["", "", "入替", "swap"]);
  g.ss.getSheetByName("performers").data.push(["swap", "", "X", "", 1]);
  g.run("issueKeys");
  assert.equal(sh.data[1][1], "open");
  assert.match(sh.data[1][0], /^[0-9a-f]{64}$/);
  assert.equal(g.get({ action: "event", e: "swap" }).event.title, "入替");
});

test("書き込みの確定はロック解放より先に行う", () => {
  const { g, body } = setup();
  assert.equal(g.post(body()).ok, true);
  assert.deepEqual(g.state.events, ["flush", "release"]);
});

test("書き込みの確定に失敗したら成功を返さず、ロックは解放する", () => {
  const { g, body } = setup();
  g.state.flushFail = true;
  assert.deepEqual(g.post(body()), { ok: false, error: "server_error" });
  assert.equal(g.state.lockReleased, 1);
});
