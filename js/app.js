import * as store from './store.js';
import * as ai from './ai.js';
import * as P from './prompts.js';
import { md, h } from './render.js';
import * as obs from './obsidian.js';

const view = document.getElementById('view');
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-5);
const today = () => new Date().toISOString().slice(0, 10);
const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
let activeController = null; // aborts in-flight Claude calls when you leave a page

/* ---------- small UI helpers ---------- */

function toast(msg, kind = '') {
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = msg;
  const box = document.getElementById('toasts');
  box.appendChild(t);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => t.classList.add('out'), 4200);
  setTimeout(() => t.remove(), 4700);
}

async function withBusy(btn, label, fn) {
  const old = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spin"></span>${h(label)}`;
  try {
    return await fn();
  } catch (e) {
    if (e.name !== 'AbortError') toast(e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.innerHTML = old;
  }
}

// In-page confirmation (the Claude viewer does not show browser confirm dialogs).
function ask(message, okLabel = 'Confirm', danger = false) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal';
    wrap.innerHTML = `<div class="modal-card" role="dialog" aria-modal="true">
      <p>${h(message)}</p>
      <div class="actions"><button class="btn ${danger ? 'danger' : 'primary'}" id="m-ok">${h(okLabel)}</button><button class="btn ghost" id="m-cancel">Cancel</button></div>
    </div>`;
    document.body.appendChild(wrap);
    const done = (v) => { wrap.remove(); resolve(v); };
    wrap.querySelector('#m-ok').onclick = () => done(true);
    wrap.querySelector('#m-cancel').onclick = () => done(false);
    wrap.onclick = (e) => e.target === wrap && done(false);
    wrap.querySelector('#m-ok').focus();
  });
}

function lessonCount(course) {
  let done = 0, total = 0;
  course.modules.forEach((m) => m.lessons.forEach((l) => { total++; if (l.status === 'done') done++; }));
  return { done, total };
}

function nextLesson(course) {
  for (let i = 0; i < course.modules.length; i++)
    for (let j = 0; j < course.modules[i].lessons.length; j++)
      if (course.modules[i].lessons[j].status !== 'done') return [i, j];
  return null;
}

function findLesson(course, lid) {
  for (let i = 0; i < course.modules.length; i++) {
    const j = course.modules[i].lessons.findIndex((l) => l.id === lid);
    if (j >= 0) return [i, j];
  }
  return null;
}

async function loadCourse(id) {
  const c = await store.get('courses', id);
  if (!c) throw new Error('That course no longer exists.');
  return c;
}

// Course documents hold only the syllabus and progress. Dialogue and notes live in lesson documents.
async function saveCourse(c) {
  c.updatedAt = Date.now();
  const clean = JSON.parse(JSON.stringify(c, (k, v) => (k === 'messages' || k === 'notes' ? undefined : v)));
  await store.put('courses', clean);
}

async function loadLessonBody(l) {
  const body = (await store.get('lessons', l.id)) || {};
  l.messages = body.messages || [];
  l.notes = body.notes || '';
}

async function saveLessonBody(c, l) {
  await store.put('lessons', { id: l.id, courseId: c.id, messages: l.messages || [], notes: l.notes || '' });
}

async function updateNavBadge() {
  try {
    const due = (await store.all('cards')).filter((c) => c.due <= Date.now()).length;
    const b = document.getElementById('due-badge');
    b.textContent = due;
    b.hidden = !due;
  } catch {}
}

function setActiveNav(r) {
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.r === r));
}

/* ---------- router (in-page; works inside the Claude viewer) ---------- */

let currentPath = location.hash.startsWith('#/') ? location.hash.slice(2) : '';

export function go(path) {
  currentPath = path.replace(/^#?\/?/, '');
  route();
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="#/"]');
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey) return;
  e.preventDefault();
  go(a.getAttribute('href').slice(2));
});

async function route() {
  if (activeController) activeController.abort();
  activeController = null;
  const [r = '', ...args] = currentPath.split('/').map(decodeURIComponent);
  setActiveNav(r === 'review' || r === 'settings' ? r : 'home');
  window.scrollTo(0, 0);
  try {
    if (r === 'new') await newCoursePage();
    else if (r === 'course') await coursePage(args[0]);
    else if (r === 'lesson') await lessonPage(args[0], args[1]);
    else if (r === 'quiz') await quizPage(args[0], args[1], args[2]);
    else if (r === 'review') await reviewPage(args[0]);
    else if (r === 'settings') await settingsPage();
    else await homePage();
  } catch (e) {
    view.innerHTML = `<div class="empty"><h2>Something went wrong</h2><p>${h(e.message)}</p><a class="btn" href="#/">Back to courses</a></div>`;
  }
  updateNavBadge();
}

/* ---------- home ---------- */

