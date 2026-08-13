// render-book.mjs — 把中英两版书渲染成"一章一页"的自包含 book.html
// 每个章节单独一页，底部上一章/下一章导航，侧边栏点击切页，语言一键切换。
// 用法：node render-book.mjs
// 依赖：marked 与 shiki（从 DSH checkout 的 node_modules 解析）
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { readFileSync, writeFileSync } from 'node:fs'

const require = createRequire('C:/Users/Siberia/WorkBuddy/2026-08-13-22-27-42/deepseek-harness/package.json')
const { marked } = require('marked')
const shiki = await import(pathToFileURL(require.resolve('shiki')).href)

const LANG_MAP = { sh: 'bash', shell: 'bash', yml: 'yaml', ts: 'typescript', js: 'javascript', text: 'plaintext', txt: 'plaintext' }

function decodeEntities(s) {
  return s
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&')
}

async function highlightBlocks(html) {
  const re = /<pre><code class="language-([\w-]+)">([\s\S]*?)<\/code><\/pre>/g
  const out = []
  let last = 0
  for (const m of html.matchAll(re)) {
    out.push(html.slice(last, m.index))
    const lang = LANG_MAP[m[1]] ?? m[1]
    try {
      out.push(await shiki.codeToHtml(decodeEntities(m[2]), { lang, theme: 'github-light' }))
    } catch {
      out.push(m[0])
    }
    last = m.index + m[0].length
  }
  out.push(html.slice(last))
  return out.join('')
}

// 标题 slug：保留中英文与数字，空格转连字符
function slugify(text) {
  const s = text
    .replace(/<[^>]+>/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
  return s || 'section'
}

// marked v16 默认不给标题加 id，这里后处理注入锚点
function addHeadingIds(html) {
  const seen = {}
  return html.replace(/<h([23])(\s[^>]*)?>([\s\S]*?)<\/h\1>/g, (m, level, attrs, content) => {
    const text = content.replace(/<[^>]+>/g, '').trim()
    let id = slugify(text)
    if (seen[id] !== undefined) {
      seen[id]++
      id = `${id}-${seen[id]}`
    } else {
      seen[id] = 0
    }
    const attr = attrs ? attrs.replace(/ id="[^"]*"/, '') : ''
    return `<h${level} id="${id}"${attr}>${content}</h${level}>`
  })
}

// 按 h2 切分章节：每一章是一页，同时提取本章的小节（h3）
function splitChapters(html) {
  const re = /<h2 id="([^"]+)">([\s\S]*?)(?=<h2 id="|$)/g
  const chapters = []
  let m
  while ((m = re.exec(html)) !== null) {
    // m[2] 从 h2 开始标签之后一直延伸到下一个 h2，先取出标题文本
    const titleMatch = m[2].match(/^([\s\S]*?)<\/h2>/)
    const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : m[2].replace(/<[^>]+>/g, '').trim()
    const block = `<h2 id="${m[1]}">${m[2]}`
    // 提取本章的小节标题（跳过各章小结）
    const subs = []
    const h3re = /<h3 id="([^"]+)">([\s\S]*?)<\/h3>/g
    let h3
    while ((h3 = h3re.exec(block)) !== null) {
      const subTitle = h3[2].replace(/<[^>]+>/g, '').trim()
      if (subTitle === '本章小结' || subTitle === 'Chapter summary') continue
      subs.push({ id: h3[1], title: subTitle })
    }
    chapters.push({ id: m[1], title, subs, content: block })
  }
  return chapters
}

const esc = (s) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

const here = new URL('../', import.meta.url)

async function renderBook(relMd) {
  let md = readFileSync(new URL(relMd, here), 'utf8')
  md = md.replace(/^\[English\]\([^)]*\) \| 中文$/m, '').replace(/^English \| \[中文\]\([^)]*\)$/m, '')
  let html = marked.parse(md, { gfm: true })
  html = addHeadingIds(html)
  html = await highlightBlocks(html)
  html = html.replace(/src="(diagrams\/[^"]+)"/g, (_, path) => {
    try {
      const buf = readFileSync(new URL(`./book/${path}`, here))
      return `src="data:image/svg+xml;base64,${buf.toString('base64')}"`
    } catch {
      return `src="${path}"`
    }
  })
  return splitChapters(html)
}

const zhChapters = await renderBook('./book/cordis-architecture-book.zh.md')
const enChapters = await renderBook('./book/cordis-architecture-book.en.md')

const NAV = { zh: { prev: '上一章', next: '下一章' }, en: { prev: 'Previous', next: 'Next' } }

