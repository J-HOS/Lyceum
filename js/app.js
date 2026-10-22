import * as db from './db.js';
import { streamText, callTool, completeText, getSettings, MODELS } from './api.js';
import * as P from './prompts.js';
import { md, h } from './render.js';
import * as obs from './obsidian.js';

const view = document.getElementById('view');
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-5);
const today = () => new Date().toISOString().slice(0, 10);
let activeController = null; // aborts in-flight streaming when you leave a page

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
  const c = await db.get('courses', id);
  if (!c) throw new Error('That course no longer exists.');
  return c;
}

async function saveCourse(c) {
  c.updatedAt = Date.now();
  await db.put('courses', c);
}

async function updateNavBadge() {
  const due = (await db.getAll('cards')).filter((c) => c.due <= Date.now()).length;
  const b = document.getElementById('due-badge');
  b.textContent = due;
  b.hidden = !due;
}

function setActiveNav(r) {
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.r === r));
}

/* ---------- router ---------- */

async function route() {
  if (activeController) activeController.abort();
  activeController = null;
  const [r = '', ...args] = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
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
  const [courses, cards, s] = await Promise.all([db.getAll('courses'), db.getAll('cards'), getSettings()]);
  courses.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const due = cards.filter((c) => c.due <= Date.now()).length;
  const lessonsDone = courses.reduce((n, c) => n + lessonCount(c).done, 0);

  view.innerHTML = `
    ${!s.apiKey ? `<div class="banner"><strong>First step:</strong> add your Anthropic API key so your tutor can teach. <a href="#/settings">Open Settings →</a></div>` : ''}
    <header class="page-head">
      <div><p class="eyebrow">Your study</p><h1>Courses</h1></div>
      <a class="btn primary" href="#/new">＋ New course</a>
    </header>
    <section class="stats">
      <div class="stat"><span class="num">${courses.length}</span><span>courses</span></div>
      <div class="stat"><span class="num">${lessonsDone}</span><span>lessons completed</span></div>
      <a class="stat link" href="#/review"><span class="num">${due}</span><span>flashcards due</span></a>
    </section>
    ${
      courses.length
        ? `<div class="course-grid">${courses.map(courseCard).join('')}</div>`
        : `<div class="empty"><h2>No courses yet</h2><p>Pick any subject, from Bayesian statistics to Byzantine history, and your tutor will design a graduate-level course around you.</p><a class="btn primary" href="#/new">Design my first course</a></div>`
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
    <div class="progress"><div style="width:${pct}%"></div></div>
    <div class="card-foot">
      <span class="muted">${done}/${total} lessons</span>
      ${nxl ? `<a class="btn small" href="#/lesson/${c.id}/${nxl.id}">${nxl.status === 'in-progress' ? 'Resume' : 'Next'}: ${h(trunc(nxl.title, 28))}</a>` : '<span class="pill done">Complete</span>'}
    </div>
  </article>`;
}

const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/* ---------- new course ---------- */

