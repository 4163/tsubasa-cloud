import * as stylex from '@stylexjs/stylex';
import { colors, layout, radius, spacing, typography } from '../tokens.stylex';
import { BrandMark } from './BrandMark';

interface DummyRow {
  id: string;
  name: string;
  kind: 'folder' | 'file';
  account: string;
  size: string;
  modified: string;
  selected?: boolean;
}

const DUMMY_ROWS: readonly DummyRow[] = [
  { id: '1', name: 'Design Assets', kind: 'folder', account: 'ale•••01', size: '-', modified: '2026-03-14' },
  { id: '2', name: 'Invoices', kind: 'folder', account: 'mar•••02', size: '-', modified: '2026-03-10' },
  { id: '3', name: 'Releases', kind: 'folder', account: 'ale•••01', size: '-', modified: '2026-03-08' },
  {
    id: '4',
    name: 'tsubasa-setup-0.1.0.exe',
    kind: 'file',
    account: 'ale•••01',
    size: '84.2 MB',
    modified: '2026-03-18',
    selected: true,
  },
  { id: '5', name: 'archive-2026-q1.tar.gz', kind: 'file', account: 'mar•••02', size: '3.41 GB', modified: '2026-03-15' },
  { id: '6', name: 'product-demo.mp4', kind: 'file', account: 'ale•••01', size: '612.8 MB', modified: '2026-03-12' },
  { id: '7', name: 'notes.md', kind: 'file', account: 'mar•••02', size: '14.6 KB', modified: '2026-03-09' },
];

