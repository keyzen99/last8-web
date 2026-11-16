// ローカル確認用: node survey/backend/test/dev_server.mjs [port]
// Code.gs をメモリモックで動かし、/api で doGet/doPost を提供、survey/ を /survey/ で静的配信する。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seedEnv } from "./gas_mock.mjs";

const port = Number(process.argv[2]) || 8787;
const surveyDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const gas = seedEnv("demo");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };

function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => { b += c; });
    req.on("end", () => resolve(b));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  if (url.pathname === "/api") {
    if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
    let out;
    if (req.method === "POST") out = gas.ctx.doPost({ postData: { contents: await readBody(req) } });
    else out = gas.ctx.doGet({ parameter: Object.fromEntries(url.searchParams) });
    res.writeHead(200, { ...CORS, "Content-Type": "application/json; charset=utf-8" });
    return res.end(out.getContent());
  }
  if (url.pathname === "/survey/config.js") {
    res.writeHead(200, { "Content-Type": MIME[".js"] });
    return res.end(`window.SURVEY_API = "http://localhost:${port}/api";\n`);
  }
  if (url.pathname.startsWith("/survey/")) {
    let rel = decodeURIComponent(url.pathname.slice("/survey/".length));
    if (rel === "" || rel.endsWith("/")) rel += "index.html";
    const file = path.resolve(surveyDir, rel);
    if (!file.startsWith(surveyDir + path.sep) || file.includes(`${path.sep}backend${path.sep}`)) {
      res.writeHead(403); return res.end("forbidden");
    }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end("not found"); }
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
      res.end(data);
    });
    return;
  }
  res.writeHead(404); res.end("not found");
});

server.listen(port, () => {
  const links = gas.rows("links");
  console.log(`dev server: http://localhost:${port}/survey/?e=demo`);
  for (const [, kind, name, u] of links) {
    console.log(`${kind}${name && kind === "出演者" ? " " + name : ""}: ${u.replace("https://last8.jp", `http://localhost:${port}`)}`);
  }
});
