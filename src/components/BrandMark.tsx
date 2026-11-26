import * as stylex from '@stylexjs/stylex';
import { siteUrl } from '../url';

// Keeps the brand circle at light-mode gold across both themes while tokens.stylex.ts stays in parity with src/client/tokens.stylex.ts.
const BRAND_CIRCLE_GOLD = '#deb76c';

// svg-r44.svg is 822x884 with the portrait circle at cx=411 cy=473 r=411.
// The circle sits behind the artwork as its own element so the ahoge and ears
// can rise above it without being clipped.
const styles = stylex.create({
  root: {
    position: 'relative',
    display: 'block',
    flexShrink: 0,
    aspectRatio: '822 / 884',
  },
  circle: {
    position: 'absolute',
    left: 0,
    top: '7.0136%', // 62 / 884
    width: '100%',
    height: '92.9864%', // 822 / 884
    borderRadius: '50%',
    backgroundColor: BRAND_CIRCLE_GOLD,
  },
  art: {
    position: 'relative',
    display: 'block',
    width: '100%',
    height: '100%',
  },
});

type BrandMarkProps = {
  alt?: string;
  xstyle?: stylex.StyleXStyles;
};

export function BrandMark({ alt = '', xstyle }: BrandMarkProps) {
  return (
    <span {...stylex.props(styles.root, xstyle)}>
      <span aria-hidden="true" {...stylex.props(styles.circle)} />
      <img src={siteUrl('/assets/svg-r44.svg')} alt={alt} width={822} height={884} {...stylex.props(styles.art)} />
    </span>
  );
}
