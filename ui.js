/**
 * Tokens to SCSS — ui.js (iframe context, no direct `penpot` access)
 *
 * Универсальный генератор: для КАЖДОГО набора токенов (TokenSet), какой бы он ни назывался,
 * собирает файл. Ссылки токенов друг на друга ("{token.name}") превращаются в ссылки на
 * переменные ($slug / var(--slug)), а не разворачиваются в resolved-значения — это и есть
 * "сохранение наследования". Если токен ссылается на токен ИЗ ДРУГОГО набора, файл (в SCSS-режиме)
 * получает `@use "<тот-набор>" as *;`.
 *
 * Составные типы токенов:
 *  - typography → в SCSS: map ($<set>-typography) + @mixin; в CSS: набор custom properties
 *    по каждому подполю (--name-font-size, --name-font-weight, …)
 *  - shadow     → обычная переменная со списком слоёв (box-shadow поддерживает несколько через запятую)
 * Остальные типы — скалярные переменные (с px там, где это единицы измерения).
 *
 * Опции generateAll(setsData, options):
 *   mergeGlobals: bool        — объединить все Global/* наборы в один _variables
 *   prefix: string            — префикс для всех генерируемых имён переменных
 *   outputMode: "scss"|"css"  — формат вывода
 *   selectedSetNames: string[]|undefined — если задано, генерируются только эти наборы
 *                                (остальные всё равно доступны для fallback-разрешения ссылок)
 */

// ---------------------------------------------------------------------------
// Утилиты
// ---------------------------------------------------------------------------

