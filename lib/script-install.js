// Apps e temas que trazem o próprio instalador (install.sh / install.ps1): a Central baixa o pacote do Release,
// guarda a pasta (para desinstalar e reinstalar depois) e roda o script. Quem precisa de senha de administrador
// (sudo) ou faz perguntas roda num terminal de verdade, que a pessoa vê e onde digita a senha.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const U = require("./util");

// "~/..." e "%LOCALAPPDATA%\..." / "$HOME/..." viram caminhos de verdade
function expandPath(p) {
  if (!p) return null;
  let s = String(p);
  if (s === "~" || s.startsWith("~/")) s = path.join(os.homedir(), s.slice(1));
  s = s.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, k) => process.env[k] ?? m);
  s = s.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, k) => (k === "HOME" ? os.homedir() : process.env[k] ?? m));
  return path.normalize(s);
}

// Versão instalada: arquivo JSON ({ "version" }), texto com "versionPattern" (regex com um grupo) ou só o número
function readVersion(inst) {
  const file = expandPath(inst.versionFile);
  if (!file) return "";
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return ""; }
  if (inst.versionPattern) {
    const m = new RegExp(inst.versionPattern).exec(text);
    return m ? U.cleanVersion(m[1]) : "";
  }
  if (/\.json$/i.test(file)) {
    try { return U.cleanVersion(JSON.parse(text).version); } catch { return ""; }
  }
  return U.cleanVersion(text.split(/\r?\n/)[0]);
}

// O script fica na raiz do pacote (a extração já sobe a pasta única de dentro do .tar.gz/.zip)
function scriptPath(dir, rel) {
  const p = path.join(dir, rel);
  return fs.existsSync(p) ? p : null;
}

const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

// Terminais conhecidos e como passar o comando para cada um
const TERMINALS = [
  ["x-terminal-emulator", ["-e"]],
  ["gnome-terminal", ["--"]],
  ["ptyxis", ["--"]],
  ["kgx", ["--"]],
  ["konsole", ["-e"]],
  ["xfce4-terminal", ["-x"]],
  ["mate-terminal", ["-x"]],
  ["tilix", ["-e"]],
  ["kitty", []],
  ["alacritty", ["-e"]],
  ["xterm", ["-e"]],
];

function findInPath(bin) {
  for (const d of (process.env.PATH || "/usr/local/bin:/usr/bin:/bin").split(path.delimiter)) {
    const p = path.join(d, bin);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* próximo */ }
  }
  return null;
}

function findTerminal() {
  for (const [bin, args] of TERMINALS) {
    const p = findInPath(bin);
    if (p) return { bin: p, args };
  }
  return null;
}

// Linux: abre um terminal com o script e espera ele terminar. Muitos terminais (gnome-terminal, ptyxis)
// devolvem o controle na hora, então quem diz que acabou é um arquivo com o código de saída.
async function runInTerminal({ cwd, file, args = [], title, signal, workDir, timeoutMs = 60 * 60 * 1000 }) {
  const term = findTerminal();
  if (!term) throw new Error("Nenhum terminal encontrado (instale o gnome-terminal ou o xterm)");
  fs.mkdirSync(workDir, { recursive: true });
  const tag = `${Date.now()}-${process.pid}`;
  const statusFile = path.join(workDir, `status-${tag}`);
  const wrapper = path.join(workDir, `run-${tag}.sh`);
  fs.writeFileSync(wrapper, [
    "#!/usr/bin/env bash",
    `printf '\\033]0;%s\\007' ${shq(title)}`,
    `cd ${shq(cwd)} || { echo 1 > ${shq(statusFile)}; exit 1; }`,
    `bash ${shq(file)} ${args.map(shq).join(" ")}`,
    "code=$?",
    `echo "$code" > ${shq(statusFile)}`,
    "echo",
    'if [ "$code" -eq 0 ]; then echo "■ Pronto. Pode fechar esta janela (ela fecha sozinha em 10 s)."; read -r -t 10 _ ;',
    'else echo "!! Terminou com erro (código $code). Aperte Enter para fechar."; read -r _ ; fi',
    "",
  ].join("\n"), { mode: 0o755 });

  const p = spawn(term.bin, [...term.args, "bash", wrapper], { cwd, detached: true, stdio: "ignore" });
  await new Promise((res, rej) => { p.once("error", rej); p.once("spawn", res); });
  p.unref();

  const started = Date.now();
  try {
    for (;;) {
      if (signal && signal.aborted) throw new Error("Cancelado");
      if (fs.existsSync(statusFile)) {
        const code = parseInt(fs.readFileSync(statusFile, "utf8"), 10);
        if (code !== 0) throw Object.assign(new Error(`O instalador terminou com erro (código ${code})`), { code });
        return;
      }
      if (Date.now() - started > timeoutMs) throw new Error("Tempo esgotado esperando o terminal");
      await new Promise((r) => setTimeout(r, 1000));
    }
  } finally {
    fs.rm(statusFile, { force: true }, () => {});
    setTimeout(() => fs.rm(wrapper, { force: true }, () => {}), 30000);
  }
}

// Sem terminal: Linux roda com bash, Windows com o PowerShell (os .ps1 dos apps não fazem perguntas)
async function runHidden({ cwd, file, args = [] }) {
  const isPs = /\.ps1$/i.test(file);
  const cmd = isPs ? "powershell.exe" : "bash";
  const argv = isPs ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file, ...args] : [file, ...args];
  try {
    await U.run(cmd, argv, { cwd, timeout: 30 * 60 * 1000 });
  } catch (e) {
    const tail = String(e.stderr || e.stdout || "").trim().split(/\r?\n/).slice(-3).join(" ");
    throw new Error(`O instalador terminou com erro (código ${e.code ?? "?"})${tail ? ": " + tail : ""}`);
  }
}

function runScript(opts) {
  return opts.terminal && !U.IS_WIN ? runInTerminal(opts) : runHidden(opts);
}

// Sistema atual (para os temas dizerem se são compatíveis): ID e VERSION_ID do os-release
function osRelease() {
  if (U.IS_WIN) return { id: "windows", versionId: os.release(), name: "Windows" };
  for (const f of ["/etc/os-release", "/usr/lib/os-release"]) {
    try {
      const kv = {};
      for (const line of fs.readFileSync(f, "utf8").split("\n")) {
        const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
        if (m) kv[m[1]] = m[2].replace(/^"|"$/g, "");
      }
      return { id: kv.ID || "", like: (kv.ID_LIKE || "").split(/\s+/).filter(Boolean), versionId: kv.VERSION_ID || "", name: kv.PRETTY_NAME || kv.NAME || "" };
    } catch { /* próximo */ }
  }
  return { id: "", like: [], versionId: "", name: "" };
}

module.exports = { expandPath, readVersion, scriptPath, runScript, osRelease, findTerminal };
