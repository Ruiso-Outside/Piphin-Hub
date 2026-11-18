// Utilidades do sistema (Windows e Linux): processos, registro, versões, extração de .zip/.tar.gz.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

function run(file, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, maxBuffer: 32 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; return reject(err); }
      resolve(String(stdout));
    });
  });
}

// PowerShell com saída em UTF-8 (o padrão do console quebra acentos)
function ps(script) {
  return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8;$ErrorActionPreference='Stop';" + script]);
}
const psq = (s) => "'" + String(s).replace(/'/g, "''") + "'";

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// "v1.10.0" > "1.9.3"; partes não numéricas contam como 0
function cmpVersion(a, b) {
  const pa = String(a || "").replace(/^v/i, "").split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b || "").replace(/^v/i, "").split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}
const cleanVersion = (v) => String(v || "").replace(/^v/i, "").replace(/\+.*$/, "").trim();

const IS_WIN = process.platform === "win32";
const IS_LINUX = process.platform === "linux";

// Entrada de desinstalação (HKCU, HKLM e HKLM 32 bits). No Linux não há registro.
async function uninstallEntry(key) {
  if (!IS_WIN) return null;
  const roots = ["HKCU:", "HKLM:", "HKLM:\\SOFTWARE\\WOW6432Node"].map((r) =>
    r.startsWith("HKLM:\\") ? r + "\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\" + key
      : r + "\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\" + key);
  const script = `foreach($k in @(${roots.map(psq).join(",")})){ if(Test-Path -LiteralPath $k){ Get-ItemProperty -LiteralPath $k | Select-Object DisplayVersion,InstallLocation,DisplayIcon,UninstallString,QuietUninstallString | ConvertTo-Json -Compress; break } }`;
  try {
    const out = (await ps(script)).trim();
    return out ? JSON.parse(out) : null;
  } catch { return null; }
}

async function exeVersion(exe) {
  if (!IS_WIN) return "";
  try { return cleanVersion((await ps(`(Get-Item -LiteralPath ${psq(exe)}).VersionInfo.ProductVersion`)).trim()); } catch { return ""; }
}

// Linux: processos pelo /proc (caminho real do executável ou o nome do programa na linha de comando)
function linuxProcs() {
  const out = [];
  let list = [];
  try { list = fs.readdirSync("/proc"); } catch { return out; }
  for (const d of list) {
    if (!/^\d+$/.test(d)) continue;
    const p = { pid: Number(d), exe: "", argv0: "", ppid: 0 };
    try { p.exe = fs.readlinkSync(`/proc/${d}/exe`).replace(/ \(deleted\)$/, ""); } catch { /* de outro usuário */ }
    try { p.argv0 = fs.readFileSync(`/proc/${d}/cmdline`, "utf8").split("\0")[0]; } catch { /* já fechou */ }
    try { p.ppid = Number(fs.readFileSync(`/proc/${d}/stat`, "utf8").replace(/^.*\) /s, "").split(" ")[1]) || 0; } catch { /* já fechou */ }
    out.push(p);
  }
  return out;
}

// PIDs do executável em execução (pelo nome; processos elevados não expõem o caminho)
async function runningPids(exe) {
  if (!IS_WIN) {
    const full = path.isAbsolute(exe) ? path.resolve(exe) : null, base = path.basename(exe);
    return linuxProcs().filter((p) => p.pid !== process.pid && (full ? p.exe === full || p.argv0 === full : path.basename(p.exe) === base || path.basename(p.argv0) === base)).map((p) => p.pid);
  }
  const name = path.basename(exe, path.extname(exe));
  try {
    const out = await ps(`@(Get-Process -Name ${psq(name)} -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }) -join ','`);
    return out.trim().split(",").filter(Boolean).map(Number);
  } catch { return []; }
}

async function killPids(pids) {
  if (!IS_WIN) {
    // a árvore toda: filhos primeiro, TERM e depois KILL em quem sobrar
    const procs = linuxProcs(), all = new Set(pids);
    for (let grew = true; grew; ) { grew = false; for (const p of procs) if (all.has(p.ppid) && !all.has(p.pid)) { all.add(p.pid); grew = true; } }
    const list = [...all].reverse();
    for (const pid of list) try { process.kill(pid, "SIGTERM"); } catch { /* já fechou */ }
    await new Promise((r) => setTimeout(r, 1500));
    for (const pid of list) try { process.kill(pid, 0); process.kill(pid, "SIGKILL"); } catch { /* fechou */ }
    return;
  }
  for (const pid of pids) {
    try { await run("taskkill.exe", ["/PID", String(pid), "/T", "/F"]); } catch { /* já fechou ou sem permissão */ }
  }
}