async function homePage() {
  const [courses, cards, s, mode] = await Promise.all([store.all('courses'), store.all('cards'), ai.getSettings(), ai.mode()]);
  courses.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const due = cards.filter((c) => c.due <= Date.now()).length;
  const lessonsDone = courses.reduce((n, c) => n + lessonCount(c).done, 0);
  const needsSetup = mode === 'api' && !s.apiKey;

  view.innerHTML = `
    ${needsSetup ? `<div class="banner"><strong>Open Lyceum inside Claude</strong> to learn on your Claude plan. Running it elsewhere needs an Anthropic API key. <a href="#/settings">Settings</a></div>` : ''}
    ${!s.profile && !needsSetup ? `<div class="banner soft">Tell your tutor about your background so every course fits you. <a href="#/settings">Add a learner profile</a></div>` : ''}
    <header class="page-head">
      <div><p class="eyebrow">Your study</p><h1>Courses</h1></div>
      <a class="btn primary" href="#/new">New course</a>
    </header>
    <section class="stats">
      <div class="stat"><span class="num">${courses.length}</span><span>courses</span></div>
      <div class="stat"><span class="num">${lessonsDone}</span><span>lessons completed</span></div>
      <a class="stat link" href="#/review"><span class="num">${due}</span><span>flashcards due</span></a>
    </section>
    ${
      courses.length
        ? `<div class="course-grid">${courses.map(courseCard).join('')}</div>`
        : `<div class="empty">
            <h2>No courses yet</h2>
            <p>Name any subject and your tutor designs a graduate course around you: modules, lessons with clear objectives, and the key texts of the field.</p>
            <div class="examples">${['Measure-theoretic probability', 'The Late Roman Republic', 'Comparative constitutional law', 'Protein folding and dynamics'].map((x) => `<a class="chip" href="#/new/${encodeURIComponent(x)}">${h(x)}</a>`).join('')}</div>
            <a class="btn primary" href="#/new">Design my first course</a>
          </div>`
    }`;
}

function courseCard(c) {
  const { done, total } = lessonCount(c);
  const nx = nextLesson(c);
  const pct = total ? Math.round((done / total) * 100) : 0;
  const nxl = nx ? c.modules[nx[0]].lessons[nx[1]] : null;
  return `<article class="course-card">
    <a class="cover" href="#/course/${c.id}">
      <p class="eyebrow">${h(c.subject)}</p>
      <h3>${h(c.title)}</h3>
      <p class="muted clamp">${h(c.description)}</p>
    </a>
    <div class="progress" title="${pct}% complete"><div style="width:${pct}%"></div></div>
    <div class="card-foot">
      <span class="muted mono">${done}/${total} lessons</span>
      ${nxl ? `<a class="btn small" href="#/lesson/${c.id}/${nxl.id}">${nxl.status === 'in-progress' ? 'Resume' : 'Next'}: ${h(trunc(nxl.title, 26))}</a>` : '<span class="pill done">Complete</span>'}
    </div>
  </article>`;
}

/* ---------- new course ---------- */

async function newCoursePage() {
  const preset = decodeURIComponent(currentPath.split('/')[1] || '');
  view.innerHTML = `
    <a class="crumb" href="#/">← All courses</a>
    <header class="page-head"><div><p class="eyebrow">New course</p><h1>What do you want to master?</h1></div></header>
    <form id="nc" class="panel form">
      <label for="nc-subject">Subject <span class="req">*</span></label>
      <input id="nc-subject" name="subject" required value="${h(preset)}" placeholder="e.g. Measure-theoretic probability, the Late Roman Republic, protein folding">
      <label for="nc-focus">Focus and goals <span class="muted">(optional)</span></label>
      <textarea id="nc-focus" name="focus" rows="3" placeholder="What do you want to be able to do or understand by the end? Anything to emphasise or skip?"></textarea>
      <label for="nc-bg">Your background in this subject <span class="muted">(optional)</span></label>
      <textarea id="nc-bg" name="background" rows="2" placeholder="e.g. Took calculus years ago; comfortable with Python; read a couple of popular books on it."></textarea>
      <fieldset class="seg">
        <legend>Course length</legend>
        <label><input type="radio" id="sz-s" name="size" value="short"><span>Short<small>4 modules, about 12 lessons</small></span></label>
        <label><input type="radio" id="sz-m" name="size" value="standard" checked><span>Standard<small>6 modules, about 20 lessons</small></span></label>
        <label><input type="radio" id="sz-l" name="size" value="deep"><span>Deep<small>10 modules, about 40 lessons</small></span></label>
      </fieldset>
      <div class="actions"><button class="btn primary" type="submit">Design my course</button><a class="btn ghost" href="#/">Cancel</a></div>
      <p class="muted small">Your tutor drafts the full syllabus. Expect 30 seconds to 2 minutes while it thinks it through.</p>
    </form>`;
  if (!preset) document.getElementById('nc-subject').focus();

  document.getElementById('nc').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const btn = e.target.querySelector('button[type=submit]');
    await withBusy(btn, 'Designing your course…', async () => {
      const s = await ai.getSettings();
      activeController = new AbortController();
      const syl = await ai.json({
        instructions: P.syllabusSystem(s.profile),
        prompt: P.syllabusRequest(f),
        schema: P.SYLLABUS_TOOL.input_schema,
        tier: s.tutorTier,
        maxTokens: 16000,
        signal: activeController.signal,
      });
      const course = {
        id: uid(),
        subject: f.subject.trim(),
        focus: f.focus,
        background: f.background,
        title: String(syl.title || f.subject),
        description: String(syl.description || ''),
        prerequisites: syl.prerequisites || [],
        core_texts: syl.core_texts || [],
        createdAt: Date.now(),
        modules: (syl.modules || []).map((m) => ({
          id: uid(),
          title: m.title,
          summary: m.summary || '',
          examHistory: [],
          lessons: (m.lessons || []).map((l) => ({ id: uid(), title: l.title, objectives: l.objectives || [], status: 'not-started', recap: '', quizHistory: [] })),
        })),
      };
      if (!course.modules.length || !course.modules.some((m) => m.lessons.length)) throw new Error('The syllabus came back empty. Try again.');
      await saveCourse(course);
      go(`course/${course.id}`);
    });
  });
}

