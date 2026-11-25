import '@fontsource/pixelify-sans/latin-400.css';
import '@fontsource/pixelify-sans/latin-600.css';
import '@fontsource/pixelify-sans/latin-700.css';
import '@fontsource/pixelify-sans/latin-ext-400.css';
import '@fontsource/pixelify-sans/latin-ext-600.css';
import '@fontsource/pixelify-sans/latin-ext-700.css';
import './ui/styles.css';
import { UiController } from './ui/uiController';

const appRoot = document.querySelector<HTMLDivElement>('#app');
if (appRoot !== null) {
  const controller = new UiController(appRoot);
  controller.mount();
}
