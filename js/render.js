// Markdown + LaTeX rendering (marked, DOMPurify and KaTeX are loaded globally in index.html).

export function h(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function md(src) {
  src = String(src || '');
  const code = [];
  const math = [];
  // Protect code first so $ inside code is left alone.
  src = src.replace(/```[\s\S]*?(```|$)|`[^`\n]+`/g, (m) => {
    code.push(m);
    return `\u0000C${code.length - 1}\u0000`;
  });
  const addMath = (tex, display) => {
    math.push({ tex, display });
    return `@@M${math.length - 1}@@`;
  };
  src = src
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, t) => addMath(t, true))
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, t) => addMath(t, true))
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, t) => addMath(t, false))
    .replace(/(^|[^\\$\w])\$(?![\s\d.,]*\s)(?!\s)([^\n$]+?)(?<!\s)\$(?![\w$])/g, (_, pre, t) => pre + addMath(t, false));
  src = src.replace(/\u0000C(\d+)\u0000/g, (_, i) => code[+i]);

  const parse = window.marked ? (s) => window.marked.parse(s, { gfm: true, breaks: false }) : (s) => `<p>${h(s)}</p>`;
  let html = parse(src);
  html = window.DOMPurify ? window.DOMPurify.sanitize(html) : html;
  return html.replace(/@@M(\d+)@@/g, (_, i) => {
    const m = math[+i];
    if (!window.katex) return `<code>${h(m.tex)}</code>`;
    try {
      // MathML output renders with the browser's own maths fonts, so no KaTeX stylesheet or font files are needed.
      return window.katex.renderToString(m.tex, { displayMode: m.display, throwOnError: false, output: 'mathml' });
    } catch {
      return `<code>${h(m.tex)}</code>`;
    }
  });
}
