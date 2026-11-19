import * as Plot from "@observablehq/plot";
import { escapeHtml } from "../format.js";
import { jsonRecords } from "./kind.js";

export type Cell = string | number | boolean | Date | null;
export type ColumnType = "number" | "date" | "text";
export type DataTable = { columns: string[]; types: ColumnType[]; rows: Cell[][] };
type ChartType = "line" | "area" | "bar" | "scatter";

const MAX_TABLE_ROWS = 1000;
const MAX_CATEGORIES = 30;
const PALETTE = ["#d87243", "#5887b7", "#3f9a72", "#c9a227", "#9b6bb3", "#d0607a", "#4fa3a5", "#8a7f72"];
const NUMBER = /^[-+]?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?(e[-+]?\d+)?%?$/i;
const DATE = /^\d{4}-\d{2}(-\d{2})?([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** Infer column types (a column is numeric/date when ≥ 90% of its non-empty cells are) and convert cells. */
export function typedTable(columns: string[], raw: Cell[][]): DataTable {
  const width = Math.max(columns.length, ...raw.slice(0, 200).map((r) => r.length));
  const names = Array.from({ length: width }, (_, i) => String(columns[i] ?? "").trim() || `Column ${i + 1}`);
  const types = names.map((_, c) => {
    let filled = 0, nums = 0, dates = 0;
    for (const row of raw.slice(0, 2000)) {
      const v = row[c];
      if (v === null || v === undefined || v === "") continue;
      filled += 1;
      if (typeof v === "number" || (typeof v === "string" && v.trim() !== "" && NUMBER.test(v.trim()))) nums += 1;
      else if (v instanceof Date || (typeof v === "string" && DATE.test(v.trim()) && !Number.isNaN(Date.parse(v)))) dates += 1;
    }
    if (!filled) return "text" as const;
    return nums / filled >= 0.9 ? ("number" as const) : dates / filled >= 0.9 ? ("date" as const) : ("text" as const);
  });
  const rows = raw.map((row) =>
    names.map((_, c) => {
      const v = row[c];
      if (v === undefined || v === "") return null;
      if (types[c] === "number" && typeof v === "string") {
        const n = Number(v.trim().replace(/,/g, "").replace(/%$/, ""));
        return Number.isFinite(n) ? n : null;
      }
      if (types[c] === "date" && typeof v === "string") {
        const d = new Date(v.trim());
        return Number.isNaN(d.getTime()) ? null : d;
      }
      return v;
    }),
  );
  return { columns: names, types, rows };
}

/** An array of flat objects reads as a table; anything else does not. */
export function tableFromJson(value: unknown): DataTable | null {
  const list = jsonRecords(value);
  if (!list) return null;
  const columns = [...new Set(list.slice(0, 100).flatMap((r) => Object.keys(r)))];
  const raw = list.map((r) =>
    columns.map((k) => {
      const v = r[k];
      return v === null || v === undefined ? null : typeof v === "object" ? JSON.stringify(v) : (v as Cell);
    }),
  );
  return typedTable(columns, raw);
}

const numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });
const formatCell = (v: Cell, type: ColumnType) =>
  v === null ? "" : type === "number" && typeof v === "number" ? numberFormat.format(v)
  : v instanceof Date ? (v.getUTCHours() || v.getUTCMinutes() ? v.toISOString().slice(0, 16).replace("T", " ") : v.toISOString().slice(0, 10))
  : String(v);

const compare = (a: Cell, b: Cell) => {
  if (a === null) return 1;
  if (b === null) return -1;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
};

