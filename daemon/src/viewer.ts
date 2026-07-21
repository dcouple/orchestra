import { extname } from "node:path";

const IMAGE_EXTENSIONS = new Set([".png", ".svg", ".jpg", ".jpeg", ".gif", ".webp"]);

export function renderViewer(id: string, files: readonly string[]): string {
  const ordered = [...files].sort((left, right) => rank(left) - rank(right) || left.localeCompare(right));
  const fileJson = JSON.stringify(ordered).replace(/<\//g, "<\\/");
  const root = `/a/${encodeURIComponent(id)}/`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Artifact bundle</title>
<style>
:root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; height: 100vh; display: grid; grid-template-columns: minmax(220px, 22vw) 1fr; background: Canvas; color: CanvasText; }
nav { overflow: auto; border-right: 1px solid color-mix(in srgb, CanvasText 18%, transparent); padding: 1rem .75rem; }
nav h1 { font-size: .8rem; letter-spacing: .08em; text-transform: uppercase; margin: 0 .5rem .75rem; opacity: .65; }
button { display: block; width: 100%; border: 0; border-radius: .4rem; padding: .55rem .65rem; margin: .15rem 0; text-align: left; font: inherit; background: transparent; color: inherit; cursor: pointer; overflow-wrap: anywhere; }
button:hover, button[aria-current="true"] { background: color-mix(in srgb, CanvasText 10%, transparent); }
main { min-width: 0; overflow: auto; }
#content { min-height: 100%; padding: clamp(1rem, 3vw, 3rem); max-width: 1000px; margin: 0 auto; line-height: 1.55; }
iframe { border: 0; display: block; width: 100%; height: 100%; min-height: 100vh; background: white; }
img { display: block; max-width: 100%; height: auto; margin: auto; }
pre { overflow: auto; padding: 1rem; border-radius: .5rem; background: color-mix(in srgb, CanvasText 7%, transparent); }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
blockquote { border-left: 3px solid color-mix(in srgb, CanvasText 30%, transparent); margin-left: 0; padding-left: 1rem; opacity: .85; }
a { color: LinkText; }
@media (max-width: 700px) { body { grid-template-columns: 1fr; grid-template-rows: auto 1fr; } nav { max-height: 32vh; border-right: 0; border-bottom: 1px solid color-mix(in srgb, CanvasText 18%, transparent); } }
</style>
</head>
<body>
<nav><h1>Bundle files</h1><div id="files"></div></nav>
<main id="main"><div id="content">No files in this bundle.</div></main>
<script type="application/json" id="bundle-files">${fileJson}</script>
<script>
const files = JSON.parse(document.getElementById("bundle-files").textContent);
const root = ${JSON.stringify(root)};
const list = document.getElementById("files");
const main = document.getElementById("main");
const rawUrl = path => root + path.split("/").map(encodeURIComponent).join("/");
const extension = path => (path.match(/\.[^.\/]+$/)?.[0] || "").toLowerCase();
const imageTypes = new Set([".png", ".svg", ".jpg", ".jpeg", ".gif", ".webp"]);

for (const path of files) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = path;
  button.addEventListener("click", () => select(path));
  list.append(button);
}

async function select(path) {
  for (const button of list.children) button.setAttribute("aria-current", String(button.textContent === path));
  const url = rawUrl(path);
  const ext = extension(path);
  if (ext === ".html") {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts allow-popups");
    frame.src = url;
    frame.title = path;
    main.replaceChildren(frame);
    return;
  }
  if (imageTypes.has(ext)) {
    const content = document.createElement("div"); content.id = "content";
    const img = document.createElement("img"); img.src = url; img.alt = path;
    content.append(img); main.replaceChildren(content); return;
  }
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) { showMessage("Unable to load " + path); return; }
  if (ext === ".md") {
    const content = document.createElement("div"); content.id = "content";
    content.innerHTML = renderMarkdown(await response.text());
    main.replaceChildren(content); return;
  }
  if ([".txt", ".json", ".css", ".js"].includes(ext)) {
    const content = document.createElement("div"); content.id = "content";
    const pre = document.createElement("pre"); pre.textContent = await response.text();
    content.append(pre); main.replaceChildren(content); return;
  }
  const content = document.createElement("div"); content.id = "content";
  const link = document.createElement("a"); link.href = url; link.textContent = "Download " + path;
  content.append(link); main.replaceChildren(content);
}

function showMessage(message) {
  const content = document.createElement("div"); content.id = "content"; content.textContent = message;
  main.replaceChildren(content);
}

function inline(value) {
  return value
    .replace(/\x60([^\x60]+)\x60/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, href) => /^(https?:|\.|\/|#)/.test(href) ? '<a href="' + href + '">' + label + "</a>" : label);
}

function renderMarkdown(markdown) {
  const lines = markdown.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").split(/\r?\n/);
  const output = []; let paragraph = []; let listType = ""; let fenced = false; let code = [];
  const flushParagraph = () => { if (paragraph.length) { output.push("<p>" + inline(paragraph.join(" ")) + "</p>"); paragraph = []; } };
  const closeList = () => { if (listType) { output.push("</" + listType + ">"); listType = ""; } };
  for (const line of lines) {
    if (/^\s*\x60\x60\x60/.test(line)) {
      flushParagraph(); closeList();
      if (fenced) { output.push("<pre><code>" + code.join("\n") + "</code></pre>"); code = []; }
      fenced = !fenced; continue;
    }
    if (fenced) { code.push(line); continue; }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    const unordered = /^\s*[-*]\s+(.+)$/.exec(line);
    const ordered = /^\s*\d+\.\s+(.+)$/.exec(line);
    if (heading) { flushParagraph(); closeList(); const level = heading[1].length; output.push("<h" + level + ">" + inline(heading[2]) + "</h" + level + ">"); }
    else if (/^\s*---+\s*$/.test(line)) { flushParagraph(); closeList(); output.push("<hr>"); }
    else if (/^&gt;\s?/.test(line)) { flushParagraph(); closeList(); output.push("<blockquote>" + inline(line.replace(/^&gt;\s?/, "")) + "</blockquote>"); }
    else if (unordered || ordered) {
      flushParagraph(); const wanted = unordered ? "ul" : "ol";
      if (listType !== wanted) { closeList(); listType = wanted; output.push("<" + wanted + ">"); }
      output.push("<li>" + inline((unordered || ordered)[1]) + "</li>");
    } else if (!line.trim()) { flushParagraph(); closeList(); }
    else paragraph.push(line.trim());
  }
  if (fenced) output.push("<pre><code>" + code.join("\n") + "</code></pre>");
  flushParagraph(); closeList(); return output.join("\n");
}

if (files.length) select(files.includes("refs/explainer.html") ? "refs/explainer.html" : files[0]);
</script>
</body>
</html>`;
}

function rank(path: string): number {
  if (path === "refs/explainer.html") return 0;
  const extension = extname(path).toLowerCase();
  if (extension === ".html") return 10;
  if (path === "plan.md") return 20;
  if (path === "wrapup.md") return 21;
  if (path === "item.md") return 22;
  if (extension === ".md") return 30;
  if (IMAGE_EXTENSIONS.has(extension)) return 40;
  return 50;
}
