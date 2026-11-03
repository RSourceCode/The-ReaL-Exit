/**
 * The-ReaL-Exit — 3D Desktop Sandbox & AI Lab
 * Entry point bootstrap that initializes Rapier physics, Three.js, and application systems.
 */

import { bootstrap } from './js/main.js';

bootstrap().catch((error) => {
  console.error('Failed to initialize The-ReaL-Exit:', error);
});
