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
        if ((res.statusCode === 403 && res.headers["x-ratelimit-remaining"] === "0") || res.statusCode === 429)
          return reject(Object.assign(new Error("Limite de consultas do GitHub atingido. Tente de novo em alguns minutos."), { status: res.statusCode, rateLimited: true }));
        if (res.statusCode !== 200) return reject(new Error(`GitHub respondeu ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("Tempo esgotado ao consultar o GitHub")));
    req.on("error", reject);
  });
}

// Página do GitHub (não a API): { status, body, url } seguindo os redirecionamentos
function getPage(url, depth = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": UA, Accept: "text/html,application/atom+xml" }, timeout: 20000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && depth < 5) {
        res.resume();
        return getPage(new URL(res.headers.location, url).href, depth + 1).then(resolve, reject);
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body, url }));
    });
    req.on("timeout", () => req.destroy(new Error("Tempo esgotado ao consultar o GitHub")));
    req.on("error", reject);
  });
}
const unescapeHtml = (t) => t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const toBytes = (t) => { const m = /([\d.,]+)\s*(Bytes|KB|MB|GB)/i.exec(t || ""); return m ? Math.round(parseFloat(m[1].replace(",", ".")) * { bytes: 1, kb: 1024, mb: 1048576, gb: 1073741824 }[m[2].toLowerCase()]) : 0; };

// Sem a API (que permite 60 consultas por hora sem login e é dividida com os módulos): o feed de releases e a
// lista de arquivos de cada versão, que trazem a versão, os arquivos, o tamanho e o SHA-256 de cada um.
async function githubLatestWeb(src) {
  const base = `https://github.com/${src.repo}`;
  const feed = await getPage(`${base}/releases.atom`);
  if (feed.status !== 200) throw new Error(`GitHub respondeu ${feed.status}`);
  const entries = feed.body.split("<entry>").slice(1).map((e) => ({
    tag: decodeURIComponent((/\/releases\/tag\/([^"]+)"/.exec(e) || [])[1] || ""),
    updated: (/<updated>([^<]+)<\/updated>/.exec(e) || [])[1] || null,
    notes: unescapeHtml((/<content type="html">([\s\S]*?)<\/content>/.exec(e) || [])[1] || ""),
  })).filter((e) => e.tag);
  let tag;
  if (src.prerelease) tag = entries[0] && entries[0].tag;
  else { // "latest" do GitHub ignora as prévias: o redirecionamento de /releases/latest diz qual é
    const r = await getPage(`${base}/releases/latest`);
    tag = decodeURIComponent((/\/releases\/tag\/([^/?#]+)/.exec(r.url) || [])[1] || "");
  }
  if (!tag) throw new Error("Nenhuma versão publicada");
  const page = await getPage(`${base}/releases/expanded_assets/${encodeURIComponent(tag)}`);
  if (page.status !== 200) throw new Error(`GitHub respondeu ${page.status}`);
  const assets = page.body.split(/<li\b/).slice(1).map((li) => {
    const a = /href="([^"]*\/releases\/download\/[^"]+)"/.exec(li);
    if (!a) return null;
    const href = new URL(unescapeHtml(a[1]), "https://github.com").href;
    const d = /sha256:([0-9a-f]{64})/.exec(li);
    return { name: decodeURIComponent(href.split("/").pop()), browser_download_url: href, size: toBytes((/>\s*([\d.,]+\s*(?:Bytes|KB|MB|GB))\s*</i.exec(li) || [])[1]),
      digest: d ? "sha256:" + d[1] : null };
  }).filter(Boolean);
  const entry = entries.find((e) => e.tag === tag) || {};
  // notas: o feed traz HTML; a Central mostra texto
  const notes = (entry.notes || "").replace(/<li>/g, "- ").replace(/<br\s*\/?>|<\/(p|li|ul|h\d)>/g, "\n").replace(/<[^>]+>/g, "").replace(/\n{3,}/g, "\n\n").trim();
  return { tag_name: tag, assets, body: unescapeHtml(notes), published_at: entry.updated, html_url: `${base}/releases/tag/${encodeURIComponent(tag)}` };
}

async function githubLatest(src, { token, force } = {}) {
  const key = src.repo + "|" + src.asset + "|" + !!src.prerelease;
  const hit = cache.get(key);
  if (hit && !force && Date.now() - hit.at < TTL) return hit.data;

  let rel;
  try {
    if (src.prerelease) {
      const list = await getJson(`https://api.github.com/repos/${src.repo}/releases?per_page=10`, token);
      rel = list.find((r) => !r.draft);
    } else {
      rel = await getJson(`https://api.github.com/repos/${src.repo}/releases/latest`, token);
    }
  } catch (e) {
    if (!e.rateLimited || src.private) throw e; // repositório privado: as páginas públicas do GitHub não mostram nada
    rel = await githubLatestWeb(src).catch(() => { throw e; }); // limite da API: pelas páginas do GitHub
  }
  if (!rel) throw new Error("Nenhuma versão publicada");
  const re = new RegExp(src.asset, "i");
  const asset = (rel.assets || []).find((a) => re.test(a.name));
  if (!asset) throw new Error(`A versão ${rel.tag_name} não tem o arquivo esperado (${src.asset})`);
  const data = {
    version: cleanVersion(rel.tag_name),
    fileName: asset.name,
    // repositório privado: o arquivo vem pela API com o token (o link do navegador pede login no site)
    url: src.private && asset.url ? asset.url : asset.browser_download_url,
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
  if (src.type === "github") return githubLatest(app.private ? { ...src, private: true } : src, opts);
  if (src.type === "local") return localLatest(src);
  throw new Error(`Origem desconhecida: ${src.type}`);
}

module.exports = { latest, getJson };