function slug(name) {
  return String(name)
    .toLowerCase()
    .replace(/[.\/_\s]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

const PX_TYPES = new Set(["spacing", "borderRadius", "borderWidth", "sizing", "dimension"]);
const REF_RE = /\{([^{}]+)\}/g;

function findRefs(str) {
  const refs = [];
  let m;
  REF_RE.lastIndex = 0;
  while ((m = REF_RE.exec(str))) refs.push(m[1]);
  return refs;
}

function scanValueForRefs(value, refs) {
  if (typeof value === "string") {
    findRefs(value).forEach((r) => refs.push(r));
  } else if (Array.isArray(value)) {
    value.forEach((v) => scanValueForRefs(v, refs));
  } else if (value && typeof value === "object") {
    Object.values(value).forEach((v) => scanValueForRefs(v, refs));
  }
}

// ---------------------------------------------------------------------------
// Состояние текущей генерации (сбрасывается в начале каждого generateAll)
// ---------------------------------------------------------------------------

let VAR_PREFIX = "";
let OUTPUT_MODE = "scss"; // "scss" | "css"
let WARNINGS = [];
let ALL_TOKENS_BY_NAME = new Map(); // полный пул токенов (до фильтрации по выбору наборов) — для fallback

function warn(msg) {
  console.warn("[Tokens to SCSS] " + msg);
  WARNINGS.push(msg);
}

function getWarnings() {
  return WARNINGS.slice();
}

// ---------------------------------------------------------------------------
// Имена переменных / способ сослаться на переменную (зависит от VAR_PREFIX и OUTPUT_MODE)
// ---------------------------------------------------------------------------

function baseSlugWithPrefix(name) {
  const base = slug(name);
  return VAR_PREFIX ? `${slug(VAR_PREFIX)}-${base}` : base;
}

function varName(name) {
  return (OUTPUT_MODE === "css" ? "--" : "$") + baseSlugWithPrefix(name);
}

function varRef(name) {
  return OUTPUT_MODE === "css" ? `var(${varName(name)})` : varName(name);
}

// ---------------------------------------------------------------------------
// Разрешение ссылок между наборами + топологический порядок внутри набора
// ---------------------------------------------------------------------------

function buildBySet(setsData) {
  const bySet = new Map();
  setsData.forEach((set) => {
    const m = new Map();
    set.tokens.forEach((t) => m.set(t.name, t));
    bySet.set(set.name, m);
  });
  return bySet;
}

function collectDeps(token, currentSetName, bySet) {
  const refs = [];
  scanValueForRefs(token.value, refs);
  const sameSetDeps = new Set();
  const crossSetDeps = new Set();
  refs.forEach((refName) => {
    if (bySet.get(currentSetName).has(refName)) {
      sameSetDeps.add(refName);
    } else {
      for (const [setName, tokens] of bySet) {
        if (setName !== currentSetName && tokens.has(refName)) {
          crossSetDeps.add(setName);
          break;
        }
      }
    }
  });
  return { sameSetDeps, crossSetDeps };
}

function topoSortTokens(tokens, sameSetDepsMap) {
  const byName = new Map(tokens.map((t) => [t.name, t]));
  const visited = new Set();
  const result = [];
  function visit(name, stack) {
    if (visited.has(name) || stack.has(name)) return;
    const t = byName.get(name);
    if (!t) return;
    stack.add(name);
    (sameSetDepsMap.get(name) || new Set()).forEach((dep) => visit(dep, stack));
    stack.delete(name);
    visited.add(name);
    result.push(t);
  }
  tokens.forEach((t) => visit(t.name, new Set()));
  return result;
}

// ---------------------------------------------------------------------------
// Подстановка ссылок "{token}" -> переменная/var(), с fallback на resolved-значение,
// если токен исключён текущей выборкой наборов (selectedSetNames / merge)
// ---------------------------------------------------------------------------

function refToText(refName, bySet, promotedPxNumbers) {
  for (const [, tokens] of bySet) {
    if (tokens.has(refName)) return varRef(refName);
  }
  const info = ALL_TOKENS_BY_NAME.get(refName);
  if (info) {
    warn(`Токен "${refName}" не входит в текущую выборку наборов — вместо ссылки подставлено его resolved-значение.`);
    return formatScalarValue(info.token, promotedPxNumbers || new Set(), bySet);
  }
  warn(`Не найден токен "${refName}", на который ссылается другой токен — значение оставлено как есть.`);
  return `{${refName}}`;
}

function substitute(str, bySet, promotedPxNumbers) {
  let hadRef = false;
  const replaced = str.replace(/\{([^{}]+)\}/g, (_, refName) => {
    hadRef = true;
    return refToText(refName, bySet, promotedPxNumbers);
  });
  if (OUTPUT_MODE === "css" && hadRef && /[*/]/.test(replaced)) {
    return `calc(${replaced})`;
  }
  return replaced;
}

// ---------------------------------------------------------------------------
// Промоция "number"-токенов (например, base-module), используемых как px-множитель
// в spacing/borderRadius/etc — им тоже нужен px, иначе `$base-module * 3` не даст px
// ---------------------------------------------------------------------------

function computePromotedPxNumbers(setsData) {
  const promoted = new Set();
  const allByName = new Map();
  setsData.forEach((set) => set.tokens.forEach((t) => allByName.set(t.name, t)));
  setsData.forEach((set) => {
    set.tokens.forEach((t) => {
      if (PX_TYPES.has(t.type) && typeof t.value === "string") {
        findRefs(t.value).forEach((refName) => {
          const refToken = allByName.get(refName);
          if (refToken && refToken.type === "number") promoted.add(refName);
        });
      }
    });
  });
  return promoted;
}

// ---------------------------------------------------------------------------
// Форматирование значений по типу токена
// ---------------------------------------------------------------------------

function formatScalarValue(token, promotedPxNumbers, bySet) {
  const { type, value, resolvedValue } = token;

  if (typeof value === "string" && /\{[^{}]+\}/.test(value)) {
    return substitute(value, bySet, promotedPxNumbers);
  }
  if (type === "fontFamilies" && Array.isArray(value)) {
    return value.map((f) => `"${f}"`).join(", ");
  }
  if (type === "color") {
    // Исходное value, а не resolvedValue — у Penpot resolvedValue теряет альфа-канал для rgba().
    return typeof value === "string" ? value : `${resolvedValue}`;
  }

  const v = resolvedValue !== undefined && resolvedValue !== null ? resolvedValue : value;

  if (PX_TYPES.has(type) || (type === "number" && promotedPxNumbers && promotedPxNumbers.has(token.name))) {
    return v === 0 || v === "0" ? "0" : `${v}px`;
  }
  if (type === "fontSizes") return `${v}px`;
  if (type === "letterSpacing") return v === 0 || v === "0" ? "0" : `${v}px`;
  if (type === "rotation") return `${v}deg`;
  return `${v}`;
}

function formatShadowValue(token, bySet, promotedPxNumbers) {
  const layers = Array.isArray(token.value) ? token.value : [token.value];
  return layers
    .map((layer) => {
      const inset = layer.inset ? "inset " : "";
      const color =
        typeof layer.color === "string" && /\{[^{}]+\}/.test(layer.color)
          ? substitute(layer.color, bySet, promotedPxNumbers)
          : layer.color;
      return `${inset}${layer.offsetX}px ${layer.offsetY}px ${layer.blur}px ${layer.spread}px ${color}`;
    })
    .join(", ");
}

const TYPOGRAPHY_KEY_MAP = [
  ["fontFamily", "font-family"],
  ["fontSize", "font-size"],
  ["fontWeight", "font-weight"],
  ["lineHeight", "line-height"],
  ["letterSpacing", "letter-spacing"],
  ["textCase", "text-transform"],
  ["textDecoration", "text-decoration"],
];

function typographySubEntries(token, bySet, promotedPxNumbers) {
  const value = token.value || {};
  const entries = [];
  for (const [key, cssKey] of TYPOGRAPHY_KEY_MAP) {
    let raw = value[key];
    if (raw === undefined || raw === null) continue;
    if (Array.isArray(raw)) raw = raw[0];
    if (typeof raw !== "string") continue;
    const formatted = /\{[^{}]+\}/.test(raw) ? substitute(raw, bySet, promotedPxNumbers) : `"${raw}"`;
    entries.push([cssKey, formatted]);
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Генерация одного файла на набор токенов — SCSS
// ---------------------------------------------------------------------------

function generateSetFileScss(set, bySet, promotedPxNumbers) {
  const crossSetDeps = new Set();
  const sameSetDepsMap = new Map();

  set.tokens.forEach((t) => {
    const { sameSetDeps, crossSetDeps: csd } = collectDeps(t, set.name, bySet);
    sameSetDepsMap.set(t.name, sameSetDeps);
    csd.forEach((s) => crossSetDeps.add(s));
  });

  const ordered = topoSortTokens(set.tokens, sameSetDepsMap);
  const fileSlug = slug(set.name); // имя файла НЕ зависит от префикса — только имена переменных внутри

  const lines = [];
  lines.push("// ============================================================================");
  lines.push(`// Сгенерировано плагином "Tokens to SCSS" — набор токенов: ${set.name}`);
  lines.push("// Ссылки между токенами сохранены как SCSS-переменные (наследование не разворачивается");
  lines.push("// в resolved-значения). Файл не редактировать вручную — пересоберите его плагином.");
  lines.push("// ============================================================================");

  if (crossSetDeps.size) {
    [...crossSetDeps].forEach((depSetName) => lines.push(`@use "${slug(depSetName)}" as *;`));
    lines.push("");
  }

  const typographyTokens = [];
  const seenVarNames = new Set();

  ordered.forEach((t) => {
    if (t.type === "typography") {
      typographyTokens.push(t);
      return;
    }
    const vName = varName(t.name);
    if (seenVarNames.has(vName)) {
      warn(`Коллизия имён: несколько токенов в наборе "${set.name}" дают одинаковую переменную ${vName}`);
    }
    seenVarNames.add(vName);

    const valueExpr =
      t.type === "shadow"
        ? formatShadowValue(t, bySet, promotedPxNumbers)
        : formatScalarValue(t, promotedPxNumbers, bySet);
    lines.push(`${vName}: ${valueExpr};`);
  });

  if (typographyTokens.length) {
    const mapName = `$${baseSlugWithPrefix(fileSlug + "-typography")}`;
    const mixinName = `${baseSlugWithPrefix(fileSlug + "-typography")}`;
    lines.push("");
    lines.push(`${mapName}: (`);
    typographyTokens.forEach((t, i) => {
      const entries = typographySubEntries(t, bySet, promotedPxNumbers);
      const body = entries.map(([k, v]) => `    ${k}: ${v}`).join(",\n");
      const comma = i < typographyTokens.length - 1 ? "," : "";
      lines.push(`  "${t.name}": (\n${body}\n  )${comma}`);
    });
    lines.push(");");
    lines.push("");
    lines.push(`@mixin ${mixinName}($name) {`);
    lines.push(`  $t: map-get(${mapName}, $name);`);
    lines.push("  font-family: map-get($t, font-family);");
    lines.push("  font-size: map-get($t, font-size);");
    lines.push("  font-weight: map-get($t, font-weight);");
    lines.push("  line-height: map-get($t, line-height);");
    lines.push("  letter-spacing: map-get($t, letter-spacing);");
    lines.push("}");
  }

  return { filename: `_${fileSlug}.scss`, content: lines.join("\n") + "\n" };
}

// ---------------------------------------------------------------------------
// Генерация одного файла на набор токенов — CSS custom properties
// ---------------------------------------------------------------------------

function guessCssSelector(setName) {
  if (/dark$/i.test(setName)) return '[data-theme="dark"]';
  if (/light$/i.test(setName)) return ':root, [data-theme="light"]';
  return ":root";
}

function generateSetFileCss(set, bySet, promotedPxNumbers) {
  const sameSetDepsMap = new Map();
  set.tokens.forEach((t) => {
    const { sameSetDeps } = collectDeps(t, set.name, bySet);
    sameSetDepsMap.set(t.name, sameSetDeps);
  });
  const ordered = topoSortTokens(set.tokens, sameSetDepsMap);
  const fileSlug = slug(set.name);
  const selector = set.name === "variables" ? ":root" : guessCssSelector(set.name);

  const lines = [];
  lines.push("/* ============================================================================");
  lines.push(`   Сгенерировано плагином "Tokens to SCSS" (CSS custom properties) — набор: ${set.name}`);
  lines.push("   ============================================================================ */");
  lines.push(`${selector} {`);

  const seen = new Set();
  ordered.forEach((t) => {
    if (t.type === "typography") {
      typographySubEntries(t, bySet, promotedPxNumbers).forEach(([cssKey, val]) => {
        lines.push(`  --${baseSlugWithPrefix(t.name)}-${cssKey}: ${val};`);
      });
      return;
    }
    const name = varName(t.name);
    if (seen.has(name)) {
      warn(`Коллизия имён: несколько токенов в наборе "${set.name}" дают одинаковую переменную ${name}`);
    }
    seen.add(name);
    const value =
      t.type === "shadow"
        ? formatShadowValue(t, bySet, promotedPxNumbers)
        : formatScalarValue(t, promotedPxNumbers, bySet);
    lines.push(`  ${name}: ${value};`);
  });

  lines.push("}");
  return { filename: `${fileSlug}.css`, content: lines.join("\n") + "\n" };
}

function generateSetFile(set, bySet, promotedPxNumbers) {
  return OUTPUT_MODE === "css"
    ? generateSetFileCss(set, bySet, promotedPxNumbers)
    : generateSetFileScss(set, bySet, promotedPxNumbers);
}

function generateIndexFile(setsData) {
  const lines = [
    "// Автосгенерированный индекс — форвардит все наборы токенов в исходном порядке приоритета Penpot",
    "// (Global-подобные наборы обычно идут раньше Theme-наборов, которые на них ссылаются)",
    "",
  ];
  setsData.forEach((set) => lines.push(`@forward "${slug(set.name)}";`));
  return { filename: "_index.scss", content: lines.join("\n") + "\n" };
}

// ---------------------------------------------------------------------------
// Опция "Объединить Global в _variables"
// ---------------------------------------------------------------------------

function isGlobalSetName(name) {
  return /^global(\/|$)/i.test(String(name).trim());
}

function mergeGlobalSets(setsData) {
  const globalSets = setsData.filter((s) => isGlobalSetName(s.name));
  const otherSets = setsData.filter((s) => !isGlobalSetName(s.name));
  if (globalSets.length === 0) return setsData;

  const mergedTokens = [];
  const seenNames = new Map();

  globalSets.forEach((set) => {
    set.tokens.forEach((t) => {
      if (seenNames.has(t.name)) {
        warn(
          `Токен "${t.name}" есть в нескольких Global-наборах ("${seenNames.get(t.name)}" и "${set.name}") — используется первое вхождение.`
        );
        return;
      }
      seenNames.set(t.name, set.name);
      mergedTokens.push(t);
    });
  });

  const mergedSet = { name: "variables", tokens: mergedTokens };
  return [mergedSet, ...otherSets];
}

// ---------------------------------------------------------------------------
// Главная функция генерации
// ---------------------------------------------------------------------------

function generateAll(setsData, options) {
  const opts = options || {};
  VAR_PREFIX = (opts.prefix || "").trim();
  OUTPUT_MODE = opts.outputMode === "css" ? "css" : "scss";
  WARNINGS = [];

  ALL_TOKENS_BY_NAME = new Map();
  setsData.forEach((set) =>
    set.tokens.forEach((t) => {
      if (!ALL_TOKENS_BY_NAME.has(t.name)) ALL_TOKENS_BY_NAME.set(t.name, { token: t, setName: set.name });
    })
  );

  let filtered = setsData;
  if (opts.selectedSetNames) {
    const wanted = new Set(opts.selectedSetNames);
    filtered = setsData.filter((s) => wanted.has(s.name));
  }

  const effectiveSets = opts.mergeGlobals ? mergeGlobalSets(filtered) : filtered;

  const bySet = buildBySet(effectiveSets);
  const promotedPxNumbers = computePromotedPxNumbers(effectiveSets);
  const files = effectiveSets.map((set) => generateSetFile(set, bySet, promotedPxNumbers));
  if (OUTPUT_MODE === "scss") files.push(generateIndexFile(effectiveSets));
  return files;
}

// ---------------------------------------------------------------------------
// Минимальный ZIP-writer (STORED, без сжатия) — без внешних зависимостей
// ---------------------------------------------------------------------------

function crc32(buf) {
  let crc = ~0;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return ~crc >>> 0;
}

function buildZip(files) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

  files.forEach((file) => {
    const nameBytes = encoder.encode(file.name);
    const dataBytes = encoder.encode(file.content);
    const crc = crc32(dataBytes);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0, true);
    local.setUint16(8, 0, true);
    local.setUint16(10, dosTime, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, dataBytes.length, true);
    local.setUint32(22, dataBytes.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    localParts.push(new Uint8Array(local.buffer), nameBytes, dataBytes);

    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, 0, true);
    central.setUint16(10, 0, true);
    central.setUint16(12, dosTime, true);
    central.setUint16(14, dosDate, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, dataBytes.length, true);
    central.setUint32(24, dataBytes.length, true);
    central.setUint16(28, nameBytes.length, true);
    central.setUint16(30, 0, true);
    central.setUint16(32, 0, true);
    central.setUint16(34, 0, true);
    central.setUint16(36, 0, true);
    central.setUint32(38, 0, true);
    central.setUint32(42, offset, true);
    centralParts.push(new Uint8Array(central.buffer), nameBytes);

    offset += local.buffer.byteLength + nameBytes.length + dataBytes.length;
  });

  const centralSize = centralParts.reduce((sum, p) => sum + p.length, 0);
  const centralOffset = offset;

  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(4, 0, true);
  end.setUint16(6, 0, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, centralOffset, true);
  end.setUint16(20, 0, true);

  const allParts = [...localParts, ...centralParts, new Uint8Array(end.buffer)];
  const total = allParts.reduce((sum, p) => sum + p.length, 0);
  const result = new Uint8Array(total);
  let pos = 0;
  allParts.forEach((p) => {
    result.set(p, pos);
    pos += p.length;
  });
  return result;
}

// ---------------------------------------------------------------------------
// Вспомогательное: разрешение цвета токена до литерала для свотчей (следует по ссылкам)
// ---------------------------------------------------------------------------

function resolveLiteralColor(tokenName, byName, depth) {
  depth = depth || 0;
  if (depth > 10) return null;
  const entry = byName.get(tokenName);
  if (!entry) return null;
  const { value, resolvedValue } = entry;
  if (typeof value === "string" && /^\{[^{}]+\}$/.test(value)) {
    return resolveLiteralColor(value.slice(1, -1), byName, depth + 1);
  }
  if (typeof value === "string") return value;
  return typeof resolvedValue === "string" ? resolvedValue : null;
}

// ---------------------------------------------------------------------------
// UI-обвязка: сообщения ↔ sandbox, индикаторы загрузки, настройки, рендер, скачивание
// ---------------------------------------------------------------------------
// Guarded so this file's pure logic (generateAll, buildZip, etc.) can also be
// required/tested in a plain Node.js context without a DOM (see test/ folder).
if (typeof document !== "undefined") {

console.log("[Tokens to SCSS] ui.js loaded");

const SETTINGS_KEY = "tokens-to-scss:settings";

let lastTokenSets = null; // кэш токенов после первой успешной загрузки
let generatedFiles = [];
let requestTimer = null;
let retryCount = 0;
const MAX_RETRIES = 2;
const RESPONSE_TIMEOUT_MS = 3000;
let regenerateDebounce = null;

const statusEl = document.getElementById("status");
const statusTextEl = document.getElementById("status-text");
const filesEl = document.getElementById("files");
const skeletonEl = document.getElementById("skeleton-list");
const zipBtn = document.getElementById("zip-btn");
const generateBtn = document.getElementById("generate-btn");
const mergeGlobalsCheckbox = document.getElementById("merge-globals-checkbox");
const prefixInput = document.getElementById("prefix-input");
const outputModeSelect = document.getElementById("output-mode-select");
const setListEl = document.getElementById("set-list");
const setListSection = document.getElementById("set-list-section");
const swatchesEl = document.getElementById("swatches");
const swatchesSection = document.getElementById("swatches-section");
const swatchesCount = document.getElementById("swatches-count");
const warningsEl = document.getElementById("warnings");

// ---------------------------------------------------------------------------
// Настройки: сохранение/восстановление между открытиями плагина (localStorage)
// ---------------------------------------------------------------------------

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function saveSettings() {
  try {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        mergeGlobals: mergeGlobalsCheckbox.checked,
        prefix: prefixInput.value,
        outputMode: outputModeSelect.value,
        selectedSetNames: getSelectedSetNames(),
      })
    );
  } catch (e) {
    // localStorage недоступен (приватный режим и т.п.) — просто не сохраняем
  }
}

