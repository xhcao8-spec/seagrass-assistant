import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';

const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const spawnPnpm = (args, options = {}) => spawn(command, args, {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  ...options,
});

// Use a separate port so the original commercial development app is unaffected.
const rendererPort = Number(process.env.SEAGRASS_DEV_PORT) || 4183;
const rendererUrl = `http://127.0.0.1:${rendererPort}`;
const renderer = spawnPnpm([
  'exec', 'vite', '--host', '127.0.0.1', '--port', String(rendererPort), '--strictPort',
]);

function waitForRenderer(url, timeoutMs = 30000) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const check = () => {
      const request = http.get(url, (response) => {
        response.resume();
        if (response.statusCode && response.statusCode < 500) {
          resolve();
        } else {
          retry();
        }
      });

      request.on('error', retry);
      request.setTimeout(1200, () => {
        request.destroy();
        retry();
      });
    };

    const retry = () => {
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error(`Renderer did not start at ${url}`));
        return;
      }
      setTimeout(check, 250);
    };

    check();
  });
}

let desktop;
let shuttingDown = false;

function terminateProcessTree(child) {
  if (!child?.pid || child.killed) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }
  child.kill('SIGTERM');
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  terminateProcessTree(renderer);
  terminateProcessTree(desktop);
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
renderer.on('exit', (code) => {
  if (!shuttingDown && code && code !== 0) shutdown(code);
});

try {
  await waitForRenderer(`${rendererUrl}/`);
  desktop = spawnPnpm(['exec', 'electron', '.'], {
    env: { ...process.env, SEAGRASS_DEV_SERVER_URL: rendererUrl },
  });
  desktop.on('exit', (code) => shutdown(code ?? 0));
} catch (error) {
  console.error(error);
  shutdown(1);
}
