import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
for (const dir of ['src', 'public', 'test', 'scripts']) {
  for (const file of readdirSync(dir, { recursive: true }).filter(x => /\.(m?js)$/.test(x))) {
    const result = spawnSync(process.execPath, ['--check', `${dir}/${file}`], { stdio: 'inherit' });
    if (result.status) process.exit(result.status);
  }
}
