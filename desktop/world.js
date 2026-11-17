/**
 * The-ReaL-Exit — 3D Desktop Sandbox & AI Lab
 * Entry point bootstrap that initializes Rapier physics, Three.js, and application systems.
 */

import { bootstrap } from './js/main.js';
import { installDiagnostics } from './js/diagnostics.js';

installDiagnostics();
console.info('[boot] starting The-ReaL-Exit');
bootstrap().then(() => {
  console.info('[boot] application ready');
}).catch((error) => {
  console.error('[boot] failed to initialize The-ReaL-Exit', error);
});
