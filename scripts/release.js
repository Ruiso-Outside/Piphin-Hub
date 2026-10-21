// Publica a versão do package.json: push, tag vX.Y.Z e Release com os dois .zip de dist\.
// Uso: npm run dist  e depois  npm run release -- notas.md
// Token: variável GH_TOKEN ou, se não houver, o login do GitHub salvo no Git (Credential Manager).
const { execFileSync } = require("child_process");
const fs = require("fs");
const https = require("https");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const V = require(path.join(ROOT, "package.json")).version;
const OWNER = "Ruiso-Outside", REPO = "Piphin-Hub", TAG = "v" + V;
const ASSETS = [`Piphin-Hub-${V}-win-x64.zip`, `hub-app-${V}.zip`];
const notesFile = process.argv[2];
const NOTES = (notesFile ? fs.readFileSync(notesFile, "utf8").trim() + "\n\n" : "") +
  `**Instalar:** baixe \`Piphin-Hub-${V}-win-x64.zip\`, extraia numa pasta fixa e abra o \`Piphin Hub.exe\`.\n` +
  "**Antes de extrair:** clique com o botão direito no `.zip`, escolha **Propriedades**, marque **Desbloquear** e clique em OK. " +
  "Sem isso, com o Controle Inteligente de Aplicativos ligado, o Windows bloqueia os atalhos do Hub (dá para desbloquear depois pelo aviso na tela Início).\n" +
  "Quem já tem o Hub recebe esta versão sozinho (atualização automática).";

const env = { ...process.env, GCM_INTERACTIVE: "never", GIT_TERMINAL_PROMPT: "0" };
function token() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  const cred = execFileSync("git", ["credential", "fill"], { input: "protocol=https\nhost=github.com\n\n", env }).toString();
  const t = (cred.match(/^password=(.*)$/m) || [])[1];
  if (!t) throw new Error("sem token: defina GH_TOKEN ou faça login no GitHub pelo Git");
  return t;
}
const TOKEN = token();
const HEADERS = { Authorization: "Bearer " + TOKEN, Accept: "application/vnd.github+json", "User-Agent": "Piphin-Hub-release" };

async function api(method, url, body) {
  const r = await fetch(url, { method, headers: HEADERS, body });
  const text = await r.text();
  if (!r.ok) throw Object.assign(new Error(`${method} ${url} -> ${r.status} ${text.slice(0, 300)}`), { status: r.status });
  return text ? JSON.parse(text) : null;
}

// envio em fluxo, sem limite de tempo (o .zip completo tem ~150 MB)
function upload(uploadUrl, file) {
  const name = path.basename(file), size = fs.statSync(file).size;
  const url = new URL(uploadUrl.replace(/\{.*\}$/, "") + "?name=" + encodeURIComponent(name));
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: "POST", headers: { ...HEADERS, "Content-Type": "application/zip", "Content-Length": size } }, (res) => {
      let t = "";
      res.on("data", (c) => (t += c));
      res.on("end", () => (res.statusCode < 300 ? resolve(JSON.parse(t)) : reject(new Error(`upload ${name}: ${res.statusCode} ${t.slice(0, 300)}`))));
    });
    req.on("error", reject);
    let sent = 0, last = 0;
    fs.createReadStream(file)
      .on("data", (c) => { sent += c.length; const p = Math.floor((sent / size) * 10); if (p > last) { last = p; process.stdout.write(`  ${name}: ${p * 10}%\n`); } })
      .pipe(req);
  });
}

(async () => {
  for (const a of ASSETS) if (!fs.existsSync(path.join(ROOT, "dist", a))) throw new Error(`falta dist\\${a} (rode npm run dist)`);
  const git = (...a) => execFileSync("git", ["-C", ROOT, ...a], { stdio: "inherit", env });
  git("push", "origin", "main");
  const tags = execFileSync("git", ["-C", ROOT, "tag", "--list", TAG]).toString().trim();
  if (!tags) git("tag", TAG);
  git("push", "origin", TAG);

  let rel;
  try { rel = await api("GET", `https://api.github.com/repos/${OWNER}/${REPO}/releases/tags/${TAG}`); }
  catch (e) {
    if (e.status !== 404) throw e;
    rel = await api("POST", `https://api.github.com/repos/${OWNER}/${REPO}/releases`, JSON.stringify({ tag_name: TAG, name: "Piphin Hub " + V, body: NOTES }));
  }
  console.log("release:", rel.html_url);
  for (const name of ASSETS) {
    if ((rel.assets || []).some((a) => a.name === name && a.state === "uploaded")) { console.log("já enviado:", name); continue; }
    const a = await upload(rel.upload_url, path.join(ROOT, "dist", name));
    console.log("enviado:", a.name, a.size, a.digest || "");
  }
})().catch((e) => { console.error("ERRO:", e.message, (e.cause && e.cause.code) || ""); process.exit(1); });
