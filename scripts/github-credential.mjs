import { execFile } from 'node:child_process';

/** Publishing is explicit; the installed updater never reads these credentials. */
export async function githubCredential() {
  const supplied = process.env.DSH_FLASH_STABILIZER_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (supplied) return supplied;
  return new Promise(resolve => {
    const child = execFile('git', ['credential', 'fill'], {
      windowsHide: true, timeout: 10000, maxBuffer: 64 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' },
    }, (error, stdout) => {
      if (error) { resolve(undefined); return; }
      resolve(stdout.split(/\r?\n/).find(line => line.startsWith('password='))?.slice(9));
    });
    child.stdin?.end('protocol=https\nhost=github.com\n\n');
    child.on('error', () => resolve(undefined));
  });
}
