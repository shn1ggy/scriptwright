import { App } from './app';

const app = new App();
(window as any).__app = app; // for diagnostics and automated tests
app.start().catch((e) => {
  console.error(e);
  document.body.textContent = `Scriptwright could not start: ${e?.message ?? e}`;
});
