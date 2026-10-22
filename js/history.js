// "A moment in history": a short history lesson that greets you each time Lyceum opens.
// To make it appear instantly, Lyceum keeps the next moment ready: after showing one, it
// prepares the following one in the background and saves it with your data.
import * as store from './store.js';
import * as ai from './ai.js';
import { md, h } from './render.js';

const REGIONS = [
  'Ancient Mesopotamia', 'Pharaonic Egypt', 'Classical Greece', 'the Roman Republic', 'the Roman Empire', 'Han China', 'Tang or Song China',
  'Mauryan or Gupta India', 'the Mughal Empire', 'the Persian empires', 'the Byzantine Empire', 'the early Islamic caliphates', 'medieval Europe',
  'the Mongol Empire', 'West African empires (Ghana, Mali, Songhai)', 'the Swahili coast', 'Mesoamerica (Maya, Aztec)', 'the Inca world',
  'Edo Japan', 'Joseon Korea', 'the Ottoman Empire', 'Renaissance Italy', 'the Reformation', 'the Age of Exploration', 'the Scientific Revolution',
  'the Enlightenment', 'the Atlantic revolutions', 'the Industrial Revolution', 'the American West', 'the US Civil War era', 'Imperial Russia',
  'Qing China', 'the scramble for Africa', 'the First World War', 'the interwar years', 'the Second World War', 'decolonisation',
  'the Cold War', 'the space race', 'the history of medicine', 'the history of mathematics', 'the history of technology', 'economic history',
  'maritime history', 'the history of ideas', 'Polynesian voyaging', 'ancient Australia and Aboriginal history', 'Scandinavia and the Vikings',
];
const ANGLES = [
  'a surprising, little-known fact', 'a turning point most people misunderstand', 'an overlooked person who changed events',
  'how ordinary people lived', 'a decision whose consequences lasted centuries', 'a historical myth and what actually happened',
  'an invention or idea and where it really came from', 'a battle, treaty or crisis explained simply',
];

const SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'A short, specific headline (max ~10 words).' },
    place_and_date: { type: 'string', description: 'Where and when, e.g. "Rome, 49 BC" or "Mali, c. 1324".' },
    hook: { type: 'string', description: 'One or two sentences: the striking fact itself.' },
    lesson: { type: 'string', description: 'A quick lesson of 120–180 words in Markdown: context, what happened, and why. Short paragraphs.' },
    why_it_matters: { type: 'string', description: 'One sentence on why it still matters.' },
    flashcard_question: { type: 'string', description: 'A question that tests the key point.' },
    flashcard_answer: { type: 'string', description: 'A concise answer.' },
    course_subject: { type: 'string', description: 'A subject for a full course that would go deeper, e.g. "The Fall of the Roman Republic".' },
    further_reading: { type: 'string', description: 'One well-known, real book or scholar on this topic ("Author, Title"), or an empty string if unsure.' },
  },
  required: ['title', 'place_and_date', 'hook', 'lesson', 'why_it_matters', 'flashcard_question', 'flashcard_answer', 'course_subject', 'further_reading'],
};

const pick = (a) => a[Math.floor(Math.random() * a.length)];

async function loadState() {
  return (await store.kvGet('history').catch(() => null)) || { recent: [], next: null, seen: 0 };
}
async function saveState(st) {
  await store.kvSet('history', st).catch(() => {});
}

async function generate(recent, signal) {
  const s = await ai.getSettings();
  const region = pick(REGIONS);
  const angle = pick(ANGLES);
  const prompt = `Write one "moment in history" for a curious adult learner who studies at graduate level.
Topic area: ${region}. Angle: ${angle}.
Pick a specific, well-documented event, person, practice or idea. Accuracy matters more than drama: use only facts that are well established in mainstream scholarship, give dates as historians do (use "c." when uncertain), and say so where historians disagree. No invented quotations, statistics or anecdotes.
${s.profile ? `About the learner: ${s.profile.slice(0, 600)}\n` : ''}Do not repeat any of these recent topics: ${recent.slice(-30).join('; ') || 'none yet'}.`;
  const out = await ai.json({ instructions: 'You are a historian who writes vivid, rigorously accurate short lessons.', prompt, schema: SCHEMA, tier: 'default', signal, maxTokens: 2000 });
  if (!out?.title || !out?.lesson) throw new Error('The history lesson came back incomplete. Try another.');
  return out;
}

