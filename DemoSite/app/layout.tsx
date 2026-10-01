import type { ReactNode } from 'react';
import './globals.css';
import { SiteHeader } from '../components/SiteHeader';
import { SiteFooter } from '../components/SiteFooter';

export const metadata = {
  title: 'Northwind Devices — Smart home, simply',
  description: 'Smart thermostats, cameras and hubs. A demo customer site for the Anchor support widget.',
};

// The layout wraps every page, so it is where a site-wide chat widget would be added — once,
// here, rather than on each page. Deliberately left out for now.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      {/* Browser extensions (ColorZilla's `cz-shortcut-listen`, password managers, Grammarly)
          add attributes to <body> before React hydrates, which React reports as a mismatch.
          This suppresses attribute differences on this one element only — not its children. */}
      <body suppressHydrationWarning>
        <SiteHeader />
        <main>{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
