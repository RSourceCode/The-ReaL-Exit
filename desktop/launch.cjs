const { spawn } = require('node:child_process');
const path = require('node:path');

const appDirectory = path.resolve(__dirname, '..');
const childEnvironment = { ...process.env };

// Some IDE and automation shells set this flag for their own Electron host.
// Electron inherits it unless it is removed, then starts as Node instead of a desktop app.
delete childEnvironment.ELECTRON_RUN_AS_NODE;

const electronBinary = require('electron');
const child = spawn(electronBinary, [appDirectory, ...process.argv.slice(2)], {
  cwd: appDirectory,
  env: childEnvironment,
  stdio: 'inherit',
  windowsHide: false
});

child.on('error', (error) => {
  console.error('Could not start the The-ReaL-Exit desktop app:', error.message);
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`The-ReaL-Exit exited after signal ${signal}`);
    process.exitCode = 1;
  } else {
    process.exitCode = code ?? 1;
  }
});
