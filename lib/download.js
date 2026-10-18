// Download com redirecionamentos, progresso, cancelamento e conferência de SHA-256.
const fs = require("fs");
const https = require("https");
const http = require("http");
const crypto = require("crypto");

function download(url, dest, { onProgress, signal, sha256, token } = {}) {
  return new Promise((resolve, reject) => {
    const tmp = dest + ".part";
    let redirects = 0;

    const get = (u) => {
      const mod = u.startsWith("https:") ? https : http;
      const headers = { "User-Agent": "Piphin-Hub", Accept: "application/octet-stream" };
      // o token só vai para a API do GitHub, nunca para o servidor de arquivos
      if (token && new URL(u).hostname === "api.github.com") headers.Authorization = "Bearer " + token;
      const req = mod.get(u, { headers, timeout: 30000 }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          if (++redirects > 8) return reject(new Error("Redirecionamentos demais"));
          return get(new URL(res.headers.location, u).href);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(`Download falhou (HTTP ${res.statusCode})`)); }

        const total = Number(res.headers["content-length"]) || 0;
        const hash = crypto.createHash("sha256");
        const out = fs.createWriteStream(tmp);
        let done = 0, last = 0, lastBytes = 0, lastAt = Date.now(), speed = 0;

        const abort = () => { req.destroy(); out.destroy(); fs.rm(tmp, { force: true }, () => {}); reject(new Error("Cancelado")); };
        if (signal) { if (signal.aborted) return abort(); signal.addEventListener("abort", abort, { once: true }); }

        res.on("data", (chunk) => {
          hash.update(chunk);
          done += chunk.length;
          const now = Date.now();
          if (now - last > 200) {
            if (now - lastAt >= 1000) { speed = ((done - lastBytes) * 1000) / (now - lastAt); lastBytes = done; lastAt = now; }
            last = now;
            onProgress && onProgress({ done, total, speed });
          }
        });
        res.on("error", (e) => { out.destroy(); reject(e); });
        res.pipe(out);
        out.on("finish", () => {
          if (signal) signal.removeEventListener("abort", abort);
          const got = hash.digest("hex");
          if (total && done !== total) { fs.rm(tmp, { force: true }, () => {}); return reject(new Error("Download incompleto")); }
          if (sha256 && got !== sha256) { fs.rm(tmp, { force: true }, () => {}); return reject(new Error("O arquivo baixado está corrompido (SHA-256 não confere)")); }
          try { fs.rmSync(dest, { force: true }); fs.renameSync(tmp, dest); } catch (e) { return reject(e); }
          resolve({ file: dest, sha256: got, size: done });
        });
        out.on("error", reject);
      });
      req.on("timeout", () => req.destroy(new Error("A conexão parou de responder")));
      req.on("error", (e) => reject(e));
    };
    get(url);
  });
}

module.exports = { download };