const styles = stylex.create({
  frame: {
    boxSizing: 'border-box',
    width: '1120px',
    maxWidth: '100%',
    height: '640px',
    marginInline: 'auto',
    backgroundColor: colors.surface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    borderRadius: radius.card,
    overflow: 'hidden',
    display: 'flex',
    '@media (max-width: 768px)': {
      width: '100%',
      height: '540px',
    },
  },
  shell: {
    display: 'flex',
    width: '100%',
    height: '100%',
    overflow: 'hidden',
    userSelect: 'none',
  },
  sidebar: {
    width: layout.sidebarWidth,
    flexShrink: 0,
    backgroundColor: colors.surface,
    borderRightWidth: '1px',
    borderRightStyle: 'solid',
    borderRightColor: colors.borderSubtle,
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'space-between',
    overflow: 'hidden',
    '@media (max-width: 768px)': {
      display: 'none',
    },
  },
  sidebarTop: {
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space6,
    padding: spacing.space6,
  },
  brandRow: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space4,
  },
  brandMark: {
    width: '26px',
  },
  brandText: {
    fontFamily: typography.fontFamilyBrand,
    fontSize: typography.fontSizeBrand,
    fontWeight: typography.fontWeightBrand,
    lineHeight: typography.lineHeightBrand,
    color: colors.headingText,
    letterSpacing: '0.02em',
  },
  versionPill: {
    fontFamily: typography.fontFamilyBrand,
    fontSize: typography.fontSizeBadge,
    fontWeight: typography.fontWeightBadge,
    color: colors.accentGoldText,
    backgroundColor: colors.accentGold,
    paddingBlock: '2px',
    paddingInline: '6px',
    borderRadius: radius.compact,
    marginLeft: 'auto',
  },
  sectionLabel: {
    fontSize: typography.fontSizeTableHeader,
    fontWeight: typography.fontWeightTableHeader,
    letterSpacing: '0.05em',
    textTransform: 'uppercase',
    color: colors.secondaryText,
    marginBottom: spacing.space3,
  },
  navList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  navItem: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBlock: spacing.space3,
    paddingInline: spacing.space4,
    fontSize: typography.fontSizeBody,
    color: colors.primaryText,
    borderLeftWidth: '3px',
    borderLeftStyle: 'solid',
    borderLeftColor: 'transparent',
  },
  navItemActive: {
    backgroundColor: colors.selectionBg,
    borderLeftColor: colors.accentGold,
    fontWeight: '600',
  },
  accountList: {
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space4,
  },
  accountCard: {
    padding: spacing.space4,
    backgroundColor: colors.canvas,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    borderRadius: radius.card,
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space2,
  },
  accountHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.space3,
  },
  accountEmail: {
    fontFamily: typography.fontFamilyMono,
    fontSize: typography.fontSizeMeta,
    color: colors.primaryText,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  statusPill: {
    fontSize: typography.fontSizeBadge,
    fontWeight: typography.fontWeightBadge,
    color: colors.success,
    backgroundColor: colors.successSurface,
    paddingBlock: '2px',
    paddingInline: '6px',
    borderRadius: radius.compact,
    flexShrink: 0,
  },
  accountMeta: {
    fontSize: typography.fontSizeMeta,
    color: colors.secondaryText,
    fontVariantNumeric: 'tabular-nums',
  },
  progressTrack: {
    height: '4px',
    width: '100%',
    backgroundColor: colors.progressTrack,
    borderRadius: radius.pill,
    overflow: 'hidden',
  },
  progressFillPrimary: {
    height: '100%',
    width: '80%',
    backgroundColor: colors.brandAccent,
  },
  progressFillSecondary: {
    height: '100%',
    width: '58%',
    backgroundColor: colors.brandAccent,
  },
  progressFillPool: {
    height: '100%',
    width: '69%',
    backgroundColor: colors.brandAccent,
  },
  sidebarFooter: {
    padding: spacing.space6,
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: colors.borderSubtle,
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space3,
  },
  quotaRow: {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: typography.fontSizeMeta,
    color: colors.secondaryText,
    fontVariantNumeric: 'tabular-nums',
  },
  workspace: {
    position: 'relative',
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: colors.canvas,
  },
  topBar: {
    height: layout.headerHeight,
    flexShrink: 0,
    paddingInline: spacing.space6,
    backgroundColor: colors.surface,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.space4,
  },
  searchBox: {
    flex: 1,
    maxWidth: '420px',
    height: layout.searchHeight,
    paddingInline: spacing.space5,
    borderRadius: radius.compact,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    backgroundColor: colors.canvas,
    color: colors.secondaryText,
    fontSize: typography.fontSizeBody,
    display: 'flex',
    alignItems: 'center',
  },
  topBarMeta: {
    fontSize: typography.fontSizeMeta,
    color: colors.secondaryText,
    whiteSpace: 'nowrap',
  },
  actionPortal: {
    height: layout.actionsPortalHeight,
    flexShrink: 0,
    paddingInline: spacing.space6,
    backgroundColor: colors.surface,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.space4,
  },
  breadcrumbs: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space3,
    fontSize: typography.fontSizeBody,
    color: colors.secondaryText,
    overflow: 'hidden',
    whiteSpace: 'nowrap',
  },
  breadcrumbCurrent: {
    color: colors.primaryText,
    fontWeight: '600',
  },
  actionButtons: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space4,
    flexShrink: 0,
  },
  btnPrimary: {
    height: '32px',
    paddingInline: spacing.space5,
    borderRadius: radius.button,
    backgroundColor: colors.brandAccent,
    color: colors.brandAccentText,
    fontSize: typography.fontSizeBody,
    fontWeight: '600',
    display: 'inline-flex',
    alignItems: 'center',
  },
  btnSecondary: {
    height: '32px',
    paddingInline: spacing.space5,
    borderRadius: radius.button,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    backgroundColor: 'transparent',
    color: colors.primaryText,
    fontSize: typography.fontSizeBody,
    fontWeight: '500',
    display: 'inline-flex',
    alignItems: 'center',
    '@media (max-width: 768px)': {
      display: 'none',
    },
  },
  tableWrap: {
    flex: 1,
    minHeight: 0,
    backgroundColor: colors.surface,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  tableHeader: {
    height: layout.tableRowHeight,
    flexShrink: 0,
    display: 'grid',
    gridTemplateColumns: '32px minmax(180px, 3fr) 110px 96px 110px',
    alignItems: 'center',
    paddingInline: spacing.space5,
    backgroundColor: colors.surfaceAlt,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
    fontSize: typography.fontSizeTableHeader,
    fontWeight: typography.fontWeightTableHeader,
    letterSpacing: '0.05em',
    textTransform: 'uppercase',
    color: colors.secondaryText,
    '@media (max-width: 768px)': {
      gridTemplateColumns: '28px minmax(0, 1fr) 80px',
    },
  },
  tableRow: {
    height: layout.tableRowHeight,
    flexShrink: 0,
    display: 'grid',
    gridTemplateColumns: '32px minmax(180px, 3fr) 110px 96px 110px',
    alignItems: 'center',
    paddingInline: spacing.space5,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
    borderLeftWidth: '3px',
    borderLeftStyle: 'solid',
    borderLeftColor: 'transparent',
    fontSize: typography.fontSizeBody,
    color: colors.primaryText,
    '@media (max-width: 768px)': {
      height: layout.mobileRowHeight,
      gridTemplateColumns: '28px minmax(0, 1fr) 80px',
    },
  },
  tableRowSelected: {
    backgroundColor: colors.selectionBg,
    borderLeftColor: colors.accentGold,
  },
  checkbox: {
    width: '14px',
    height: '14px',
    borderRadius: '3px',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  checkboxChecked: {
    backgroundColor: colors.brandAccent,
    borderColor: colors.brandAccent,
  },
  nameCell: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space4,
    minWidth: 0,
  },
  nameText: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  hideMobile: {
    '@media (max-width: 768px)': {
      display: 'none',
    },
  },
  monoCell: {
    fontFamily: typography.fontFamilyMono,
    fontSize: typography.fontSizeMeta,
    color: colors.secondaryText,
  },
  numCell: {
    fontSize: typography.fontSizeMeta,
    color: colors.secondaryText,
    fontVariantNumeric: 'tabular-nums',
  },
  folderIcon: {
    width: '16px',
    height: '16px',
    flexShrink: 0,
    color: colors.accentGold,
  },
  fileIcon: {
    width: '16px',
    height: '16px',
    flexShrink: 0,
    color: colors.secondaryText,
  },
});

