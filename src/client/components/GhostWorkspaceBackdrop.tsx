import * as stylex from '@stylexjs/stylex';
import { colors, layout, spacing, radius, typography } from '../tokens.stylex.js';
import type { EffectiveTheme, ThemeChoice } from '../utils/theme.js';
import { DEMO_EXTERNAL_LABEL, isEmbeddedDemo } from '../utils/demoLink.js';
import {
  IconChevronDown,
  IconChevronRight,
  IconChevronUp,
  IconClock,
  IconDownload,
  IconEdit,
  IconExternalLink,
  IconFile,
  IconFolder,
  IconFolderFilled,
  IconFolderPlus,
  IconGitHub,
  IconMenu,
  IconMonitor,
  IconMoon,
  IconPlus,
  IconRefreshCw,
  IconSearch,
  IconShare,
  IconSun,
  IconTrash,
  IconUpload,
} from './Icons.js';
import { DitherDivider } from './DitherDivider.js';
import brandLogo from '../assets/svg-r44.svg';

const PLACEHOLDER_ROWS = [
  { nameWidth: '42%', isFolder: true, sizeWidth: '44px', dateWidth: '88px' },
  { nameWidth: '34%', isFolder: true, sizeWidth: '36px', dateWidth: '82px' },
  { nameWidth: '58%', isFolder: false, accountWidth: '72px', sizeWidth: '56px', dateWidth: '92px' },
  { nameWidth: '49%', isFolder: false, accountWidth: '60px', sizeWidth: '48px', dateWidth: '84px' },
  { nameWidth: '64%', isFolder: false, accountWidth: '84px', sizeWidth: '62px', dateWidth: '90px' },
  { nameWidth: '38%', isFolder: false, accountWidth: '56px', sizeWidth: '52px', dateWidth: '86px' },
  { nameWidth: '53%', isFolder: false, accountWidth: '76px', sizeWidth: '46px', dateWidth: '94px' },
  { nameWidth: '45%', isFolder: false, accountWidth: '64px', sizeWidth: '58px', dateWidth: '80px' },
  { nameWidth: '61%', isFolder: false, accountWidth: '80px', sizeWidth: '50px', dateWidth: '88px' },
  { nameWidth: '36%', isFolder: false, accountWidth: '68px', sizeWidth: '42px', dateWidth: '84px' },
] as const;

const PLACEHOLDER_ACCOUNTS = [
  { nameWidth: '84px', emailWidth: '124px', quotaWidth: '68px', fillWidth: '54%', hasTransfer: true, transferFill: '14%' },
  { nameWidth: '96px', emailWidth: '132px', quotaWidth: '72px', fillWidth: '72%', hasTransfer: false, transferFill: '0%' },
  { nameWidth: '76px', emailWidth: '116px', quotaWidth: '64px', fillWidth: '31%', hasTransfer: false, transferFill: '0%' },
] as const;

