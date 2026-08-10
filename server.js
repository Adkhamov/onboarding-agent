// Статический сервер + прокси к парсеру MoonAI (ключ парсера хранится в env, не в браузере).
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PARSER_BASE = process.env.PARSER_BASE || "https://api.parser.digitalocean.mooonai.com";
const PARSER_API_KEY = process.env.PARSER_API_KEY || "";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
};

const PARSER_PATHS = {
  website: "/api/v1/parsers/general",
  "2gis": "/api/v1/parsers/2gis",
  instagram: "/api/v1/parsers/instagram/profile",
};

// грубое извлечение текста из HTML для экономии токенов
function htmlToText(html) {
  if (!html) return "";
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 15000);
}

function sendJson(res, code, obj) {
  res.writeHead(code, { "content-type": MIME[".json"] });
  res.end(JSON.stringify(obj));
}

async function handleParse(req, res) {
  let body = "";
  req.on("data", (c) => {
    body += c;
    if (body.length > 1e6) req.destroy();
  });
  req.on("end", async () => {
    let payload = {};
    try {
      payload = JSON.parse(body || "{}");
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: "Некорректный JSON" });
    }
    const type = payload.type;
    const url = payload.url;
    const apiPath = PARSER_PATHS[type];
    if (!apiPath) return sendJson(res, 400, { ok: false, error: "Неизвестный тип источника" });
    if (!url) return sendJson(res, 400, { ok: false, error: "Не передан url" });
    if (!PARSER_API_KEY)
      return sendJson(res, 500, { ok: false, error: "PARSER_API_KEY не задан на сервере (env)" });

    try {
      const target = `${PARSER_BASE}${apiPath}?url=${encodeURIComponent(url)}`;
      const r = await fetch(target, {
        method: "POST",
        headers: { Authorization: PARSER_API_KEY, accept: "application/json" },
      });
      const txt = await r.text();
      let data;
      try {
        data = JSON.parse(txt);
      } catch (e) {
        data = { raw: txt };
      }
      if (!r.ok) {
        return sendJson(res, 502, {
          ok: false,
          error: `Парсер вернул ${r.status}`,
          detail: (data && (data.detail || data.error)) || txt.slice(0, 300),
        });
      }
      // для сайта отдаём очищенный текст, а не гигантский html
      if (type === "website" && data && typeof data.html === "string") {
        data = { source: data.source, url: data.url, text: htmlToText(data.html), error: data.error };
      }
      return sendJson(res, 200, { ok: true, type, data });
    } catch (err) {
      return sendJson(res, 502, { ok: false, error: "Ошибка запроса к парсеру: " + (err.message || err) });
    }
  });
}

http
  .createServer((req, res) => {
    if (req.method === "POST" && (req.url || "").split("?")[0] === "/api/parse") {
      return handleParse(req, res);
    }
    if ((req.url || "").split("?")[0] === "/api/health") {
      return sendJson(res, 200, { ok: true, parser_key: !!PARSER_API_KEY });
    }

    let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    if (urlPath === "/") urlPath = "/index.html";
    const filePath = path.normalize(path.join(ROOT, urlPath));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403);
      return res.end("Forbidden");
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        return fs.readFile(path.join(ROOT, "index.html"), (e2, home) => {
          if (e2) {
            res.writeHead(404);
            return res.end("Not found");
          }
          res.writeHead(200, { "content-type": MIME[".html"] });
          res.end(home);
        });
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream" });
      res.end(data);
    });
  })
  .listen(PORT, () => console.log(`onboarding-agent listening on :${PORT}`));