/* ---------- course ---------- */

async function coursePage(id) {
  const c = await loadCourse(id);
  const cards = (await store.all('cards')).filter((x) => x.courseId === id);
  const due = cards.filter((x) => x.due <= Date.now()).length;
  const { done, total } = lessonCount(c);
  const nx = nextLesson(c);
  const nxl = nx ? c.modules[nx[0]].lessons[nx[1]] : null;

  view.innerHTML = `
    <a class="crumb" href="#/">← All courses</a>
    <header class="course-head">
      <p class="eyebrow">${h(c.subject)}</p>
      <h1>${h(c.title)}</h1>
      <p class="lede">${h(c.description)}</p>
      <div class="progress big"><div style="width:${total ? (done / total) * 100 : 0}%"></div></div>
      <p class="muted small mono">${done} of ${total} lessons complete · ${cards.length} flashcards${due ? ` · <a href="#/review/${id}">${due} due</a>` : ''}</p>
      <div class="actions">
        ${nxl ? `<a class="btn primary" href="#/lesson/${id}/${nxl.id}">${nxl.status === 'in-progress' ? 'Resume' : done ? 'Continue' : 'Start'}: ${h(nxl.title)}</a>` : ''}
        <a class="btn" href="#/review/${id}">Review flashcards</a>
        <button class="btn" id="exp" title="${h(obs.VAULT_HINT)}">Export to Obsidian (.zip)</button>
      </div>
    </header>
    <div class="course-body">
      <div class="modules">
        ${c.modules
          .map(
            (m, i) => `<section class="module">
              <div class="module-head">
                <div><p class="eyebrow">Module ${i + 1}</p><h2>${h(m.title)}</h2><p class="muted">${h(m.summary)}</p></div>
                <div class="module-side">
                  <a class="btn small" href="#/quiz/${id}/module/${m.id}">Module exam</a>
                  ${m.examHistory?.length ? `<span class="muted small mono">Best ${Math.round(Math.max(...m.examHistory.map((e) => e.score)) * 100)}%</span>` : ''}
                </div>
              </div>
              <ol class="lessons">
                ${m.lessons
                  .map(
                    (l, j) => `<li><a href="#/lesson/${id}/${l.id}" class="lesson-row ${l.status}">
                      <span class="dot" title="${l.status.replace('-', ' ')}"></span>
                      <span class="ln mono">${i + 1}.${j + 1}</span>
                      <span class="lt">${h(l.title)}</span>
                      <span class="lm muted small mono">${l.quizHistory?.length ? `quiz ${Math.round(l.quizHistory[l.quizHistory.length - 1].score * 100)}%` : ''}</span>
                    </a></li>`
                  )
                  .join('')}
              </ol>
            </section>`
          )
          .join('')}
      </div>
      <aside class="course-aside">
        ${c.prerequisites?.length ? `<div class="panel"><h3>Prerequisites</h3><ul>${c.prerequisites.map((p) => `<li>${h(p)}</li>`).join('')}</ul></div>` : ''}
        ${c.core_texts?.length ? `<div class="panel"><h3>Core texts</h3><ul class="texts">${c.core_texts.map((p) => `<li>${h(p)}</li>`).join('')}</ul></div>` : ''}
        <div class="panel quiet"><p class="muted small">${h(obs.VAULT_HINT)}</p><button class="btn ghost small" id="del">Delete course</button></div>
      </aside>
    </div>`;

  document.getElementById('exp').onclick = (e) =>
    withBusy(e.currentTarget, 'Packing notes…', async () => toast(await obs.exportCourse(c), 'ok'));
  document.getElementById('del').onclick = async () => {
    if (!(await ask(`Delete "${c.title}", its lessons and its flashcards? This cannot be undone.`, 'Delete course', true))) return;
    for (const m of c.modules) for (const l of m.lessons) await store.del('lessons', l.id).catch(() => {});
    for (const card of cards) await store.del('cards', card.id);
    await store.del('courses', id);
    toast('Course deleted');
    go('');
  };
}

/* ---------- lesson ---------- */

