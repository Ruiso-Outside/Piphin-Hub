// Dicionários de idioma do Piphin Hub e dos módulos (lib/i18n.js usa i18n/<código>.json).
//
//   node scripts/i18n.js extract <pasta>          acha os textos das telas (português) e atualiza <pasta>/i18n/source.jsonl
//   node scripts/i18n.js todo <pasta> [n]         textos ainda sem tradução (uma linha JSON por texto)
//   node scripts/i18n.js merge <pasta> <arq.jsonl> junta traduções ({"pt": ..., "en": ..., "th": ...} por linha)
//   node scripts/i18n.js build <pasta>            gera <pasta>/i18n/<código>.json e confere os {0} {1}
//
// Onde procurar: <pasta>/i18n/config.json  { "src": ["module", "web"], "skip": ["vendor"] }  (padrão: module e web).
// Os módulos usam esta mesma ferramenta: node ../Hub/scripts/i18n.js extract .
const fs = require("fs");
const path = require("path");
const acorn = require("acorn");
const walk = require("acorn-walk");
const { LANGS } = require("../lib/i18n");

const CODES = Object.keys(LANGS).filter((c) => c !== "pt");
const [, , cmd, rootArg, extra] = process.argv;
const root = path.resolve(rootArg || ".");
const dir = path.join(root, "i18n");
const SOURCE = path.join(dir, "source.jsonl");

function readSource() {
  if (!fs.existsSync(SOURCE)) return new Map();
  const m = new Map();
  for (const line of fs.readFileSync(SOURCE, "utf8").split(/\r?\n/)) { if (!line.trim()) continue; const o = JSON.parse(line); m.set(o.pt, o); }
  return m;
}
function writeSource(m) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SOURCE, [...m.values()].map((o) => JSON.stringify(o)).join("\n") + "\n");
}

// ---------------------------------------------------------------- extração
const MARK = "\u0001";
const ENT = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " ", "&middot;": "·", "&hellip;": "…", "&rarr;": "→" };
const SKIP_CALLS = new Set(["log", "warn", "error", "debug", "info", "querySelector", "querySelectorAll", "getElementById", "closest", "matches", "addEventListener",
  "removeEventListener", "setAttribute", "getAttribute", "removeAttribute", "toggleAttribute", "hasAttribute", "require", "handle", "emit", "invoke", "on", "call",
  "startsWith", "endsWith", "includes", "split", "join", "indexOf", "getItem", "setItem", "removeItem", "createElement", "RegExp", "fetch", "postMessage", "send",
  "sendSync", "dispatchEvent", "Event", "CustomEvent", "registerHotkey", "unregisterHotkey", "openWindow", "showWindow", "hideWindow", "sendToWindow", "callTool", "readJson", "getContext"]);
const USER_CALLS = new Set(["notify", "messageBox", "toast", "confirmBox", "ask", "status"]);