const savedSettings = loadSettings();
if (savedSettings) {
  mergeGlobalsCheckbox.checked = !!savedSettings.mergeGlobals;
  prefixInput.value = savedSettings.prefix || "";
  if (savedSettings.outputMode) outputModeSelect.value = savedSettings.outputMode;
}

// ---------------------------------------------------------------------------
// Статус / индикаторы загрузки
// ---------------------------------------------------------------------------

function setStatus(text, mode) {
  statusTextEl.textContent = text;
  statusEl.classList.toggle("is-loading", mode === "loading");
  statusEl.classList.toggle("is-success", mode === "success");
  statusEl.classList.toggle("is-error", mode === "error");
}

function setBusy(busy) {
  generateBtn.disabled = busy;
  generateBtn.classList.toggle("is-loading", busy);
  skeletonEl.classList.toggle("is-visible", busy);
  if (busy) filesEl.innerHTML = "";
}

// ---------------------------------------------------------------------------
// Скачивание / копирование
// ---------------------------------------------------------------------------

function triggerDownload(filename, blobParts, mime) {
  const blob = new Blob(blobParts, { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function fallbackCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
  } catch (e) {
    /* ignore */
  }
  ta.remove();
}

function copyToClipboard(text, btn) {
  const original = btn.textContent;
  const showDone = () => {
    btn.textContent = "✓ Скопировано";
    setTimeout(() => (btn.textContent = original), 1200);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(showDone, () => {
      fallbackCopy(text);
      showDone();
    });
  } else {
    fallbackCopy(text);
    showDone();
  }
}

// ---------------------------------------------------------------------------
// Список наборов (чекбоксы для выборочного экспорта)
// ---------------------------------------------------------------------------

function getSelectedSetNames() {
  if (!setListEl) return null;
  const boxes = Array.from(setListEl.querySelectorAll('input[type="checkbox"]'));
  if (boxes.length === 0) return null;
  return boxes.filter((b) => b.checked).map((b) => b.value);
}

function renderSetCheckboxes(sets) {
  setListEl.innerHTML = "";
  const saved = savedSettings && savedSettings.selectedSetNames ? new Set(savedSettings.selectedSetNames) : null;

  sets.forEach((set) => {
    const label = document.createElement("label");
    label.className = "checkbox-row set-row";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = set.name;
    input.checked = saved ? saved.has(set.name) : true;
    input.addEventListener("change", scheduleRegenerate);

    const span = document.createElement("span");
    span.textContent = `${set.name} (${set.tokens.length})`;

    label.append(input, span);
    setListEl.appendChild(label);
  });

  setListSection.style.display = sets.length ? "block" : "none";
}

// ---------------------------------------------------------------------------
// Свотчи цветовых токенов
// ---------------------------------------------------------------------------

function renderSwatches(sets) {
  const byName = new Map();
  sets.forEach((set) => set.tokens.forEach((t) => byName.set(t.name, t)));

  const colorTokens = [];
  sets.forEach((set) => set.tokens.forEach((t) => { if (t.type === "color") colorTokens.push(t); }));

  swatchesEl.innerHTML = "";
  colorTokens.forEach((t) => {
    const literal = resolveLiteralColor(t.name, byName) || "transparent";
    const item = document.createElement("div");
    item.className = "swatch";
    item.title = `${t.name}: ${literal}`;

    const box = document.createElement("div");
    box.className = "swatch__box";
    box.style.background = literal;

    const label = document.createElement("div");
    label.className = "swatch__label";
    label.textContent = t.name;

    item.append(box, label);
    swatchesEl.appendChild(item);
  });

  swatchesCount.textContent = String(colorTokens.length);
  swatchesSection.style.display = colorTokens.length ? "block" : "none";
}

// ---------------------------------------------------------------------------
// Панель предупреждений
// ---------------------------------------------------------------------------

function renderWarnings(warnings) {
  warningsEl.innerHTML = "";
  if (!warnings.length) {
    warningsEl.style.display = "none";
    return;
  }
  warningsEl.style.display = "block";
  const title = document.createElement("div");
  title.className = "warnings__title";
  title.textContent = `⚠ Предупреждения (${warnings.length})`;
  const ul = document.createElement("ul");
  warnings.forEach((w) => {
    const li = document.createElement("li");
    li.textContent = w;
    ul.appendChild(li);
  });
  warningsEl.append(title, ul);
}

// ---------------------------------------------------------------------------
// Список сгенерированных файлов: превью, копирование, скачивание
// ---------------------------------------------------------------------------

function togglePreview(li, file) {
  let pre = li.querySelector(".file-preview");
  if (pre) {
    pre.remove();
    return;
  }
  pre = document.createElement("pre");
  pre.className = "file-preview";
  pre.textContent = file.content;
  li.appendChild(pre);
}

function renderFiles(files) {
  filesEl.innerHTML = "";
  files.forEach((f, i) => {
    const li = document.createElement("li");
    li.style.animationDelay = `${i * 40}ms`;

    const row = document.createElement("div");
    row.className = "file-row";

    const meta = document.createElement("div");
    meta.className = "meta";
    const nameEl = document.createElement("div");
    nameEl.className = "filename";
    nameEl.textContent = f.filename;
    const countEl = document.createElement("div");
    countEl.className = "count";
    countEl.textContent = `${f.content.split("\n").length} строк`;
    meta.append(nameEl, countEl);

    const actions = document.createElement("div");
    actions.className = "file-actions";

    const previewBtn = document.createElement("button");
    previewBtn.type = "button";
    previewBtn.dataset.appearance = "secondary";
    previewBtn.textContent = "Просмотр";
    previewBtn.addEventListener("click", () => togglePreview(li, f));

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.dataset.appearance = "secondary";
    copyBtn.textContent = "Копировать";
    copyBtn.addEventListener("click", () => copyToClipboard(f.content, copyBtn));

    const downloadBtn = document.createElement("button");
    downloadBtn.type = "button";
    downloadBtn.dataset.appearance = "secondary";
    downloadBtn.textContent = "Скачать";
    downloadBtn.addEventListener("click", () =>
      triggerDownload(f.filename, [f.content], f.filename.endsWith(".css") ? "text/css" : "text/x-scss")
    );

    actions.append(previewBtn, copyBtn, downloadBtn);
    row.append(meta, actions);
    li.appendChild(row);
    filesEl.appendChild(li);
  });
  zipBtn.style.display = files.length ? "block" : "none";
}

// ---------------------------------------------------------------------------
// Генерация (по уже загруженным токенам) и запрос токенов у plugin.js
// ---------------------------------------------------------------------------

function currentOptions() {
  return {
    mergeGlobals: mergeGlobalsCheckbox.checked,
    prefix: prefixInput.value,
    outputMode: outputModeSelect.value,
    selectedSetNames: getSelectedSetNames(),
  };
}

function regenerate() {
  if (!lastTokenSets) return;
  try {
    generatedFiles = generateAll(lastTokenSets, currentOptions());
    renderFiles(generatedFiles);
    renderWarnings(getWarnings());
    setStatus(`Готово: ${generatedFiles.length} файлов.`, "success");
    saveSettings();
  } catch (err) {
    console.error("[Tokens to SCSS] generation failed:", err);
    setStatus("Ошибка генерации: " + (err && err.message ? err.message : err), "error");
  }
}

function scheduleRegenerate() {
  clearTimeout(regenerateDebounce);
  regenerateDebounce = setTimeout(regenerate, 150);
}

mergeGlobalsCheckbox.addEventListener("change", scheduleRegenerate);
prefixInput.addEventListener("input", scheduleRegenerate);
outputModeSelect.addEventListener("change", scheduleRegenerate);

function requestTokens() {
  console.log("[Tokens to SCSS] requesting tokens from plugin.js (attempt", retryCount + 1, ")");
  setBusy(true);
  setStatus("Запрашиваю токены из файла…", "loading");

  window.parent.postMessage({ type: "request-tokens" }, "*");

  clearTimeout(requestTimer);
  requestTimer = setTimeout(() => {
    if (retryCount < MAX_RETRIES) {
      retryCount += 1;
      console.warn("[Tokens to SCSS] no response yet, retrying…");
      requestTokens();
    } else {
      setBusy(false);
      setStatus(
        "Не удалось получить токены от Penpot. Проверьте: 1) плагин установлен и открыт через " +
          "публичный URL (не file://); 2) разрешение library:read выдано; 3) в файле есть хотя бы " +
          "один набор токенов. Подробности — в консоли разработчика (F12).",
        "error"
      );
    }
  }, RESPONSE_TIMEOUT_MS);
}

generateBtn.addEventListener("click", () => {
  if (lastTokenSets) {
    regenerate();
    return;
  }
  retryCount = 0;
  requestTokens();
});

zipBtn.addEventListener("click", () => {
  const zipBytes = buildZip(generatedFiles.map((f) => ({ name: f.filename, content: f.content })));
  triggerDownload("tokens-export.zip", [zipBytes], "application/zip");
});

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg) return;
  console.log("[Tokens to SCSS] ui.js received message:", msg);

  if (msg.type === "tokens-error") {
    clearTimeout(requestTimer);
    setBusy(false);
    setStatus("Ошибка при чтении токенов: " + msg.message, "error");
    return;
  }
  if (msg.type !== "tokens-data") return;

  clearTimeout(requestTimer);
  lastTokenSets = msg.sets;

  renderSetCheckboxes(msg.sets);
  renderSwatches(msg.sets);

  try {
    generatedFiles = generateAll(msg.sets, currentOptions());
    renderFiles(generatedFiles);
    renderWarnings(getWarnings());
    setBusy(false);
    setStatus(`Готово: ${generatedFiles.length} файлов из ${msg.sets.length} наборов токенов.`, "success");
    saveSettings();
  } catch (err) {
    console.error("[Tokens to SCSS] generation failed:", err);
    setBusy(false);
    setStatus("Ошибка генерации: " + (err && err.message ? err.message : err), "error");
  }
});

setTimeout(() => {
  console.log("[Tokens to SCSS] ui.js ready, waiting for user action");
}, 1500);

} // end DOM guard

if (typeof module !== "undefined") {
  module.exports = {
    generateAll,
    buildZip,
    slug,
    generateSetFile,
    generateIndexFile,
    isGlobalSetName,
    mergeGlobalSets,
    getWarnings,
    resolveLiteralColor,
  };
}
