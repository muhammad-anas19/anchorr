import type { ReactNode } from 'react';
import { Instrument_Sans, IBM_Plex_Mono } from 'next/font/google';
import './globals.css';
import { ThemeProvider } from '../shared/theme/ThemeProvider';
import { ToastHost } from '../shared/ui/ToastHost';

// The prototype's two real typefaces, loaded through next/font (built into Next.js — no new
// dependency). Exposed as CSS variables so globals.css and every component reference them by
// token rather than by name.
const sans = Instrument_Sans({ subsets: ['latin'], variable: '--font-sans', display: 'swap' });
const mono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-mono', display: 'swap' });

export const metadata = {
  title: 'Anchor Console',
  description: 'Agent console for escalated customer conversations.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <body>
        <ThemeProvider>
          {children}
          <ToastHost />
        </ThemeProvider>
      </body>
    </html>
  );
}