const styles = stylex.create({
  placeholderShell: {
    width: '100%',
    height: '100%',
    display: 'flex',
    backgroundColor: colors.canvas,
    filter: 'blur(3px)',
    pointerEvents: 'none',
    userSelect: 'none',
    overflow: 'hidden',
  },
  placeholderSidebar: {
    width: layout.sidebarWidth,
    height: '100%',
    backgroundColor: colors.surface,
    borderRightWidth: '1px',
    borderRightStyle: 'solid',
    borderRightColor: colors.borderSubtle,
    display: 'flex',
    flexDirection: 'column',
    boxSizing: 'border-box',
    flexShrink: 0,
    overflow: 'hidden',
    '@media (max-width: 768px)': {
      display: 'none',
    },
  },
  brandHeader: {
    padding: spacing.space6,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space1,
    flexShrink: 0,
  },
  brandRow: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space4,
  },
  brandLogoContainer: {
    width: '40px',
    height: '40px',
    aspectRatio: '1 / 1',
    borderRadius: radius.pill,
    backgroundColor: colors.accentGold,
    position: 'relative',
    flexShrink: 0,
  },
  brandLogoImage: {
    position: 'absolute',
    bottom: 0,
    left: '50%',
    transform: 'translateX(-50%)',
    width: '100%',
    height: 'auto',
    display: 'block',
  },
  brandTitleGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space1,
    minWidth: 0,
  },
  brandTitleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space2,
    minWidth: 0,
  },
  brandWordmark: {
    fontFamily: typography.fontFamilyBrand,
    fontSize: typography.fontSizeBrand,
    fontWeight: typography.fontWeightBrand,
    color: colors.primaryText,
    letterSpacing: '0.02em',
    margin: 0,
    lineHeight: typography.lineHeightBrand,
  },
  brandVersionBadge: {
    fontFamily: typography.fontFamilyBrand,
    fontSize: typography.fontSizeMeta,
    fontWeight: typography.fontWeightBrand,
    lineHeight: typography.lineHeightBadge,
    letterSpacing: '0.02em',
    color: colors.secondaryText,
    backgroundColor: colors.surfaceAlt,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    borderRadius: radius.compact,
    paddingTop: spacing.space1,
    paddingBottom: spacing.space1,
    paddingLeft: spacing.space2,
    paddingRight: spacing.space2,
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },
  brandSubtitle: {
    fontSize: typography.fontSizeMeta,
    color: colors.secondaryText,
    fontFamily: typography.fontFamilyBody,
    lineHeight: typography.lineHeightMeta,
  },
  poolSection: {
    paddingTop: spacing.space3,
    paddingBottom: spacing.space3,
    paddingLeft: spacing.space4,
    paddingRight: spacing.space4,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space2,
    flexShrink: 0,
  },
  poolHeaderRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.space2,
  },
  poolHeadingLabel: {
    fontSize: typography.fontSizeBadge,
    fontWeight: typography.fontWeightSection,
    color: colors.dimText,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
  },
  poolHeaderActions: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space1,
  },
  poolActionChip: {
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    borderRadius: radius.compact,
    paddingTop: spacing.space1,
    paddingBottom: spacing.space1,
    paddingLeft: spacing.space2,
    paddingRight: spacing.space2,
    fontSize: typography.fontSizeBadge,
    fontWeight: typography.fontWeightBadge,
    color: colors.secondaryText,
    display: 'inline-flex',
    alignItems: 'center',
    gap: '3px',
  },
  poolSelectMock: {
    width: '100%',
    height: '32px',
    paddingLeft: spacing.space3,
    paddingRight: '28px',
    borderRadius: radius.compact,
    backgroundColor: colors.surfaceAlt,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    boxSizing: 'border-box',
    color: colors.secondaryText,
  },
  poolSelectValueBar: {
    height: '11px',
    width: '62%',
    borderRadius: radius.compact,
    backgroundColor: colors.borderSubtle,
  },
  poolSelectChevron: {
    position: 'absolute',
    right: spacing.space4,
    top: '50%',
    transform: 'translateY(-50%)',
    color: colors.secondaryText,
    display: 'flex',
    alignItems: 'center',
  },
  navSection: {
    paddingTop: spacing.space2,
    paddingBottom: spacing.space2,
    display: 'flex',
    flexDirection: 'column',
    gap: '0px',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
    flexShrink: 0,
  },
  navItem: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space3,
    paddingTop: spacing.space3,
    paddingBottom: spacing.space3,
    paddingLeft: spacing.space6,
    paddingRight: spacing.space4,
    borderLeftWidth: '3px',
    borderLeftStyle: 'solid',
    borderLeftColor: 'transparent',
    color: colors.secondaryText,
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBody,
    fontWeight: '500',
    width: '100%',
    boxSizing: 'border-box',
  },
  navItemActive: {
    backgroundColor: colors.selectionBg,
    color: colors.primaryText,
    fontWeight: typography.fontWeightTitle,
    borderLeftColor: colors.accentGold,
  },
  accountsSection: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  sectionHeading: {
    fontSize: typography.fontSizeBadge,
    fontWeight: typography.fontWeightSection,
    color: colors.dimText,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    paddingLeft: spacing.space4,
    paddingRight: spacing.space4,
    marginTop: spacing.space4,
    marginBottom: spacing.space2,
  },
  addAccountWrapper: {
    paddingLeft: spacing.space4,
    paddingRight: spacing.space4,
    marginBottom: spacing.space2,
  },
  addAccountBox: {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space3,
    paddingTop: spacing.space4,
    paddingBottom: spacing.space4,
    paddingLeft: spacing.space3,
    paddingRight: spacing.space3,
    borderRadius: radius.card,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    color: colors.primaryText,
    boxSizing: 'border-box',
  },
  addAccountIconCircle: {
    width: '30px',
    height: '30px',
    borderRadius: radius.pill,
    borderWidth: '1px',
    borderStyle: 'dashed',
    borderColor: colors.border,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    color: colors.primaryText,
  },
  addAccountTextCol: {
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space1,
    minWidth: 0,
    flex: 1,
  },
  addAccountLabel: {
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBody,
    fontWeight: typography.fontWeightTitle,
    color: colors.primaryText,
    lineHeight: typography.lineHeightBadge,
  },
  addAccountSub: {
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBadge,
    color: colors.secondaryText,
    lineHeight: typography.lineHeightBadge,
  },
  accountList: {
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space2,
    paddingLeft: spacing.space4,
    paddingRight: spacing.space4,
    paddingBottom: spacing.space3,
    overflow: 'hidden',
  },
  accountCard: {
    padding: spacing.space3,
    borderRadius: radius.card,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    backgroundColor: colors.surfaceAlt,
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space2,
  },
  accountTop: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  accountNameGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space2,
    minWidth: 0,
  },
  accountAvatar: {
    width: '24px',
    height: '24px',
    borderRadius: radius.pill,
    backgroundColor: colors.borderSubtle,
    flexShrink: 0,
  },
  accountTextGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space1,
    minWidth: 0,
  },
  accountNameBar: {
    height: '11px',
    borderRadius: radius.compact,
    backgroundColor: colors.borderSubtle,
  },
  accountEmailBar: {
    height: '9px',
    borderRadius: radius.compact,
    backgroundColor: colors.borderSubtle,
  },
  authPill: {
    fontSize: typography.fontSizeBadge,
    color: colors.success,
    fontWeight: typography.fontWeightBadge,
    flexShrink: 0,
  },
  storageSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: '3px',
  },
  storageHeaderRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    fontSize: typography.fontSizeBadge,
  },
  storageLabel: {
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBadge,
    fontWeight: typography.fontWeightBadge,
    color: colors.secondaryText,
    textTransform: 'uppercase',
    letterSpacing: '0.03em',
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space2,
  },
  storageValueBar: {
    height: '10px',
    borderRadius: radius.compact,
    backgroundColor: colors.borderSubtle,
  },
  progressTrack: {
    height: '4px',
    width: '100%',
    borderRadius: radius.pill,
    backgroundColor: colors.progressTrack,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: radius.pill,
    backgroundColor: colors.brandAccent,
  },
  poolProgressFill: {
    height: '100%',
    borderRadius: radius.pill,
    backgroundColor: colors.poolGold,
  },
  accountActionsRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing.space2,
    marginTop: spacing.space1,
  },
  accountMiniChip: {
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    borderRadius: radius.compact,
    paddingTop: spacing.space1,
    paddingBottom: spacing.space1,
    paddingLeft: spacing.space2,
    paddingRight: spacing.space2,
    fontSize: typography.fontSizeBadge,
    lineHeight: typography.lineHeightBadge,
    color: colors.secondaryText,
  },
  accountMiniDangerChip: {
    color: colors.danger,
  },
  sidebarQuotaFooter: {
    padding: spacing.space4,
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: colors.borderSubtle,
    backgroundColor: colors.surfaceAlt,
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space2,
    marginTop: 'auto',
    flexShrink: 0,
  },
  footerTitle: {
    fontSize: typography.fontSizeBadge,
    fontWeight: typography.fontWeightSection,
    color: colors.secondaryText,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  footerStats: {
    fontSize: typography.fontSizeMeta,
    color: colors.primaryText,
    fontVariantNumeric: 'tabular-nums',
    fontWeight: typography.fontWeightTitle,
  },
  footerHeadroom: {
    fontSize: typography.fontSizeBadge,
    color: colors.secondaryText,
    fontVariantNumeric: 'tabular-nums',
  },
  footerTransfer: {
    fontSize: typography.fontSizeBadge,
    color: colors.dimText,
    fontVariantNumeric: 'tabular-nums',
    paddingTop: spacing.space2,
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: colors.borderSubtle,
  },
  footerInlineBarSm: {
    display: 'inline-block',
    height: '8px',
    width: '24px',
    verticalAlign: 'baseline',
    borderRadius: radius.compact,
    backgroundColor: colors.progressTrack,
  },
  footerInlineBarMd: {
    display: 'inline-block',
    height: '8px',
    width: '30px',
    verticalAlign: 'baseline',
    borderRadius: radius.compact,
    backgroundColor: colors.progressTrack,
  },
  footerInlineBarXs: {
    display: 'inline-block',
    height: '8px',
    width: '14px',
    verticalAlign: 'baseline',
    borderRadius: radius.compact,
    backgroundColor: colors.progressTrack,
  },
  placeholderMain: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minWidth: 0,
    height: '100%',
    overflow: 'hidden',
    paddingLeft: layout.ditherStripHeight,
    '@media (max-width: 768px)': {
      paddingLeft: '0px',
    },
  },
  placeholderHeader: {
    height: layout.headerHeight,
    backgroundColor: colors.surface,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: spacing.space6,
    paddingRight: spacing.space6,
    gap: spacing.space4,
    boxSizing: 'border-box',
    flexShrink: 0,
  },
  headerLeftGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space4,
    flex: 1,
    maxWidth: layout.searchMaxWidth,
    minWidth: 0,
  },
  mobileMenuMock: {
    display: 'none',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.space2,
    color: colors.primaryText,
    flexShrink: 0,
    '@media (max-width: 768px)': {
      display: 'inline-flex',
    },
  },
  searchBar: {
    display: 'flex',
    alignItems: 'center',
    backgroundColor: colors.surfaceAlt,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    borderRadius: radius.button,
    paddingLeft: spacing.space4,
    paddingRight: spacing.space3,
    height: layout.searchHeight,
    width: '100%',
    minWidth: 0,
    boxSizing: 'border-box',
    color: colors.dimText,
    fontSize: typography.fontSizeBody,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
  },
  searchIcon: {
    width: '14px',
    height: '14px',
    color: colors.secondaryText,
    marginRight: spacing.space2,
    flexShrink: 0,
  },
  headerRightGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space4,
    flexShrink: 0,
  },
  compactHideText: {
    '@media (max-width: 600px)': {
      display: 'none',
    },
  },
  themeSelector: {
    display: 'inline-flex',
    alignItems: 'center',
    height: '28px',
    backgroundColor: colors.surfaceAlt,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    borderRadius: radius.button,
    padding: spacing.space1,
    gap: spacing.space1,
    boxSizing: 'border-box',
  },
  themeBtn: {
    borderRadius: radius.compact,
    color: colors.secondaryText,
    fontSize: typography.fontSizeBadge,
    fontWeight: '500',
    height: '22px',
    paddingLeft: spacing.space3,
    paddingRight: spacing.space3,
    display: 'inline-flex',
    alignItems: 'center',
    gap: spacing.space2,
    boxSizing: 'border-box',
  },
  themeBtnActive: {
    backgroundColor: colors.surfaceElevated,
    color: colors.primaryText,
  },
  githubChip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: spacing.space3,
    height: '28px',
    paddingLeft: spacing.space3,
    paddingRight: spacing.space3,
    borderRadius: radius.button,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    backgroundColor: colors.surfaceAlt,
    color: colors.secondaryText,
    fontSize: typography.fontSizeBadge,
    fontWeight: '500',
    whiteSpace: 'nowrap',
    boxSizing: 'border-box',
  },
  placeholderPortal: {
    height: layout.actionsPortalHeight,
    backgroundColor: colors.surface,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
    display: 'flex',
    alignItems: 'center',
    paddingLeft: spacing.space6,
    paddingRight: spacing.space6,
    gap: spacing.space3,
    boxSizing: 'border-box',
    flexShrink: 0,
    overflow: 'hidden',
  },
  breadcrumbsWrap: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space2,
    marginRight: 'auto',
    paddingRight: spacing.space2,
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },
  breadcrumbActive: {
    fontSize: typography.fontSizeBody,
    fontWeight: typography.fontWeightTitle,
    color: colors.primaryText,
    paddingTop: spacing.space1,
    paddingBottom: spacing.space1,
    paddingLeft: spacing.space2,
    paddingRight: spacing.space2,
  },
  primaryBtnMock: {
    height: '32px',
    paddingLeft: spacing.space5,
    paddingRight: spacing.space5,
    borderRadius: radius.button,
    backgroundColor: colors.brandAccent,
    color: colors.brandAccentText,
    fontSize: typography.fontSizeBody,
    fontWeight: typography.fontWeightTitle,
    display: 'inline-flex',
    alignItems: 'center',
    gap: spacing.space2,
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },
  secondaryBtnMock: {
    height: '32px',
    paddingLeft: spacing.space4,
    paddingRight: spacing.space4,
    borderRadius: radius.button,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    color: colors.primaryText,
    fontSize: typography.fontSizeBody,
    fontWeight: '500',
    display: 'inline-flex',
    alignItems: 'center',
    gap: spacing.space2,
    whiteSpace: 'nowrap',
    flexShrink: 0,
    '@media (max-width: 960px)': {
      display: 'none',
    },
  },
  placeholderTable: {
    flex: 1,
    backgroundColor: colors.surfaceContainer,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  tableHeaderRow: {
    height: '36px',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
    borderLeftWidth: '3px',
    borderLeftStyle: 'solid',
    borderLeftColor: 'transparent',
    backgroundColor: colors.surfaceAlt,
    display: 'grid',
    gridTemplateColumns: '16px 40px minmax(240px, 3fr) 160px 110px 156px 96px',
    alignItems: 'stretch',
    paddingRight: spacing.space4,
    fontSize: typography.fontSizeTableHeader,
    fontWeight: typography.fontWeightTableHeader,
    color: colors.secondaryText,
    boxSizing: 'border-box',
    flexShrink: 0,
    '@media (max-width: 768px)': {
      display: 'none',
    },
  },
  tableHeaderCell: {
    height: '100%',
    display: 'flex',
    alignItems: 'center',
    minWidth: 0,
    boxSizing: 'border-box',
  },
  tableHeaderInnerLeft: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: spacing.space1,
    paddingLeft: spacing.space1,
    paddingRight: spacing.space2,
    marginLeft: '-4px',
  },
  tableHeaderInnerActive: {
    color: colors.primaryText,
  },
  tableCellCenter: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    height: '100%',
  },
  checkboxMock: {
    width: '16px',
    height: '16px',
    borderRadius: radius.compact,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    backgroundColor: colors.surface,
    boxSizing: 'border-box',
  },
  rowWrapper: {
    width: '100%',
    height: layout.tableRowHeight,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
    borderLeftWidth: '3px',
    borderLeftStyle: 'solid',
    borderLeftColor: 'transparent',
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'stretch',
    boxSizing: 'border-box',
    flexShrink: 0,
    '@media (max-width: 768px)': {
      height: layout.mobileRowHeight,
    },
  },
  gutterCell: {
    width: '16px',
    height: '100%',
    flexShrink: 0,
    '@media (max-width: 768px)': {
      display: 'none',
    },
  },
  rowMain: {
    flex: 1,
    minWidth: 0,
    height: '100%',
    display: 'grid',
    gridTemplateColumns: '40px minmax(240px, 3fr) 160px 110px 156px 96px',
    alignItems: 'center',
    paddingRight: spacing.space4,
    boxSizing: 'border-box',
    '@media (max-width: 768px)': {
      gridTemplateColumns: '36px minmax(0, 1fr) auto',
      paddingLeft: spacing.space2,
      paddingRight: spacing.space3,
    },
  },
  rowNameGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space3,
    minWidth: 0,
  },
  rowFolderIcon: {
    color: colors.accentGold,
    flexShrink: 0,
  },
  rowFileIcon: {
    color: colors.secondaryText,
    flexShrink: 0,
  },
  rowBar: {
    height: '12px',
    borderRadius: radius.compact,
    backgroundColor: colors.surfaceAlt,
  },
  rowAccountCell: {
    display: 'flex',
    alignItems: 'center',
    minWidth: 0,
    height: '100%',
    paddingLeft: '2px',
    paddingRight: spacing.space6,
    overflow: 'hidden',
    '@media (max-width: 768px)': {
      display: 'none',
    },
  },
  rowFolderPill: {
    fontSize: typography.fontSizeBadge,
    fontFamily: typography.fontFamilyMono,
    display: 'inline-block',
    maxWidth: '100%',
    height: '22px',
    lineHeight: '18px',
    paddingTop: '1px',
    paddingBottom: '1px',
    paddingLeft: spacing.space2,
    paddingRight: spacing.space2,
    borderRadius: radius.compact,
    backgroundColor: colors.brandAccentSurface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    color: colors.brandAccent,
    boxSizing: 'border-box',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    verticalAlign: 'middle',
  },
  rowAccountSelectMock: {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    minWidth: 0,
    maxWidth: '136px',
    height: '22px',
    lineHeight: '18px',
    paddingTop: '1px',
    paddingBottom: '1px',
    paddingLeft: spacing.space2,
    paddingRight: '22px',
    borderRadius: radius.compact,
    backgroundColor: colors.brandAccentSurface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    color: colors.brandAccent,
    boxSizing: 'border-box',
  },
  rowAccountSelectBar: {
    height: '8px',
    borderRadius: radius.compact,
    backgroundColor: colors.borderSubtle,
  },
  rowAccountSelectChevron: {
    position: 'absolute',
    right: '7px',
    top: '50%',
    transform: 'translateY(-50%)',
    color: colors.brandAccent,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  barWidth: (width: string) => ({ width }),
  rowDesktopCellLeft: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingRight: spacing.space2,
    '@media (max-width: 768px)': {
      display: 'none',
    },
  },
  rowActionIcons: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: spacing.space1,
    '@media (max-width: 768px)': {
      justifyContent: 'flex-end',
    },
  },
  rowBtnMock: {
    minWidth: '26px',
    minHeight: '26px',
    padding: spacing.space1,
    color: colors.secondaryText,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxSizing: 'border-box',
  },
});

