// Export lessons and courses as Obsidian-ready Markdown.
// A lesson downloads as one .md note; a course downloads as a .zip you unzip into your vault
// (it contains a folder named after the course with an index note and one note per lesson).
import * as store from './store.js';
import { transcript } from './prompts.js';

const VAULT_FOLDER = '00 Notes/Courses';

export const safe = (s) =>
  String(s).replace(/[\\/:*?"<>|#^[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 90) || 'Untitled';

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const pad = (n) => String(n).padStart(2, '0');
const today = () => new Date().toISOString().slice(0, 10);
const yq = (s) => JSON.stringify(String(s));
// nest the notes' own headings under the "## Notes" section
const demote = (s) => String(s).replace(/^(#{1,5}) /gm, '#$1 ');
const oneLine = (s) => String(s).replace(/\n+/g, '<br>').replace(/::/g, ': :');

export function lessonFile(course, mi, li) {
  return `${pad(mi + 1)}.${pad(li + 1)} ${safe(course.modules[mi].lessons[li].title)}`;
}

// `body` = {messages, notes} for the lesson (may be empty).
export function lessonMarkdown(course, mi, li, body, cards) {
  const m = course.modules[mi];
  const l = m.lessons[li];
  const dir = `${VAULT_FOLDER}/${safe(course.title)}`;
  const tag = slug(course.title);
  const messages = body?.messages || [];
  const notes = body?.notes || '';
  const parts = [];
  parts.push(`---
course: ${yq(course.title)}
module: ${yq(`${mi + 1}. ${m.title}`)}
lesson: ${yq(`${mi + 1}.${li + 1} ${l.title}`)}
status: ${l.status || 'not-started'}
updated: ${today()}
tags: [lyceum, course/${tag}]
---`);
  parts.push(`# ${l.title}`);
  parts.push(`Part of [[${dir}/${safe(course.title)}|${course.title}]] · Module ${mi + 1}: ${m.title}`);
  parts.push(`## Objectives\n${l.objectives.map((o) => `- [${l.status === 'done' ? 'x' : ' '}] ${o}`).join('\n')}`);
  if (l.recap) parts.push(`> [!summary] Recap\n> ${l.recap}`);
  parts.push(`## Notes\n${notes ? demote(notes) : '_No notes generated yet. Use "Generate notes" in Lyceum._'}`);
  if (cards.length) {
    parts.push(`## Flashcards\n#flashcards/${tag}\n\n${cards.map((c) => `${oneLine(c.front)}::${oneLine(c.back)}`).join('\n')}`);
  }
  if (l.quizHistory?.length) {
    parts.push(`## Quiz history\n${l.quizHistory.map((q) => `- ${q.date}: ${Math.round(q.score * 100)}%`).join('\n')}`);
  }
  if (transcript({ messages })) {
    const quoted = messages
      .filter((x) => !x.hidden)
      .map((x) => `**${x.role === 'user' ? 'Me' : 'Tutor'}:** ${x.content}`)
      .join('\n\n')
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
    parts.push(`## Transcript\n> [!quote]- Full lesson dialogue\n${quoted}`);
  }
  return parts.join('\n\n') + '\n';
}

export function courseMarkdown(course) {
  const dir = `${VAULT_FOLDER}/${safe(course.title)}`;
  const done = course.modules.reduce((n, m) => n + m.lessons.filter((l) => l.status === 'done').length, 0);
  const total = course.modules.reduce((n, m) => n + m.lessons.length, 0);
  const parts = [];
  parts.push(`---
course: ${yq(course.title)}
subject: ${yq(course.subject)}
started: ${new Date(course.createdAt).toISOString().slice(0, 10)}
updated: ${today()}
progress: ${done}/${total}
tags: [lyceum, course, course/${slug(course.title)}]
---`);
  parts.push(`# ${course.title}`);
  parts.push(course.description);
  if (course.prerequisites?.length) parts.push(`## Prerequisites\n${course.prerequisites.map((p) => `- ${p}`).join('\n')}`);
  if (course.core_texts?.length) parts.push(`## Core texts\n${course.core_texts.map((p) => `- ${p}`).join('\n')}`);
  parts.push(
    `## Syllabus\n` +
      course.modules
        .map((m, i) => {
          const ls = m.lessons
            .map((l, j) => `- [${l.status === 'done' ? 'x' : ' '}] [[${dir}/${lessonFile(course, i, j)}|${i + 1}.${j + 1} ${l.title}]]`)
            .join('\n');
          const exams = (m.examHistory || []).map((e) => `${e.date}: ${Math.round(e.score * 100)}%`).join(', ');
          return `### Module ${i + 1}: ${m.title}\n${m.summary}\n\n${ls}${exams ? `\n\nExam results: ${exams}` : ''}`;
        })
        .join('\n\n')
  );
  return parts.join('\n\n') + '\n';
}

/* ---------- saving files ---------- */

let downloadsPromise = null;
function getDownloads() {
  if (!downloadsPromise) downloadsPromise = window.claude?.use ? window.claude.use('downloads').catch(() => null) : Promise.resolve(null);
  return downloadsPromise;
}

async function saveFile(filename, data) {
  const dl = await getDownloads();
  if (dl) {
    try {
      await dl.save({ filename, data });
      return `Saved ${filename}`;
    } catch (e) {
      if (e?.code === 'declined') return 'Download cancelled';
      throw new Error(e?.message || 'The download did not go through.');
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type: 'text/plain' }));
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  return `Downloaded ${filename}`;
}

export { saveFile };

async function cardsFor(lessonId) {
  return (await store.all('cards')).filter((c) => c.lessonId === lessonId);
}

export async function exportLesson(course, mi, li, body) {
  const l = course.modules[mi].lessons[li];
  const text = lessonMarkdown(course, mi, li, body, await cardsFor(l.id));
  return saveFile(`${lessonFile(course, mi, li)}.md`, text);
}

export async function exportCourse(course) {
  if (!window.JSZip) throw new Error('The zip tool did not load. Check your connection and reload.');
  const zip = new window.JSZip();
  const folder = zip.folder(safe(course.title));
  const cards = await store.all('cards');
  folder.file(`${safe(course.title)}.md`, courseMarkdown(course));
  for (const [i, m] of course.modules.entries()) {
    for (const [j, l] of m.lessons.entries()) {
      if (l.status === 'not-started' && !l.hasNotes) continue;
      const body = (await store.get('lessons', l.id)) || {};
      folder.file(`${lessonFile(course, i, j)}.md`, lessonMarkdown(course, i, j, body, cards.filter((c) => c.lessonId === l.id)));
    }
  }
  const blob = await zip.generateAsync({ type: 'blob' });
  return saveFile(`${safe(course.title)}.zip`, blob);
}

export const VAULT_HINT = `Unzip into your vault's "${VAULT_FOLDER}" folder.`;
