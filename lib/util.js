// Utilidades do Windows: processos, registro, versões, extração de .zip.
const fs = require("fs");
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

// Entrada de desinstalação (HKCU, HKLM e HKLM 32 bits)
async function uninstallEntry(key) {
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
  try { return cleanVersion((await ps(`(Get-Item -LiteralPath ${psq(exe)}).VersionInfo.ProductVersion`)).trim()); } catch { return ""; }
}

// PIDs do executável em execução (pelo nome; processos elevados não expõem o caminho)
async function runningPids(exe) {
  const name = path.basename(exe, path.extname(exe));
  try {
    const out = await ps(`@(Get-Process -Name ${psq(name)} -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }) -join ','`);
    return out.trim().split(",").filter(Boolean).map(Number);
  } catch { return []; }
}

async function killPids(pids) {
  for (const pid of pids) {
    try { await run("taskkill.exe", ["/PID", String(pid), "/T", "/F"]); } catch { /* já fechou ou sem permissão */ }
  }
}

// Extrai .zip com o tar do Windows (rápido); cai para o Expand-Archive se falhar
async function extractZip(zip, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const tar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
  try {
    await run(tar, ["-xf", zip, "-C", dest]);
  } catch {
    await ps(`Expand-Archive -LiteralPath ${psq(zip)} -DestinationPath ${psq(dest)} -Force`);
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

module.exports = { run, ps, psq, readJson, writeJson, cmpVersion, cleanVersion, uninstallEntry, exeVersion,
  runningPids, killPids, extractZip, folderSize, splitCommand };
