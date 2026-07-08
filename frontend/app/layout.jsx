import Script from 'next/script';
import './globals.css';
import Providers from '../components/Providers.jsx';
import { ThemeProvider } from '../components/ThemeProvider.jsx';
import { THEME_STORAGE_KEY } from '../lib/theme.js';

export const metadata = {
  title: 'EBTMS — EV Bus Tyre Management System',
  description: 'Fleet tyre lifecycle management for an EV bus operator',
};

// Applies the persisted theme (or Light, if none was ever chosen) to <html>
// before the page hydrates, so there's no light-to-dark flash. This is the
// only place besides ThemeProvider's own fallback that decides the initial
// theme, and neither one ever reads prefers-color-scheme -- first visit is
// always Light.
const THEME_INIT_SCRIPT = `(function () {
  try {
    var stored = localStorage.getItem('${THEME_STORAGE_KEY}');
    document.documentElement.setAttribute('data-theme', stored === 'dark' ? 'dark' : 'light');
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'light');
  }
})();`;

export default function RootLayout({ children }) {
  return (
    // suppressHydrationWarning is scoped to this element only, and only
    // covers attribute mismatches (never children) -- it's the documented
    // way to tell React "an inline script legitimately sets this attribute
    // before hydration" instead of silencing hydration issues generally.
    <html lang="en" suppressHydrationWarning>
      <body>
        <Script id="theme-init" strategy="beforeInteractive">
          {THEME_INIT_SCRIPT}
        </Script>
        <ThemeProvider>
          <Providers>{children}</Providers>
        </ThemeProvider>
      </body>
    </html>
  );
}