export interface GhostWorkspaceBackdropProps {
  effectiveTheme: EffectiveTheme;
  themeChoice?: ThemeChoice;
  isDemoMode?: boolean;
}

/**
 * Blurred, non-interactive workspace shell rendered behind the tab-blocked modal and demo hydration.
 */
export function GhostWorkspaceBackdrop({
  effectiveTheme,
  themeChoice,
  isDemoMode = false,
}: GhostWorkspaceBackdropProps) {
  const activeThemeChoice: ThemeChoice = themeChoice ?? effectiveTheme;
  const showExternalDemoLink = isDemoMode && isEmbeddedDemo();
  return (
    <div {...stylex.props(styles.placeholderShell)} aria-hidden="true">
      <aside {...stylex.props(styles.placeholderSidebar)}>
        <div {...stylex.props(styles.brandHeader)}>
          <div {...stylex.props(styles.brandRow)}>
            <div {...stylex.props(styles.brandLogoContainer)}>
              <img src={brandLogo} alt="" {...stylex.props(styles.brandLogoImage)} />
            </div>
            <div {...stylex.props(styles.brandTitleGroup)}>
              <div {...stylex.props(styles.brandTitleRow)}>
                <div {...stylex.props(styles.brandWordmark)}>Tsubasa~</div>
                <span {...stylex.props(styles.brandVersionBadge)}>v{__APP_VERSION__}</span>
              </div>
              <div {...stylex.props(styles.brandSubtitle)}>Pooled Google Drive Cluster</div>
            </div>
          </div>
        </div>

        <section {...stylex.props(styles.poolSection)}>
          <div {...stylex.props(styles.poolHeaderRow)}>
            <span {...stylex.props(styles.poolHeadingLabel)}>Storage pool</span>
            <div {...stylex.props(styles.poolHeaderActions)}>
              <span {...stylex.props(styles.poolActionChip)}>
                <IconEdit size={11} />
                <span>Rename</span>
              </span>
              <span {...stylex.props(styles.poolActionChip)}>
                <IconPlus size={11} strokeWidth={2.5} />
                <span>New</span>
              </span>
            </div>
          </div>
          <div {...stylex.props(styles.poolSelectMock)}>
            <div {...stylex.props(styles.poolSelectValueBar)} />
            <div {...stylex.props(styles.poolSelectChevron)}>
              <IconChevronDown size={14} strokeWidth={2.5} />
            </div>
          </div>
        </section>

        <nav {...stylex.props(styles.navSection)}>
          <div {...stylex.props(styles.navItem, styles.navItemActive)}>
            <IconFolder size={18} />
            <span>All files</span>
          </div>
          <div {...stylex.props(styles.navItem)}>
            <IconTrash size={18} />
            <span>Trash</span>
          </div>
        </nav>

        <div {...stylex.props(styles.accountsSection)}>
          <div {...stylex.props(styles.sectionHeading)}>Connected accounts</div>
          <div {...stylex.props(styles.addAccountWrapper)}>
            <div {...stylex.props(styles.addAccountBox)}>
              <div {...stylex.props(styles.addAccountIconCircle)}>
                <IconPlus size={14} strokeWidth={2.5} />
              </div>
              <div {...stylex.props(styles.addAccountTextCol)}>
                <span {...stylex.props(styles.addAccountLabel)}>Add account</span>
                <span {...stylex.props(styles.addAccountSub)}>
                  {isDemoMode ? 'Click or drop any .json file' : 'Import OAuth credentials'}
                </span>
              </div>
            </div>
          </div>
          <div {...stylex.props(styles.accountList)}>
            {PLACEHOLDER_ACCOUNTS.map((acc, idx) => (
              <div key={idx} {...stylex.props(styles.accountCard)}>
                <div {...stylex.props(styles.accountTop)}>
                  <div {...stylex.props(styles.accountNameGroup)}>
                    <div {...stylex.props(styles.accountAvatar)} />
                    <div {...stylex.props(styles.accountTextGroup)}>
                      <div {...stylex.props(styles.accountNameBar, styles.barWidth(acc.nameWidth))} />
                      <div {...stylex.props(styles.accountEmailBar, styles.barWidth(acc.emailWidth))} />
                    </div>
                  </div>
                  <span {...stylex.props(styles.authPill)}>Active</span>
                </div>
                <div {...stylex.props(styles.storageSection)}>
                  <div {...stylex.props(styles.storageHeaderRow)}>
                    <span {...stylex.props(styles.storageLabel)}>
                      <IconFolder size={11} />
                      <span>Storage</span>
                    </span>
                    <div {...stylex.props(styles.storageValueBar, styles.barWidth(acc.quotaWidth))} />
                  </div>
                  <div {...stylex.props(styles.progressTrack)}>
                    <div {...stylex.props(styles.progressFill, styles.barWidth(acc.fillWidth))} />
                  </div>
                </div>
                {acc.hasTransfer && (
                  <div {...stylex.props(styles.storageSection)}>
                    <div {...stylex.props(styles.storageHeaderRow)}>
                      <span {...stylex.props(styles.storageLabel)}>
                        <IconClock size={11} />
                        <span>24h quota</span>
                      </span>
                      <div {...stylex.props(styles.storageValueBar, styles.barWidth('58px'))} />
                    </div>
                    <div {...stylex.props(styles.progressTrack)}>
                      <div {...stylex.props(styles.progressFill, styles.barWidth(acc.transferFill))} />
                    </div>
                  </div>
                )}
                <div {...stylex.props(styles.accountActionsRow)}>
                  <span {...stylex.props(styles.accountMiniChip)}>Move pool</span>
                  <span {...stylex.props(styles.accountMiniChip)}>Disable</span>
                  <span {...stylex.props(styles.accountMiniChip, styles.accountMiniDangerChip)}>Remove</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div {...stylex.props(styles.sidebarQuotaFooter)}>
          <div {...stylex.props(styles.footerTitle)}>Pooled storage</div>
          <div {...stylex.props(styles.progressTrack)}>
            <div {...stylex.props(styles.poolProgressFill, styles.barWidth('48%'))} />
          </div>
          <div {...stylex.props(styles.footerStats)}>
            <span {...stylex.props(styles.footerInlineBarSm)} /> GB used of{' '}
            <span {...stylex.props(styles.footerInlineBarMd)} /> GB (
            <span {...stylex.props(styles.footerInlineBarXs)} />%)
          </div>
          <div {...stylex.props(styles.footerHeadroom)}>
            <span {...stylex.props(styles.footerInlineBarSm)} /> GB free across{' '}
            <span {...stylex.props(styles.footerInlineBarXs)} /> accounts (each account has a safety buffer of 750 MB)
          </div>
          <div {...stylex.props(styles.footerTransfer)}>
            24h cluster transfers: <span {...stylex.props(styles.footerInlineBarSm)} /> /{' '}
            <span {...stylex.props(styles.footerInlineBarMd)} /> GB (
            <span {...stylex.props(styles.footerInlineBarXs)} />%)
          </div>
        </div>
      </aside>

      <div {...stylex.props(styles.placeholderMain)}>
        <DitherDivider orientation="vertical" isDark={effectiveTheme === 'dark'} />

        <header {...stylex.props(styles.placeholderHeader)}>
          <div {...stylex.props(styles.headerLeftGroup)}>
            <span {...stylex.props(styles.mobileMenuMock)}>
              <IconMenu size={13} />
            </span>
            <div {...stylex.props(styles.searchBar)}>
              <IconSearch size={14} {...stylex.props(styles.searchIcon)} />
              <span>Search pooled files and directories...</span>
            </div>
          </div>
          <div {...stylex.props(styles.headerRightGroup)}>
            <div {...stylex.props(styles.themeSelector)}>
              <span {...stylex.props(styles.themeBtn, activeThemeChoice === 'auto' && styles.themeBtnActive)}>
                <IconMonitor size={12} />
                <span>Auto</span>
              </span>
              <span {...stylex.props(styles.themeBtn, activeThemeChoice === 'light' && styles.themeBtnActive)}>
                <IconSun size={12} />
                <span>Light</span>
              </span>
              <span {...stylex.props(styles.themeBtn, activeThemeChoice === 'dark' && styles.themeBtnActive)}>
                <IconMoon size={12} />
                <span>Dark</span>
              </span>
            </div>
            <span {...stylex.props(styles.githubChip)}>
              {showExternalDemoLink ? (
                <>
                  <IconExternalLink size={13} />
                  <span {...stylex.props(styles.compactHideText)}>{DEMO_EXTERNAL_LABEL}</span>
                </>
              ) : (
                <>
                  <IconGitHub size={14} />
                  <span {...stylex.props(styles.compactHideText)}>GitHub</span>
                </>
              )}
            </span>
            {isDemoMode && (
              <span {...stylex.props(styles.githubChip)}>
                <IconRefreshCw size={13} />
                <span {...stylex.props(styles.compactHideText)}>Reset demo</span>
              </span>
            )}
          </div>
        </header>

        <div {...stylex.props(styles.placeholderPortal)}>
          <div {...stylex.props(styles.breadcrumbsWrap)}>
            <span {...stylex.props(styles.breadcrumbActive)}>All files</span>
          </div>
          <span {...stylex.props(styles.primaryBtnMock)}>
            <IconUpload size={14} />
            <span>Upload file</span>
          </span>
          <span {...stylex.props(styles.secondaryBtnMock)}>
            <IconFolderPlus size={14} />
            <span>Upload folder</span>
          </span>
          <span {...stylex.props(styles.secondaryBtnMock)}>
            <IconFolder size={14} />
            <span>New folder</span>
          </span>
          <span {...stylex.props(styles.secondaryBtnMock)}>
            <IconRefreshCw size={14} />
            <span>Fetch Drive changes</span>
          </span>
        </div>

        <div {...stylex.props(styles.placeholderTable)}>
          <div {...stylex.props(styles.tableHeaderRow)}>
            <div />
            <div {...stylex.props(styles.tableCellCenter)}>
              <div {...stylex.props(styles.checkboxMock)} />
            </div>
            <div {...stylex.props(styles.tableHeaderCell)}>
              <span {...stylex.props(styles.tableHeaderInnerLeft, styles.tableHeaderInnerActive)}>
                <span>Name</span>
                <IconChevronUp size={12} strokeWidth={2.5} />
              </span>
            </div>
            <div {...stylex.props(styles.tableHeaderCell)}>
              <span {...stylex.props(styles.tableHeaderInnerLeft)}>Account</span>
            </div>
            <div {...stylex.props(styles.tableHeaderCell)}>
              <span {...stylex.props(styles.tableHeaderInnerLeft)}>Size</span>
            </div>
            <div {...stylex.props(styles.tableHeaderCell)}>
              <span {...stylex.props(styles.tableHeaderInnerLeft)}>Modified</span>
            </div>
            <div {...stylex.props(styles.tableHeaderCell)}>Actions</div>
          </div>

          {PLACEHOLDER_ROWS.map((row, idx) => (
            <div key={idx} {...stylex.props(styles.rowWrapper)}>
              <div {...stylex.props(styles.gutterCell)} />
              <div {...stylex.props(styles.rowMain)}>
                <div {...stylex.props(styles.tableCellCenter)}>
                  <div {...stylex.props(styles.checkboxMock)} />
                </div>
                <div {...stylex.props(styles.rowNameGroup)}>
                  {row.isFolder ? (
                    <IconFolderFilled size={16} {...stylex.props(styles.rowFolderIcon)} />
                  ) : (
                    <IconFile size={16} {...stylex.props(styles.rowFileIcon)} />
                  )}
                  <div {...stylex.props(styles.rowBar, styles.barWidth(row.nameWidth))} />
                </div>
                <div {...stylex.props(styles.rowAccountCell)}>
                  {row.isFolder ? (
                    <span {...stylex.props(styles.rowFolderPill)}>Cluster folder</span>
                  ) : (
                    <div {...stylex.props(styles.rowAccountSelectMock)}>
                      <div {...stylex.props(styles.rowAccountSelectBar, styles.barWidth(row.accountWidth))} />
                      <span {...stylex.props(styles.rowAccountSelectChevron)}>
                        <IconChevronDown size={10} strokeWidth={2.5} />
                      </span>
                    </div>
                  )}
                </div>
                <div {...stylex.props(styles.rowDesktopCellLeft)}>
                  <div {...stylex.props(styles.rowBar, styles.barWidth(row.sizeWidth))} />
                </div>
                <div {...stylex.props(styles.rowDesktopCellLeft)}>
                  <div {...stylex.props(styles.rowBar, styles.barWidth(row.dateWidth))} />
                </div>
                <div {...stylex.props(styles.rowActionIcons)}>
                  <span {...stylex.props(styles.rowBtnMock)}>
                    <IconShare size={14} />
                  </span>
                  {row.isFolder ? (
                    <>
                      <span {...stylex.props(styles.rowBtnMock)}>
                        <IconTrash size={14} />
                      </span>
                      <span {...stylex.props(styles.rowBtnMock)}>
                        <IconChevronRight size={14} />
                      </span>
                    </>
                  ) : (
                    <>
                      <span {...stylex.props(styles.rowBtnMock)}>
                        <IconDownload size={14} />
                      </span>
                      <span {...stylex.props(styles.rowBtnMock)}>
                        <IconTrash size={14} />
                      </span>
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
