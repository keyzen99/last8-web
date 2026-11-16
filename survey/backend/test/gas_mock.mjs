// Apps Script ランタイムのメモリモック。Code.gs を vm で読み込む（テストと dev_server で共有）。
import vm from "node:vm";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const CODE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "Code.gs");

/** 数式として保存されたセル。読み戻しても元の文字列にはならない。 */
export class MockFormula {
  constructor(src) { this.src = src; }
  toString() { return "#NAME?"; }
}

/** Sheets が setValues で行う自動変換の再現。 */
function convertOnWrite(v) {
  if (typeof v !== "string") return v;
  if (v.startsWith("'")) return v.slice(1);
  if (v.startsWith("=")) return new MockFormula(v);
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  const m = /^(\d+)\/(\d+)$/.exec(v);
  if (m) return new Date(2026, Number(m[1]) - 1, Number(m[2]));
  return v;
}

class MockSheet {
  constructor(name) { this.name = name; this.data = []; }
  _ensure(r, c) {
    while (this.data.length < r) this.data.push([]);
    for (let i = 0; i < this.data.length; i++) while (this.data[i].length < c) this.data[i].push("");
  }
  getLastRow() {
    let last = 0;
    this.data.forEach((row, i) => { if (row.some((v) => v !== "")) last = i + 1; });
    return last;
  }
  getLastColumn() {
    let last = 0;
    this.data.forEach((row) => row.forEach((v, j) => { if (v !== "" && j + 1 > last) last = j + 1; }));
    return last;
  }
  getRange(r, c, nr = 1, nc = 1) {
    const sh = this;
    return {
      getValues() {
        sh._ensure(r + nr - 1, c + nc - 1);
        const out = [];
        for (let i = 0; i < nr; i++) out.push(sh.data[r - 1 + i].slice(c - 1, c - 1 + nc));
        return out;
      },
      getValue() { return this.getValues()[0][0]; },
      setValues(vals) {
        if (vals.length !== nr || vals.some((row) => row.length !== nc)) throw new Error("setValues size mismatch");
        sh._ensure(r + nr - 1, c + nc - 1);
        for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) sh.data[r - 1 + i][c - 1 + j] = convertOnWrite(vals[i][j]);
      },
      setValue(v) { this.setValues([[v]]); },
    };
  }
  clear() { this.data = []; }
  setFrozenRows() {}
}

class MockSpreadsheet {
  constructor() { this.sheets = new Map(); this.menus = []; this.toasts = []; }
  getSheetByName(n) { return this.sheets.get(n) || null; }
  insertSheet(n) { const s = new MockSheet(n); this.sheets.set(n, s); return s; }
  toast(m) { this.toasts.push(m); }
}

export function createGas() {
  const ss = new MockSpreadsheet();
  const state = { lockFail: false, lockHeld: 0, lockReleased: 0, flushFail: false, events: [] };
  const sandbox = {
    console,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss,
      flush() {
        if (state.flushFail) throw new Error("flush failed");
        state.events.push("flush");
      },
      getUi: () => ({
        createMenu(title) {
          const menu = { title, items: [] };
          const b = { addItem(label, fn) { menu.items.push([label, fn]); return b; }, addToUi() { ss.menus.push(menu); } };
          return b;
        },
      }),
    },
    LockService: {
      getScriptLock: () => ({
        waitLock() { if (state.lockFail) throw new Error("Lock timeout"); state.lockHeld++; },
        releaseLock() { state.lockReleased++; state.events.push("release"); },
      }),
    },
    ContentService: {
      MimeType: { JSON: "JSON" },
      createTextOutput(content) {
        const o = { content, mime: null, setMimeType(m) { o.mime = m; return o; }, getContent: () => content };
        return o;
      },
    },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      // yyyy.MM.dd のみ対応（Asia/Tokyo は UTC+9 固定）
      formatDate(date, tz, fmt) {
        if (tz !== "Asia/Tokyo" || fmt !== "yyyy.MM.dd") throw new Error("mock formatDate: unsupported " + tz + " " + fmt);
        const d = new Date(date.getTime() + 9 * 3600 * 1000);
        const p = (n) => String(n).padStart(2, "0");
        return `${d.getUTCFullYear()}.${p(d.getUTCMonth() + 1)}.${p(d.getUTCDate())}`;
      },
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(CODE_PATH, "utf8"), ctx, { filename: "Code.gs" });
  const parse = (out) => JSON.parse(out.getContent());
  return {
    ss, state, ctx,
    get: (params) => parse(ctx.doGet({ parameter: params })),
    post: (body) => parse(ctx.doPost({ postData: { contents: typeof body === "string" ? body : JSON.stringify(body) } })),
    run: (fn) => vm.runInContext(`${fn}()`, ctx),
    /** 指定シートの行（ヘッダー除く）を返す。 */
    rows: (name) => (ss.getSheetByName(name)?.data.slice(1) ?? []).filter((r) => r.some((v) => v !== "")),
    /** 人が events / performers に入力する操作の再現（Sheets では入力値も変換されるが、ここは文字列を直接置く）。 */
    addEvent(id, title) { const s = ss.getSheetByName("events"); s.data.push([id, title, "", ""]); },
    addPerformer(eventId, name, sort) { const s = ss.getSheetByName("performers"); s.data.push([eventId, "", name, "", sort]); },
  };
}

/** setup + イベント投入 + issueKeys までを済ませた環境。 */
export function seedEnv(eventId = "demo", names = ["アキラ", "ミサキ", "ケン"]) {
  const g = createGas();
  g.run("setup");
  g.addEvent(eventId, "デモライブ");
  names.forEach((n, i) => g.addPerformer(eventId, n, i + 1));
  g.run("issueKeys");
  return g;
}
