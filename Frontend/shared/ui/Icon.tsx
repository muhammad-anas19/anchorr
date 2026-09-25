import type { CSSProperties } from 'react';

// Every path here is taken verbatim from Anchor_Prototype.html. Kept as one map rather than
// one component per icon so a caller adds an icon by name, and so the stroke/size/colour
// conventions can never drift between them.
const PATHS = {
  overview: (
    <>
      <rect x="2" y="2" width="5" height="5" rx="1.2" />
      <rect x="9" y="2" width="5" height="5" rx="1.2" />
      <rect x="2" y="9" width="5" height="5" rx="1.2" />
      <rect x="9" y="9" width="5" height="5" rx="1.2" />
    </>
  ),
  conversations: <path d="M2 4.5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H6.5L3 13V10.5A2 2 0 0 1 2 8.5z" />,
  knowledge: (
    <>
      <path d="M3 3.5A1.5 1.5 0 0 1 4.5 2H12v12H4.5A1.5 1.5 0 0 1 3 12.5z" />
      <line x1="6" y1="5.5" x2="9.5" y2="5.5" />
      <line x1="6" y1="8" x2="9.5" y2="8" />
    </>
  ),
  playground: <path d="M8 2l1.4 3.5L13 6.9 9.4 8.3 8 12 6.6 8.3 3 6.9l3.6-1.4z" />,
  agents: (
    <>
      <circle cx="8" cy="5.5" r="2.5" />
      <path d="M3 14c0-2.6 2.2-4.2 5-4.2s5 1.6 5 4.2" />
    </>
  ),
  analytics: (
    <>
      <line x1="2.5" y1="13.5" x2="13.5" y2="13.5" />
      <rect x="3.5" y="8" width="2.4" height="4" />
      <rect x="7" y="5" width="2.4" height="7" />
      <rect x="10.5" y="2.5" width="2.4" height="9.5" />
    </>
  ),
  evaluations: (
    <>
      <path d="M5.5 2.5h5l1 3.5H4.5z" />
      <path d="M8 6v7.5" />
      <path d="M4.5 13.5h7" />
    </>
  ),
  usage: <path d="M2.5 10.5c2-5 3.5-5 5.5 0s3.5 5 5.5 0" />,
  widget: (
    <>
      <rect x="2" y="2.5" width="12" height="9" rx="1.5" />
      <line x1="5.5" y1="14" x2="10.5" y2="14" />
    </>
  ),
  billing: (
    <>
      <rect x="2" y="3.5" width="12" height="9" rx="1.5" />
      <line x1="2" y1="6.8" x2="14" y2="6.8" />
    </>
  ),
  settings: (
    <>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1" />
    </>
  ),
  onboarding: (
    <>
      <path d="M8 2.2l5.5 2.4L8 7 2.5 4.6z" />
      <path d="M4.5 6.6v3.2c0 1.4 1.6 2.4 3.5 2.4s3.5-1 3.5-2.4V6.6" />
    </>
  ),
  search: (
    <>
      <circle cx="7" cy="7" r="4.4" />
      <line x1="10.4" y1="10.4" x2="13.5" y2="13.5" />
    </>
  ),
  sidebarToggle: (
    <>
      <rect x="2" y="2.5" width="12" height="11" rx="2" />
      <line x1="6.2" y1="2.5" x2="6.2" y2="13.5" />
    </>
  ),
  moon: <path d="M13 9.4A5.4 5.4 0 0 1 6.6 3a5.5 5.5 0 1 0 6.4 6.4z" />,
  help: (
    <>
      <circle cx="8" cy="8" r="5.8" />
      <path d="M6.4 6.3a1.7 1.7 0 1 1 2.4 1.5c-.5.3-.8.6-.8 1.2" />
      <circle cx="8" cy="11.4" r=".7" fill="currentColor" stroke="none" />
    </>
  ),
  chevronUpDown: <path d="M5.5 6.5L8 4l2.5 2.5M5.5 9.5L8 12l2.5-2.5" />,
  chevronLeft: <path d="M9.5 4L5.5 8l4 4" />,
  chevronRight: <path d="M6.5 4l4 4-4 4" />,
  logout: (
    <>
      <path d="M6 2.5H3.5A1.5 1.5 0 0 0 2 4v8a1.5 1.5 0 0 0 1.5 1.5H6" />
      <path d="M10 11l3-3-3-3" />
      <line x1="13" y1="8" x2="6" y2="8" />
    </>
  ),
  send: <path d="M2.5 8l11-5-4 12-2.5-5z" />,
  trash: (
    <>
      <path d="M2.8 4.3h10.4" />
      <path d="M6.2 4.3V3.1a.8.8 0 0 1 .8-.8h2a.8.8 0 0 1 .8.8v1.2" />
      <path d="M4.2 4.3l.6 8.3a1 1 0 0 0 1 .9h4.4a1 1 0 0 0 1-.9l.6-8.3" />
      <path d="M6.8 6.9v3.8M9.2 6.9v3.8" />
    </>
  ),
  upload: (
    <>
      <path d="M8 10.5V2.8" />
      <path d="M5.2 5.6L8 2.8l2.8 2.8" />
      <path d="M2.8 10.5v1.9a1.2 1.2 0 0 0 1.2 1.2h8a1.2 1.2 0 0 0 1.2-1.2v-1.9" />
    </>
  ),
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  size = 15,
  strokeWidth = 1.5,
  style,
}: {
  name: IconName;
  size?: number;
  strokeWidth?: number;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      style={{ flex: 'none', ...style }}
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}
