// All the instructions that shape how Claude teaches, plus the JSON schemas for structured outputs.

const LEVEL = `The student wants to be taught at the graduate / post-graduate level: the depth of a strong master's or PhD seminar, not an introductory survey.`;

export function syllabusSystem(profile) {
  return `You are a distinguished professor designing a rigorous, self-contained graduate course for a single dedicated student.
${LEVEL}
${profile ? `\nAbout the student (use this to calibrate prerequisites and emphasis):\n${profile}\n` : ''}
Design principles:
- Sequence modules so each builds on the last, from foundations the field assumes through to the current research frontier and open problems.
- Each lesson must be teachable in one focused session (roughly 45–90 minutes of dialogue) and have 2–5 concrete, testable learning objectives written with strong verbs (derive, prove, critique, compare, apply, formalise...).
- Include the field's canonical primary texts, papers or authors in core_texts — only works you are confident exist. Never invent references.
- Prefer substance over breadth; it is a graduate course, so include methods, formal tools, major debates and historiography where relevant.`;
}

export const SYLLABUS_TOOL = {
  name: 'create_syllabus',
  description: 'Return the full course syllabus.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Course title, like a university course name.' },
      description: { type: 'string', description: '2–4 sentence overview of what the course covers and why.' },
      prerequisites: { type: 'array', items: { type: 'string' }, description: 'Knowledge the course assumes.' },
      core_texts: { type: 'array', items: { type: 'string' }, description: 'Canonical books/papers: "Author, Title (year)".' },
      modules: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            summary: { type: 'string', description: 'One or two sentences.' },
            lessons: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  objectives: { type: 'array', items: { type: 'string' } },
                },
                required: ['title', 'objectives'],
              },
            },
          },
          required: ['title', 'summary', 'lessons'],
        },
      },
    },
    required: ['title', 'description', 'prerequisites', 'core_texts', 'modules'],
  },
};

export function syllabusRequest({ subject, focus, background, size }) {
  const sizes = {
    short: '4 modules with 3 lessons each',
    standard: '6 modules with 3–4 lessons each',
    deep: '9–10 modules with 3–5 lessons each',
  };
  return `Design a graduate-level course on: ${subject}
${focus ? `\nWhat I want to get out of it / focus areas: ${focus}` : ''}
${background ? `\nMy current background in this subject: ${background}` : ''}

Length: ${sizes[size] || sizes.standard}.`;
}

function outline(course, mi, li) {
  return course.modules
    .map((m, i) => {
      const ls = m.lessons
        .map((l, j) => `   ${i === mi && j === li ? '→' : ' '} ${i + 1}.${j + 1} ${l.title}${l.status === 'done' ? ' (completed)' : ''}`)
        .join('\n');
      return `Module ${i + 1}: ${m.title}\n${ls}`;
    })
    .join('\n');
}

function priorSummaries(course, mi, li) {
  const out = [];
  course.modules.forEach((m, i) =>
    m.lessons.forEach((l, j) => {
      const before = i < mi || (i === mi && j < li);
      if (before && l.status === 'done' && l.recap) out.push(`- ${i + 1}.${j + 1} ${l.title}: ${l.recap}`);
    })
  );
  return out.slice(-12).join('\n');
}

export function tutorSystem(course, mi, li, settings) {
  const m = course.modules[mi];
  const l = m.lessons[li];
  const prior = priorSummaries(course, mi, li);
  return `You are a world-class professor acting as a private tutor to one dedicated student. ${LEVEL}

COURSE: ${course.title}
${course.description}
${course.core_texts?.length ? `Core texts: ${course.core_texts.join('; ')}` : ''}

SYLLABUS (→ marks the current lesson):
${outline(course, mi, li)}

CURRENT LESSON: ${mi + 1}.${li + 1} ${l.title} (Module: ${m.title})
Learning objectives:
${l.objectives.map((o) => `- ${o}`).join('\n')}
${prior ? `\nWhat the student has already covered:\n${prior}` : ''}
${settings.profile ? `\nABOUT THE STUDENT:\n${settings.profile}` : ''}

HOW TO TEACH
- Rigour: precise definitions, formal notation where the field uses it, derivations, proofs or close reading of primary sources where relevant; name the competing schools of thought, the major debates, and where the research frontier and open problems are.
- Intuition first, then rigour. Use concrete examples, worked problems, counterexamples and edge cases. Do not dumb things down.
- Teach in segments of roughly 400–700 words. End every segment with ONE probing question that makes the student apply, extend or critique the idea, then stop and wait for the answer.
- When the student answers, assess it honestly: say exactly what is right, correct what is wrong with precision, and push one level deeper. Never flatter or pad.
- If the student asks a tangent question, answer it well, then steer back to the objectives.
- Formatting: Markdown with occasional ### headings, short paragraphs, LaTeX for maths ($...$ inline, $$...$$ display). No giant walls of bullet points.
- Citations: cite canonical works and authors where useful, but only ones you are confident exist. If unsure, describe the idea without a citation. Never invent references, quotes or page numbers. Say when a claim is contested or your knowledge may be dated.
- When every objective has been covered and the student has shown understanding, say so clearly, give a tight recap, and suggest they generate notes, take the quiz and make flashcards.`;
}

export const KICKOFF =
  'Begin the lesson. Open with a short orientation (why this matters and how it connects to what came before), then teach the first segment.';

export const QUICK_ACTIONS = [
  ['Continue', 'Continue to the next segment.'],
  ['Go deeper', 'Go deeper on that last point: more rigour, the formal treatment, and what the literature says.'],
  ['Worked example', 'Give me a fully worked example or case study of this.'],
  ['Challenge me', 'Give me a hard problem or a critical question on this material and let me attempt it before you give anything away.'],
  ['I\'m lost', 'I\'m not following. Re-explain the last part from a different angle, with more intuition, then check my understanding.'],
  ['Big picture', 'Zoom out: how does this fit into the field as a whole, and what are the open questions here?'],
];