function chapterHtml(chapters, lang) {
  const n = chapters.length
  const nav = NAV[lang]
  return chapters.map((ch, i) => {
    const prev = i > 0 ? `<a class="nav-btn" onclick="showChapter(${i - 1})">← ${nav.prev}</a>` : '<span class="nav-btn disabled"></span>'
    const next = i < n - 1 ? `<a class="nav-btn" onclick="showChapter(${i + 1})">${nav.next} →</a>` : '<span class="nav-btn disabled"></span>'
    const foot = `<nav class="page-nav">${prev}<span class="nav-mid">${i + 1} / ${n}</span>${next}</nav>`
    return `<div id="${lang}-ch-${i}" class="chapter"${i === 0 ? '' : ' hidden'}>${ch.content}${foot}</div>`
  }).join('\n')
}

// 目录：章节（h2）默认折叠，点击展开小节（h3）；点小节跳到该章并滚到对应位置
function tocNav(chapters) {
  return chapters.map((ch, i) => {
    const subLinks = ch.subs
      .map((s) => `<a class="toc-3" data-idx="${i}" onclick="showChapter(${i}, '${s.id}')">${esc(s.title)}</a>`)
      .join('\n')
    return (
      `<a class="toc-2" data-idx="${i}" onclick="toggleChapter(this, ${i})">${esc(ch.title)}</a>\n` +
      `<div class="toc-group" hidden>\n${subLinks}\n</div>`
    )
  }).join('\n')
}

