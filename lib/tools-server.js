// Ferramentas dos módulos para a IA: um servidor MCP (Model Context Protocol, HTTP "streamable") só no
// 127.0.0.1, num endereço com token secreto. O Piphin LLM se conecta nele e o modelo passa a poder usar
// as ferramentas que cada módulo declara no module.json ("tools"), por exemplo criar uma macro no Piphin
// Macro ou ler o hardware no InfoHardware.
//
// No module.json:  "tools": [{ "name": "create_macro", "description": "...", "input": { JSON Schema }, "readOnly": false }]
// No backend:      ctx.handle("tool:create_macro", async (args) => "texto para a IA" | { ...objeto })
// O módulo é iniciado sozinho se estiver parado. Para a IA a ferramenta se chama <módulo>_<ferramenta>.
const http = require("http");
const crypto = require("crypto");

const PROTOCOL = "2025-06-18";
const SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"];
const CALL_TIMEOUT = 5 * 60 * 1000;

class ToolsServer {
  constructor({ modules, hubVersion, onCall }) {
    this.modules = modules;
    this.hubVersion = hubVersion;
    this.onCall = onCall || (() => {});
    this.token = crypto.randomBytes(24).toString("hex");
    this.url = "";
  }

  // nome que a IA vê: só letras, números e _ (o id "llm-local" vira "llm_local")
  static toolName(modId, tool) { return `${modId}_${tool}`.replace(/[^A-Za-z0-9_]/g, "_"); }

  list() {
    const out = [];
    for (const mf of this.modules.installed()) {
      for (const t of Array.isArray(mf.tools) ? mf.tools : []) {
        if (!t || !/^[a-z0-9_]{1,40}$/.test(t.name || "")) continue;
        const schema = t.input && t.input.type === "object" ? t.input : { type: "object", properties: {} };
        out.push({ mod: mf, tool: t, def: { name: ToolsServer.toolName(mf.id, t.name), title: `${mf.name}: ${t.title || t.name}`,
          description: `[${mf.name}] ${String(t.description || t.name)}`.slice(0, 1500), inputSchema: schema,
          annotations: { readOnlyHint: !!t.readOnly } } });
      }
    }
    return out;
  }

  async call(name, args) {
    const hit = this.list().find((x) => x.def.name === name);
    if (!hit) throw Object.assign(new Error("Ferramenta desconhecida: " + name), { code: -32602 });
    this.onCall(hit.mod, hit.tool, args);
    let timer;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${hit.mod.name} não respondeu a tempo`)), CALL_TIMEOUT); });
    try {
      const data = await Promise.race([this.modules.callTool(hit.mod.id, hit.tool.name, args || {}), timeout]);
      const text = typeof data === "string" ? data : JSON.stringify(data, null, 1);
      return { content: [{ type: "text", text: text || "(ok)" }], isError: false };
    } catch (e) {
      return { content: [{ type: "text", text: (e && e.message) || String(e) }], isError: true };
    } finally { clearTimeout(timer); }
  }

  async rpc(msg) {
    const { id, method, params } = msg || {};
    switch (method) {
      case "initialize": {
        const want = params && params.protocolVersion;
        const names = this.list().map((x) => x.mod.name).filter((v, i, a) => a.indexOf(v) === i);
        return { protocolVersion: SUPPORTED.includes(want) ? want : PROTOCOL, capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "Piphin Hub", version: this.hubVersion },
          instructions: "Ferramentas dos módulos instalados no Piphin Hub" + (names.length ? ` (${names.join(", ")})` : "") +
            ". Use-as quando o pedido envolver esses programas e explique ao usuário, em linguagem simples, o que foi feito." };
      }
      case "ping": return {};
      case "tools/list": return { tools: this.list().map((x) => x.def) };
      case "tools/call": return this.call(params && params.name, params && params.arguments);
      default: throw Object.assign(new Error("Método não suportado: " + method), { code: -32601 });
    }
  }

  start() {
    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => this.handle(req, res));
      srv.on("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        this.server = srv;
        this.url = `http://127.0.0.1:${srv.address().port}/mcp/${this.token}`;
        resolve(this.url);
      });
    });
  }

  stop() { if (this.server) this.server.close(); }

  handle(req, res) {
    // só o caminho com o token; páginas da web não conseguem ler a resposta (sem CORS) nem adivinhar o token
    if (req.url !== `/mcp/${this.token}`) { res.writeHead(404); return res.end(); }
    if (req.method === "DELETE") { res.writeHead(200); return res.end(); }
    if (req.method !== "POST") { res.writeHead(405, { Allow: "POST" }); return res.end(); }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (d) => { body += d; if (body.length > 4 * 1024 * 1024) req.destroy(); });
    req.on("end", async () => {
      let msg;
      try { msg = JSON.parse(body); } catch { return this.reply(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON inválido" } }); }
      const batch = Array.isArray(msg);
      const out = [];
      for (const m of batch ? msg : [msg]) {
        if (m.id === undefined || m.id === null) continue; // notificação: sem resposta
        try { out.push({ jsonrpc: "2.0", id: m.id, result: await this.rpc(m) }); }
        catch (e) { out.push({ jsonrpc: "2.0", id: m.id, error: { code: e.code || -32603, message: e.message } }); }
      }
      if (!out.length) { res.writeHead(202); return res.end(); }
      this.reply(res, 200, batch ? out : out[0]);
    });
  }

  reply(res, code, obj) {
    const data = Buffer.from(JSON.stringify(obj), "utf8");
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": data.length });
    res.end(data);
  }
}

module.exports = { ToolsServer };