async function lessonPage(cid, lid) {
  const c = await loadCourse(cid);
  const pos = findLesson(c, lid);
  if (!pos) throw new Error('Lesson not found.');
  const [mi, li] = pos;
  const l = c.modules[mi].lessons[li];
  await loadLessonBody(l);
  const s = await ai.getSettings();
  const flat = c.modules.flatMap((mm) => mm.lessons);
  const idx = flat.findIndex((x) => x.id === lid);
  const prev = flat[idx - 1];
  const next = flat[idx + 1];
  let busy = false;

  view.innerHTML = `
    <a class="crumb" href="#/course/${cid}">← ${h(c.title)}</a>
    <header class="lesson-head">
      <p class="eyebrow">Module ${mi + 1} · Lesson ${mi + 1}.${li + 1}</p>
      <h1>${h(l.title)}</h1>
    </header>
    <div class="lesson-layout">
      <section class="lesson-main">
        <div id="chat" class="chat" aria-live="polite"></div>
        <div id="start" class="start-card" hidden>
          <p>Your tutor opens with an orientation, then teaches in segments and questions you as you go. Answer in your own words. Getting things wrong is part of how this works.</p>
          <button class="btn primary" id="begin">Begin lesson</button>
        </div>
        <div class="composer" id="composer">
          <div class="chips">${P.QUICK_ACTIONS.map(([label], i) => `<button class="chip" data-q="${i}">${h(label)}</button>`).join('')}</div>
          <form id="ask" class="ask">
            <label class="sr" for="input">Your reply</label>
            <textarea id="input" rows="2" placeholder="Answer the question, ask anything, or push back…"></textarea>
            <button class="btn primary" id="send" type="submit">Send</button>
            <button class="btn ghost" id="stop" type="button" hidden>Stop</button>
          </form>
          <p class="muted tiny">Enter to send · Shift+Enter for a new line</p>
        </div>
      </section>
      <aside class="lesson-aside">
        <div class="panel">
          <h3>Objectives</h3>
          <ul class="objectives">${l.objectives.map((o) => `<li>${h(o)}</li>`).join('')}</ul>
          <label class="check"><input type="checkbox" id="done" ${l.status === 'done' ? 'checked' : ''}> Lesson complete</label>
        </div>
        <div class="panel tools">
          <h3>Study tools</h3>
          <button class="btn block" id="notes-btn">${l.notes ? 'Regenerate notes' : 'Generate notes'}</button>
          <a class="btn block" href="#/quiz/${cid}/lesson/${lid}">Quiz me</a>
          <button class="btn block" id="cards-btn">Make flashcards</button>
          <button class="btn block" id="export-btn">Export note (.md)</button>
        </div>
        <div class="panel" id="notes-panel" ${l.notes ? '' : 'hidden'}>
          <div class="row-between"><h3>Notes</h3><button class="link-btn" id="notes-toggle">Expand</button></div>
          <div class="prose notes collapsed" id="notes">${md(l.notes)}</div>
        </div>
        <nav class="pager">
          ${prev ? `<a href="#/lesson/${cid}/${prev.id}">← ${h(trunc(prev.title, 30))}</a>` : '<span></span>'}
          ${next ? `<a href="#/lesson/${cid}/${next.id}">${h(trunc(next.title, 30))} →</a>` : ''}
        </nav>
      </aside>
    </div>`;

  const chat = document.getElementById('chat');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const stopBtn = document.getElementById('stop');
  const startCard = document.getElementById('start');
  const composer = document.getElementById('composer');

  const bubble = (msg) =>
    msg.hidden
      ? `<div class="sys-note">Lesson started</div>`
      : `<div class="msg ${msg.role}"><div class="who">${msg.role === 'user' ? 'You' : 'Tutor'}</div><div class="prose">${md(msg.content)}</div></div>`;

  function renderAll() {
    const empty = !l.messages.length;
    startCard.hidden = !empty;
    composer.hidden = empty;
    chat.innerHTML = l.messages.map(bubble).join('');
  }

  function scrollDown(force) {
    const nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 220;
    if (force || nearBottom) window.scrollTo({ top: document.body.scrollHeight, behavior: force ? 'smooth' : 'auto' });
  }

  function errorBubble(message, label, onRetry) {
    const err = document.createElement('div');
    err.className = 'msg error';
    err.innerHTML = `<p>${h(message)}</p><button class="btn small">${h(label)}</button>`;
    err.querySelector('button').onclick = () => { err.remove(); onRetry(); };
    chat.appendChild(err);
  }

  async function generate() {
    busy = true;
    sendBtn.disabled = true;
    stopBtn.hidden = false;
    const el = document.createElement('div');
    el.className = 'msg assistant streaming';
    el.innerHTML = `<div class="who">Tutor</div><div class="prose"><span class="thinking">Thinking<span class="typing"><i></i><i></i><i></i></span></span></div>`;
    chat.appendChild(el);
    scrollDown(true);
    const prose = el.querySelector('.prose');
    let pending = null;
    let partial = '';
    const controller = new AbortController();
    activeController = controller;
    const finish = () => { busy = false; sendBtn.disabled = false; stopBtn.hidden = true; };
    try {
      const full = await ai.chat({
        instructions: P.tutorSystem(c, mi, li, s),
        turns: l.messages.map(({ role, content }) => ({ role, content })),
        tier: s.tutorTier,
        signal: controller.signal,
        onText: (t) => {
          partial = t;
          if (pending) return;
          pending = requestAnimationFrame(() => { pending = null; prose.innerHTML = md(partial); scrollDown(false); });
        },
      });
      l.messages.push({ role: 'assistant', content: full });
      await saveLessonBody(c, l);
    } catch (e) {
      cancelAnimationFrame(pending);
      const kept = partial || e.partial || '';
      if (e.name === 'AbortError') {
        if (kept) { l.messages.push({ role: 'assistant', content: kept + '\n\n*(stopped)*' }); await saveLessonBody(c, l); }
      } else {
        el.remove();
        finish();
        if (document.body.contains(chat)) errorBubble(e.message, 'Try again', generate);
        return;
      }
    } finally {
      cancelAnimationFrame(pending);
      if (activeController === controller) activeController = null;
    }
    finish();
    if (document.body.contains(chat)) { renderAll(); scrollDown(false); }
  }

  async function send(text, hidden = false) {
    text = text.trim();
    if (!text || busy) return;
    l.messages.push({ role: 'user', content: text, ...(hidden ? { hidden: true } : {}) });
    if (l.status === 'not-started') { l.status = 'in-progress'; saveCourse(c).catch(() => {}); }
    renderAll();
    saveLessonBody(c, l).catch((e) => toast(e.message, 'err'));
    generate();
  }

  renderAll();
  if (l.messages.length) setTimeout(() => window.scrollTo(0, document.body.scrollHeight), 0);
  if (l.messages.length && l.messages[l.messages.length - 1].role === 'user') {
    errorBubble("Your tutor hasn't replied to this yet.", 'Get reply', generate);
  }

  document.getElementById('begin').onclick = () => send(P.KICKOFF, true);
  document.getElementById('ask').onsubmit = (e) => {
    e.preventDefault();
    const t = input.value;
    if (!t.trim() || busy) return;
    input.value = '';
    send(t);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      document.getElementById('ask').requestSubmit();
    }
  });
  stopBtn.onclick = () => activeController && activeController.abort();
  composer.querySelectorAll('.chip').forEach((b) => (b.onclick = () => send(P.QUICK_ACTIONS[+b.dataset.q][1])));

  document.getElementById('done').onchange = async (e) => {
    l.status = e.target.checked ? 'done' : l.messages.length ? 'in-progress' : 'not-started';
    await saveCourse(c);
    if (!e.target.checked) return;
    toast('Lesson marked complete', 'ok');
    // A one-line recap lets later lessons build on this one.
    if (!l.recap && l.messages.length) {
      ai.json({
        instructions: 'You summarise tutoring sessions precisely.',
        prompt: `Summarise what the student learned in this lesson in one sentence of at most 40 words.\n\n${P.transcript(l).slice(-30000)}`,
        schema: P.RECAP_TOOL.input_schema,
        tier: 'quick',
        maxTokens: 400,
      })
        .then(async (r) => { if (r?.recap) { l.recap = String(r.recap); await saveCourse(c); } })
        .catch(() => {});
    }
  };

  const notesPanel = document.getElementById('notes-panel');
  const notesEl = document.getElementById('notes');
  document.getElementById('notes-toggle').onclick = (e) => {
    notesEl.classList.toggle('collapsed');
    e.target.textContent = notesEl.classList.contains('collapsed') ? 'Expand' : 'Collapse';
  };
  document.getElementById('notes-btn').onclick = async (e) => {
    const btn = e.currentTarget;
    await withBusy(btn, 'Writing notes…', async () => {
      notesPanel.hidden = false;
      notesEl.classList.remove('collapsed');
      document.getElementById('notes-toggle').textContent = 'Collapse';
      notesEl.innerHTML = '<p class="muted">Thinking…</p>';
      const text = await ai.write({
        instructions: P.NOTES_SYSTEM,
        prompt: P.notesRequest(c, mi, li),
        tier: s.toolTier,
        onText: (t) => (notesEl.innerHTML = md(t)),
      });
      l.notes = text;
      l.hasNotes = true;
      notesEl.innerHTML = md(text);
      await saveLessonBody(c, l);
      await saveCourse(c);
      toast('Notes saved', 'ok');
    });
    if (l.notes) btn.textContent = 'Regenerate notes';
  };

  document.getElementById('cards-btn').onclick = (e) =>
    withBusy(e.currentTarget, 'Making flashcards…', async () => {
      const r = await ai.json({
        instructions: 'You are an expert at writing spaced-repetition flashcards for graduate students.',
        prompt: P.flashcardRequest(c, mi, li),
        schema: P.FLASHCARD_TOOL.input_schema,
        tier: s.toolTier,
      });
      const now = Date.now();
      const cards = (r.cards || [])
        .filter((x) => x && x.front && x.back)
        .map((x) => ({ id: uid(), courseId: cid, lessonId: lid, front: String(x.front), back: String(x.back), ease: 2.5, interval: 0, reps: 0, due: now, created: now }));
      await store.putMany('cards', cards);
      updateNavBadge();
      toast(`${cards.length} flashcards added to your review queue`, 'ok');
    });

  document.getElementById('export-btn').onclick = (e) =>
    withBusy(e.currentTarget, 'Exporting…', async () => toast(await obs.exportLesson(c, mi, li, l), 'ok'));
}

