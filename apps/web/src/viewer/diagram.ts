import mermaid from "mermaid";
import { escapeHtml } from "../format.js";

let initialized = false;
let seq = 0;

function init() {
  if (initialized) return;
  initialized = true;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--sans"),
    themeVariables: {
      background: "#ffffff",
      primaryColor: "#fbeee4",
      primaryBorderColor: "#d87243",
      primaryTextColor: "#1d2023",
      secondaryColor: "#e6f1ea",
      secondaryBorderColor: "#3f9a72",
      tertiaryColor: "#e7eef6",
      tertiaryBorderColor: "#5887b7",
      lineColor: "#8f8a83",
      edgeLabelBackground: "#ffffff",
      clusterBkg: "#faf9f6",
      clusterBorder: "#dcd8d0",
      textColor: "#1d2023",
      noteBkgColor: "#fff6d8",
      noteBorderColor: "#e0c068",
      fontSize: "14px",
    },
  });
}

/** Renders a Mermaid diagram into `el`; a syntax error shows the message and the source instead. */
export async function renderDiagram(el: HTMLElement, source: string) {
  init();
  try {
    const { svg } = await mermaid.render(`portage-mmd-${++seq}`, source.trim());
    el.innerHTML = svg;
    el.classList.add("rendered");
  } catch (error) {
    el.innerHTML = `<p class="viewer-error">Diagram has an error: ${escapeHtml(error instanceof Error ? error.message.split("\n")[0] : String(error))}</p><pre>${escapeHtml(source)}</pre>`;
  }
}