function candidates(raw, out, page) {
  if (!raw || (!page && raw.length > 4000)) return; // páginas .html inteiras passam; textos muito longos de JS não
  let s = raw.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ");
  const pieces = [];
  if (/<[a-z!/][^>]*>/i.test(s)) {
    for (const m of s.matchAll(/\b(?:title|placeholder|aria-label|alt|data-tip|label)="([^"]*)"/g)) pieces.push(m[1].includes("<") ? "" : m[1]);
    for (const seg of s.replace(/<!--[\s\S]*?-->/g, " ").split(/<[^>]*>/)) pieces.push(seg);
  } else pieces.push(s);
  for (let p of pieces) {
    p = p.replace(/&[a-z#0-9]+;/gi, (e) => ENT[e] || e).replace(/\s+/g, " ").trim();
    if (!p) continue;
    // valores ({0}) nas pontas que só têm sinais em volta saem; o meio fica
    const plain = p.split(MARK).join(" ");
    const letters = (plain.match(/[A-Za-zÀ-ÿ]/g) || []).length;
    if (letters < 2) continue;
    if (/[{}]|=>|\bfunction\b|\breturn\b|\\|`/.test(plain)) continue;
    if (/^[\w.$-]+$/.test(plain) && !/[À-ÿ]/.test(plain) && !/^[A-ZÀ-Ý][a-zà-ÿ]/.test(plain)) continue; // identificadores
    if (/^[A-Z0-9_]+$/.test(plain)) continue;
    if (/^(https?:|file:|data:|piphin:|mailto:|\.{0,2}\/|[A-Za-z]:[\\/])/.test(plain)) continue;
    if (/^[\w./-]+\.(js|css|html|png|jpe?g|svg|json|zip|exe|ps1|dll|wav|mp3|mp4|ico|md)$/i.test(plain)) continue;
    if (/^[a-z-]+\s*:\s*[^ ]+;?$/.test(plain) || /^[.#][\w-]/.test(plain) || /^\[[\w-]+/.test(plain)) continue; // CSS e seletores
    if (/^(Ctrl|Shift|Alt|Win|Cmd)\+/.test(plain) && !/\s\w+\s/.test(plain)) continue;
    let n = 0;
    out.add(p.replace(new RegExp(MARK, "g"), () => `{${n++}}`));
  }
}

function fromJs(code, out, file) {
  let ast;
  for (const sourceType of ["script", "module"]) {
    try { ast = acorn.parse(code, { ecmaVersion: "latest", sourceType, allowHashBang: true, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true }); break; } catch (e) { if (sourceType === "module") { console.warn("não li", file, e.message); return; } }
  }
  const calleeName = (c) => (c.type === "Identifier" ? c.name : c.type === "MemberExpression" && !c.computed ? c.property.name : null);
  const keep = (node, anc) => {
    const parent = anc[anc.length - 2];
    if (parent && parent.type === "Property" && parent.key === node && !parent.computed) return false;
    if (parent && (parent.type === "ImportDeclaration" || parent.type === "ExportNamedDeclaration")) return false;
    if (parent && (parent.type === "CallExpression" || parent.type === "NewExpression") && parent.arguments[0] === node && SKIP_CALLS.has(calleeName(parent.callee))) return false;
    if (parent && parent.type === "BinaryExpression" && /^[!=]==?$/.test(parent.operator)) return false; // comparações: valores de código
    if (parent && parent.type === "SwitchCase" && parent.test === node) return false;
    // respostas para a IA (ctx.handle("tool:...")): só o que a pessoa vê (notificações, perguntas)
    const tool = anc.some((a) => a.type === "CallExpression" && calleeName(a.callee) === "handle" && a.arguments[0] && a.arguments[0].type === "Literal" && /^tool:/.test(String(a.arguments[0].value)));
    if (tool && !anc.some((a) => (a.type === "CallExpression" && USER_CALLS.has(calleeName(a.callee))) || (a.type === "Property" && a.key && /^(message|detail|buttons)$/.test(a.key.name || a.key.value)))) return false;
    return true;
  };
  walk.ancestor(ast, {
    Literal(node, anc) { if (typeof node.value === "string" && keep(node, anc)) candidates(node.value, out); },
    TemplateLiteral(node, anc) {
      if (!keep(node, anc)) return;
      const parent = anc[anc.length - 2];
      if (parent && parent.type === "TaggedTemplateExpression") return;
      candidates(node.quasis.map((q) => q.value.cooked ?? q.value.raw).join(MARK), out);
    },
  });
}

function files() {
  const cfgFile = path.join(dir, "config.json");
  const cfg = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, "utf8")) : {};
  const src = cfg.src || ["module", "web"], skip = new Set(["node_modules", "vendor", "dist", "i18n", ...(cfg.skip || [])]);
  const list = [];
  const visit = (p) => {
    if (!fs.existsSync(p)) return;
    const st = fs.statSync(p);
    if (st.isDirectory()) { if (!skip.has(path.basename(p))) for (const f of fs.readdirSync(p)) visit(path.join(p, f)); }
    else if (/\.(js|html)$/.test(p) && !(cfg.skipFiles || []).includes(path.relative(root, p).replace(/\\/g, "/"))) list.push(p);
  };
  for (const s of src) visit(path.join(root, s));
  return list;
}

function extract() {
  const out = new Set();
  for (const f of files()) {
    const code = fs.readFileSync(f, "utf8");
    if (f.endsWith(".html")) {
      candidates(code.replace(/<script[\s\S]*?<\/script>/gi, " "), out, true);
      for (const m of code.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) fromJs(m[1], out, f);
    } else fromJs(code, out, f);
  }
  const cfgFile = path.join(dir, "config.json");
  const extraKeys = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, "utf8")).extra || [] : [];
  for (const k of extraKeys) out.add(k);
  const old = readSource(), next = new Map();
  for (const k of [...out].sort((a, b) => a.localeCompare(b, "pt-BR"))) next.set(k, old.get(k) || { pt: k });
  writeSource(next);
  const missing = [...next.values()].filter((o) => CODES.some((c) => !o[c])).length;
  console.log(`${path.basename(root)}: ${next.size} textos (${next.size - old.size >= 0 ? "+" : ""}${next.size - old.size}), ${missing} sem tradução completa`);
}

function todo() {
  const n = Number(extra) || 1e9;
  const list = [...readSource().values()].filter((o) => CODES.some((c) => !o[c])).slice(0, n);
  for (const o of list) console.log(JSON.stringify(o.pt));
}

function merge() {
  const m = readSource();
  let ok = 0, unknown = 0;
  for (const line of fs.readFileSync(path.resolve(extra), "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch (e) { console.log("linha inválida:", line.slice(0, 120)); continue; }
    if (Array.isArray(o)) o = Object.fromEntries(["pt", ...CODES].map((c, i) => [c, o[i]]));
    if (o["*"] !== undefined) for (const c of CODES) o[c] = o["*"] === "=" ? o.pt : o["*"]; // igual em todos os idiomas (nomes, termos técnicos)
    const cur = m.get(o.pt);
    if (!cur) { unknown++; continue; }
    for (const c of CODES) if (o[c]) cur[c] = o[c];
    ok++;
  }
  writeSource(m);
  console.log(`juntadas: ${ok}${unknown ? ` · ${unknown} textos que não existem mais` : ""}`);
}

function build() {
  const m = readSource();
  const problems = [];
  const ph = (s) => (String(s).match(/\{\d+\}/g) || []).sort().join(",");
  for (const c of CODES) {
    const d = {};
    for (const o of m.values()) {
      if (!o[c] || o[c] === o.pt) continue;
      if (ph(o[c]) !== ph(o.pt)) { problems.push(`${c}: ${o.pt} -> ${o[c]}`); continue; }
      d[o.pt] = o[c];
    }
    fs.writeFileSync(path.join(dir, c + ".json"), JSON.stringify(d));
  }
  const missing = [...m.values()].filter((o) => CODES.some((c) => !o[c])).length;
  console.log(`${path.basename(root)}: ${m.size} textos, ${missing} sem tradução completa${problems.length ? `, ${problems.length} com {n} diferente:` : ""}`);
  for (const p of problems.slice(0, 30)) console.log("  " + p);
}

({ extract, todo, merge, build }[cmd] || (() => console.log("uso: extract | todo | merge | build <pasta>")))();
