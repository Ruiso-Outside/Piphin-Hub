// Corrige as permissões do .tar.gz do Linux gerado no Windows (o electron-builder grava tudo como 644,
// e aí o piphin-hub não abre). Marca como executáveis o programa, os auxiliares do Chromium, as bibliotecas .so
// e os scripts .sh. Uso: node scripts/fix-linux-tar.js [arquivo.tar.gz]  (padrão: o da versão atual em dist/)
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const root = path.join(__dirname, "..");
const pkg = require(path.join(root, "package.json"));
const file = path.resolve(process.argv[2] || path.join(root, "dist", `Arasaka-Central-${pkg.version}-linux-x64.tar.gz`));
const EXEC = /(^|\/)(piphin-hub|chrome-sandbox|chrome_crashpad_handler|[^/]+\.so(\.\d+)*|[^/]+\.sh)$/;

const buf = zlib.gunzipSync(fs.readFileSync(file));
const field = (h, off, len) => h.toString("latin1", off, off + len).replace(/\0.*$/s, "").trim();
let pos = 0, changed = 0, longName = null;
while (pos + 512 <= buf.length) {
  const h = buf.subarray(pos, pos + 512);
  if (h.every((b) => b === 0)) break; // fim do arquivo
  const type = String.fromCharCode(h[156] || 48);
  const size = parseInt(field(h, 124, 12), 8) || 0;
  const prefix = field(h, 345, 155);
  let name = longName || (prefix ? prefix + "/" : "") + field(h, 0, 100);
  longName = null;
  if (type === "L") longName = buf.toString("utf8", pos + 512, pos + 512 + size).replace(/\0.*$/s, ""); // nome longo (GNU)
  const isFile = type === "0" || type === "\0";
  const isDir = type === "5";
  const want = isDir ? 0o755 : isFile && EXEC.test(name) ? 0o755 : null;
  if (want !== null && (parseInt(field(h, 100, 8), 8) & 0o777) !== want) {
    h.write(want.toString(8).padStart(7, "0") + "\0", 100, 8, "latin1");
    h.fill(0x20, 148, 156); // soma de verificação: calculada com o campo em espaços
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "latin1");
    changed++;
  }
  pos += 512 + Math.ceil(size / 512) * 512;
}
fs.writeFileSync(file, zlib.gzipSync(buf, { level: 9 }));
console.log(`permissões corrigidas em ${changed} entradas: ${file}`);