async function newCoursePage() {
  view.innerHTML = `
    <header class="page-head"><div><p class="eyebrow">New course</p><h1>What do you want to master?</h1></div></header>
    <form id="nc" class="panel form">
      <label>Subject <span class="req">*</span>
        <input name="subject" required placeholder="e.g. Measure-theoretic probability, the Late Roman Republic, protein folding…" autofocus>
      </label>
      <label>Focus and goals <span class="muted">(optional)</span>
        <textarea name="focus" rows="3" placeholder="What do you want to be able to do or understand by the end? Any angles to emphasise or skip?"></textarea>
      </label>
      <label>Your background in this subject <span class="muted">(optional)</span>
        <textarea name="background" rows="2" placeholder="e.g. Took undergrad calculus years ago; comfortable with Python; read a couple of popular books on it."></textarea>
      </label>
      <fieldset class="seg">
        <legend>Course length</legend>
        <label><input type="radio" name="size" value="short"><span>Short<small>4 modules · ~12 lessons</small></span></label>
        <label><input type="radio" name="size" value="standard" checked><span>Standard<small>6 modules · ~20 lessons</small></span></label>
        <label><input type="radio" name="size" value="deep"><span>Deep<small>10 modules · ~40 lessons</small></span></label>
      </fieldset>
      <div class="actions"><button class="btn primary" type="submit">Design my course</button><a class="btn ghost" href="#/">Cancel</a></div>
      <p class="muted small">Your tutor drafts a full syllabus with modules, lessons, objectives and core texts. It usually takes 20–60 seconds.</p>
    </form>`;

  document.getElementById('nc').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const btn = e.target.querySelector('button[type=submit]');
    await withBusy(btn, 'Designing your course…', async () => {
      const s = await getSettings();
      const syl = await callTool({
        system: P.syllabusSystem(s.profile),
        messages: [{ role: 'user', content: P.syllabusRequest(f) }],
        tool: P.SYLLABUS_TOOL,
        model: s.tutorModel,
        maxTokens: 16000,
      });
      const course = {
        id: uid(),
        subject: f.subject.trim(),
        focus: f.focus,
        background: f.background,
        title: syl.title,
        description: syl.description,
        prerequisites: syl.prerequisites || [],
        core_texts: syl.core_texts || [],
        createdAt: Date.now(),
        modules: (syl.modules || []).map((m) => ({
          id: uid(),
          title: m.title,
          summary: m.summary,
          examHistory: [],
          lessons: (m.lessons || []).map((l) => ({
            id: uid(),
            title: l.title,
            objectives: l.objectives || [],
            status: 'not-started',
            messages: [],
            notes: '',
            recap: '',
            quizHistory: [],
          })),
        })),
      };
      if (!course.modules.length) throw new Error('The syllabus came back empty. Try again.');
      await saveCourse(course);
      location.hash = `#/course/${course.id}`;
    });
  });
}

/* ---------- course ---------- */

