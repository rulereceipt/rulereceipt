#!/usr/bin/env node
// Zero-dependency static blog builder for rulereceipt.dev/blog.
// Reads blog/posts/*.md (frontmatter: title, date, description, chapter, ogImage, draft),
// publishes those with draft:false AND date <= today (evaluated at build time), and writes
// blog/<slug>.html, blog/index.html and blog/rss.xml with the same look as the site.
// No external deps on purpose (runs in a bare Vercel build). Markdown is a controlled subset.
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const POSTS_DIR = join(ROOT, "blog", "posts");
const OUT_DIR = join(ROOT, "blog");
const SITE = "https://rulereceipt.dev";
const TODAY = new Date().toISOString().slice(0, 10);

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function parseFront(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: raw };
  const data = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim().replace(/^["']|["']$/g, "");
    if (v === "true") v = true; else if (v === "false") v = false;
    data[kv[1]] = v;
  }
  return { data, body: m[2] };
}

// Minimal, controlled Markdown → HTML (headings, p, ul/ol, code fences, inline code,
// bold/italic, links, images, blockquote, hr). Posts are ours, so the subset is enough.
function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, a, u) => `<img src="${esc(u)}" alt="${esc(a)}" loading="lazy">`)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => `<a href="${esc(u)}">${t}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
}
function md(src) {
  const out = [], lines = src.replace(/\r/g, "").split("\n");
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) { const buf = []; i++; while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]); i++; out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`); continue; }
    if (/^#{1,4}\s/.test(l)) { const n = l.match(/^#+/)[0].length; out.push(`<h${n}>${inline(l.replace(/^#+\s/, ""))}</h${n}>`); i++; continue; }
    if (/^>\s?/.test(l)) { const buf = []; while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, "")); out.push(`<blockquote>${inline(buf.join(" "))}</blockquote>`); continue; }
    if (/^(?:-{3,}|\*{3,})\s*$/.test(l)) { out.push("<hr>"); i++; continue; }
    if (/^[-*]\s/.test(l)) { const buf = []; while (i < lines.length && /^[-*]\s/.test(lines[i])) buf.push(`<li>${inline(lines[i++].replace(/^[-*]\s/, ""))}</li>`); out.push(`<ul>${buf.join("")}</ul>`); continue; }
    if (/^\d+\.\s/.test(l)) { const buf = []; while (i < lines.length && /^\d+\.\s/.test(lines[i])) buf.push(`<li>${inline(lines[i++].replace(/^\d+\.\s/, ""))}</li>`); out.push(`<ol>${buf.join("")}</ol>`); continue; }
    if (/^</.test(l)) { const buf = []; while (i < lines.length && lines[i].trim() !== "") buf.push(lines[i++]); out.push(buf.join("\n")); continue; } // raw HTML block (our own posts), passed through verbatim
    if (l.trim() === "") { i++; continue; }
    const buf = []; while (i < lines.length && lines[i].trim() !== "" && !/^(#{1,4}\s|[-*]\s|\d+\.\s|>|```|-{3,}|\*{3,})/.test(lines[i])) buf.push(lines[i++]);
    out.push(`<p>${inline(buf.join(" "))}</p>`);
  }
  return out.join("\n");
}

const CSS = `
:root{--bg:#FAF9F5;--paper:#141413;--paper-dim:#7A756E;--cyan:#17805F;--panel:#fff;--line:#e7e4dd}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--paper);font-family:Georgia,'Times New Roman',serif;line-height:1.65;font-size:18px}
.wrap{max-width:720px;margin:0 auto;padding:0 20px}
.top{display:flex;justify-content:space-between;align-items:center;padding:22px 0;border-bottom:1px solid var(--line);font-family:-apple-system,system-ui,sans-serif}
.wordmark{font-weight:800;letter-spacing:.02em;text-transform:uppercase;color:var(--paper);text-decoration:none;font-size:1rem}
.nav a{color:var(--cyan);text-decoration:none;font-size:.9rem;margin-left:16px}
article,.index{padding:34px 0 64px}
h1{font-size:2.1rem;line-height:1.2;margin:.2em 0;font-family:Georgia,serif}
.meta{color:var(--paper-dim);font-size:.9rem;margin-bottom:26px;font-family:-apple-system,system-ui,sans-serif}
article h2{font-size:1.45rem;margin-top:1.8em}article h3{font-size:1.15rem}
code{background:#f0eee8;padding:1px 5px;border-radius:4px;font-size:.9em;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
pre{background:#14151a;color:#e6e6e6;padding:16px;border-radius:8px;overflow:auto;font-size:.86rem;line-height:1.5}
pre code{background:none;padding:0;color:inherit;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
a{color:var(--cyan)}ul,ol{padding-left:1.3em}img{max-width:100%;height:auto;border-radius:8px;border:1px solid var(--line);display:block;margin:20px auto}
video{max-width:100%;height:auto;border-radius:10px;border:1px solid var(--line);display:block;margin:0 auto 6px}
figure{margin:24px 0}figcaption{text-align:center;color:var(--paper-dim);font-size:.82rem;font-family:-apple-system,system-ui,sans-serif}
blockquote{border-left:3px solid var(--line);margin:1em 0;padding:4px 0 4px 16px;color:var(--paper-dim)}
.post-list{list-style:none;padding:0}.post-list li{margin:0 0 26px;padding-bottom:22px;border-bottom:1px solid var(--line)}
.post-list a{font-size:1.3rem;text-decoration:none;color:var(--paper);font-weight:600}
.post-list .d{color:var(--paper-dim);font-size:.95rem;margin-top:4px}
footer{border-top:1px solid var(--line);padding:22px 0;color:var(--paper-dim);font-size:.85rem;font-family:-apple-system,system-ui,sans-serif}
`;

