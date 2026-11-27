/** Minimal plugin showing the API: a page with a button that runs the bot on the level being played. */
export default function register(api) {
  api.plugins.register({
    id: 'api-demo', title: 'API Demo', icon: '⚙', description: 'Runs the headless bot on the current level.',
    mount(box) {
      box.innerHTML = '<button class="tool primary" id="demoRun">Bot-test current level</button><pre id="demoOut"></pre>';
      box.querySelector('#demoRun').addEventListener('click', async () => {
        const out = box.querySelector('#demoOut');
        try {
          const level = api.levels.current();
          const { metrics } = await api.bot.simulate(level, { policy: 'random', runs: 10, maxAttempts: 3 });
          const features = await api.levels.features(level);
          out.textContent = JSON.stringify({ clear_rate: metrics.clear_rate, mean_attempts: metrics.mean_attempts, obstacles: features.obstacles_total }, null, 2);
        } catch (e) { out.textContent = e.message; }
      });
    },
  });
  api.game.on('levelComplete', (r) => api.ui.toast(`Cleared ${r.levelName} in ${r.timeSeconds}s`));
}
