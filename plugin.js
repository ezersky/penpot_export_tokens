/**
 * Tokens to SCSS — plugin.js (sandbox context)
 *
 * Работает только с `penpot.library.local.tokens`. Никаких изменений в файл не вносит —
 * только читает все наборы токенов (Global/*, Theme/* и любые другие, какие есть в файле)
 * и пересылает их в интерфейс плагина (index.html/ui.js), где происходит генерация SCSS
 * и скачивание. Вся генерация/скачивание — в iframe, т.к. там доступны DOM/Blob API,
 * которых нет в этом sandbox-контексте.
 */

console.log("[Tokens to SCSS] plugin.js loaded");

penpot.ui.open("Tokens to SCSS", "index.html", { width: 380, height: 560 });

function serializeTokenCatalog() {
  const catalog = penpot.library.local.tokens;
  return {
    sets: catalog.sets.map((set) => ({
      name: set.name,
      active: set.active,
      tokens: set.tokens.map((t) => ({
        name: t.name,
        type: t.type,
        value: t.value,
        resolvedValue: t.resolvedValue,
      })),
    })),
  };
}

penpot.ui.onMessage((message) => {
  console.log("[Tokens to SCSS] plugin.js received message:", message);

  if (!message || message.type !== "request-tokens") return;

  try {
    const data = serializeTokenCatalog();
    console.log("[Tokens to SCSS] sending", data.sets.length, "token sets to UI");
    penpot.ui.sendMessage({ type: "tokens-data", sets: data.sets });
  } catch (err) {
    console.error("[Tokens to SCSS] failed to read token catalog:", err);
    penpot.ui.sendMessage({
      type: "tokens-error",
      message: String((err && err.message) || err),
    });
  }
});
