// Gera web/ui/icons.css: os ícones do Piphin UI (Lucide, licença ISC) como classes CSS.
//   <i class="i i-house"></i>   -> ícone na cor do texto, em qualquer página (Hub e módulos)
// Cada ícone vira uma máscara (data URI), então funciona até em páginas de outra origem.
// Uso: npm run ui-icons   (para incluir um ícone novo, acrescente o nome do arquivo do Lucide em NAMES)
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "node_modules", "lucide-static", "icons");
const OUT = path.join(__dirname, "..", "web", "ui", "icons.css");

const NAMES = `
house layout-grid store settings search command refresh-cw download arrow-up-circle circle-arrow-up play square x check plus minus
trash-2 folder-open external-link chevron-right chevron-down chevron-left chevron-up panel-left-close panel-left-open sparkles
cpu monitor memory-stick hard-drive network thermometer gauge activity fan zap layers keyboard mouse-pointer-click mouse timer
circle-dot circle list sliders-horizontal power bell info triangle-alert circle-check circle-x shield-check shield bot
message-square wand-sparkles scan-eye app-window puzzle package rotate-ccw log-out eye eye-off copy pencil upload file-text save
pin crosshair mouse-pointer-2 move type hourglass repeat pause gamepad-2 clock user star filter arrow-right arrow-left
maximize-2 ellipsis grip-vertical flame battery wifi circuit-board server database chart-line chart-area waves radio video image
mic volume-2 brain code terminal arrow-down-to-line arrow-up-from-line keyboard-music record-circle scan-line loader lock lock-open
rocket heart-pulse layout-dashboard microchip box-select hand gauge-circle chart-no-axes-column calendar-clock history
globe book-open flask-conical message-square square-terminal palette users library brain-circuit hard-drive-download
`.split(/\s+/).filter(Boolean);

const css = [`/* Piphin UI · ícones (Lucide ${require("lucide-static/package.json").version}, ISC) · gerado por scripts/make-ui-icons.js */`,
  `.i { display: inline-block; width: 1.15em; height: 1.15em; flex: none; vertical-align: -0.2em; background: currentColor;`,
  `  -webkit-mask: var(--i) center / contain no-repeat; mask: var(--i) center / contain no-repeat; }`];
const missing = [];
for (const name of [...new Set(NAMES)]) {
  const file = path.join(SRC, name + ".svg");
  if (!fs.existsSync(file)) { missing.push(name); continue; }
  const svg = fs.readFileSync(file, "utf8")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s*class="[^"]*"/, "")
    .replace(/stroke="currentColor"/, 'stroke="#000"')
    .replace(/\s+/g, " ")
    .trim();
  css.push(`.i-${name} { --i: url("data:image/svg+xml,${encodeURIComponent(svg).replace(/'/g, "%27")}"); }`);
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, css.join("\n") + "\n");
console.log(`ícones: ${NAMES.length - missing.length} gerados em ${path.relative(process.cwd(), OUT)}` + (missing.length ? ` · não existem no Lucide: ${missing.join(", ")}` : ""));
