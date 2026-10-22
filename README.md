# Lyceum

A private, graduate-level tutor for any subject, powered by Claude.

Tell it what you want to master. It designs a full graduate course (modules, lessons, learning objectives and canonical texts), then teaches each lesson as a Socratic dialogue: it teaches a segment, questions you, and pushes deeper based on your answers.

## Features

- **Structured courses:** a graduate-level syllabus for any subject, tailored to your background and goals.
- **Socratic lessons:** rigorous teaching with LaTeX maths, worked examples and probing questions. Quick buttons for *Go deeper*, *Worked example*, *Challenge me*, *I'm lost* and *Big picture*.
- **Testing and recall:** lesson quizzes and module exams with multiple-choice and written answers. Claude grades the written answers and explains them.
- **Spaced repetition:** flashcards generated from each lesson, plus your missed quiz questions, scheduled with an SM-2 algorithm.
- **Obsidian export:** each lesson becomes a Markdown note with objectives, study notes, flashcards (in Spaced Repetition plugin format), quiz history and the full transcript. Each course also gets an index note.

## Setup

1. Open the app: **https://j-hos.github.io/lyceum/**
2. Get an API key at [console.anthropic.com](https://console.anthropic.com/settings/keys) and add some credit.
3. In **Settings**, paste the key, write a few lines about yourself as a learner, and connect your Obsidian vault folder. Connecting the vault needs Chrome or Edge on desktop; other browsers download `.md` files instead.

## Privacy

There is no server. Your courses, lessons and flashcards are stored in your browser (IndexedDB), and your API key is sent only to Anthropic. Nothing personal is ever written to this repository. Use **Settings → Backup** to move your data between devices.

## Costs

You pay Anthropic per use. Opus 5.5 gives the deepest teaching and Sonnet 5.5 is cheaper. You can choose a model separately for the tutor and for the study tools (notes, quizzes, flashcards, grading).

## Tech

Plain HTML, CSS and ES modules, with no build step. The app calls the Anthropic Messages API directly from the browser. It uses marked, DOMPurify and KaTeX from jsDelivr, and is hosted on GitHub Pages.
