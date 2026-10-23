// Idiomas do Piphin Hub e dos módulos. O texto original é o português; cada idioma é um dicionário
// i18n/<código>.json  { "texto em português": "tradução" }  (gerado por scripts/i18n.js).
// Textos com valores usam {0}, {1}...: "Vídeo exportado: {0} ({1} MB)" -> "Video exported: {0} ({1} MB)".
//
// - No processo principal: translator(dict) traduz janelas do Windows, notificações e o menu do ícone.
// - Nas páginas (Hub e módulos): domScript(dict, locale) devolve um script que traduz a tela sozinho,
//   inclusive o que aparece depois (MutationObserver), e faz as datas saírem no idioma escolhido.
//   Assim um módulo não precisa mudar o código das telas: basta ter o dicionário.
const fs = require("fs");
const path = require("path");

// código -> { nome no próprio idioma, locale para datas e números }
const LANGS = {
  pt: { name: "Português (Brasil)", locale: "pt-BR" },
  en: { name: "English", locale: "en-US" },
  es: { name: "Español", locale: "es-ES" },
  th: { name: "ไทย", locale: "th-TH" },
  zh: { name: "简体中文", locale: "zh-CN" },
  ja: { name: "日本語", locale: "ja-JP" },
  ko: { name: "한국어", locale: "ko-KR" },
  id: { name: "Bahasa Indonesia", locale: "id-ID" },
  vi: { name: "Tiếng Việt", locale: "vi-VN" },
  fr: { name: "Français", locale: "fr-FR" },
  de: { name: "Deutsch", locale: "de-DE" },
  ru: { name: "Русский", locale: "ru-RU" },
};

// idioma do Windows ("th-TH", "zh-Hans-CN"...) -> código suportado (inglês se não tiver)
function fromSystem(list) {
  for (const l of list || []) {
    const c = String(l).toLowerCase().split(/[-_]/)[0];
    if (LANGS[c]) return c;
  }
  return "en";
}

// dicionário de uma pasta (Hub ou módulo); português não tem arquivo
function loadDict(dir, lang) {
  if (!lang || lang === "pt") return {};
  try { return JSON.parse(fs.readFileSync(path.join(dir, "i18n", lang + ".json"), "utf8").replace(/^﻿/, "")); } catch { return {}; }
}

// ---------------------------------------------------------------- tradutor (também vai para as páginas: sem dependências)
function createTranslator(dict) {
  const exact = new Map(), buckets = new Map(), wild = [], cache = new Map();
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const k of Object.keys(dict || {})) {
    const v = dict[k];
    if (!v || typeof v !== "string") continue;
    if (!/\{\d+\}/.test(k)) { exact.set(k, v); continue; }
    const parts = k.split(/\{(\d+)\}/);
    const idx = [];
    let re = "^";
    for (let i = 0; i < parts.length; i++) {
      if (i % 2) { idx.push(Number(parts[i])); re += "(.+?)"; } else re += esc(parts[i]);
    }
    // lit: quanto texto fixo o modelo tem. "{0} de lixo para limpar" vem antes de "{0} de {1}";
    // modelos com quase nenhum texto fixo ("{0} de {1}", "{0}: {1}") só aceitam valores curtos
    const lit = parts.filter((x, i) => !(i % 2)).join("").replace(/[^A-Za-zÀ-ÿ]/g, "").length;
    const p = { re: new RegExp(re + "$", "s"), idx, v, lit, weak: lit < 5 };
    const head = parts[0].slice(0, 2);
    if (head.length === 2) { if (!buckets.has(head)) buckets.set(head, []); buckets.get(head).push(p); } else wild.push(p);
  }
  const byLit = (a, b) => b.lit - a.lit;
  wild.sort(byLit);
  for (const list of buckets.values()) list.sort(byLit);
  const has = exact.size + wild.length + buckets.size > 0;
  const short = (x) => x.length <= 24 && (x.match(/ /g) || []).length <= 2;
  function core(s) {
    const e = exact.get(s);
    if (e !== undefined) return e;
    for (const list of [buckets.get(s.slice(0, 2)) || [], wild]) {
      for (const p of list) {
        const m = p.re.exec(s);
        if (!m || (p.weak && !m.slice(1).every(short))) continue;
        // os valores também podem ter tradução (ex.: "Gravação · {0}")
        return p.v.replace(/\{(\d+)\}/g, (all, n) => { const i = p.idx.indexOf(Number(n)); if (i < 0) return all; const x = m[i + 1]; const t = exact.get(x); return t === undefined ? (x.length < s.length ? parts(x, 1) ?? x : x) : t; });
      }
    }
    return null;
  }
  // sem tradução inteira: "Texto (Ctrl+Z)" traduz o texto (e o que está entre parênteses, se tiver);
  // "frase; outra frase" traduz cada frase; "6 ajustes..." traduz depois do número;
  // "a, b, c" só se todos os itens tiverem tradução
  function parts(s, depth) {
    if (depth > 2) return null;
    const one = (p) => { const w = /^(\s*)(.*?)(\s*)$/s.exec(p), x = w[2] ? core(w[2]) ?? parts(w[2], depth + 1) : null; return x == null || x === "" ? null : w[1] + x + w[3]; };
    let m = /^(.+?)\s\(([^()]{1,30})\)$/.exec(s);
    if (m) {
      const h = core(m[1]) ?? parts(m[1], depth + 1);
      if (h != null) return `${h} (${core(m[2]) ?? m[2]})`;
    }
    if (s.includes("; ")) {
      const list = s.split("; "), t = list.map(one);
      if (t.some((x) => x != null)) return t.map((x, i) => x ?? list[i]).join("; ");
    }
    m = /^([\d.,]+\s)(\D.*)$/s.exec(s);
    if (m) { const x = core(m[2]); if (x != null) return m[1] + x; }
    if (s.includes(", ")) {
      const list = s.split(", "), t = list.map(one);
      if (t.every((x) => x != null)) return t.join(", ");
    }
    return null;
  }
  function tr(s) {
    if (!has || s == null) return s;
    s = String(s);
    if (cache.has(s)) return cache.get(s);
    let out = s;
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s);
    const body = m[2].replace(/\s+/g, " ");
    if (body && /[A-Za-zÀ-ÿ]/.test(body)) {
      const t = core(body) ?? parts(body, 0);
      if (t != null) out = m[1] + t + m[3];
    }
    if (cache.size > 20000) cache.clear();
    cache.set(s, out);
    return out;
  }
  // com valores: t("Vídeo exportado: {0}", nome)
  tr.f = (key, ...vals) => tr(key).replace(/\{(\d+)\}/g, (all, n) => (vals[n] !== undefined ? vals[n] : all));
  return tr;
}