/* ---------- quizzes and exams ---------- */

async function quizPage(cid, kind, targetId) {
  const c = await loadCourse(cid);
  let mi, li, title, back;
  if (kind === 'module') {
    mi = c.modules.findIndex((m) => m.id === targetId);
    if (mi < 0) throw new Error('Module not found.');
    title = `Module ${mi + 1} exam: ${c.modules[mi].title}`;
    back = `#/course/${cid}`;
  } else {
    const pos = findLesson(c, targetId);
    if (!pos) throw new Error('Lesson not found.');
    [mi, li] = pos;
    await loadLessonBody(c.modules[mi].lessons[li]);
    title = `Quiz: ${c.modules[mi].lessons[li].title}`;
    back = `#/lesson/${cid}/${targetId}`;
  }

  view.innerHTML = `
    <a class="crumb" href="${back}">← Back</a>
    <header class="page-head"><div><p class="eyebrow">${h(c.title)}</p><h1>${h(title)}</h1></div></header>
    <div id="quiz"><div class="loading-card"><span class="spin"></span>Your examiner is writing the questions. This can take a minute.</div></div>`;

  const box = document.getElementById('quiz');
  const controller = new AbortController();
  activeController = controller;
  let quiz;
  try {
    quiz = await ai.json({
      instructions: P.QUIZ_SYSTEM,
      prompt: kind === 'module' ? P.moduleExamRequest(c, mi) : P.lessonQuizRequest(c, mi, li),
      schema: P.QUIZ_TOOL.input_schema,
      signal: controller.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') return;
    box.innerHTML = `<div class="msg error"><p>${h(e.message)}</p><button class="btn small" id="retry">Try again</button></div>`;
    document.getElementById('retry').onclick = () => route();
    return;
  }
  const qs = (quiz.questions || []).filter(
    (q) => q && q.prompt && (q.type === 'written' || (Array.isArray(q.options) && q.options.length >= 2 && Number.isInteger(q.answer_index) && q.answer_index < q.options.length))
  );
  if (!qs.length) {
    box.innerHTML = `<div class="msg error"><p>The quiz came back empty.</p><button class="btn small" id="retry">Try again</button></div>`;
    document.getElementById('retry').onclick = () => route();
    return;
  }
  qs.forEach((q, i) => (q.id = i + 1));

  box.innerHTML = `<form id="qf" class="quiz">
    ${qs
      .map(
        (q) => `<fieldset class="q panel" data-id="${q.id}">
          <legend><span class="qn mono">${q.id}</span>${q.type === 'mcq' ? 'Multiple choice' : 'Written answer'}</legend>
          <div class="prose">${md(q.prompt)}</div>
          ${
            q.type === 'mcq'
              ? `<div class="opts">${q.options.map((o, k) => `<label class="opt"><input type="radio" id="q${q.id}o${k}" name="q${q.id}" value="${k}"><span class="prose">${md(o)}</span></label>`).join('')}</div>`
              : `<textarea id="q${q.id}w" name="q${q.id}" rows="5" placeholder="Write your answer. LaTeX like $x^2$ is fine."></textarea>`
          }
          <div class="result" hidden></div>
        </fieldset>`
      )
      .join('')}
    <div class="actions"><button class="btn primary" type="submit">Submit for grading</button></div>
  </form>`;

  document.getElementById('qf').onsubmit = (e) => {
    e.preventDefault();
    const form = e.target;
    const btn = form.querySelector('button[type=submit]');
    withBusy(btn, 'Grading…', async () => {
      const fd = new FormData(form);
      const scores = {};
      const written = [];
      for (const q of qs) {
        const v = fd.get(`q${q.id}`);
        if (q.type === 'mcq') scores[q.id] = { score: v != null && Number(v) === q.answer_index ? 1 : 0, chosen: v == null ? null : Number(v) };
        else written.push({ id: q.id, prompt: q.prompt, model_answer: q.model_answer, answer: (v || '').trim() });
      }
      written.filter((w) => !w.answer).forEach((w) => (scores[w.id] = { score: 0, feedback: 'No answer given.' }));
      const needGrading = written.filter((w) => w.answer);
      if (needGrading.length) {
        const g = await ai.json({ instructions: P.GRADE_SYSTEM, prompt: P.gradeRequest(needGrading), schema: P.GRADE_TOOL.input_schema });
        for (const r of g.grades || []) scores[r.id] = { score: Math.max(0, Math.min(1, Number(r.score) || 0)), feedback: String(r.feedback || '') };
      }
      let total = 0;
      for (const q of qs) {
        const sc = scores[q.id] || { score: 0 };
        total += sc.score;
        const fs = form.querySelector(`[data-id="${q.id}"]`);
        fs.classList.add(sc.score >= 0.75 ? 'right' : sc.score > 0 ? 'partial' : 'wrong');
        fs.querySelectorAll('input,textarea').forEach((x) => (x.disabled = true));
        if (q.type === 'mcq') {
          fs.querySelectorAll('.opt').forEach((o, k) => {
            if (k === q.answer_index) o.classList.add('correct');
            else if (k === sc.chosen) o.classList.add('chosen-wrong');
          });
        }
        const res = fs.querySelector('.result');
        res.hidden = false;
        res.innerHTML = `
          <p class="verdict">${q.type === 'mcq' ? (sc.score ? 'Correct' : 'Incorrect') : `Score: ${Math.round(sc.score * 100)}%`}</p>
          ${sc.feedback ? `<div class="prose">${md(sc.feedback)}</div>` : ''}
          ${q.type === 'written' ? `<details><summary>Model answer</summary><div class="prose">${md(q.model_answer || '')}</div></details>` : ''}
          <div class="prose explain">${md(q.explanation || '')}</div>`;
      }
      const score = total / qs.length;
      const entry = { date: today(), score };
      if (kind === 'module') (c.modules[mi].examHistory ||= []).push(entry);
      else (c.modules[mi].lessons[li].quizHistory ||= []).push(entry);
      await saveCourse(c);

      const missed = qs.filter((q) => (scores[q.id]?.score ?? 0) < 0.75);
      btn.closest('.actions').innerHTML = '';
      const sum = document.createElement('div');
      sum.className = 'panel score-card';
      sum.innerHTML = `<p class="eyebrow">Result</p><p class="big-score mono">${Math.round(score * 100)}%</p>
        <p class="muted">${score >= 0.85 ? 'Excellent command of the material.' : score >= 0.65 ? 'Solid, with gaps worth revisiting.' : 'Worth another pass before moving on. Ask your tutor about the questions you missed.'}</p>
        <div class="actions">
          ${missed.length ? `<button class="btn primary" id="miss">Turn ${missed.length} missed question${missed.length > 1 ? 's' : ''} into flashcards</button>` : ''}
          <a class="btn" href="${back}">Done</a>
        </div>`;
      box.prepend(sum);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      const mb = document.getElementById('miss');
      if (mb)
        mb.onclick = async () => {
          const now = Date.now();
          const lessonId = kind === 'module' ? null : targetId;
          await store.putMany('cards', missed.map((q) => ({
            id: uid(), courseId: cid, lessonId,
            front: q.prompt + (q.type === 'mcq' ? '\n\n' + q.options.map((o, k) => `${'ABCDEF'[k]}. ${o}`).join('\n') : ''),
            back: (q.type === 'mcq' ? `**${'ABCDEF'[q.answer_index]}. ${q.options[q.answer_index]}**\n\n` : `${q.model_answer || ''}\n\n`) + (q.explanation || ''),
            ease: 2.5, interval: 0, reps: 0, due: now, created: now,
          })));
          mb.disabled = true;
          mb.textContent = 'Added to your review queue';
          updateNavBadge();
        };
    });
  };
}

/* ---------- spaced repetition review (SM-2 variant) ---------- */

function schedule(card, grade) {
  // grade: 1 again, 2 hard, 3 good, 4 easy
  let { ease = 2.5, interval = 0, reps = 0 } = card;
  const q = { 1: 1, 2: 3, 3: 4, 4: 5 }[grade];
  let due;
  if (q < 3) {
    reps = 0;
    interval = 0;
    due = Date.now() + 10 * 60 * 1000;
  } else {
    reps += 1;
    if (reps === 1) interval = q === 5 ? 3 : 1;
    else if (reps === 2) interval = q === 3 ? 3 : 6;
    else interval = Math.max(interval + 1, Math.round(interval * ease * (q === 3 ? 0.8 : q === 5 ? 1.3 : 1)));
    due = Date.now() + interval * 86400000;
  }
  ease = Math.max(1.3, ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
  return { ...card, ease, interval, reps, due, lastReviewed: Date.now() };
}

async function reviewPage(courseId) {
  const [cards, courses] = await Promise.all([store.all('cards'), store.all('courses')]);
  const titles = Object.fromEntries(courses.map((c) => [c.id, c.title]));
  const queue = cards.filter((c) => c.due <= Date.now() && (!courseId || c.courseId === courseId)).sort((a, b) => a.due - b.due);
  let reviewed = 0;
  let grading = false;

  const header = `<header class="page-head"><div><p class="eyebrow">Spaced repetition</p><h1>Review${courseId && titles[courseId] ? `: ${h(titles[courseId])}` : ''}</h1></div>
    ${courseId ? `<a class="btn ghost" href="#/review">All courses</a>` : ''}</header>`;

  function show() {
    if (!queue.length) {
      const upcoming = cards.filter((c) => c.due > Date.now() && (!courseId || c.courseId === courseId)).sort((a, b) => a.due - b.due)[0];
      view.innerHTML = `${header}<div class="empty"><h2>${reviewed ? `Done: ${reviewed} card${reviewed > 1 ? 's' : ''} reviewed` : 'Nothing due right now'}</h2>
        <p class="muted">${upcoming ? `Next card is due ${new Date(upcoming.due).toLocaleString()}.` : 'Make flashcards from any lesson to start building long-term memory.'}</p>
        <a class="btn" href="#/">Back to courses</a></div>`;
      updateNavBadge();
      return;
    }
    const card = queue[0];
    view.innerHTML = `${header}
      <p class="muted small center mono">${queue.length} due · ${h(titles[card.courseId] || '')}</p>
      <div class="flashcard panel" id="fc">
        <div class="prose front">${md(card.front)}</div>
        <div class="prose back" hidden>${md(card.back)}</div>
      </div>
      <div class="review-actions" id="ra">
        <button class="btn primary wide" id="reveal">Show answer <kbd>Space</kbd></button>
      </div>`;
    document.getElementById('reveal').onclick = reveal;
  }

  function reveal() {
    const back = document.querySelector('#fc .back');
    if (!back || !back.hidden) return;
    back.hidden = false;
    document.getElementById('ra').innerHTML = [[1, 'Again'], [2, 'Hard'], [3, 'Good'], [4, 'Easy']]
      .map(([g, label]) => {
        const next = schedule(queue[0], g);
        const d = Math.round((next.due - Date.now()) / 86400000);
        const when = g === 1 ? '10 min' : d <= 1 ? '1 day' : `${d} days`;
        return `<button class="btn grade g${g}" data-g="${g}">${label}<small>${when}</small></button>`;
      })
      .join('');
    document.querySelectorAll('.grade').forEach((b) => (b.onclick = () => grade(+b.dataset.g)));
  }

  async function grade(g) {
    const back = document.querySelector('#fc .back');
    if (grading || !queue.length || !back || back.hidden) return;
    grading = true;
    const card = queue.shift();
    const updated = schedule(card, g);
    try { await store.put('cards', updated); } catch (e) { toast(e.message, 'err'); }
    reviewed++;
    if (g === 1) queue.push(updated); // see it again this session
    grading = false;
    show();
  }

  const onKey = (e) => {
    if (!currentPath.startsWith('review')) return document.removeEventListener('keydown', onKey);
    if (e.target.matches('input,textarea')) return;
    if (e.code === 'Space') { e.preventDefault(); reveal(); }
    if (['1', '2', '3', '4'].includes(e.key) && document.querySelector('.grade')) grade(+e.key);
  };
  document.addEventListener('keydown', onKey);
  show();
}

/* ---------- settings ---------- */

async function settingsPage() {
  const [s, mode, where] = await Promise.all([ai.getSettings(), ai.mode(), store.kind()]);
  const tierOpt = (sel, opts) => opts.map(([v, label]) => `<option value="${v}" ${v === sel ? 'selected' : ''}>${h(label)}</option>`).join('');

  view.innerHTML = `
    <header class="page-head"><div><p class="eyebrow">Setup</p><h1>Settings</h1></div></header>
    <form id="sf" class="settings">
      <section class="panel form">
        <h2>About you as a learner</h2>
        <p class="muted">Every course and lesson is tailored to this. Mention your education, what you already know well, and how you like to be taught.</p>
        <label class="sr" for="profile">Learner profile</label>
        <textarea id="profile" name="profile" rows="6" placeholder="e.g. Self-taught generalist, comfortable with algebra, rusty on calculus. I learn best from concrete examples before formalism, and I like the history of ideas.">${h(s.profile)}</textarea>
      </section>

      <section class="panel form">
        <h2>Teaching depth</h2>
        <p class="muted">${mode === 'plan' ? 'Lyceum runs on your Claude plan. Lessons count toward your plan\'s usage limits, not a separate bill.' : 'Lyceum is running outside Claude, so it uses the Anthropic API key below.'}</p>
        <label for="tutorTier">Tutor and syllabus</label>
        <select id="tutorTier" name="tutorTier">${tierOpt(s.tutorTier, [['complex', 'Deepest reasoning (uses more of your plan)'], ['default', 'Balanced (lighter on usage)']])}</select>
        <label for="toolTier">Notes, quizzes, flashcards and grading</label>
        <select id="toolTier" name="toolTier">${tierOpt(s.toolTier, [['default', 'Balanced'], ['complex', 'Deepest reasoning'], ['quick', 'Fastest']])}</select>
      </section>

      ${
        mode === 'api'
          ? `<section class="panel form">
              <h2>Anthropic API key</h2>
              <p class="muted">Only needed when Lyceum runs outside Claude. Stored in this browser only.</p>
              <div class="keyrow"><label class="sr" for="apiKey">API key</label><input type="password" id="apiKey" name="apiKey" value="${h(s.apiKey)}" placeholder="sk-ant-…" autocomplete="off" spellcheck="false"></div>
            </section>`
          : ''
      }

      <div class="actions sticky"><button class="btn primary" type="submit">Save settings</button></div>

      <section class="panel form">
        <h2>Your data</h2>
        <p class="muted">${where === 'account' ? 'Courses, lessons and flashcards are saved privately to your Claude account, so they follow you to any device.' : 'Courses, lessons and flashcards are saved in this browser only.'} Download a backup any time.</p>
        <div class="row"><button type="button" class="btn" id="backup">Download backup</button>
        <label class="btn file" for="restore">Restore from backup</label><input type="file" id="restore" accept="application/json,.json" hidden></div>
      </section>

      <section class="panel form">
        <h2>Obsidian</h2>
        <p class="muted">Each lesson exports as a Markdown note with your notes, flashcards (in the Spaced Repetition plugin's <code>question::answer</code> format), quiz history and the full dialogue. A whole course exports as a .zip. ${h(obs.VAULT_HINT)}</p>
      </section>
    </form>`;

  const form = document.getElementById('sf');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    try {
      await ai.saveSettings({ ...s, profile: f.profile.trim(), tutorTier: f.tutorTier, toolTier: f.toolTier, ...(f.apiKey !== undefined ? { apiKey: f.apiKey.trim() } : {}) });
      toast('Settings saved', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  };

  document.getElementById('backup').onclick = (e) =>
    withBusy(e.currentTarget, 'Preparing…', async () => {
      const data = { app: 'lyceum', version: 2, exported: new Date().toISOString(), courses: await store.all('courses'), lessons: [], cards: await store.all('cards') };
      for (const c of data.courses) for (const m of c.modules) for (const l of m.lessons) {
        const b = await store.get('lessons', l.id);
        if (b) data.lessons.push(b);
      }
      toast(await obs.saveFile(`lyceum-backup-${today()}.json`, JSON.stringify(data)), 'ok');
    });
  document.getElementById('restore').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data.app !== 'lyceum') throw new Error('That file is not a Lyceum backup.');
      if (!(await ask(`Restore ${data.courses.length} courses and ${data.cards.length} flashcards? Items with the same ID are overwritten.`, 'Restore'))) return;
      await store.putMany('courses', data.courses);
      await store.putMany('lessons', data.lessons || []);
      await store.putMany('cards', data.cards);
      toast('Backup restored', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  };
}

/* ---------- boot ---------- */

route();
