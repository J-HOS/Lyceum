// Export lessons and courses as Markdown into an Obsidian vault.
// Uses the File System Access API (Chrome/Edge desktop) to write straight into the vault folder;
// falls back to downloading .md files elsewhere.
import * as db from './db.js';
import { getSettings } from './api.js';
import { transcript } from './prompts.js';

export const fsSupported = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

export async function connectVault() {
  const handle = await window.showDirectoryPicker({ id: 'lyceum-vault', mode: 'readwrite' });
  await db.kvSet('vault', handle);
  return handle.name;
}

export async function disconnectVault() {
  await db.kvDel('vault');
}

export async function vaultName() {
  const hd = await db.kvGet('vault');
  return hd ? hd.name : null;
}

async function vaultHandle() {
  if (!fsSupported) return null;
  const hd = await db.kvGet('vault');
  if (!hd) return null;
  const opts = { mode: 'readwrite' };
  try {
    if ((await hd.queryPermission(opts)) === 'granted') return hd;
    if ((await hd.requestPermission(opts)) === 'granted') return hd;
  } catch {}
  return null;
}

async function getDir(root, path) {
  let d = root;
  for (const part of path.split('/').map((p) => p.trim()).filter(Boolean)) {
    d = await d.getDirectoryHandle(part, { create: true });
  }
  return d;
}

async function writeFile(dir, name, text) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(text);
  await w.close();
}

export const safe = (s) =>
  String(s).replace(/[\\/:*?"<>|#^[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 90) || 'Untitled';

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const pad = (n) => String(n).padStart(2, '0');
const today = () => new Date().toISOString().slice(0, 10);
const yq = (s) => JSON.stringify(String(s));

export function lessonFile(course, mi, li) {
  return `${pad(mi + 1)}.${pad(li + 1)} ${safe(course.modules[mi].lessons[li].title)}`;
}

// nest the notes' own headings under the "## Notes" section
const demote = (s) => String(s).replace(/^(#{1,5}) /gm, '#$1 ');

function oneLine(s) {
  return String(s).replace(/\n+/g, '<br>').replace(/::/g, ': :');
}

export function lessonMarkdown(course, mi, li, cards, folder) {
  const m = course.modules[mi];
  const l = m.lessons[li];
  const tag = slug(course.title);
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
  parts.push(`Part of [[${folder}/${safe(course.title)}/${safe(course.title)}|${course.title}]] · Module ${mi + 1}: ${m.title}`);
  parts.push(`## Objectives\n${l.objectives.map((o) => `- [${l.status === 'done' ? 'x' : ' '}] ${o}`).join('\n')}`);
  if (l.recap) parts.push(`> [!summary] Recap\n> ${l.recap}`);
  parts.push(`## Notes\n${l.notes ? demote(l.notes) : '_No notes generated yet. Use "Generate notes" in Lyceum._'}`);
  if (cards.length) {
    parts.push(`## Flashcards\n#flashcards/${tag}\n\n${cards.map((c) => `${oneLine(c.front)}::${oneLine(c.back)}`).join('\n')}`);
  }
  if (l.quizHistory?.length) {
    parts.push(`## Quiz history\n${l.quizHistory.map((q) => `- ${q.date}: ${Math.round(q.score * 100)}%`).join('\n')}`);
  }
  const t = transcript(l);
  if (t) {
    const quoted = l.messages
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

export function courseMarkdown(course, folder) {
  const dir = `${folder}/${safe(course.title)}`;
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

function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}

// files: [{ name, text }] (name without .md). Returns a human description of where they went.
async function writeFiles(course, files) {
  const s = await getSettings();
  const root = await vaultHandle();
  const sub = `${s.vaultPath}/${safe(course.title)}`.replace(/^\/+/, '');
  if (root) {
    const dir = await getDir(root, sub);
    for (const f of files) await writeFile(dir, `${f.name}.md`, f.text);
    return `Saved to ${root.name}/${sub}`;
  }
  for (const [i, f] of files.entries()) setTimeout(() => download(`${f.name}.md`, f.text), i * 250);
  return files.length > 1 ? `Downloaded ${files.length} Markdown files` : `Downloaded ${files[0].name}.md`;
}

async function cardsFor(lessonId) {
  return (await db.getAll('cards')).filter((c) => c.lessonId === lessonId);
}

export async function exportLesson(course, mi, li) {
  const s = await getSettings();
  const l = course.modules[mi].lessons[li];
  const files = [{ name: lessonFile(course, mi, li), text: lessonMarkdown(course, mi, li, await cardsFor(l.id), s.vaultPath) }];
  // keep the course index note in sync when writing into the vault
  if (await vaultHandle()) files.push({ name: safe(course.title), text: courseMarkdown(course, s.vaultPath) });
  return writeFiles(course, files);
}

export async function exportCourse(course) {
  const s = await getSettings();
  const all = await db.getAll('cards');
  const files = [{ name: safe(course.title), text: courseMarkdown(course, s.vaultPath) }];
  course.modules.forEach((m, i) =>
    m.lessons.forEach((l, j) => {
      if (l.status === 'not-started' && !l.notes) return;
      files.push({ name: lessonFile(course, i, j), text: lessonMarkdown(course, i, j, all.filter((c) => c.lessonId === l.id), s.vaultPath) });
    })
  );
  return writeFiles(course, files);
}
