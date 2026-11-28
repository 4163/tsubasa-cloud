import type { SVGProps } from 'react';

export type IconProps = SVGProps<SVGSVGElement> & {
  size?: number | string;
};

const baseProps = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true as const,
};

export function IconFolder({ size = 18, ...props }: IconProps) {
  return (
    <svg width={size} height={size} {...baseProps} {...props}>
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

export function IconFolderFilled({ size = 18, ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
    </svg>
  );
}

export function IconFolderPlus({ size = 18, ...props }: IconProps) {
  return (
    <svg width={size} height={size} {...baseProps} {...props}>
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      <line x1="12" y1="11" x2="12" y2="17" />
      <line x1="9" y1="14" x2="15" y2="14" />
    </svg>
  );
}

export function IconFile({ size = 18, ...props }: IconProps) {
  return (
    <svg width={size} height={size} {...baseProps} {...props}>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    </svg>
  );
}

export function IconTrash({ size = 18, ...props }: IconProps) {
  return (
    <svg width={size} height={size} {...baseProps} {...props}>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

export function IconUpload({ size = 18, strokeWidth = 2.5, ...props }: IconProps) {
  return (
    <svg width={size} height={size} {...baseProps} strokeWidth={strokeWidth} {...props}>
      <line x1="12" y1="19" x2="12" y2="5" />
      <polyline points="5 12 12 5 19 12" />
    </svg>
  );
}

export function IconDownload({ size = 18, ...props }: IconProps) {
  return (
    <svg width={size} height={size} {...baseProps} {...props}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

export function IconRefreshCw({ size = 18, ...props }: IconProps) {
  return (
    <svg width={size} height={size} {...baseProps} {...props}>
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  );
}

export function IconSearch({ size = 14, ...props }: IconProps) {
  return (
    <svg width={size} height={size} {...baseProps} {...props}>
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

export function IconClose({ size = 14, ...props }: IconProps) {
  return (
    <svg width={size} height={size} {...baseProps} {...props}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

export function IconMenu({ size = 18, ...props }: IconProps) {
  return (
    <svg width={size} height={size} {...baseProps} {...props}>
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}

export function IconChevronRight({ size = 18, ...props }: IconProps) {
  return (
    <svg width={size} height={size} {...baseProps} {...props}>
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

export function IconChevronDown({ size = 14, ...props }: IconProps) {
  return (
    <svg width={size} height={size} {...baseProps} {...props}>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

export function IconChevronUp({ size = 14, ...props }: IconProps) {
  return (
    <svg width={size} height={size} {...baseProps} {...props}>
      <polyline points="18 15 12 9 6 15" />
    </svg>
  );
}

export function IconMonitor({ size = 14, ...props }: IconProps) {
  return (
    <svg width={size} height={size} {...baseProps} {...props}>
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}

export function IconSun({ size = 14, ...props }: IconProps) {
  return (
    <svg width={size} height={size} {...baseProps} {...props}>
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  );
}

export function IconMoon({ size = 14, ...props }: IconProps) {
  return (
    <svg width={size} height={size} {...baseProps} {...props}>
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

export function IconCheck({ size = 14, ...props }: IconProps) {
  return (
    <svg width={size} height={size} {...baseProps} {...props}>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

export function IconMinus({ size = 14, ...props }: IconProps) {
  return (
    <svg width={size} height={size} {...baseProps} {...props}>
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

export function IconAlertTriangle({ size = 16, ...props }: IconProps) {
  return (
    <svg width={size} height={size} {...baseProps} {...props}>
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

export function IconRotateCcw({ size = 14, ...props }: IconProps) {
  return (
    <svg width={size} height={size} {...baseProps} {...props}>
      <polyline points="1 4 1 10 7 10" />
      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
    </svg>
  );
}

export function IconGitHub({ size = 14, ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
      />
    </svg>
  );
}

export function IconExternalLink({ size = 14, ...props }: IconProps) {
  return (
    <svg width={size} height={size} {...baseProps} {...props}>
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </svg>
  );
}

export function IconPlus({ size = 16, strokeWidth = 2, ...props }: IconProps) {
  return (
    <svg width={size} height={size} {...baseProps} strokeWidth={strokeWidth} {...props}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

export function IconClock({ size = 14, ...props }: IconProps) {
  return (
    <svg width={size} height={size} {...baseProps} {...props}>
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

export function IconEdit({ size = 16, ...props }: IconProps) {
  return (
    <svg width={size} height={size} {...baseProps} {...props}>
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  );
}

export function IconCopy({ size = 16, ...props }: IconProps) {
  return (
    <svg width={size} height={size} {...baseProps} {...props}>
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

export function IconClipboard({ size = 16, ...props }: IconProps) {
  return (
    <svg width={size} height={size} {...baseProps} {...props}>
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
    </svg>
  );
}

export function IconFunnel({ size = 14, ...props }: IconProps) {
  return (
    <svg width={size} height={size} {...baseProps} {...props}>
      <path d="M10 20a1 1 0 0 0 .553.895l2 1A1 1 0 0 0 14 21v-7a2 2 0 0 1 .517-1.341L21.74 4.67A1 1 0 0 0 21 3H3a1 1 0 0 0-.742 1.67l7.225 7.989A2 2 0 0 1 10 14z" />
    </svg>
  );
}

export function IconFunnelX({ size = 14, ...props }: IconProps) {
  return (
    <svg width={size} height={size} {...baseProps} {...props}>
      <path d="M12.531 3H3a1 1 0 0 0-.742 1.67l7.225 7.989A2 2 0 0 1 10 14v6a1 1 0 0 0 .553.895l2 1A1 1 0 0 0 14 21v-7a2 2 0 0 1 .517-1.341l.427-.473" />
      <path d="m16.5 3.5 5 5" />
      <path d="m21.5 3.5-5 5" />
    </svg>
  );
}

export function IconShare({ size = 16, ...props }: IconProps) {
  return (
    <svg width={size} height={size} {...baseProps} {...props}>
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
      <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
    </svg>
  );
}

export function IconLink({ size = 16, ...props }: IconProps) {
  return (
    <svg width={size} height={size} {...baseProps} {...props}>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

export function IconScissors({ size = 16, ...props }: IconProps) {
  return (
    <svg width={size} height={size} {...baseProps} {...props}>
      <circle cx="6" cy="6" r="3" />
      <path d="M8.12 8.12 12 12" />
      <path d="M20 4 8.12 15.88" />
      <circle cx="6" cy="18" r="3" />
      <path d="M14.8 14.8 20 20" />
    </svg>
  );
}

export function IconFileVideoCamera({ size = 18, ...props }: IconProps) {
  return (
    <svg width={size} height={size} {...baseProps} {...props}>
      <path d="M4 22h14a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v4" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <rect width="8" height="6" x="2" y="12" rx="1" />
      <path d="m10 13.843 3.033-1.755a.64.64 0 0 1 .967.56v4.704a.65.65 0 0 1-.967.56L10 16.157" />
    </svg>
  );
}

export function IconFilePlay({ size = 18, ...props }: IconProps) {
  return (
    <svg width={size} height={size} {...baseProps} {...props}>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="M10 11l5 3-5 3v-6Z" />
    </svg>
  );
}

export function IconFilm({ size = 18, ...props }: IconProps) {
  return (
    <svg width={size} height={size} {...baseProps} {...props}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M7 3v18" />
      <path d="M3 7.5h4" />
      <path d="M3 12h18" />
      <path d="M3 16.5h4" />
      <path d="M17 3v18" />
      <path d="M17 7.5h4" />
      <path d="M17 16.5h4" />
    </svg>
  );
}

export function IconImage({ size = 18, ...props }: IconProps) {
  return (
    <svg width={size} height={size} {...baseProps} {...props}>
      <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
    </svg>
  );
}

export function IconImagePlay({ size = 18, ...props }: IconProps) {
  return (
    <svg width={size} height={size} {...baseProps} {...props}>
      <path d="M11 16l-5-5L2 15" />
      <path d="M14 22H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v7" />
      <path d="m17 14 5 3-5 3v-6Z" />
      <circle cx="9" cy="8" r="2" />
    </svg>
  );
}

export function IconVectorSquare({ size = 18, ...props }: IconProps) {
  return (
    <svg width={size} height={size} {...baseProps} {...props}>
      <path d="M19.5 7a24 24 0 0 1 0 10" />
      <path d="M4.5 7a24 24 0 0 0 0 10" />
      <path d="M7 19.5a24 24 0 0 0 10 0" />
      <path d="M7 4.5a24 24 0 0 1 10 0" />
      <rect x="17" y="17" width="5" height="5" rx="1" />
      <rect x="17" y="2" width="5" height="5" rx="1" />
      <rect x="2" y="17" width="5" height="5" rx="1" />
      <rect x="2" y="2" width="5" height="5" rx="1" />
    </svg>
  );
}

export function IconAperture({ size = 18, ...props }: IconProps) {
  return (
    <svg width={size} height={size} {...baseProps} {...props}>
      <circle cx="12" cy="12" r="10" />
      <path d="m14.31 8 5.74 9.94" />
      <path d="M9.69 8h11.48" />
      <path d="m7.38 12 5.74-9.94" />
      <path d="M9.69 16 3.95 6.06" />
      <path d="M14.31 16H2.83" />
      <path d="m16.62 12-5.74 9.94" />
    </svg>
  );
}

export function IconFileVolume({ size = 18, ...props }: IconProps) {
  return (
    <svg width={size} height={size} {...baseProps} {...props}>
      <path d="M11 11a5 5 0 0 1 0 6" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="M4 6.765V4a2 2 0 0 1 2-2h9l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-.93-.23" />
      <path d="M7 10.51a.5.5 0 0 0-.826-.38l-1.893 1.628A1 1 0 0 1 3.63 12H2.5a.5.5 0 0 0-.5.5v3a.5.5 0 0 0 .5.5h1.129a1 1 0 0 1 .652.242l1.893 1.63a.5.5 0 0 0 .826-.38z" />
    </svg>
  );
}

export function IconFileMusic({ size = 18, ...props }: IconProps) {
  return (
    <svg width={size} height={size} {...baseProps} {...props}>
      <path d="M10.5 22H18a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v8.4" />
      <path d="M8 18v-7.7L16 9v7" />
      <circle cx="14" cy="16" r="2" />
      <circle cx="6" cy="18" r="2" />
    </svg>
  );
}

export function IconFileSignal({ size = 18, ...props }: IconProps) {
  return (
    <svg width={size} height={size} {...baseProps} {...props}>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="M8 18v-2" />
      <path d="M12 18v-4" />
      <path d="M16 18v-6" />
    </svg>
  );
}

export function IconFileText({ size = 18, ...props }: IconProps) {
  return (
    <svg width={size} height={size} {...baseProps} {...props}>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="M10 9H8" />
      <path d="M16 13H8" />
      <path d="M16 17H8" />
    </svg>
  );
}

export function IconFileSpreadsheet({ size = 18, ...props }: IconProps) {
  return (
    <svg width={size} height={size} {...baseProps} {...props}>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="M8 13h2" />
      <path d="M14 13h2" />
      <path d="M8 17h2" />
      <path d="M14 17h2" />
    </svg>
  );
}

export function IconFileCode({ size = 18, ...props }: IconProps) {
  return (
    <svg width={size} height={size} {...baseProps} {...props}>
      <path d="M10 12.5 8 15l2 2.5" />
      <path d="m14 12.5 2 2.5-2 2.5" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z" />
    </svg>
  );
}

export function IconFileBraces({ size = 18, ...props }: IconProps) {
  return (
    <svg width={size} height={size} {...baseProps} {...props}>
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z" />
      <path d="M10 12a1 1 0 0 0-1 1v1a1 1 0 0 1-1 1 1 1 0 0 1 1 1v1a1 1 0 0 0 1 1" />
      <path d="M14 18a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1 1 1 0 0 1-1-1v-1a1 1 0 0 0-1-1" />
    </svg>
  );
}

export function IconFileCog({ size = 18, ...props }: IconProps) {
  return (
    <svg width={size} height={size} {...baseProps} {...props}>
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="m3.2 12.9-.9-.4" />
      <path d="m3.2 15.1-.9.4" />
      <path d="M4.677 21.5a2 2 0 0 0 1.313.5H18a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v2.5" />
      <path d="m4.9 11.2-.4-.9" />
      <path d="m4.9 16.8-.4.9" />
      <path d="m7.5 10.3-.4.9" />
      <path d="m7.5 17.7-.4-.9" />
      <path d="m9.7 12.5-.9.4" />
      <path d="m9.7 15.5-.9-.4" />
      <circle cx="6" cy="14" r="3" />
    </svg>
  );
}

export function IconFileDatabase({ size = 18, ...props }: IconProps) {
  return (
    <svg width={size} height={size} {...baseProps} {...props}>
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="M4 6V4a2 2 0 0 1 2-2h9l5 5v13a2 2 0 0 1-2 2h-6" />
      <ellipse cx="6" cy="12" rx="4" ry="1.5" />
      <path d="M2 12v6c0 .83 1.79 1.5 4 1.5s4-.67 4-1.5v-6" />
      <path d="M2 15c0 .83 1.79 1.5 4 1.5s4-.67 4-1.5" />
    </svg>
  );
}

export function IconFileArchive({ size = 18, ...props }: IconProps) {
  return (
    <svg width={size} height={size} {...baseProps} {...props}>
      <path d="M10 12v-1" />
      <path d="M10 18v-2" />
      <path d="M10 7V6" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="M15.5 22H18a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v16a2 2 0 0 0 .274 1.01" />
      <circle cx="10" cy="20" r="2" />
    </svg>
  );
}

export function IconFolderArchive({ size = 18, ...props }: IconProps) {
  return (
    <svg width={size} height={size} {...baseProps} {...props}>
      <circle cx="15" cy="19" r="2" />
      <path d="M20.9 19.8A2 2 0 0 0 22 18V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h5.1" />
      <path d="M15 11v-1" />
      <path d="M15 17v-2" />
    </svg>
  );
}

export function IconFileTerminal({ size = 18, ...props }: IconProps) {
  return (
    <svg width={size} height={size} {...baseProps} {...props}>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="m8 16 2-2-2-2" />
      <path d="M12 18h4" />
    </svg>
  );
}

type IconComponent = (props: IconProps) => ReturnType<typeof IconFile>;

const EXTENSION_ICON_MAP: Record<string, IconComponent> = {
  // Video: Camera & Broadcast (file-video-camera)
  avi: IconFileVideoCamera,
  mov: IconFileVideoCamera,
  ts: IconFileVideoCamera,
  m2ts: IconFileVideoCamera,
  mts: IconFileVideoCamera,
  mxf: IconFileVideoCamera,
  dv: IconFileVideoCamera,
  '3gp': IconFileVideoCamera,
  '3g2': IconFileVideoCamera,
  tod: IconFileVideoCamera,
  braw: IconFileVideoCamera,
  r3d: IconFileVideoCamera,

  // Video: Digital & Web (file-play)
  mp4: IconFilePlay,
  m4v: IconFilePlay,
  webm: IconFilePlay,
  flv: IconFilePlay,
  f4v: IconFilePlay,
  wmv: IconFilePlay,
  mpg: IconFilePlay,
  swf: IconFilePlay,
  mpeg: IconFilePlay,
  ogv: IconFilePlay,
  asf: IconFilePlay,
  amv: IconFilePlay,
  m4p: IconFilePlay,

  // Video: Cinema & Media (film)
  mkv: IconFilm,
  vob: IconFilm,
  rmvb: IconFilm,
  divx: IconFilm,
  m2v: IconFilm,
  ogm: IconFilm,
  rm: IconFilm,
  ifo: IconFilm,

  // Images: Static Raster (image)
  bmp: IconImage,
  jfif: IconImage,
  jpeg: IconImage,
  jpg: IconImage,
  png: IconImage,
  webp: IconImage,
  avif: IconImage,
  tif: IconImage,
  tiff: IconImage,
  heic: IconImage,
  heif: IconImage,
  jxl: IconImage,
  tga: IconImage,
  dds: IconImage,
  qoi: IconImage,
  pcx: IconImage,

  // Images: Animated (image-play)
  gif: IconImagePlay,
  apng: IconImagePlay,
  avis: IconImagePlay,
  mng: IconImagePlay,
  flif: IconImagePlay,

  // Images: Vectors & Icons (vector-square)
  svg: IconVectorSquare,
  ico: IconVectorSquare,
  svgz: IconVectorSquare,
  ai: IconVectorSquare,
  eps: IconVectorSquare,
  wmf: IconVectorSquare,
  emf: IconVectorSquare,
  cdr: IconVectorSquare,

  // Images: Canvas, RAW & HDR (aperture)
  xcf: IconAperture,
  kra: IconAperture,
  psd: IconAperture,
  psb: IconAperture,
  clip: IconAperture,
  sai: IconAperture,
  sai2: IconAperture,
  pdn: IconAperture,
  ase: IconAperture,
  aseprite: IconAperture,
  raw: IconAperture,
  cr2: IconAperture,
  cr3: IconAperture,
  nef: IconAperture,
  arw: IconAperture,
  dng: IconAperture,
  orf: IconAperture,
  rw2: IconAperture,
  exr: IconAperture,
  hdr: IconAperture,

  // Audio: Lossy (file-volume)
  m4a: IconFileVolume,
  mp3: IconFileVolume,
  wma: IconFileVolume,
  aac: IconFileVolume,
  mp2: IconFileVolume,
  mpc: IconFileVolume,
  amr: IconFileVolume,
  '3ga': IconFileVolume,
  ac3: IconFileVolume,
  eac3: IconFileVolume,
  dts: IconFileVolume,
  m4b: IconFileVolume,
  m4r: IconFileVolume,
  aa: IconFileVolume,
  aax: IconFileVolume,
  mid: IconFileVolume,
  midi: IconFileVolume,
  kar: IconFileVolume,

  // Audio: Lossless (file-music)
  flac: IconFileMusic,
  alac: IconFileMusic,
  dsf: IconFileMusic,
  dff: IconFileMusic,
  dsd: IconFileMusic,
  mqa: IconFileMusic,

  // Audio: Lossless Alt & Wave (file-signal)
  wav: IconFileSignal,
  ape: IconFileSignal,
  ogg: IconFileSignal,
  opus: IconFileSignal,
  wv: IconFileSignal,
  wave: IconFileSignal,
  aif: IconFileSignal,
  aiff: IconFileSignal,
  aifc: IconFileSignal,
  pcm: IconFileSignal,
  tak: IconFileSignal,
  tta: IconFileSignal,
  shn: IconFileSignal,
  ofr: IconFileSignal,
  caf: IconFileSignal,
  w64: IconFileSignal,
  au: IconFileSignal,
  oga: IconFileSignal,
  mogg: IconFileSignal,
  mka: IconFileSignal,
  mod: IconFileSignal,
  xm: IconFileSignal,
  it: IconFileSignal,
  s3m: IconFileSignal,

  // Text & Documents (file-text)
  log: IconFileText,
  nfo: IconFileText,
  txt: IconFileText,
  pdf: IconFileText,
  docx: IconFileText,
  md: IconFileText,
  markdown: IconFileText,
  rst: IconFileText,
  tex: IconFileText,
  srt: IconFileText,
  vtt: IconFileText,
  lrc: IconFileText,
  sub: IconFileText,
  doc: IconFileText,
  odt: IconFileText,
  rtf: IconFileText,
  pages: IconFileText,
  epub: IconFileText,
  mobi: IconFileText,
  azw3: IconFileText,
  djvu: IconFileText,
  ppt: IconFileText,
  pptx: IconFileText,
  odp: IconFileText,
  key: IconFileText,

  // Spreadsheets & Tabular (file-spreadsheet)
  xlsx: IconFileSpreadsheet,
  csv: IconFileSpreadsheet,
  xls: IconFileSpreadsheet,
  xlsm: IconFileSpreadsheet,
  xlsb: IconFileSpreadsheet,
  xltx: IconFileSpreadsheet,
  ods: IconFileSpreadsheet,
  numbers: IconFileSpreadsheet,
  tsv: IconFileSpreadsheet,
  tab: IconFileSpreadsheet,
  parquet: IconFileSpreadsheet,

  // Web & Source Code (file-code)
  html: IconFileCode,
  mhtml: IconFileCode,
  css: IconFileCode,
  py: IconFileCode,
  js: IconFileCode,
  htm: IconFileCode,
  xhtml: IconFileCode,
  scss: IconFileCode,
  sass: IconFileCode,
  less: IconFileCode,
  tsx: IconFileCode,
  jsx: IconFileCode,
  mjs: IconFileCode,
  cjs: IconFileCode,
  vue: IconFileCode,
  svelte: IconFileCode,
  php: IconFileCode,
  rb: IconFileCode,
  go: IconFileCode,
  rs: IconFileCode,
  c: IconFileCode,
  cpp: IconFileCode,
  h: IconFileCode,
  hpp: IconFileCode,
  cs: IconFileCode,
  java: IconFileCode,
  kt: IconFileCode,
  swift: IconFileCode,
  lua: IconFileCode,
  xml: IconFileCode,
  wasm: IconFileCode,

  // Structured Data (file-braces)
  json: IconFileBraces,
  jsonc: IconFileBraces,
  json5: IconFileBraces,
  jsonl: IconFileBraces,
  ndjson: IconFileBraces,
  geojson: IconFileBraces,
  graphql: IconFileBraces,
  gql: IconFileBraces,
  proto: IconFileBraces,

  // Config (file-cog)
  ini: IconFileCog,
  cfg: IconFileCog,
  conf: IconFileCog,
  config: IconFileCog,
  toml: IconFileCog,
  yaml: IconFileCog,
  yml: IconFileCog,
  properties: IconFileCog,
  env: IconFileCog,
  editorconfig: IconFileCog,
  gitignore: IconFileCog,
  gitattributes: IconFileCog,
  npmrc: IconFileCog,
  yarnrc: IconFileCog,
  prettierrc: IconFileCog,
  eslintrc: IconFileCog,
  plist: IconFileCog,
  reg: IconFileCog,
  service: IconFileCog,

  // Database (file-database)
  db: IconFileDatabase,
  sqlite: IconFileDatabase,
  sqlite3: IconFileDatabase,
  db3: IconFileDatabase,
  s3db: IconFileDatabase,
  mdb: IconFileDatabase,
  accdb: IconFileDatabase,
  dbf: IconFileDatabase,
  mdf: IconFileDatabase,
  ldf: IconFileDatabase,
  ndf: IconFileDatabase,
  rdb: IconFileDatabase,
  duckdb: IconFileDatabase,
  realm: IconFileDatabase,
  kdbx: IconFileDatabase,
  sql: IconFileDatabase,
  dump: IconFileDatabase,
  bak: IconFileDatabase,

  // Archives: General & Comic (file-archive)
  '7z': IconFileArchive,
  zip: IconFileArchive,
  rar: IconFileArchive,
  cbz: IconFileArchive,
  cbr: IconFileArchive,
  cb7: IconFileArchive,
  gz: IconFileArchive,
  bz2: IconFileArchive,
  xz: IconFileArchive,
  zst: IconFileArchive,
  lz4: IconFileArchive,
  cab: IconFileArchive,
  arj: IconFileArchive,
  lzh: IconFileArchive,
  cba: IconFileArchive,
  jar: IconFileArchive,
  apk: IconFileArchive,
  vpk: IconFileArchive,
  pak: IconFileArchive,

  // Archives: Tarballs & CBT (folder-archive)
  tar: IconFolderArchive,
  cbt: IconFolderArchive,
  tgz: IconFolderArchive,
  tbz: IconFolderArchive,
  tbz2: IconFolderArchive,
  txz: IconFolderArchive,
  tzst: IconFolderArchive,
  tlz: IconFolderArchive,

  // Applications & Scripts (file-terminal)
  bat: IconFileTerminal,
  exe: IconFileTerminal,
  cmd: IconFileTerminal,
  ps1: IconFileTerminal,
  sh: IconFileTerminal,
  bash: IconFileTerminal,
  zsh: IconFileTerminal,
  vbs: IconFileTerminal,
  msi: IconFileTerminal,
  msix: IconFileTerminal,
  appx: IconFileTerminal,
  dmg: IconFileTerminal,
  pkg: IconFileTerminal,
  deb: IconFileTerminal,
  rpm: IconFileTerminal,
  appimage: IconFileTerminal,
  com: IconFileTerminal,
  dll: IconFileTerminal,
  sys: IconFileTerminal,
  so: IconFileTerminal,
  dylib: IconFileTerminal,

  // Explicit Default / Misc exclusions (file)
  accurip: IconFile,
  ass: IconFile,
  bin: IconFile,
  cue: IconFile,
  m3u: IconFile,
  iso: IconFile,
  mds: IconFile,
  xspf: IconFile,
  ani: IconFile,
  cur: IconFile,
  eot: IconFile,
  inf: IconFile,
  moc: IconFile,
  sample: IconFile,
  scr: IconFile,
  skel: IconFile,
  ttf: IconFile,
  woff: IconFile,
  woff2: IconFile,
};

export type FileTypeIconProps = IconProps & {
  name: string;
};

export function resolveFileIcon(nameOrPath: string): IconComponent {
  if (!nameOrPath) return IconFile;
  const slashIdx = Math.max(nameOrPath.lastIndexOf('/'), nameOrPath.lastIndexOf('\\'));
  const baseStart = slashIdx + 1;
  const dotIdx = nameOrPath.lastIndexOf('.');
  if (dotIdx < baseStart || dotIdx >= nameOrPath.length - 1) {
    return IconFile;
  }
  const ext = nameOrPath.slice(dotIdx + 1).toLowerCase();
  return Object.hasOwn(EXTENSION_ICON_MAP, ext) ? EXTENSION_ICON_MAP[ext] : IconFile;
}

export function FileTypeIcon({ name, ...props }: FileTypeIconProps) {
  const ResolvedIcon = resolveFileIcon(name);
  return <ResolvedIcon {...props} />;
}