function card(m) {
  return `
    <p class="eyebrow">A moment in history · ${h(m.place_and_date)}</p>
    <h2 id="hm-title">${h(m.title)}</h2>
    <p class="hm-hook">${h(m.hook)}</p>
    <div class="prose hm-lesson">${md(m.lesson)}</div>
    <p class="hm-why"><strong>Why it matters.</strong> ${h(m.why_it_matters)}</p>
    ${m.further_reading ? `<p class="muted small">Further reading: <em>${h(m.further_reading)}</em></p>` : ''}`;
}

// Shows the pop-up. `go` navigates within the app; `onCardAdded` refreshes the review badge.
export async function showHistoryMoment({ go, onCardAdded, toast }) {
  const s = await ai.getSettings();
  if (s.historyPopup === false) return;
  const st = await loadState();

  const wrap = document.createElement('div');
  wrap.className = 'modal hm';
  wrap.innerHTML = `<div class="modal-card hm-card" role="dialog" aria-modal="true" aria-labelledby="hm-title">
      <button class="hm-x btn ghost small" aria-label="Close">✕</button>
      <div id="hm-body"><p class="eyebrow">A moment in history</p><div class="loading-card"><span class="spin"></span>Finding something worth knowing…</div></div>
      <div class="actions hm-actions" hidden>
        <button class="btn primary" id="hm-close">Start studying</button>
        <button class="btn" id="hm-card">Add to flashcards</button>
        <button class="btn" id="hm-course">Make it a course</button>
        <button class="btn ghost" id="hm-another">Another one</button>
      </div>
      <label class="check small hm-pref"><input type="checkbox" id="hm-off"> Don't show this when I open Lyceum</label>
    </div>`;
  document.body.appendChild(wrap);
  const body = wrap.querySelector('#hm-body');
  const actions = wrap.querySelector('.hm-actions');
  let current = null;
  let controller = null;

  const close = () => { controller?.abort(); wrap.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => e.key === 'Escape' && close();
  document.addEventListener('keydown', onKey);
  wrap.querySelector('.hm-x').onclick = close;
  wrap.querySelector('#hm-close').onclick = close;
  wrap.onclick = (e) => e.target === wrap && close();

  wrap.querySelector('#hm-off').onchange = async (e) => {
    const cur = await ai.getSettings();
    await ai.saveSettings({ ...cur, historyPopup: !e.target.checked }).catch(() => {});
    toast(e.target.checked ? 'History pop-up turned off. Turn it back on in Settings.' : 'History pop-up turned on');
  };

  function show(m) {
    current = m;
    body.innerHTML = card(m);
    actions.hidden = false;
    const btn = wrap.querySelector('#hm-card');
    btn.disabled = false;
    btn.textContent = 'Add to flashcards';
  }

  function fail(msg) {
    body.innerHTML = `<p class="eyebrow">A moment in history</p><p class="muted">${h(msg)}</p>`;
    actions.hidden = false;
  }

  async function fresh() {
    controller?.abort();
    controller = new AbortController();
    actions.hidden = true;
    body.innerHTML = `<p class="eyebrow">A moment in history</p><div class="loading-card"><span class="spin"></span>Finding something worth knowing…</div>`;
    try {
      const m = await generate(st.recent, controller.signal);
      if (!wrap.isConnected) return;
      show(m);
      remember(m);
    } catch (e) {
      if (e.name !== 'AbortError' && wrap.isConnected) fail(e.message);
    }
  }

  function remember(m) {
    st.recent = [...st.recent, m.title].slice(-40);
    st.seen = (st.seen || 0) + 1;
    saveState(st);
  }

  // Prepare the next moment so the next visit opens instantly. One background call per visit.
  async function prepareNext() {
    try {
      st.next = await generate(st.recent);
      await saveState(st);
    } catch {}
  }

  wrap.querySelector('#hm-another').onclick = () => fresh();
  wrap.querySelector('#hm-course').onclick = () => { if (current) { close(); go(`new/${encodeURIComponent(current.course_subject)}`); } };
  wrap.querySelector('#hm-card').onclick = async (e) => {
    if (!current) return;
    const now = Date.now();
    try {
      await store.put('cards', {
        id: Math.random().toString(36).slice(2, 9) + now.toString(36).slice(-5),
        courseId: 'history-moments', lessonId: null,
        front: current.flashcard_question,
        back: `${current.flashcard_answer}\n\n*${current.title} · ${current.place_and_date}*`,
        ease: 2.5, interval: 0, reps: 0, due: now, created: now,
      });
      e.target.disabled = true;
      e.target.textContent = 'Added';
      onCardAdded?.();
    } catch (err) {
      toast(err.message, 'err');
    }
  };

  if (st.next) {
    const m = st.next;
    st.next = null;
    show(m);
    remember(m);
    prepareNext();
  } else {
    await fresh();
    if (wrap.isConnected) prepareNext();
  }
}
