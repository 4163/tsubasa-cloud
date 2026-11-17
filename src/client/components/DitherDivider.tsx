import * as stylex from '@stylexjs/stylex';
import { layout } from '../tokens.stylex.js';

interface DitherDividerProps {
  orientation?: 'vertical' | 'horizontal';
  isDark?: boolean;
}

const styles = stylex.create({
  vertical: {
    width: layout.ditherStripHeight,
    height: '100%',
    flexShrink: 0,
    position: 'relative',
    userSelect: 'none',
    pointerEvents: 'none',
    backgroundRepeat: 'repeat',
    backgroundSize: '6px 4px',
    '@media (max-width: 768px)': {
      display: 'none',
    },
  },
  horizontal: {
    height: layout.ditherStripHeight,
    width: '100%',
    flexShrink: 0,
    position: 'relative',
    userSelect: 'none',
    pointerEvents: 'none',
    backgroundRepeat: 'repeat',
    backgroundSize: '4px 6px',
    '@media (max-width: 768px)': {
      display: 'none',
    },
  },
  verticalLight: {
    backgroundImage:
      'url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%276%27 height=%274%27 shape-rendering=%27crispEdges%27%3E%3Crect width=%276%27 height=%274%27 fill=%27%23f7faf5%27/%3E%3Cpath d=%27M0 0h2v4H0zM2 0h1v1H2zM2 2h1v1H2zM3 1h1v1H3zM5 1h1v1H5zM3 3h1v1H3zM5 3h1v1H5z%27 fill=%27%23dce6de%27/%3E%3C/svg%3E")',
  },
  verticalDark: {
    backgroundImage:
      'url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%276%27 height=%274%27 shape-rendering=%27crispEdges%27%3E%3Crect width=%276%27 height=%274%27 fill=%27%2312211d%27/%3E%3Cpath d=%27M0 0h2v4H0zM2 0h1v1H2zM2 2h1v1H2zM3 1h1v1H3zM5 1h1v1H5zM3 3h1v1H3zM5 3h1v1H5z%27 fill=%27%231e332c%27/%3E%3C/svg%3E")',
  },
  horizontalLight: {
    backgroundImage:
      'url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%274%27 height=%276%27 shape-rendering=%27crispEdges%27%3E%3Crect width=%274%27 height=%276%27 fill=%27%23f7faf5%27/%3E%3Cpath d=%27M0 0h4v2H0zM0 2h1v1H0zM2 2h1v1H2zM1 3h1v1H1zM3 3h1v1H3zM1 5h1v1H1zM3 5h1v1H3z%27 fill=%27%23dce6de%27/%3E%3C/svg%3E")',
  },
  horizontalDark: {
    backgroundImage:
      'url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%274%27 height=%276%27 shape-rendering=%27crispEdges%27%3E%3Crect width=%274%27 height=%276%27 fill=%27%2312211d%27/%3E%3Cpath d=%27M0 0h4v2H0zM0 2h1v1H0zM2 2h1v1H2zM1 3h1v1H1zM3 3h1v1H3zM1 5h1v1H1zM3 5h1v1H3z%27 fill=%27%231e332c%27/%3E%3C/svg%3E")',
  },
});

export function DitherDivider({ orientation = 'vertical', isDark = false }: DitherDividerProps) {
  const isVertical = orientation === 'vertical';
  return (
    <div
      aria-hidden="true"
      {...stylex.props(
        isVertical ? styles.vertical : styles.horizontal,
        isVertical
          ? isDark
            ? styles.verticalDark
            : styles.verticalLight
          : isDark
            ? styles.horizontalDark
            : styles.horizontalLight
      )}
    />
  );
}