// ---------------------------------------------------------------- tela (roda dentro da página)
function startDom(dict, locale, skip) {
  /* global document, MutationObserver, Node, NodeFilter */
  // datas (e números) pedidos em português saem no idioma escolhido
  if (locale && !/^pt/i.test(locale)) {
    const fix = (l) => (l === undefined || l === null || /^pt(-br)?$/i.test(String(l)) ? locale : l);
    for (const n of ["toLocaleDateString", "toLocaleTimeString", "toLocaleString"]) {
      const o = Date.prototype[n];
      Date.prototype[n] = function (l, opt) { return o.call(this, fix(l), opt); };
    }
    const no = Number.prototype.toLocaleString;
    // moeda continua no formato original (ex.: R$ do Piphin Finanças)
    Number.prototype.toLocaleString = function (l, opt) { return no.call(this, opt && opt.style === "currency" ? l : fix(l), opt); };
    for (const k of ["DateTimeFormat", "RelativeTimeFormat", "NumberFormat"]) {
      const O = Intl[k];
      if (!O) continue;
      const W = function (l, opt) { return new O(k === "NumberFormat" && opt && opt.style === "currency" ? l : fix(l), opt); };
      W.prototype = O.prototype;
      W.supportedLocalesOf = O.supportedLocalesOf;
      Intl[k] = W;
    }
  }
  const tr = createTranslator(dict);
  // para o código da página que quiser traduzir algo que não vai para a tela
  window.piphinT = tr;
  if (!Object.keys(dict || {}).length) return;
  // o que nunca é traduzido: o que a pessoa escreve, código e o que o módulo marcar
  const SKIP = "script,style,textarea,pre,code,[contenteditable=true],[contenteditable=''],[data-noi18n],.notranslate,[translate=no]" + (skip ? "," + skip : "");
  const ATTRS = ["title", "placeholder", "aria-label", "alt", "data-tip", "label"];
  const seen = new WeakMap();
  const skipped = (el) => !el || (el.closest && el.closest(SKIP));
  function text(n) {
    const v = n.nodeValue;
    if (seen.get(n) === v || skipped(n.parentElement)) return;
    const t = tr(v);
    if (t !== v) n.nodeValue = t;
    seen.set(n, n.nodeValue);
  }
  function attrs(el) {
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (!v) continue;
      const t = tr(v);
      if (t !== v) el.setAttribute(a, t);
    }
    // botões <input type="button" value="...">
    if (el.tagName === "INPUT" && /^(button|submit|reset)$/i.test(el.type) && el.value) { const t = tr(el.value); if (t !== el.value) el.value = t; }
  }
  function walk(root) {
    if (root.nodeType === 3) return text(root);
    if (root.nodeType !== 1 && root.nodeType !== 9) return;
    if (root.nodeType === 1) { if (skipped(root)) { if (root.closest(SKIP) === root) attrs(root); return; } attrs(root); }
    const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.nodeType === 1 && n.matches(SKIP) ? (attrs(n), NodeFilter.FILTER_REJECT) : NodeFilter.FILTER_ACCEPT),
    });
    for (let n = w.nextNode(); n; n = w.nextNode()) { if (n.nodeType === 3) text(n); else attrs(n); }
  }
  new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === "childList") m.addedNodes.forEach(walk);
      else if (m.type === "characterData") text(m.target);
      else if (m.type === "attributes" && !skipped(m.target.parentElement)) {
        const v = m.target.getAttribute(m.attributeName), t = v && tr(v);
        if (t && t !== v) m.target.setAttribute(m.attributeName, t);
      }
    }
  }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  if (document.documentElement) walk(document.documentElement);
}

// script para executar na página (webFrame.executeJavaScript), com o dicionário dentro
function domScript(dict, lang, skip) {
  const locale = (LANGS[lang] || LANGS.pt).locale;
  return `(() => { try { if (window.__piphinI18n) return; window.__piphinI18n = 1; const setLang = () => document.documentElement && (document.documentElement.lang = ${JSON.stringify(locale)}); setLang(); document.addEventListener("DOMContentLoaded", setLang);
    ${createTranslator.toString()}\n${startDom.toString()}\nstartDom(${JSON.stringify(dict || {})}, ${JSON.stringify(locale)}, ${JSON.stringify(skip || "")}); } catch (e) { console.error("piphin i18n", e); } })();`;
}

module.exports = { LANGS, fromSystem, loadDict, createTranslator, domScript };
