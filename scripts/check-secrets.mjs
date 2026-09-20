import { execFileSync } from 'node:child_process';
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
export function forbidden(path) {
  if (path === '.env.example') return false;
  return /(^|\/)(data|research|artifacts)\//.test(path) || /(^|\/)\.env($|\.)/.test(path) || /\.log$/.test(path);
}
const rejected = files.filter(forbidden);
if (rejected.length) { console.error('Runtime data must not be tracked:', rejected.join(', ')); process.exitCode = 1; }
