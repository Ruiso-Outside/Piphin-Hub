// De onde vem cada app: Releases do GitHub ou uma pasta local (para testar antes de publicar).
const fs = require("fs");
const path = require("path");
const https = require("https");
const { cleanVersion, cmpVersion } = require("./util");

const UA = "Piphin-Hub";
const cache = new Map(); // repo -> { at, data }
const TTL = 10 * 60 * 1000;

function getJson(url, token) {
  return new Promise((resolve, reject) => {
    const headers = { "User-Agent": UA, Accept: "application/vnd.github+json" };
    if (token) headers.Authorization = "Bearer " + token;
    const req = https.get(url, { headers, timeout: 20000 }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return getJson(new URL(res.headers.location, url).href, token).then(resolve, reject);
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        if (res.statusCode === 404) return reject(Object.assign(new Error("Não encontrado (404)"), { status: 404 }));
        if (res.statusCode === 403 && res.headers["x-ratelimit-remaining"] === "0")
          return reject(new Error("Limite de consultas do GitHub atingido. Tente de novo em alguns minutos."));
        if (res.statusCode !== 200) return reject(new Error(`GitHub respondeu ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("Tempo esgotado ao consultar o GitHub")));
    req.on("error", reject);
  });
}

async function githubLatest(src, { token, force } = {}) {
  const key = src.repo + "|" + src.asset + "|" + !!src.prerelease;
  const hit = cache.get(key);
  if (hit && !force && Date.now() - hit.at < TTL) return hit.data;

  let rel;
  if (src.prerelease) {
    const list = await getJson(`https://api.github.com/repos/${src.repo}/releases?per_page=10`, token);
    rel = list.find((r) => !r.draft);
  } else {
    rel = await getJson(`https://api.github.com/repos/${src.repo}/releases/latest`, token);
  }
  if (!rel) throw new Error("Nenhuma versão publicada");
  const re = new RegExp(src.asset, "i");
  const asset = (rel.assets || []).find((a) => re.test(a.name));
  if (!asset) throw new Error(`A versão ${rel.tag_name} não tem o arquivo esperado (${src.asset})`);
  const data = {
    version: cleanVersion(rel.tag_name),
    fileName: asset.name,
    url: asset.browser_download_url,
    size: asset.size,
    sha256: /^sha256:/.test(asset.digest || "") ? asset.digest.slice(7).toLowerCase() : null,
    notes: rel.body || "",
    publishedAt: rel.published_at,
    page: rel.html_url,
  };
  cache.set(key, { at: Date.now(), data });
  return data;
}

// Pasta local: o arquivo mais novo que bate com "asset"; a versão sai do nome (X.Y.Z)
function localLatest(src) {
  const re = new RegExp(src.asset, "i");
  const files = fs.readdirSync(src.path).filter((f) => re.test(f));
  if (!files.length) throw new Error(`Nenhum arquivo ${src.asset} em ${src.path}`);
  const withVer = files.map((f) => ({ f, v: (f.match(/\d+\.\d+(\.\d+)?/) || ["0"])[0] }));
  withVer.sort((a, b) => cmpVersion(b.v, a.v));
  const best = withVer[0];
  const full = path.join(src.path, best.f);
  return { version: best.v, fileName: best.f, path: full, size: fs.statSync(full).size, sha256: null, notes: "", page: null };
}

async function latest(app, opts) {
  const src = app.source || {};
  if (src.type === "github") return githubLatest(src, opts);
  if (src.type === "local") return localLatest(src);
  throw new Error(`Origem desconhecida: ${src.type}`);
}

module.exports = { latest, getJson };
