import { App } from './app';
import { t } from '../shared/i18n';

const app = new App();
(window as any).__app = app; // for diagnostics and automated tests
app.start().catch((e) => {
  console.error(e);
  document.body.textContent = t("Scriptwright could not start: {0}", e?.message ?? e);
});
