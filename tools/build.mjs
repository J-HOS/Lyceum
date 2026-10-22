// Builds:
//   index.html         -> GitHub Pages version (loads css/ and js/ as files)
//   dist/lyceum.html   -> single-file Claude artifact version (everything inlined)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const head = read('tools/head.html');
const shell = read('tools/shell.html');
const css = read('css/styles.css');
const TITLE = '<title>Lyceum</title>';
const META = '<meta name="claude:viewport-fit-sides" content="cover">\n<meta name="description" content="A private, graduate-level tutor for any subject.">';

fs.writeFileSync(path.join(root, 'index.html'), `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
${TITLE}
${META}
${head}<link rel="stylesheet" href="css/styles.css">
<script type="module" src="js/app.js"></script>
</head>
<body>
${shell}</body>
</html>
`);

const out = await build({ entryPoints: [path.join(root, 'js/app.js')], bundle: true, format: 'iife', write: false, target: 'es2020', minify: false, legalComments: 'none' });
const js = out.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist/lyceum.html'), `${TITLE}
${META}
${head}<style>
${css}</style>
${shell}<script>
${js}</script>
`);
console.log('built index.html and dist/lyceum.html', (fs.statSync(path.join(root, 'dist/lyceum.html')).size / 1024).toFixed(0) + ' KB');