export function DummyWindow() {
  return (
    <div {...stylex.props(styles.frame)} data-dummy-window="">
      <div {...stylex.props(styles.shell)} inert={true} aria-hidden="true">
        <aside {...stylex.props(styles.sidebar)}>
          <div {...stylex.props(styles.sidebarTop)}>
            <div {...stylex.props(styles.brandRow)}>
              <BrandMark xstyle={styles.brandMark} />
              <span {...stylex.props(styles.brandText)}>Tsubasa~</span>
              <span {...stylex.props(styles.versionPill)}>v0.1.0</span>
            </div>

            <div>
              <div {...stylex.props(styles.sectionLabel)}>Pools</div>
              <div {...stylex.props(styles.navList)}>
                <div {...stylex.props(styles.navItem, styles.navItemActive)}>
                  <span>Main Pool</span>
                  <span {...stylex.props(styles.numCell)}>2</span>
                </div>
                <div {...stylex.props(styles.navItem)}>
                  <span>Media Archive</span>
                  <span {...stylex.props(styles.numCell)}>1</span>
                </div>
                <div {...stylex.props(styles.navItem)}>
                  <span>Share Pool</span>
                  <span {...stylex.props(styles.numCell)}>RO</span>
                </div>
              </div>
            </div>

            <div>
              <div {...stylex.props(styles.sectionLabel)}>Navigation</div>
              <div {...stylex.props(styles.navList)}>
                <div {...stylex.props(styles.navItem, styles.navItemActive)}>All files</div>
                <div {...stylex.props(styles.navItem)}>Trash</div>
              </div>
            </div>

            <div>
              <div {...stylex.props(styles.sectionLabel)}>Accounts</div>
              <div {...stylex.props(styles.accountList)}>
                <div {...stylex.props(styles.accountCard)}>
                  <div {...stylex.props(styles.accountHeader)}>
                    <span {...stylex.props(styles.accountEmail)}>ale•••••••••01@gmail.com</span>
                    <span {...stylex.props(styles.statusPill)}>Active</span>
                  </div>
                  <div {...stylex.props(styles.accountMeta)}>11.4 GB / 14.25 GB</div>
                  <div {...stylex.props(styles.progressTrack)}>
                    <div {...stylex.props(styles.progressFillPrimary)} />
                  </div>
                </div>
                <div {...stylex.props(styles.accountCard)}>
                  <div {...stylex.props(styles.accountHeader)}>
                    <span {...stylex.props(styles.accountEmail)}>mar•••••••••02@gmail.com</span>
                    <span {...stylex.props(styles.statusPill)}>Active</span>
                  </div>
                  <div {...stylex.props(styles.accountMeta)}>8.2 GB / 14.25 GB</div>
                  <div {...stylex.props(styles.progressTrack)}>
                    <div {...stylex.props(styles.progressFillSecondary)} />
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div {...stylex.props(styles.sidebarFooter)}>
            <div {...stylex.props(styles.quotaRow)}>
              <span>Pool usage</span>
              <span>19.6 / 28.5 GB</span>
            </div>
            <div {...stylex.props(styles.progressTrack)}>
              <div {...stylex.props(styles.progressFillPool)} />
            </div>
          </div>
        </aside>

        <div {...stylex.props(styles.workspace)}>
          <div {...stylex.props(styles.topBar)}>
            <div {...stylex.props(styles.searchBox)}>Search files and folders...</div>
            <span {...stylex.props(styles.topBarMeta)}>Local index · 7 items</span>
          </div>

          <div {...stylex.props(styles.actionPortal)}>
            <div {...stylex.props(styles.breadcrumbs)}>
              <span>Main Pool</span>
              <span>/</span>
              <span>Projects</span>
              <span>/</span>
              <span {...stylex.props(styles.breadcrumbCurrent)}>2026</span>
            </div>
            <div {...stylex.props(styles.actionButtons)}>
              <span {...stylex.props(styles.btnSecondary)}>New folder</span>
              <span {...stylex.props(styles.btnPrimary)}>Upload</span>
            </div>
          </div>

          <div {...stylex.props(styles.tableWrap)}>
            <div {...stylex.props(styles.tableHeader)}>
              <span />
              <span>Name</span>
              <span {...stylex.props(styles.hideMobile)}>Account</span>
              <span>Size</span>
              <span {...stylex.props(styles.hideMobile)}>Modified</span>
            </div>
            {DUMMY_ROWS.map((row) => (
              <div
                key={row.id}
                {...stylex.props(styles.tableRow, row.selected && styles.tableRowSelected)}
              >
                <span
                  {...stylex.props(styles.checkbox, row.selected && styles.checkboxChecked)}
                />
                <div {...stylex.props(styles.nameCell)}>
                  {row.kind === 'folder' ? (
                    <svg
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      aria-hidden="true"
                      {...stylex.props(styles.folderIcon)}
                    >
                      <path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z" />
                    </svg>
                  ) : (
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      aria-hidden="true"
                      {...stylex.props(styles.fileIcon)}
                    >
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                    </svg>
                  )}
                  <span {...stylex.props(styles.nameText)}>{row.name}</span>
                </div>
                <span {...stylex.props(styles.monoCell, styles.hideMobile)}>{row.account}</span>
                <span {...stylex.props(styles.numCell)}>{row.size}</span>
                <span {...stylex.props(styles.numCell, styles.hideMobile)}>{row.modified}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