async function coursePage(id) {
  const c = await loadCourse(id);
  const cards = (await db.getAll('cards')).filter((x) => x.courseId === id);
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
      <p class="muted small">${done} of ${total} lessons complete · ${cards.length} flashcards${due ? `, <a href="#/review/${id}">${due} due</a>` : ''}</p>
      <div class="actions">
        ${nxl ? `<a class="btn primary" href="#/lesson/${id}/${nxl.id}">${nxl.status === 'in-progress' ? 'Resume' : done ? 'Continue' : 'Start'}: ${h(nxl.title)}</a>` : ''}
        <a class="btn" href="#/review/${id}">Review flashcards</a>
        <button class="btn" id="exp">Export course to Obsidian</button>
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
                  ${m.examHistory?.length ? `<span class="muted small">Best ${Math.round(Math.max(...m.examHistory.map((e) => e.score)) * 100)}%</span>` : ''}
                </div>
              </div>
              <ol class="lessons">
                ${m.lessons
                  .map(
                    (l, j) => `<li><a href="#/lesson/${id}/${l.id}" class="lesson-row ${l.status}">
                      <span class="dot" title="${l.status}"></span>
                      <span class="ln">${i + 1}.${j + 1}</span>
                      <span class="lt">${h(l.title)}</span>
                      <span class="lm muted small">${l.quizHistory?.length ? `Quiz ${Math.round(l.quizHistory[l.quizHistory.length - 1].score * 100)}%` : ''}</span>
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
        <div class="panel danger-zone"><button class="btn ghost small" id="del">Delete course</button></div>
      </aside>
    </div>`;

  document.getElementById('exp').onclick = (e) =>
    withBusy(e.currentTarget, 'Exporting…', async () => toast(await obs.exportCourse(c), 'ok'));
  document.getElementById('del').onclick = async () => {
    if (!confirm(`Delete "${c.title}" and its flashcards? This cannot be undone.`)) return;
    await db.del('courses', id);
    for (const card of cards) await db.del('cards', card.id);
    location.hash = '#/';
  };
}

/* ---------- lesson ---------- */

async function lessonPage(cid, lid) {
  const c = await loadCourse(cid);
  const pos = findLesson(c, lid);
  if (!pos) throw new Error('Lesson not found.');
  const [mi, li] = pos;
  const m = c.modules[mi];
  const l = m.lessons[li];
  const s = await getSettings();
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
          <p>Your tutor will open with an orientation, then teach in segments and question you as you go. Answer in your own words; being wrong is how this works.</p>
          <button class="btn primary" id="begin">Begin lesson</button>
        </div>
        <div class="composer" id="composer">
          <div class="chips">${P.QUICK_ACTIONS.map(([label], i) => `<button class="chip" data-q="${i}">${h(label)}</button>`).join('')}</div>
          <form id="ask" class="ask">
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
          <button class="btn block" id="export-btn">Export to Obsidian</button>
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

  function bubble(msg) {
    if (msg.hidden) return `<div class="sys-note">Lesson started</div>`;
    return `<div class="msg ${msg.role}"><div class="who">${msg.role === 'user' ? 'You' : 'Tutor'}</div><div class="prose">${msg.role === 'user' ? md(msg.content) : md(msg.content)}</div></div>`;
  }

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

  async function generate() {
    busy = true;
    sendBtn.disabled = true;
    stopBtn.hidden = false;
    const el = document.createElement('div');
    el.className = 'msg assistant streaming';
    el.innerHTML = `<div class="who">Tutor</div><div class="prose"><span class="typing"><i></i><i></i><i></i></span></div>`;
    chat.appendChild(el);
    scrollDown(true);
    const prose = el.querySelector('.prose');
    let pending = null;
    let partial = '';
    activeController = new AbortController();
    try {
      const full = await streamText({
        system: P.tutorSystem(c, mi, li, s),
        messages: l.messages,
        maxTokens: 4096,
        signal: activeController.signal,
        onText: (t) => {
          partial = t;
          if (pending) return;
          pending = requestAnimationFrame(() => {
            pending = null;
            prose.innerHTML = md(partial);
            scrollDown(false);
          });
        },
      });
      l.messages.push({ role: 'assistant', content: full });
      await saveCourse(c);
    } catch (e) {
      if (e.name === 'AbortError') {
        if (partial) {
          l.messages.push({ role: 'assistant', content: partial + '\n\n*(stopped)*' });
          await saveCourse(c);
        }
      } else {
        el.remove();
        const err = document.createElement('div');
        err.className = 'msg error';
        err.innerHTML = `<p>${h(e.message)}</p><button class="btn small">Retry</button>`;
        err.querySelector('button').onclick = () => { err.remove(); generate(); };
        chat.appendChild(err);
        busy = false; sendBtn.disabled = false; stopBtn.hidden = true;
        return;
      }
    } finally {
      cancelAnimationFrame(pending);
      activeController = null;
    }
    busy = false;
    sendBtn.disabled = false;
    stopBtn.hidden = true;
    if (document.body.contains(chat)) { renderAll(); scrollDown(false); }
  }

  async function send(text, hidden = false) {
    text = text.trim();
    if (!text || busy) return;
    l.messages.push({ role: 'user', content: text, ...(hidden ? { hidden: true } : {}) });
    if (l.status === 'not-started') l.status = 'in-progress';
    await saveCourse(c);
    renderAll();
    generate();
  }

  renderAll();
  if (l.messages.length) setTimeout(() => window.scrollTo(0, document.body.scrollHeight), 0);
  if (l.messages.length && l.messages[l.messages.length - 1].role === 'user') {
    // last attempt failed or was interrupted: offer retry
    const err = document.createElement('div');
    err.className = 'msg error';
    err.innerHTML = `<p>Your tutor hasn't replied to this yet.</p><button class="btn small">Get reply</button>`;
    err.querySelector('button').onclick = () => { err.remove(); generate(); };
    chat.appendChild(err);
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
    if (e.target.checked) {
      toast('Lesson marked complete', 'ok');
      // a one-line recap lets later lessons build on this one
      if (!l.recap && l.messages.length) {
        callTool({
          system: 'You summarise tutoring sessions precisely.',
          messages: [{ role: 'user', content: `Summarise what the student learned in this lesson in one sentence.\n\n${P.transcript(l).slice(-30000)}` }],
          tool: P.RECAP_TOOL,
          maxTokens: 400,
        })
          .then(async (r) => { l.recap = r.recap; await saveCourse(c); })
          .catch(() => {});
      }
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
      const text = await streamText({
        system: P.NOTES_SYSTEM,
        messages: [{ role: 'user', content: P.notesRequest(c, mi, li) }],
        model: s.utilityModel,
        maxTokens: 6000,
        onText: (t) => (notesEl.innerHTML = md(t)),
      });
      l.notes = text;
      await saveCourse(c);
      toast('Notes saved', 'ok');
    });
    if (l.notes) btn.textContent = 'Regenerate notes';
  };

  document.getElementById('cards-btn').onclick = (e) =>
    withBusy(e.currentTarget, 'Making flashcards…', async () => {
      const r = await callTool({
        system: 'You are an expert at writing spaced-repetition flashcards for graduate students.',
        messages: [{ role: 'user', content: P.flashcardRequest(c, mi, li) }],
        tool: P.FLASHCARD_TOOL,
      });
      const now = Date.now();
      const cards = (r.cards || []).map((x) => ({ id: uid(), courseId: cid, lessonId: lid, front: x.front, back: x.back, ease: 2.5, interval: 0, reps: 0, due: now, created: now }));
      await db.putMany('cards', cards);
      updateNavBadge();
      toast(`${cards.length} flashcards added to your review queue`, 'ok');
    });

  document.getElementById('export-btn').onclick = (e) =>
    withBusy(e.currentTarget, 'Exporting…', async () => toast(await obs.exportLesson(c, mi, li), 'ok'));
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
    title = `Quiz: ${c.modules[mi].lessons[li].title}`;
    back = `#/lesson/${cid}/${targetId}`;
  }

  view.innerHTML = `
    <a class="crumb" href="${back}">← Back</a>
    <header class="page-head"><div><p class="eyebrow">${h(c.title)}</p><h1>${h(title)}</h1></div></header>
    <div id="quiz"><div class="loading-card"><span class="spin"></span>Your examiner is writing the questions…</div></div>`;

  const box = document.getElementById('quiz');
  activeController = new AbortController();
  let quiz;
  try {
    quiz = await callTool({
      system: P.QUIZ_SYSTEM,
      messages: [{ role: 'user', content: kind === 'module' ? P.moduleExamRequest(c, mi) : P.lessonQuizRequest(c, mi, li) }],
      tool: P.QUIZ_TOOL,
      signal: activeController.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') return;
    box.innerHTML = `<div class="msg error"><p>${h(e.message)}</p><button class="btn small" onclick="location.reload()">Try again</button></div>`;
    return;
  }
  const qs = (quiz.questions || []).filter((q) => q.type === 'written' || (q.options?.length >= 2 && Number.isInteger(q.answer_index)));
  qs.forEach((q, i) => (q.id = i + 1));

  box.innerHTML = `<form id="qf" class="quiz">
    ${qs
      .map(
        (q) => `<fieldset class="q panel" data-id="${q.id}">
          <legend><span class="qn">${q.id}</span>${q.type === 'mcq' ? 'Multiple choice' : 'Written answer'}</legend>
          <div class="prose">${md(q.prompt)}</div>
          ${
            q.type === 'mcq'
              ? `<div class="opts">${q.options.map((o, k) => `<label class="opt"><input type="radio" name="q${q.id}" value="${k}"><span class="prose">${md(o)}</span></label>`).join('')}</div>`
              : `<textarea name="q${q.id}" rows="5" placeholder="Write your answer. LaTeX like $x^2$ is fine."></textarea>`
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
        if (q.type === 'mcq') scores[q.id] = { score: Number(v) === q.answer_index ? 1 : 0, chosen: v == null ? null : Number(v) };
        else written.push({ id: q.id, prompt: q.prompt, model_answer: q.model_answer, answer: (v || '').trim() });
      }
      if (written.length) {
        const needGrading = written.filter((w) => w.answer);
        written.filter((w) => !w.answer).forEach((w) => (scores[w.id] = { score: 0, feedback: 'No answer given.' }));
        if (needGrading.length) {
          const g = await callTool({
            system: P.GRADE_SYSTEM,
            messages: [{ role: 'user', content: P.gradeRequest(needGrading) }],
            tool: P.GRADE_TOOL,
          });
          for (const r of g.grades || []) scores[r.id] = { score: Math.max(0, Math.min(1, r.score)), feedback: r.feedback };
        }
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
          ${q.type === 'written' ? `<details><summary>Model answer</summary><div class="prose">${md(q.model_answer)}</div></details>` : ''}
          <div class="prose explain">${md(q.explanation)}</div>`;
      }
      const score = qs.length ? total / qs.length : 0;
      const entry = { date: today(), score };
      if (kind === 'module') (c.modules[mi].examHistory ||= []).push(entry);
      else (c.modules[mi].lessons[li].quizHistory ||= []).push(entry);
      await saveCourse(c);

      const missed = qs.filter((q) => (scores[q.id]?.score ?? 0) < 0.75);
      btn.closest('.actions').innerHTML = '';
      const sum = document.createElement('div');
      sum.className = 'panel score-card';
      sum.innerHTML = `<p class="eyebrow">Result</p><p class="big-score">${Math.round(score * 100)}%</p>
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
          await db.putMany('cards', missed.map((q) => ({
            id: uid(), courseId: cid, lessonId, front: q.prompt + (q.type === 'mcq' ? '\n\n' + q.options.map((o, k) => `${'ABCD'[k]}. ${o}`).join('\n') : ''),
            back: (q.type === 'mcq' ? `**${'ABCD'[q.answer_index]}. ${q.options[q.answer_index]}**\n\n` : `${q.model_answer}\n\n`) + q.explanation,
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
  const [cards, courses] = await Promise.all([db.getAll('cards'), db.getAll('courses')]);
  const titles = Object.fromEntries(courses.map((c) => [c.id, c.title]));
  let queue = cards.filter((c) => c.due <= Date.now() && (!courseId || c.courseId === courseId)).sort((a, b) => a.due - b.due);
  let reviewed = 0;

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
      <p class="muted small center">${queue.length} due · ${h(titles[card.courseId] || '')}</p>
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
    document.getElementById('ra').innerHTML = [
      [1, 'Again', '10 min'],
      [2, 'Hard', ''],
      [3, 'Good', ''],
      [4, 'Easy', ''],
    ]
      .map(([g, label]) => {
        const next = schedule(queue[0], g);
        const d = Math.round((next.due - Date.now()) / 86400000);
        const when = g === 1 ? '10 min' : d <= 1 ? '1 day' : `${d} days`;
        return `<button class="btn grade g${g}" data-g="${g}">${label}<small>${when}</small><kbd>${g}</kbd></button>`;
      })
      .join('');
    document.querySelectorAll('.grade').forEach((b) => (b.onclick = () => grade(+b.dataset.g)));
  }

  let grading = false;
  async function grade(g) {
    const back = document.querySelector('#fc .back');
    if (grading || !queue.length || !back || back.hidden) return;
    grading = true;
    const card = queue.shift();
    const updated = schedule(card, g);
    await db.put('cards', updated);
    reviewed++;
    if (g === 1) queue.push(updated); // see it again this session
    grading = false;
    show();
  }

  const onKey = (e) => {
    if (!location.hash.startsWith('#/review')) return document.removeEventListener('keydown', onKey);
    if (e.target.matches('input,textarea')) return;
    if (e.code === 'Space') { e.preventDefault(); reveal(); }
    if (['1', '2', '3', '4'].includes(e.key) && document.querySelector('.grade')) grade(+e.key);
  };
  document.addEventListener('keydown', onKey);
  show();
}

/* ---------- settings ---------- */

async function settingsPage() {
  const s = await getSettings();
  const vault = await obs.vaultName();
  const opt = (sel) => MODELS.map((m) => `<option value="${m.id}" ${m.id === sel ? 'selected' : ''}>${h(m.label)}</option>`).join('');

  view.innerHTML = `
    <header class="page-head"><div><p class="eyebrow">Setup</p><h1>Settings</h1></div></header>
    <form id="sf" class="settings">
      <section class="panel form">
        <h2>Claude API key</h2>
        <p class="muted">Your tutor runs on Claude through your own Anthropic API key. Create one at <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a> and add some credit. The key is stored only in this browser and is sent only to Anthropic.</p>
        <div class="keyrow"><input type="password" name="apiKey" value="${h(s.apiKey)}" placeholder="sk-ant-…" autocomplete="off" spellcheck="false"><button type="button" class="btn ghost" id="showkey">Show</button><button type="button" class="btn" id="testkey">Test</button></div>
      </section>

      <section class="panel form">
        <h2>Models</h2>
        <label>Tutor and syllabus model<select name="tutorModel">${opt(s.tutorModel)}</select></label>
        <label>Study tools model <span class="muted">(notes, quizzes, flashcards, grading)</span><select name="utilityModel">${opt(s.utilityModel)}</select></label>
        <p class="muted small">Opus gives the deepest teaching. Sonnet is strong and cheaper; good for the study tools.</p>
      </section>

      <section class="panel form">
        <h2>About you as a learner</h2>
        <p class="muted">Every course and lesson is tailored to this. Mention your education, what you know well, and how you like to be taught.</p>
        <textarea name="profile" rows="5" placeholder="e.g. Self-taught generalist. Comfortable with algebra, rusty on calculus. I learn best from concrete examples before formalism, and I like history-of-ideas context.">${h(s.profile)}</textarea>
      </section>

      <section class="panel form">
        <h2>Obsidian vault</h2>
        ${
          obs.fsSupported
            ? `<p class="muted">Connect your vault folder once and exports are written straight into it. Choose the vault's top folder (the one containing <code>00 Notes</code>).</p>
               <div class="row"><span class="pill ${vault ? 'done' : ''}">${vault ? `Connected: ${h(vault)}` : 'Not connected'}</span>
               <button type="button" class="btn" id="vault">${vault ? 'Change folder' : 'Connect vault folder'}</button>
               ${vault ? '<button type="button" class="btn ghost" id="unvault">Disconnect</button>' : ''}</div>`
            : `<p class="muted">This browser can't write to folders directly, so exports download as .md files that you can drop into your vault. Chrome or Edge on desktop can write straight into the vault.</p>`
        }
        <label>Folder inside the vault<input name="vaultPath" value="${h(s.vaultPath)}"></label>
      </section>

      <div class="actions sticky"><button class="btn primary" type="submit">Save settings</button></div>

      <section class="panel form">
        <h2>Backup</h2>
        <p class="muted">Courses, lessons and flashcards live in this browser. Export a backup now and then, or to move to another device. Your API key is not included.</p>
        <div class="row"><button type="button" class="btn" id="backup">Download backup</button>
        <label class="btn file">Restore from backup<input type="file" id="restore" accept="application/json" hidden></label></div>
      </section>
    </form>`;

  const form = document.getElementById('sf');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    await db.kvSet('settings', { ...s, apiKey: f.apiKey.trim(), tutorModel: f.tutorModel, utilityModel: f.utilityModel, profile: f.profile.trim(), vaultPath: f.vaultPath.trim().replace(/^\/+|\/+$/g, '') || '00 Notes/Courses' });
    toast('Settings saved', 'ok');
  };
  document.getElementById('showkey').onclick = (e) => {
    const k = form.apiKey;
    k.type = k.type === 'password' ? 'text' : 'password';
    e.target.textContent = k.type === 'password' ? 'Show' : 'Hide';
  };
  document.getElementById('testkey').onclick = (e) =>
    withBusy(e.currentTarget, 'Testing…', async () => {
      form.requestSubmit();
      await new Promise((r) => setTimeout(r, 150));
      const out = await completeText({ system: 'Reply with exactly: ready', messages: [{ role: 'user', content: 'Ping' }], maxTokens: 10, model: form.utilityModel.value });
      toast(out ? 'Key works. Your tutor is ready.' : 'Connected, but got an empty reply.', 'ok');
    });
  const vb = document.getElementById('vault');
  if (vb)
    vb.onclick = async () => {
      try {
        const name = await obs.connectVault();
        toast(`Connected to ${name}`, 'ok');
        settingsPage();
      } catch (e) {
        if (e.name !== 'AbortError') toast(e.message, 'err');
      }
    };
  const ub = document.getElementById('unvault');
  if (ub) ub.onclick = async () => { await obs.disconnectVault(); settingsPage(); };

  document.getElementById('backup').onclick = async () => {
    const data = { app: 'lyceum', version: 1, exported: new Date().toISOString(), courses: await db.getAll('courses'), cards: await db.getAll('cards') };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
    a.download = `lyceum-backup-${today()}.json`;
    a.click();
  };
  document.getElementById('restore').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data.app !== 'lyceum') throw new Error('That file is not a Lyceum backup.');
      if (!confirm(`Restore ${data.courses.length} courses and ${data.cards.length} flashcards? Items with the same ID will be overwritten.`)) return;
      await db.putMany('courses', data.courses);
      await db.putMany('cards', data.cards);
      toast('Backup restored', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  };
}

/* ---------- boot ---------- */

window.addEventListener('hashchange', route);
route();
if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
