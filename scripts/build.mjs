import { copyFile, cp, mkdir } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
for (const file of ['index.html', 'styles.css', 'favicon.svg']) {
  await copyFile(file, `dist/${file}`);
}
await cp('assets', 'dist/assets', { recursive: true });
console.log('Static landing built in dist/');
