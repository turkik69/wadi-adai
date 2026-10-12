import { mkdir, cp, copyFile } from 'node:fs/promises';

const files = ['index.html', 'styles.css', 'app.js', 'content.js', 'study-data.js', 'sw.js', 'manifest.webmanifest'];
await mkdir('dist', { recursive: true });
await Promise.all(files.map(file => copyFile(file, `dist/${file}`)));
await Promise.all(['assets', 'icons', 'icon-options'].map(dir => cp(dir, `dist/${dir}`, { recursive: true })));