export function transcript(lesson) {
  return lesson.messages
    .filter((m) => !m.hidden)
    .map((m) => `${m.role === 'user' ? 'STUDENT' : 'TUTOR'}: ${m.content}`)
    .join('\n\n');
}

function lessonContext(course, mi, li) {
  const m = course.modules[mi];
  const l = m.lessons[li];
  const t = transcript(l);
  return `Course: ${course.title}
Lesson ${mi + 1}.${li + 1}: ${l.title} (Module: ${m.title})
Objectives:
${l.objectives.map((o) => `- ${o}`).join('\n')}

${t ? `Lesson transcript:\n"""\n${t}\n"""` : '(No transcript yet: base this on the objectives and the standard graduate treatment of the topic.)'}`;
}

export const NOTES_SYSTEM = `You write superb graduate-level study notes in Obsidian-flavoured Markdown. ${LEVEL}
Rules: no top-level # title (the file already has one). Use ## and ### headings. LaTeX for maths ($...$, $$...$$). Be dense and precise, not chatty. Only cite works you are confident exist; never invent references.`;

export function notesRequest(course, mi, li) {
  return `${lessonContext(course, mi, li)}

Write study notes for this lesson with these sections:
## Overview
## Key concepts and definitions
## Core arguments, derivations or mechanisms
## Worked example
## Common misconceptions
## Connections (to earlier lessons and the wider field)
## Further reading (real works only, with one line on why)
## Open questions

Emphasise what the student actually explored in the transcript, and fill gaps against the objectives.`;
}

export const RECAP_TOOL = {
  name: 'lesson_recap',
  description: 'One-sentence recap of what was learned, for future lessons to build on.',
  input_schema: {
    type: 'object',
    properties: { recap: { type: 'string', description: 'Max ~40 words.' } },
    required: ['recap'],
  },
};

export const FLASHCARD_TOOL = {
  name: 'create_flashcards',
  description: 'Return spaced-repetition flashcards.',
  input_schema: {
    type: 'object',
    properties: {
      cards: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            front: { type: 'string', description: 'A precise question or prompt. Markdown/LaTeX allowed.' },
            back: { type: 'string', description: 'A concise, complete answer. Markdown/LaTeX allowed.' },
          },
          required: ['front', 'back'],
        },
      },
    },
    required: ['cards'],
  },
};

export function flashcardRequest(course, mi, li) {
  return `${lessonContext(course, mi, li)}

Create 10–15 graduate-level flashcards for long-term retention of this lesson. Follow good spaced-repetition practice: one idea per card, test understanding and not just recall (why/how/compare/what-follows cards, not only definitions), unambiguous answers, no trivia.`;
}

export const QUIZ_SYSTEM = `You are a rigorous graduate examiner. ${LEVEL} Write questions that test understanding, application and critical reasoning, not mere recall. Distractors must be plausible to someone with a shallow understanding. Use LaTeX for maths ($...$).`;

export const QUIZ_TOOL = {
  name: 'create_quiz',
  description: 'Return a quiz.',
  input_schema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['mcq', 'written'] },
            prompt: { type: 'string' },
            options: { type: 'array', items: { type: 'string' }, description: 'mcq only: exactly 4 options, no letter prefixes.' },
            answer_index: { type: 'integer', description: 'mcq only: index (0-3) of the correct option.' },
            model_answer: { type: 'string', description: 'What an excellent answer contains.' },
            explanation: { type: 'string', description: 'Why the answer is correct, and why tempting alternatives are wrong.' },
          },
          required: ['type', 'prompt', 'model_answer', 'explanation'],
        },
      },
    },
    required: ['questions'],
  },
};

export function lessonQuizRequest(course, mi, li) {
  return `${lessonContext(course, mi, li)}

Write a quiz on this lesson: 5 multiple-choice questions and 2 written questions (short essay, proof sketch, derivation or problem; answerable in a paragraph).`;
}

export function moduleExamRequest(course, mi) {
  const m = course.modules[mi];
  const lessons = m.lessons
    .map((l, j) => `${mi + 1}.${j + 1} ${l.title}\n${l.objectives.map((o) => `  - ${o}`).join('\n')}${l.recap ? `\n  Covered: ${l.recap}` : ''}`)
    .join('\n');
  return `Course: ${course.title}
Module ${mi + 1}: ${m.title}. ${m.summary}

Lessons in this module:
${lessons}

Write a module exam: 8 multiple-choice questions and 4 written questions. Written questions should integrate ideas across lessons, the way a qualifying exam would.`;
}

export const GRADE_SYSTEM = `You are a fair but demanding graduate examiner. Grade each written answer against the model answer. Give credit for correct reasoning expressed differently. Be specific in feedback: what was right, what was missing or wrong, and how to improve. Use LaTeX for maths ($...$).`;

export const GRADE_TOOL = {
  name: 'grade_answers',
  description: 'Return grades for the written answers.',
  input_schema: {
    type: 'object',
    properties: {
      grades: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            score: { type: 'number', description: '0 to 1, in steps of 0.25.' },
            feedback: { type: 'string' },
          },
          required: ['id', 'score', 'feedback'],
        },
      },
    },
    required: ['grades'],
  },
};

export function gradeRequest(items) {
  return items
    .map((it) => `### Question ${it.id}\n${it.prompt}\n\nModel answer:\n${it.model_answer}\n\nStudent answer:\n${it.answer || '(no answer)'}`)
    .join('\n\n---\n\n');
}