// Extrai .zip com o tar do Windows (rápido); cai para o Expand-Archive se falhar
// .zip em Node puro (Linux/macOS): não depende de unzip instalado. Aceita "stored" e "deflate" (o que o
// tar do Windows e o zipfile do Python geram); recusa caminhos que saiam da pasta. Mantém o bit de execução.
const zlib = require("zlib");
function extractZipNode(zip, dest) {
  const buf = fs.readFileSync(zip);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("Arquivo .zip inválido");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw new Error("zip64 não suportado aqui");
  const root = path.resolve(dest);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("Arquivo .zip corrompido");
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const madeBy = buf.readUInt16LE(p + 4) >> 8, attr = buf.readUInt32LE(p + 38), local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen).replace(/\\/g, "/");
    p += 46 + nameLen + extraLen + commentLen;
    const out = path.resolve(root, name);
    if (out !== root && !out.startsWith(root + path.sep)) throw new Error("Caminho inválido no .zip: " + name);
    if (name.endsWith("/")) { fs.mkdirSync(out, { recursive: true }); continue; }
    const mode = madeBy === 3 ? (attr >>> 16) & 0o777 : 0;
    if (madeBy === 3 && ((attr >>> 16) & 0o170000) === 0o120000) throw new Error("Link simbólico no .zip: " + name);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error("Compressão não suportada no .zip (" + method + ")");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, data);
    if (mode & 0o111) try { fs.chmodSync(out, 0o755); } catch { /* sistema de arquivos sem permissões */ }
  }
}

// Linux: .tar.gz/.tar.xz pelo tar do sistema; .zip em Node puro e, se não der, pelas ferramentas que houver
async function extractArchiveUnix(file, dest) {
  if (/\.(tar\.gz|tgz|tar\.xz|tar)$/i.test(file)) return run("tar", ["-xf", file, "-C", dest]);
  try { return extractZipNode(file, dest); } catch (e) {
    const tries = [["unzip", ["-oq", file, "-d", dest]], ["bsdtar", ["-xf", file, "-C", dest]],
      ["python3", ["-c", "import sys,zipfile;zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])", file, dest]], ["7z", ["x", "-y", "-o" + dest, file]]];
    for (const [cmd, args] of tries) { try { return await run(cmd, args); } catch { /* sem a ferramenta: tenta a próxima */ } }
    throw e;
  }
}

async function extractZip(zip, dest) {
  fs.mkdirSync(dest, { recursive: true });
  if (!IS_WIN) await extractArchiveUnix(zip, dest);
  else {
    const tar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
    try {
      await run(tar, ["-xf", zip, "-C", dest]);
    } catch {
      await ps(`Expand-Archive -LiteralPath ${psq(zip)} -DestinationPath ${psq(dest)} -Force`);
    }
  }
  // .zip com uma única pasta na raiz: sobe o conteúdo
  const entries = fs.readdirSync(dest);
  if (entries.length === 1 && fs.statSync(path.join(dest, entries[0])).isDirectory()) {
    const inner = path.join(dest, entries[0]);
    for (const e of fs.readdirSync(inner)) fs.renameSync(path.join(inner, e), path.join(dest, e));
    fs.rmdirSync(inner);
  }
}

function folderSize(dir) {
  let total = 0;
  const walk = (d) => {
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else try { total += fs.statSync(p).size; } catch { /* arquivo em uso */ }
    }
  };
  walk(dir);
  return total;
}

// Divide uma linha de comando do registro: "C:\x\Uninstall.exe" /uninstall /silent
function splitCommand(cmd) {
  const m = String(cmd).trim().match(/^"([^"]+)"\s*(.*)$/) || String(cmd).trim().match(/^(\S+)\s*(.*)$/);
  if (!m) return null;
  return { file: m[1], args: m[2] ? m[2].match(/"[^"]*"|\S+/g).map((a) => a.replace(/^"|"$/g, "")) : [] };
}

// Pastas do usuário por sistema: dados locais (cache), programas instalados pelo Hub
const localDir = () => (IS_WIN ? process.env.LOCALAPPDATA || os.homedir() : process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"));
const cacheDir = () => (IS_WIN ? process.env.LOCALAPPDATA || os.tmpdir() : process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"));
const programsDir = () => (IS_WIN ? path.join(localDir(), "Programs") : path.join(localDir(), "piphin", "apps"));

module.exports = { IS_WIN, IS_LINUX, localDir, cacheDir, programsDir, run, ps, psq, readJson, writeJson, cmpVersion, cleanVersion, uninstallEntry, exeVersion,
  runningPids, killPids, extractZip, extractZipNode, folderSize, splitCommand };