function page({ title, desc, canonical, og, bodyHtml }) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(canonical)}">
<link rel="alternate" type="application/rss+xml" title="RuleReceipt blog" href="${SITE}/blog/rss.xml">
<meta property="og:type" content="article"><meta property="og:url" content="${esc(canonical)}">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
${og ? `<meta property="og:image" content="${esc(og)}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="${esc(og)}">` : ""}
<style>${CSS}</style></head>
<body><div class="wrap">
<header class="top"><a class="wordmark" href="/">RuleReceipt</a><nav class="nav"><a href="/blog">blog</a><a href="/">home</a></nav></header>
${bodyHtml}
<footer>RuleReceipt runs locally, nothing uploaded. <a href="/">rulereceipt.dev</a> · <a href="/blog/rss.xml">RSS</a></footer>
</div></body></html>`;
}

function main() {
  if (!existsSync(POSTS_DIR)) { console.log("no posts dir, nothing to build"); return; }
  const files = readdirSync(POSTS_DIR).filter((f) => f.endsWith(".md"));
  const posts = [];
  for (const f of files) {
    const { data, body } = parseFront(readFileSync(join(POSTS_DIR, f), "utf8"));
    const slug = data.slug || f.replace(/^\d{4}-\d{2}-\d{2}-/, "").replace(/\.md$/, "");
    posts.push({ ...data, slug, body, file: f });
  }
  const live = posts.filter((p) => p.draft === false && String(p.date) <= TODAY).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  mkdirSync(OUT_DIR, { recursive: true });

  for (const p of live) {
    const canonical = `${SITE}/blog/${p.slug}`;
    const og = p.ogImage ? (p.ogImage.startsWith("http") ? p.ogImage : SITE + p.ogImage) : "";
    const bodyHtml = `<article>
<h1>${esc(p.title)}</h1>
<div class="meta">${esc(p.date)}${p.chapter ? ` · ${esc(p.chapter)}` : ""} · <a href="/blog">RuleReceipt blog</a></div>
${md(p.body)}
</article>`;
    writeFileSync(join(OUT_DIR, `${p.slug}.html`), page({ title: `${p.title} — RuleReceipt`, desc: p.description || p.title, canonical, og, bodyHtml }));
  }

  const listItems = live.map((p) => `<li><a href="/blog/${esc(p.slug)}">${esc(p.title)}</a><div class="d">${esc(p.date)} — ${esc(p.description || "")}</div></li>`).join("\n");
  const indexBody = `<div class="index"><h1>Blog</h1><p class="meta">Field notes on checking what AI coding agents actually did. Plain, dated, honest about what it can't do.</p><ul class="post-list">${listItems || "<li>No posts yet.</li>"}</ul></div>`;
  writeFileSync(join(OUT_DIR, "index.html"), page({ title: "Blog — RuleReceipt", desc: "Field notes on checking what AI coding agents actually did.", canonical: `${SITE}/blog`, og: `${SITE}/og-image.png`, bodyHtml: indexBody }));

  const rssItems = live.map((p) => `    <item>
      <title>${esc(p.title)}</title>
      <link>${SITE}/blog/${esc(p.slug)}</link>
      <guid>${SITE}/blog/${esc(p.slug)}</guid>
      <pubDate>${new Date(p.date + "T09:00:00Z").toUTCString()}</pubDate>
      <description>${esc(p.description || "")}</description>
    </item>`).join("\n");
  const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>RuleReceipt blog</title>
  <link>${SITE}/blog</link>
  <description>Checking what AI coding agents actually did, against your written rules.</description>
  <language>en</language>
${rssItems}
</channel></rss>`;
  writeFileSync(join(OUT_DIR, "rss.xml"), rss);

  console.log(`blog built: ${live.length} live post(s) of ${posts.length}; drafts/future held: ${posts.length - live.length}. today=${TODAY}`);
}
main();
