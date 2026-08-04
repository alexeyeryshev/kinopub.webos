import './polyfills';
import './plugins';

import { render } from 'react-dom';

import App from './App';
import * as serviceWorkerRegistration from './serviceWorkerRegistration';

const app = <App />;

// In a browser environment, render instead of exporting
if (typeof window !== 'undefined') {
  render(app, document.getElementById('root'));
}

export default app;

// If you want your app to work offline and load faster, you can change
// unregister() to register() below. Note this comes with some pitfalls.
// Learn more about service workers: https://cra.link/PWA
serviceWorkerRegistration.register({
  onUpdate: () => {
    if (window.confirm?.('Достуна новая версия, желаете обновиться?')) {
      window.location.reload();
    }
  },
});

// Web Vitals used to be forwarded to an inherited Google Analytics property from here. They are not
// gone: `@sentry/tracing`'s BrowserTracing integration already records CLS, LCP, FID, FCP and TTFB
// as measurements on the pageload transaction, into a project this fork owns. See `utils/logging`.
