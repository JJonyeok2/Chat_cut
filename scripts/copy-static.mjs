// tsc는 html/css를 복사하지 않으므로 빌드 결과물 폴더로 옮긴다.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist', 'renderer', 'renderer');
mkdirSync(out, { recursive: true });
for (const f of ['index.html', 'styles.css']) copyFileSync(join(root, 'src', 'renderer', f), join(out, f));