const page = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>拆开 DeepSeek Harness，看懂 Cordis 架构 / Inside DeepSeek Harness</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif; color: #2b2b2b; background: #fff; }
  .topbar {
    position: sticky; top: 0; z-index: 20; background: #fff;
    border-bottom: 1px solid #eee; display: flex; align-items: center;
    justify-content: space-between; gap: 1rem; padding: .55rem 1.2rem;
  }
  .brand { font-weight: 700; font-size: .92rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .lang-bar { display: flex; gap: .4rem; flex-shrink: 0; }
  .lang-btn {
    border: 1px solid #d0d7de; background: #f6f8fa; border-radius: 999px;
    padding: .25rem .9rem; cursor: pointer; font-size: .85rem; color: #57606a;
  }
  .lang-btn.active { background: #0f172a; color: #fff; border-color: #0f172a; }
  .layout { display: flex; align-items: flex-start; }
  .sidebar {
    width: 280px; flex-shrink: 0; border-right: 1px solid #eee;
    padding: 1rem .8rem 2rem; position: sticky; top: 47px;
    height: calc(100vh - 47px); overflow-y: auto;
  }
  .sidebar .toc-title { font-size: .75rem; font-weight: 700; color: #8b949e; text-transform: uppercase; letter-spacing: .05em; margin: 0 0 .5rem .4rem; }
  .sidebar nav { display: flex; flex-direction: column; gap: .1rem; }
  .sidebar a {
    display: block; padding: .3rem .6rem; border-radius: 6px;
    color: #57606a; text-decoration: none; font-size: .85rem; line-height: 1.4; cursor: pointer;
  }
  .sidebar a:hover { background: #f6f8fa; color: #0f172a; }
  .sidebar a.active { background: #eef4ff; color: #1a6bb0; font-weight: 600; }
  .sidebar a.toc-2 { position: relative; }
  .sidebar a.toc-2::after { content: '▸'; position: absolute; right: .6rem; color: #b6beca; transition: transform .15s; }
  .sidebar a.toc-2.open::after { transform: rotate(90deg); }
  .sidebar a.toc-3 { padding-left: 1.5rem; font-size: .8rem; color: #8b949e; }
  .toc-group { display: flex; flex-direction: column; gap: .1rem; }
  .toc-group[hidden] { display: none; }
  .content { flex: 1; min-width: 0; }
  .content-inner { max-width: 800px; margin: 0 auto; padding: 2rem 1.5rem 4rem; line-height: 1.85; }
  .content-inner h2 { font-size: 1.45rem; border-bottom: 1px solid #eee; padding-bottom: .35rem; margin-top: 0; }
  .content-inner h3 { font-size: 1.18rem; margin-top: 1.6rem; }
  .content-inner p { margin: .7rem 0; }
  .content-inner a { color: #1a6bb0; }
  .content-inner code { font-family: Consolas, "JetBrains Mono", monospace; background: #f4f4f4; border-radius: 4px; padding: .12em .35em; font-size: .92em; }
  .content-inner pre { background: #f7f7f7; border: 1px solid #e6e6e6; border-radius: 8px; padding: .9rem 1.1rem; overflow-x: auto; line-height: 1.55; }
  .content-inner pre code { background: none; padding: 0; font-size: .88em; }
  .content-inner table { border-collapse: collapse; margin: 1rem 0; width: 100%; font-size: .95rem; }
  .content-inner th, .content-inner td { border: 1px solid #ddd; padding: .45rem .7rem; text-align: left; }
  .content-inner th { background: #f4f6f8; font-weight: 600; }
  .content-inner img { max-width: 100%; height: auto; display: block; margin: 1.1rem auto .3rem; border: 1px solid #e2e2e2; border-radius: 8px; }
  .content-inner blockquote { border-left: 4px solid #d0d7de; margin: 1rem 0; padding: .2rem 1rem; color: #57606a; background: #f8f9fa; border-radius: 0 6px 6px 0; }
  .content-inner ul, .content-inner ol { padding-left: 1.6rem; }
  .content-inner li { margin: .25rem 0; }
  .content-inner hr { border: none; border-top: 1px solid #e5e5e5; margin: 2rem 0; }
  .page-nav {
    display: flex; justify-content: space-between; align-items: center; gap: 1rem;
    margin-top: 3rem; padding-top: 1.2rem; border-top: 1px solid #e5e5e5;
  }
  .nav-btn {
    border: 1px solid #d0d7de; background: #f6f8fa; border-radius: 8px;
    padding: .5rem 1.1rem; font-size: .9rem; color: #1a6bb0; cursor: pointer; text-decoration: none;
  }
  .nav-btn:hover { background: #eef4ff; }
  .nav-btn.disabled { visibility: hidden; }
  .nav-mid { color: #8b949e; font-size: .85rem; }
  @media (max-width: 900px) { .sidebar { display: none; } }
</style>
</head>
<body>
<header class="topbar">
  <div id="brand-zh" class="brand">拆开 DeepSeek Harness，看懂 Cordis 架构</div>
  <div id="brand-en" class="brand" hidden>Inside DeepSeek Harness, Understanding Cordis Architecture</div>
  <div class="lang-bar">
    <button id="btn-zh" class="lang-btn active" onclick="showLang('zh')">中文</button>
    <button id="btn-en" class="lang-btn" onclick="showLang('en')">English</button>
  </div>
</header>
<div class="layout">
  <aside class="sidebar">
    <div id="toc-zh-block">
      <div class="toc-title">目录</div>
      <nav id="toc-zh">${tocNav(zhChapters)}</nav>
    </div>
    <div id="toc-en-block" hidden>
      <div class="toc-title">Contents</div>
      <nav id="toc-en">${tocNav(enChapters)}</nav>
    </div>
  </aside>
  <main class="content">
    <div id="zh" class="content-inner">${chapterHtml(zhChapters, 'zh')}</div>
    <div id="en" class="content-inner" hidden>${chapterHtml(enChapters, 'en')}</div>
  </main>
</div>
<script>
let lang = 'zh'
let chapter = 0

function showLang(l) {
  lang = l
  document.getElementById('zh').hidden = l !== 'zh'
  document.getElementById('en').hidden = l !== 'en'
  document.getElementById('brand-zh').hidden = l !== 'zh'
  document.getElementById('brand-en').hidden = l !== 'en'
  document.getElementById('toc-zh-block').hidden = l !== 'zh'
  document.getElementById('toc-en-block').hidden = l !== 'en'
  document.getElementById('btn-zh').classList.toggle('active', l === 'zh')
  document.getElementById('btn-en').classList.toggle('active', l === 'en')
  paint()
}

function showChapter(i, anchor) {
  chapter = i
  paint(anchor)
}

// 点击章节标题：展开/收起它的小节，并切到这一章
function toggleChapter(a, i) {
  const group = a.nextElementSibling
  if (group && group.classList.contains('toc-group')) {
    group.hidden = !group.hidden
    a.classList.toggle('open', !group.hidden)
  }
  showChapter(i)
}

function paint(anchor) {
  const count = document.querySelectorAll('#zh .chapter').length
  document.querySelectorAll('.chapter').forEach((d) => { d.hidden = true })
  document.getElementById(lang + '-ch-' + chapter).hidden = false
  document.querySelectorAll('.sidebar a').forEach((a) => a.classList.remove('active'))
  // 只高亮当前语言侧边栏里的链接，并展开当前章节的小节
  const navId = lang === 'zh' ? 'toc-zh' : 'toc-en'
  const link = document.querySelector('#' + navId + ' a[data-idx="' + chapter + '"]')
  if (link) {
    link.classList.add('active')
    const group = link.nextElementSibling
    if (group && group.classList.contains('toc-group')) {
      group.hidden = false
      link.classList.add('open')
    }
  }
  history.replaceState(null, '', '#' + lang + '-' + chapter)
  window.scrollTo(0, 0)
  if (anchor) {
    // 等章节显示后，滚动到小节标题
    setTimeout(() => {
      const el = document.getElementById(anchor)
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 50)
  }
}

// 初始状态：从 URL 恢复语言与章节
const m = location.hash.match(/^#(zh|en)(?:-(\d+))?/)
if (m) {
  lang = m[1]
  chapter = m[2] !== undefined ? Math.min(Number(m[2]), document.querySelectorAll('#zh .chapter').length - 1) : 0
}
showLang(lang)
</script>
</body>
</html>
`

writeFileSync(new URL('./book/book.html', here), page)
console.log(`book/book.html written (${(page.length / 1024).toFixed(1)} KB, zh ${zhChapters.length} 章, en ${enChapters.length} 章)`)
