/**
 * Plugin list. Each entry loads one plugin module; the module's default export (or `register`) receives window.TheRealExit.
 * Add the level-generator plugin here:
 *
 *   export const PLUGINS = [() => import('./level_generator/index.js')];
 */
export const PLUGINS = [
  // () => import('./example/index.js'),   // API demo: lists levels, runs the bot on the current level
];
