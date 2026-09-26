export function RailIcon({ name }: { name: 'reader' | 'library' | 'graph' | 'discover' | 'settings' }) {
  const paths = {
    reader: (
      <>
        <path d="M5 4.5h14v15H5z" />
        <path d="M8 8h8M8 12h8M8 16h5" />
      </>
    ),
    library: (
      <>
        <path d="M3.5 5.5c3-1 5.8-.5 8.5 1.3v13c-2.7-1.8-5.5-2.3-8.5-1.3z" />
        <path d="M20.5 5.5c-3-1-5.8-.5-8.5 1.3v13c2.7-1.8 5.5-2.3 8.5-1.3z" />
      </>
    ),
    graph: (
      <>
        <circle cx="6" cy="7" r="2" />
        <circle cx="18" cy="6" r="2" />
        <circle cx="12" cy="18" r="2" />
        <path d="m8 7 8-1M7.4 8.5l3.5 7.7M16.7 7.7l-3.6 8.5" />
      </>
    ),
    discover: (
      <>
        <path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
        <path d="m19 16 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7z" />
      </>
    ),
    settings: (
      <>
        <path d="M12.2 3h-.4a1.8 1.8 0 0 0-1.8 1.8v.3a1.8 1.8 0 0 1-.9 1.55l-.35.2a1.8 1.8 0 0 1-1.8 0l-.25-.14a1.8 1.8 0 0 0-2.46.66l-.2.35a1.8 1.8 0 0 0 .66 2.46l.25.14a1.8 1.8 0 0 1 .9 1.56v.4a1.8 1.8 0 0 1-.9 1.56l-.25.14a1.8 1.8 0 0 0-.66 2.46l.2.35a1.8 1.8 0 0 0 2.46.66l.25-.14a1.8 1.8 0 0 1 1.8 0l.35.2a1.8 1.8 0 0 1 .9 1.55v.3a1.8 1.8 0 0 0 1.8 1.8h.4a1.8 1.8 0 0 0 1.8-1.8v-.3a1.8 1.8 0 0 1 .9-1.55l.35-.2a1.8 1.8 0 0 1 1.8 0l.25.14a1.8 1.8 0 0 0 2.46-.66l.2-.35a1.8 1.8 0 0 0-.66-2.46l-.25-.14a1.8 1.8 0 0 1-.9-1.56v-.4a1.8 1.8 0 0 1 .9-1.56l.25-.14a1.8 1.8 0 0 0 .66-2.46l-.2-.35a1.8 1.8 0 0 0-2.46-.66l-.25.14a1.8 1.8 0 0 1-1.8 0l-.35-.2a1.8 1.8 0 0 1-.9-1.55v-.3A1.8 1.8 0 0 0 12.2 3Z" />
        <circle cx="12" cy="12" r="2.6" />
      </>
    ),
  }[name];
  return (
    <svg
      className="rail-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths}
    </svg>
  );
}

export function BrandMascot({ busy = false, compact = false }: { busy?: boolean; compact?: boolean }) {
  return (
    <span className={`brand-mascot ${busy ? 'busy' : ''} ${compact ? 'compact' : ''}`} aria-hidden="true">
      <svg viewBox="0 0 72 54" fill="none">
        <g className="woodpecker-body">
          <ellipse cx="18" cy="35" rx="11" ry="13" fill="#f8f1e8" stroke="#272522" strokeWidth="2" />
          <path
            d="M10 34c-5 4-7 11-7 16 6-1 11-4 14-9"
            fill="#34443a"
            stroke="#272522"
            strokeWidth="2"
            strokeLinejoin="round"
          />
          <path d="M9 40c4 1 8 0 11-3" stroke="#fffefa" strokeWidth="2" strokeLinecap="round" />
        </g>
        <g className="woodpecker-head">
          <circle cx="20" cy="20" r="10" fill="#f8f1e8" stroke="#272522" strokeWidth="2" />
          <path
            d="M11 15c2-8 9-12 17-8-1 1-1 3 0 5-6-3-11-1-14 5"
            fill="#b31b1b"
            stroke="#272522"
            strokeWidth="2"
            strokeLinejoin="round"
          />
          <path d="M28 19 42 23 28 26Z" fill="#d2c7ba" stroke="#272522" strokeWidth="2" strokeLinejoin="round" />
          <circle cx="22" cy="18" r="2.3" fill="#272522" />
          <circle cx="22.7" cy="17.3" r=".7" fill="#fff" />
        </g>
        <g className="x-card">
          <path
            d="M40 7h31v40H40V28l4-4-4-4Z"
            fill="#fffdf8"
            stroke="#272522"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
          <g transform="translate(20 11) scale(.28)">
            <path
              d="M127.98 55.61 95.24 94.46c-1.29 1.37-2.08 3.78-1.36 5.5.75 1.8 2.46 2.91 4.4 2.91 1.09 0 1.99-.38 3.16-1.56l40.19-42.71c1.6-1.69 1.62-4.33.04-6.04Z"
              fill="#aa142d"
            />
            <path
              d="m127.98 55.61 31.19-38.27c1.49-1.99 2.2-3.03 1.49-4.72-.74-1.77-2.59-3.16-4.48-3.16-1.06 0-1.72.09-3.01 1.11l-38.63 41.76c-1.72 1.84-1.71 4.7.02 6.53l47.79 51.07c1.02 1.05 2.05 1.19 3.14 1.19 1.93 0 3.19-1.14 4.03-2.82.72-1.73-.08-3.44-1.4-5.23Z"
              fill="#afa497"
            />
            <path
              d="M141.67 52.56 95 2.13S93.29.04 91.48 0s-3.6 1.02-4.34 2.79c-.7 1.69-.2 2.88 1.35 5.1l40.09 48.42Z"
              fill="#aa142d"
            />
          </g>
        </g>
        <g className="peck-spark" stroke="#b31b1b" strokeWidth="1.6" strokeLinecap="round">
          <path d="m41 17-2-3M44 16v-4" />
        </g>
      </svg>
    </span>
  );
}

export function ReaderIcon({ name }: { name: 'magnify' | 'fullscreen' | 'reference' | 'print' | 'original' }) {
  const paths = {
    magnify: (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m15.5 15.5 5 5" />
        <path d="M8.1 13.2 10.5 7l2.4 6.2M9 11h3" />
      </>
    ),
    fullscreen: (
      <>
        <path d="M8.5 4H4v4.5M15.5 4H20v4.5M8.5 20H4v-4.5M15.5 20H20v-4.5" />
      </>
    ),
    reference: (
      <>
        <path d="M5 4.5h10v14H5z" />
        <path d="M9 7.5h10v12H9" />
        <path d="M8 8h4M8 11h4" />
      </>
    ),
    print: (
      <>
        <path d="M7 9V4h10v5M7 17H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2" />
        <path d="M7 14h10v7H7zM17.5 12h.01" />
      </>
    ),
    original: (
      <>
        <path d="M6 3.5h9l3 3V21H6z" />
        <path d="M15 3.5V7h3M9 11h6M9 14h6M9 17h4" />
      </>
    ),
  }[name];
  return (
    <svg
      className="reader-control-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths}
    </svg>
  );
}

export function ProcessMascot({ busy = false }: { busy?: boolean }) {
  return (
    <span className={`process-mascot ${busy ? 'busy' : ''}`} aria-hidden="true">
      <BrandMascot busy={busy} compact />
    </span>
  );
}