/** Sortable, filterable table with data bars on numeric columns. */
export function renderTable(el: HTMLElement, table: DataTable) {
  let sort: { col: number; dir: 1 | -1 } | null = null;
  let filter = "";
  const ranges = table.columns.map((_, c) => {
    if (table.types[c] !== "number") return null;
    const values = table.rows.map((r) => r[c]).filter((v): v is number => typeof v === "number");
    return values.length ? { min: Math.min(0, ...values), max: Math.max(0, ...values) } : null;
  });
  el.innerHTML = `<div class="data-toolbar"><label class="data-filter"><span aria-hidden="true">⌕</span><input type="search" placeholder="Filter rows…" aria-label="Filter rows" /></label><span class="data-count"></span></div><div class="data-scroll"><table class="data-table"><thead></thead><tbody></tbody></table></div>`;
  const thead = el.querySelector("thead")!;
  const tbody = el.querySelector("tbody")!;
  const count = el.querySelector<HTMLElement>(".data-count")!;
  const glyph = { number: "#", date: "◷", text: "Aa" };

  const draw = () => {
    let rows = table.rows;
    if (filter) rows = rows.filter((r) => r.some((v, c) => formatCell(v, table.types[c]!).toLowerCase().includes(filter)));
    if (sort) {
      const { col, dir } = sort;
      rows = [...rows].sort((a, b) => (a[col] === null ? 1 : b[col] === null ? -1 : compare(a[col]!, b[col]!) * dir));
    }
    thead.innerHTML = `<tr><th class="row-no">#</th>${table.columns
      .map(
        (name, c) =>
          `<th class="${table.types[c]}${sort?.col === c ? " sorted" : ""}"><button type="button" data-sort-col="${c}" title="Sort by ${escapeHtml(name)}"><i>${glyph[table.types[c]!]}</i>${escapeHtml(name)}<em>${sort?.col === c ? (sort.dir === 1 ? "↑" : "↓") : ""}</em></button></th>`,
      )
      .join("")}</tr>`;
    tbody.innerHTML = rows
      .slice(0, MAX_TABLE_ROWS)
      .map(
        (row, i) =>
          `<tr><td class="row-no">${i + 1}</td>${row
            .map((v, c) => {
              const type = table.types[c]!;
              const range = ranges[c];
              let style = "";
              if (range && typeof v === "number" && range.max !== range.min) {
                const span = range.max - range.min;
                const zero = ((0 - range.min) / span) * 100;
                const at = ((v - range.min) / span) * 100;
                const [from, to] = v >= 0 ? [zero, at] : [at, zero];
                style = ` style="--bar-from:${from.toFixed(1)}%;--bar-to:${to.toFixed(1)}%"`;
              }
              return `<td class="${type}${v !== null && typeof v === "number" && v < 0 ? " negative" : ""}${style ? " bar" : ""}"${style}>${escapeHtml(formatCell(v, type))}</td>`;
            })
            .join("")}</tr>`,
      )
      .join("");
    count.textContent = `${rows.length.toLocaleString("en-US")} of ${table.rows.length.toLocaleString("en-US")} rows · ${table.columns.length} columns${rows.length > MAX_TABLE_ROWS ? ` · showing first ${MAX_TABLE_ROWS.toLocaleString("en-US")}` : ""}`;
  };
  thead.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>("[data-sort-col]");
    if (!button) return;
    const col = Number(button.dataset.sortCol);
    sort = sort?.col !== col ? { col, dir: table.types[col] === "text" ? 1 : -1 } : sort.dir === -1 ? { col, dir: 1 } : null;
    draw();
  });
  el.querySelector("input")!.addEventListener("input", (event) => {
    filter = (event.target as HTMLInputElement).value.trim().toLowerCase();
    draw();
  });
  draw();
}

/** Whether a chart can say anything: at least one numeric column. */
export const chartable = (t: DataTable) => t.types.includes("number");

