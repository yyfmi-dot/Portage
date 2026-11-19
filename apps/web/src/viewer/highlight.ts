import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { bundledLanguages } from "shiki/langs";
import roseDawn from "shiki/themes/rose-pine-dawn.mjs";

const THEME = "rose-pine-dawn";
let highlighter: Promise<HighlighterCore> | undefined;

const core = () =>
  (highlighter ??= createHighlighterCore({ themes: [roseDawn], langs: [], engine: createJavaScriptRegexEngine() }));

/** Highlighted HTML for `code`; unknown languages fall back to plain text with the same layout. */
export async function highlight(code: string, lang: string) {
  const h = await core();
  const id = lang.toLowerCase();
  const loader = (bundledLanguages as Record<string, (() => Promise<unknown>) | undefined>)[id];
  let use = "text";
  if (loader) {
    if (!h.getLoadedLanguages().includes(id)) await h.loadLanguage(loader as never);
    use = id;
  }
  return h.codeToHtml(code, { lang: use, theme: THEME });
}
