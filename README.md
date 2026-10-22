# Lyceum

A private, graduate-level tutor for any subject, powered by Claude.

Tell it what you want to master. It designs a full graduate course (modules, lessons, learning objectives and canonical texts), then teaches each lesson as a Socratic dialogue: it teaches a segment, questions you, and pushes deeper based on your answers.

## Features

- **Structured courses:** a graduate-level syllabus for any subject, tailored to your background and goals.
- **Socratic lessons:** rigorous teaching with LaTeX maths, worked examples and probing questions. Quick buttons for *Go deeper*, *Worked example*, *Challenge me*, *I'm lost* and *Big picture*.
- **Testing and recall:** lesson quizzes and module exams with multiple-choice and written answers. Claude grades the written answers and explains them.
- **Spaced repetition:** flashcards generated from each lesson, plus your missed quiz questions, scheduled with an SM-2 algorithm.
- **A moment in history:** each time you open Lyceum, a short, freshly written history lesson pops up. Save it as a flashcard or turn it into a full course. Turn it off in Settings.
- **Obsidian export:** each lesson becomes a Markdown note with objectives, study notes, flashcards (in Spaced Repetition plugin format), quiz history and the full transcript. Each course also gets an index note.

## Using it

Lyceum is built to run as a **Claude artifact**. Inside Claude it uses your own Claude plan: lessons count toward your plan's usage limits, with no API key and no per-token billing. Your courses are saved privately to your Claude account, so they follow you across devices.

1. Open your Lyceum artifact in Claude.
2. The first time your tutor speaks, choose **Allow** so the page can use Claude on your account.
3. In **Settings**, write a few lines about yourself as a learner.

The GitHub Pages copy (https://j-hos.github.io/Lyceum/) runs the same code outside Claude. There it needs an Anthropic API key and saves data in that browser only.

## Obsidian

Each lesson exports as a Markdown note with objectives, study notes, flashcards (in the Spaced Repetition plugin's `question::answer` format), quiz history and the full dialogue. A whole course exports as a `.zip`; unzip it into your vault's `00 Notes/Courses` folder.

## Tech

Plain HTML, CSS and ES modules. `npm run build` writes `index.html` (GitHub Pages) and `dist/lyceum.html` (the single-file artifact). Inside Claude it uses the artifact `sample`, `db`, `user` and `downloads` capabilities; outside it falls back to the Anthropic Messages API and IndexedDB. It uses marked, DOMPurify, KaTeX (MathML output) and JSZip from cdnjs.