/** Interactive chart with an automatic first guess: dates → line, categories → bars, numbers → scatter. */
export function renderChart(el: HTMLElement, table: DataTable) {
  const numeric = table.columns.map((_, i) => i).filter((i) => table.types[i] === "number");
  const firstDate = table.types.indexOf("date");
  const firstText = table.types.indexOf("text");
  let x = firstDate >= 0 ? firstDate : firstText >= 0 ? firstText : -1;
  let ys = numeric.filter((i) => i !== x).slice(0, 3);
  if (x < 0 && numeric.length > 1) {
    x = numeric[0]!;
    ys = numeric.slice(1, 4);
  }
  const autoType = (): ChartType =>
    x < 0 ? "line" : table.types[x] === "date" ? "line" : table.types[x] === "text" ? "bar" : "scatter";
  let type: ChartType = autoType();

  el.innerHTML = `<div class="chart-controls"><div class="seg chart-type" role="group" aria-label="Chart type">${(["line", "area", "bar", "scatter"] as const)
    .map((t) => `<button type="button" data-chart-type="${t}">${t[0]!.toUpperCase()}${t.slice(1)}</button>`)
    .join("")}</div><label class="chart-axis">X<select data-chart-x><option value="-1">Row number</option>${table.columns
    .map((name, i) => `<option value="${i}">${escapeHtml(name)}</option>`)
    .join("")}</select></label><div class="chart-series" aria-label="Series">${numeric
    .map((i) => `<button type="button" data-chart-y="${i}"><i></i>${escapeHtml(table.columns[i]!)}</button>`)
    .join("")}</div></div><div class="chart-canvas"></div><div class="chart-stats"></div>`;
  const canvas = el.querySelector<HTMLElement>(".chart-canvas")!;
  const stats = el.querySelector<HTMLElement>(".chart-stats")!;
  (el.querySelector("[data-chart-x]") as HTMLSelectElement).value = String(x);

  const draw = () => {
    for (const b of el.querySelectorAll<HTMLElement>("[data-chart-type]")) b.classList.toggle("selected", b.dataset.chartType === type);
    for (const b of el.querySelectorAll<HTMLElement>("[data-chart-y]")) {
      const at = ys.indexOf(Number(b.dataset.chartY));
      b.classList.toggle("selected", at >= 0);
      b.style.setProperty("--series", at >= 0 ? PALETTE[at % PALETTE.length]! : "transparent");
    }
    if (!ys.length) {
      canvas.innerHTML = '<p class="viewer-note">Pick at least one numeric column to plot.</p>';
      stats.innerHTML = "";
      return;
    }
    const xName = x < 0 ? "Row" : table.columns[x]!;
    const categorical = x >= 0 && table.types[x] === "text";
    let rows = table.rows.map((r, i) => ({ r, i })).filter(({ r }) => x < 0 || r[x] !== null);
    if (x >= 0 && !categorical) rows.sort((a, b) => compare(a.r[x]!, b.r[x]!));
    if (type === "bar" && categorical) rows.sort((a, b) => compare(b.r[ys[0]!] ?? null, a.r[ys[0]!] ?? null));
    if (type === "bar" && rows.length > MAX_CATEGORIES) rows = rows.slice(0, MAX_CATEGORIES);

    // series whose magnitudes differ by more than 10× get their own panel instead of a flattened line
    const magnitude = (y: number) => rows.reduce((m, { r }) => (typeof r[y] === "number" ? Math.max(m, Math.abs(r[y] as number)) : m), 1e-9);
    const groups: number[][] = [];
    for (const y of [...ys].sort((a, b) => magnitude(b) - magnitude(a))) {
      const group = groups.find((g) => magnitude(g[0]!) / magnitude(y) <= 10);
      if (group) group.push(y);
      else groups.push([y]);
    }
    for (const g of groups) g.sort((a, b) => ys.indexOf(a) - ys.indexOf(b));
    groups.sort((a, b) => ys.indexOf(a[0]!) - ys.indexOf(b[0]!));

    const pad = getComputedStyle(canvas);
    const width = Math.max(320, canvas.clientWidth - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight));
    const fullHeight = Math.min(420, Math.max(280, Math.round(width * 0.42)));
    const height = groups.length > 1 ? Math.max(180, Math.round(fullHeight * 0.62)) : fullHeight;
    const rotate = categorical && type === "bar" && rows.length > 6;
    const xLabel = (v: Cell) => formatCell(v, x >= 0 ? table.types[x]! : "number");

    // ordinal axes sort alphabetically unless told the order
    const categories = categorical ? [...new Set(rows.map(({ r }) => r[x] as Cell))] : undefined;
    const panel = (group: number[], last: boolean) => {
      const long = rows.flatMap(({ r, i }) =>
        group.filter((y) => typeof r[y] === "number").map((y) => ({ x: x < 0 ? i + 1 : r[x], value: r[y] as number, series: table.columns[y]! })),
      );
      const grouped = type === "bar" && group.length > 1;
      const marks: Plot.Markish[] = [];
      if (type === "bar") {
        marks.push(
          grouped
            ? Plot.barY(long, { fx: "x", x: "series", y: "value", fill: "series", rx: 3, tip: true })
            : Plot.barY(long, { x: "x", y: "value", fill: "series", rx: 3, tip: true }),
          Plot.ruleY([0], { stroke: "#cfcac2" }),
        );
      } else if (type === "scatter") {
        marks.push(Plot.dot(long, { x: "x", y: "value", fill: "series", r: 3.5, fillOpacity: 0.8, tip: true }));
      } else {
        if (type === "area") marks.push(Plot.areaY(long, { x: "x", y: "value", fill: "series", fillOpacity: 0.14, curve: "monotone-x" }));
        marks.push(
          Plot.lineY(long, { x: "x", y: "value", stroke: "series", strokeWidth: 2, curve: "monotone-x" }),
          Plot.crosshairX(long, { x: "x", y: "value", color: "#8f8a83" }),
          Plot.dot(long, Plot.pointerX({ x: "x", y: "value", fill: "series", r: 4, stroke: "#fff", strokeWidth: 1.5 })),
          Plot.tip(long, Plot.pointerX({ x: "x", y: "value", stroke: "series", title: (d) => `${d.series}\n${xLabel(d.x)}: ${numberFormat.format(d.value)}` })),
        );
      }
      const figure = Plot.plot({
        width,
        height,
        marginTop: 16,
        marginLeft: 56,
        marginBottom: rotate ? 70 : 36,
        style: { fontFamily: "var(--sans)", fontSize: "12px", color: "#5b6066", background: "transparent", overflow: "visible" },
        x: grouped
          ? { axis: null, domain: group.map((y) => table.columns[y]!) }
          : { label: last && !categorical ? xName : null, tickRotate: rotate ? -30 : 0, domain: type === "bar" ? categories : undefined },
        fx: grouped ? { label: null, padding: 0.2, axis: "bottom", tickRotate: rotate ? -30 : 0, domain: categories } : undefined,
        y: { grid: true, nice: true, label: group.length === 1 && groups.length === 1 ? table.columns[group[0]!] : null, tickFormat: (v: number) => compact.format(v) },
        color: { domain: ys.map((y) => table.columns[y]!), range: PALETTE, legend: false },
        marks,
      });
      if (groups.length === 1) return figure;
      const box = document.createElement("div");
      box.className = "chart-panel";
      box.innerHTML = `<b>${group.map((y) => `<i style="--series:${PALETTE[ys.indexOf(y) % PALETTE.length]}"></i>${escapeHtml(table.columns[y]!)}`).join("")}</b>`;
      box.append(figure);
      return box;
    };
    const figures = groups.map((g, k) => panel(g, k === groups.length - 1));
    if (groups.length > 1) {
      const note = document.createElement("p");
      note.className = "chart-note";
      note.textContent = "These series differ in scale by more than 10×, so each scale gets its own panel.";
      figures.push(note);
    }
    canvas.replaceChildren(...figures);
    stats.innerHTML = ys
      .map((y, k) => {
        const values = rows.map(({ r }) => r[y]).filter((v): v is number => typeof v === "number");
        if (!values.length) return "";
        const first = values[0]!, last = values.at(-1)!;
        const mean = values.reduce((s, v) => s + v, 0) / values.length;
        const change = first !== 0 && x >= 0 && table.types[x] === "date" ? ((last - first) / Math.abs(first)) * 100 : null;
        return `<div class="stat-card" style="--series:${PALETTE[k % PALETTE.length]}"><b>${escapeHtml(table.columns[y]!)}</b><span><small>Latest</small>${compact.format(last)}</span><span><small>Min</small>${compact.format(Math.min(...values))}</span><span><small>Max</small>${compact.format(Math.max(...values))}</span><span><small>Mean</small>${compact.format(mean)}</span>${change === null ? "" : `<span class="${change >= 0 ? "up" : "down"}"><small>Change</small>${change >= 0 ? "+" : ""}${change.toFixed(1)}%</span>`}</div>`;
      })
      .join("");
  };

  el.addEventListener("click", (event) => {
    const t = (event.target as HTMLElement).closest<HTMLElement>("[data-chart-type],[data-chart-y]");
    if (!t) return;
    if (t.dataset.chartType) type = t.dataset.chartType as ChartType;
    else {
      const y = Number(t.dataset.chartY);
      ys = ys.includes(y) ? ys.filter((v) => v !== y) : [...ys, y];
    }
    draw();
  });
  el.querySelector("[data-chart-x]")!.addEventListener("change", (event) => {
    x = Number((event.target as HTMLSelectElement).value);
    ys = ys.filter((y) => y !== x);
    type = autoType();
    draw();
  });
  draw();
  // redraw on width changes only, once per frame; height changes are our own drawing
  let lastWidth = canvas.clientWidth;
  let pending = 0;
  const resize = new ResizeObserver(() => {
    if (!el.isConnected) return resize.disconnect();
    if (pending || Math.abs(canvas.clientWidth - lastWidth) < 8) return;
    pending = requestAnimationFrame(() => {
      pending = 0;
      lastWidth = canvas.clientWidth;
      if (el.isConnected) draw();
    });
  });
  resize.observe(canvas);
}
