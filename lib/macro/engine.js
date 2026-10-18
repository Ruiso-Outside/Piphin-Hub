// Processo do motor de entrada (engine.cs compilado pelo PowerShell do Windows).
// Fala por linhas com campos separados por TAB; reinicia sozinho se cair.
const { spawn } = require("child_process");
const { EventEmitter } = require("events");
const path = require("path");

const SOURCE = path.join(__dirname, "engine.cs");
// o caminho vai por variável de ambiente: nada de aspas/barras dentro do comando
const BOOT = "$ErrorActionPreference='Stop';Add-Type -TypeDefinition ([IO.File]::ReadAllText($env:PIPHIN_ENGINE));[Piphin.MacroEngine]::Main()";

class Engine extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.ready = false;
    this.error = null;
    this.screen = null;
    this.crashes = [];
    this.waiting = {}; // respostas de pos/pix/fg
    this.stopping = false;
  }

  start() {
    if (this.proc) return this.readyPromise;
    this.stopping = false;
    this.ready = false;
    this.error = null;
    this.readyPromise = new Promise((resolve, reject) => { this._resolve = resolve; this._reject = reject; });
    this.readyPromise.catch(() => {});
    const p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", BOOT], {
      windowsHide: true,
      env: { ...process.env, PIPHIN_ENGINE: SOURCE },
    });
    this.proc = p;
    let buf = "";
    let errText = "";
    p.stdout.setEncoding("utf8");
    p.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, "");
        buf = buf.slice(i + 1);
        if (line) this._line(line.split("\t"));
      }
    });
    p.stderr.setEncoding("utf8");
    p.stderr.on("data", (d) => { errText += d; });
    p.on("error", (e) => { this.error = e.message; });
    p.on("exit", (code) => {
      const was = this.ready;
      this.proc = null;
      this.ready = false;
      for (const k of Object.keys(this.waiting)) { for (const w of this.waiting[k]) w.reject(new Error("O motor de macros fechou")); delete this.waiting[k]; }
      if (this.stopping) { this.emit("status"); return; }
      this.error = (errText.split(/\r?\n/).find((l) => l.trim()) || `O motor de macros fechou (código ${code})`).trim();
      this._reject(new Error(this.error));
      this.emit("status");
      this.emit("exit", { code, was });
      // reinicia sozinho, mas desiste se cair 3 vezes em 1 minuto
      const now = Date.now();
      this.crashes = this.crashes.filter((t) => now - t < 60000).concat(now);
      if (was && this.crashes.length < 3) setTimeout(() => this.start().then(() => this.emit("restarted")).catch(() => {}), 1000);
    });
    return this.readyPromise;
  }

  stop() {
    this.stopping = true;
    if (this.proc) { try { this.proc.stdin.end(); } catch { /* já fechou */ } }
  }

  send(...fields) {
    if (!this.proc || !this.proc.stdin.writable) return false;
    this.proc.stdin.write(fields.map((f) => String(f ?? "").replace(/[\t\r\n]/g, " ")).join("\t") + "\n");
    return true;
  }

  // pergunta algo ao motor e espera a resposta de mesmo nome
  async ask(kind, ...args) {
    await this.start();
    return new Promise((resolve, reject) => {
      (this.waiting[kind] = this.waiting[kind] || []).push({ resolve, reject });
      this.send(kind, ...args);
      setTimeout(() => reject(new Error("O motor de macros não respondeu")), 3000);
    });
  }

  _line(f) {
    const [type] = f;
    if (type === "ready") {
      this.ready = true;
      this.screen = { x: +f[1], y: +f[2], w: +f[3], h: +f[4] };
      this._resolve();
      this.emit("status");
      return;
    }
    if (this.waiting[type] && this.waiting[type].length) { this.waiting[type].shift().resolve(f.slice(1)); return; }
    this.emit("line", f);
  }
}

module.exports = { Engine };
