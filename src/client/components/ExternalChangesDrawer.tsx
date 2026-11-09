import React, { useState, useEffect, useCallback, useRef } from 'react';
import * as stylex from '@stylexjs/stylex';
import { client } from '../api.js';
import { colors, spacing, radius, typography, motion } from '../tokens.stylex.js';
import { IconClose, IconAlertTriangle, IconFile, IconCheck, IconChevronDown } from './Icons.js';
import { formatBytes } from '../utils/format.js';

export interface ExternalDiscrepancyItem {
  driveFileId: string;
  name: string;
  virtualPath: string;
  sizeBytes: number;
  mimeType: string;
  accountId: string;
  discrepancyType: 'unindexed' | 'modified' | 'over_ceiling';
}

export interface DiscrepancyReport {
  accountId: string;
  scannedFiles: number;
  unindexed: ExternalDiscrepancyItem[];
  modified: ExternalDiscrepancyItem[];
  overCeiling: ExternalDiscrepancyItem[];
  missingRemote: Array<{
    fileId: string;
    driveFileId: string;
    virtualPath: string;
    accountId: string;
  }>;
}

interface ExternalChangesDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  accounts: Array<{
    id: string;
    displayName: string;
    email: string;
    quotaUsedBytes?: number;
    usableLimitBytes?: number;
    tsubasaUsedBytes?: number;
  }>;
  initialAccountId?: string;
  onResolved: () => Promise<void>;
}

const styles = stylex.create({
  backdrop: {
    position: 'fixed',
    inset: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    zIndex: 90,
    transition: motion.transitionFast,
  },
  drawer: {
    position: 'fixed',
    top: 0,
    right: 0,
    bottom: 0,
    width: '460px',
    maxWidth: '100vw',
    backgroundColor: colors.surface,
    borderLeftWidth: '1px',
    borderLeftStyle: 'solid',
    borderLeftColor: colors.borderSubtle,
    display: 'flex',
    flexDirection: 'column',
    zIndex: 100,
    boxSizing: 'border-box',
    transform: 'translateX(0)',
    transition: 'transform 0.25s ease-out',
    '@media (max-width: 768px)': {
      width: '100vw',
    },
  },
  drawerHeader: {
    height: '56px',
    paddingLeft: spacing.space6,
    paddingRight: spacing.space6,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexShrink: 0,
    backgroundColor: colors.surface,
  },
  titleGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space3,
  },
  title: {
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeTitle,
    fontWeight: typography.fontWeightTitle,
    color: colors.primaryText,
    margin: 0,
  },
  closeBtn: {
    backgroundColor: 'transparent',
    borderWidth: '0px',
    cursor: 'pointer',
    color: colors.secondaryText,
    padding: spacing.space2,
    borderRadius: radius.compact,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.rowHover,
      color: colors.primaryText,
    },
  },
  accountSelectorBar: {
    paddingTop: spacing.space3,
    paddingBottom: spacing.space3,
    paddingLeft: spacing.space6,
    paddingRight: spacing.space6,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
    backgroundColor: colors.surface,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.space3,
    flexShrink: 0,
  },
  selectWrapper: {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    minWidth: 0,
    flex: 1,
  },
  select: {
    appearance: 'none',
    WebkitAppearance: 'none',
    MozAppearance: 'none',
    width: '100%',
    height: '32px',
    lineHeight: '28px',
    paddingTop: '2px',
    paddingBottom: '2px',
    paddingLeft: spacing.space3,
    paddingRight: '28px',
    borderRadius: radius.compact,
    backgroundColor: colors.surface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    color: colors.primaryText,
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeMeta,
    fontWeight: '500',
    outline: 'none',
    cursor: 'pointer',
    boxSizing: 'border-box',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    transition: motion.transitionFast,
    ':hover': {
      borderColor: colors.brandAccent,
      backgroundColor: colors.surface,
    },
    ':focus': {
      borderColor: colors.brandAccent,
      boxShadow: `0 0 0 1px ${colors.brandAccent}`,
    },
  },
  selectChevron: {
    position: 'absolute',
    right: '8px',
    top: '50%',
    transform: 'translateY(-50%)',
    pointerEvents: 'none',
    color: colors.dimText,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  contentScroll: {
    flex: 1,
    overflowY: 'auto',
    padding: spacing.space5,
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space4,
  },
  sectionTitle: {
    fontSize: typography.fontSizeSection,
    fontWeight: typography.fontWeightSection,
    color: colors.primaryText,
    margin: 0,
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space2,
  },
  card: {
    padding: `${spacing.space3} ${spacing.space4}`,
    borderRadius: radius.card,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    backgroundColor: colors.surfaceAlt,
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space2,
  },
  cardOverCeiling: {
    borderColor: colors.dangerBorder,
    backgroundColor: colors.dangerSurface,
  },
  fileHeaderRow: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.space3,
  },
  fileTitleGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space3,
    minWidth: 0,
    flex: 1,
  },
  fileName: {
    fontSize: typography.fontSizeBody,
    fontWeight: '600',
    color: colors.primaryText,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  fileMeta: {
    fontSize: typography.fontSizeMeta,
    color: colors.secondaryText,
    fontVariantNumeric: 'tabular-nums',
  },
  cardDesc: {
    fontSize: '12px',
    color: colors.secondaryText,
    lineHeight: '1.4',
    margin: 0,
  },
  actionsRow: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space2,
    flexWrap: 'wrap',
    marginTop: spacing.space1,
  },
  btnPrimary: {
    height: '28px',
    paddingLeft: spacing.space3,
    paddingRight: spacing.space3,
    borderRadius: radius.button,
    backgroundColor: colors.brandAccent,
    color: colors.brandAccentText,
    borderWidth: '0px',
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeMeta,
    fontWeight: '600',
    cursor: 'pointer',
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.brandAccentHover,
    },
    ':disabled': {
      opacity: 0.5,
      cursor: 'not-allowed',
    },
  },
  btnSecondary: {
    height: '28px',
    paddingLeft: spacing.space3,
    paddingRight: spacing.space3,
    borderRadius: radius.button,
    backgroundColor: colors.surface,
    color: colors.primaryText,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeMeta,
    fontWeight: '500',
    cursor: 'pointer',
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.rowHover,
      borderColor: colors.border,
    },
    ':disabled': {
      opacity: 0.5,
      cursor: 'not-allowed',
    },
  },
  btnDanger: {
    height: '28px',
    paddingLeft: spacing.space3,
    paddingRight: spacing.space3,
    borderRadius: radius.button,
    backgroundColor: colors.danger,
    color: colors.dangerText,
    borderWidth: '0px',
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeMeta,
    fontWeight: '600',
    cursor: 'pointer',
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.dangerHover,
    },
    ':disabled': {
      opacity: 0.5,
      cursor: 'not-allowed',
    },
  },
  statusNoticeBanner: {
    padding: `${spacing.space4} ${spacing.space5}`,
    borderRadius: radius.compact,
    backgroundColor: colors.dangerSurface,
    color: colors.danger,
    fontSize: typography.fontSizeMeta,
  },
  cardList: {
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space4,
    marginTop: spacing.space4,
  },
  fileTitleCol: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    flex: 1,
    gap: spacing.space1,
  },
  fileVirtualPath: {
    fontSize: typography.fontSizeMeta,
    color: colors.dimText,
    fontFamily: typography.fontFamilyMono,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  rebalanceTitle: {
    fontSize: typography.fontSizeBody,
    fontWeight: '600',
    color: colors.primaryText,
  },
  scanningNoticeText: {
    fontSize: typography.fontSizeBody,
    color: colors.dimText,
  },
  emptyNoticeTitle: {
    fontSize: '14px',
    fontWeight: '600',
    color: colors.primaryText,
  },
  rebalanceBanner: {
    padding: `${spacing.space3} ${spacing.space4}`,
    borderRadius: radius.card,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    backgroundColor: colors.surfaceAlt,
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space2,
  },
  emptyNotice: {
    textAlign: 'center',
    padding: spacing.space10,
    color: colors.secondaryText,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: spacing.space2,
  },
  scanningNotice: {
    textAlign: 'center',
    padding: spacing.space10,
    color: colors.dimText,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: spacing.space2,
  },
});

export function ExternalChangesDrawer({
  isOpen,
  onClose,
  accounts,
  initialAccountId,
  onResolved,
}: ExternalChangesDrawerProps) {
  const [selectedAccount, setSelectedAccount] = useState<string>(() => {
    if (initialAccountId && accounts.some((a) => a.id === initialAccountId)) {
      return initialAccountId;
    }
    return accounts[0]?.id || '';
  });
  const [report, setReport] = useState<DiscrepancyReport | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [activeActionId, setActiveActionId] = useState<string | null>(null);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);

  const activeScanRef = useRef<string | null>(null);

  const currentAccount = accounts.find((a) => a.id === selectedAccount);
  const isBreached = currentAccount
    ? (currentAccount.quotaUsedBytes ?? 0) > (currentAccount.usableLimitBytes ?? 0)
    : false;
  const hasPoolFiles = (currentAccount?.tsubasaUsedBytes ?? 0) > 0;
  const showRebalance = isBreached && hasPoolFiles;

  useEffect(() => {
    if (initialAccountId && accounts.some((a) => a.id === initialAccountId)) {
      setSelectedAccount(initialAccountId);
    } else if (accounts.length > 0 && (!selectedAccount || !accounts.some((a) => a.id === selectedAccount))) {
      setSelectedAccount(accounts[0].id);
    }
  }, [initialAccountId, accounts]);

  const scanAccount = useCallback(async (accId: string) => {
    if (!accId) return;
    activeScanRef.current = accId;
    setIsScanning(true);
    setReport(null);
    setStatusNotice(null);

    try {
      const res = await client.api.sync['external-changes'][':accountId'].$get({
        param: { accountId: accId },
      });
      if (activeScanRef.current !== accId) return;

      if (res.ok) {
        const data = await res.json();
        if (activeScanRef.current === accId) {
          setReport(data as DiscrepancyReport);
        }
      } else {
        const errData = await res.json().catch(() => ({}));
        if (activeScanRef.current === accId) {
          setStatusNotice(('error' in errData ? errData.error : null) || `Scan failed (${res.status})`);
        }
      }
    } catch (err) {
      if (activeScanRef.current === accId) {
        setStatusNotice(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (activeScanRef.current === accId) {
        setIsScanning(false);
      }
    }
  }, []);

  useEffect(() => {
    if (isOpen && selectedAccount) {
      scanAccount(selectedAccount);
    }
    return () => {
      activeScanRef.current = null;
    };
  }, [isOpen, selectedAccount, scanAccount]);

  const handleAccept = async (item: ExternalDiscrepancyItem) => {
    setActiveActionId(item.driveFileId);
    try {
      const res = await client.api.sync.resolve.accept.$post({
        json: {
          accountId: item.accountId,
          driveFileId: item.driveFileId,
          targetVirtualPath: item.virtualPath,
        },
      });

      if (res.ok) {
        await scanAccount(selectedAccount);
        await onResolved();
      } else {
        const err = await res.json().catch(() => ({}));
        setStatusNotice(('error' in err ? err.error : null) || 'Failed to accept file');
      }
    } catch (err) {
      setStatusNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setActiveActionId(null);
    }
  };

  const handleMoveToRoot = async (item: ExternalDiscrepancyItem) => {
    setActiveActionId(item.driveFileId);
    try {
      const res = await client.api.sync.resolve['move-to-root'].$post({
        json: {
          accountId: item.accountId,
          driveFileId: item.driveFileId,
        },
      });

      if (res.ok) {
        await scanAccount(selectedAccount);
        await onResolved();
      } else {
        const err = await res.json().catch(() => ({}));
        setStatusNotice(('error' in err ? err.error : null) || 'Failed to eject file');
      }
    } catch (err) {
      setStatusNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setActiveActionId(null);
    }
  };

  const handleRemoveMissing = async (item: { driveFileId: string; accountId: string }) => {
    setActiveActionId(item.driveFileId);
    setStatusNotice(null);
    try {
      const res = await client.api.sync.resolve['remove-missing'].$post({
        json: {
          accountId: item.accountId,
          driveFileId: item.driveFileId,
        },
      });

      if (res.ok) {
        await scanAccount(selectedAccount);
        await onResolved();
      } else {
        const err = await res.json().catch(() => ({}));
        setStatusNotice(('error' in err ? err.error : null) || 'Failed to remove missing file');
      }
    } catch (err) {
      setStatusNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setActiveActionId(null);
    }
  };

  const handleAutoRebalance = async () => {
    if (!selectedAccount) return;
    setActiveActionId('rebalance');
    try {
      const res = await client.api.sync.rebalance.auto[':accountId'].$post({
        param: { accountId: selectedAccount },
      });

      if (res.ok) {
        const data = await res.json();
        const count = ('results' in data && Array.isArray(data.results)) ? data.results.length : 0;
        setStatusNotice(`Rebalance complete. ${count} files migrated.`);
        await scanAccount(selectedAccount);
        await onResolved();
      } else {
        const err = await res.json().catch(() => ({}));
        setStatusNotice(('error' in err ? err.error : null) || 'Auto-rebalance failed');
      }
    } catch (err) {
      setStatusNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setActiveActionId(null);
    }
  };

  if (!isOpen) return null;

  const totalDiscrepancies =
    (report?.overCeiling.length ?? 0) +
    (report?.unindexed.length ?? 0) +
    (report?.modified.length ?? 0) +
    (report?.missingRemote.length ?? 0);

  return (
    <>
      <div {...stylex.props(styles.backdrop)} onClick={onClose} />
      <div {...stylex.props(styles.drawer)} role="dialog" aria-modal="true" aria-label="External modifications">
        <div {...stylex.props(styles.drawerHeader)}>
          <div {...stylex.props(styles.titleGroup)}>
            <IconAlertTriangle size={18} />
            <h2 {...stylex.props(styles.title)}>External changes</h2>
          </div>
          <button type="button" {...stylex.props(styles.closeBtn)} onClick={onClose} aria-label="Close drawer">
            <IconClose size={16} />
          </button>
        </div>

        <div {...stylex.props(styles.accountSelectorBar)}>
          <div {...stylex.props(styles.selectWrapper)}>
            <select
              aria-label="Select connected account"
              title={(() => {
                const cur = accounts.find((a) => a.id === selectedAccount);
                return cur ? `${cur.displayName || cur.id} (${cur.email || cur.id})` : 'Select connected account';
              })()}
              {...stylex.props(styles.select)}
              value={selectedAccount}
              onChange={(e) => setSelectedAccount(e.target.value)}
              disabled={accounts.length === 0 || isScanning}
            >
              {accounts.length === 0 ? (
                <option value="" disabled>
                  No accounts with external changes
                </option>
              ) : (
                accounts.map((acc) => (
                  <option
                    key={acc.id}
                    value={acc.id}
                    title={`${acc.displayName || acc.id} (${acc.email || acc.id})`}
                  >
                    {acc.displayName || acc.id} ({acc.email || acc.id})
                  </option>
                ))
              )}
            </select>
            <div {...stylex.props(styles.selectChevron)}>
              <IconChevronDown size={11} strokeWidth={2.5} />
            </div>
          </div>
        </div>

        <div {...stylex.props(styles.contentScroll)}>
          {statusNotice && (
            <div {...stylex.props(styles.statusNoticeBanner)}>
              {statusNotice}
            </div>
          )}

          {/* Over-ceiling items */}
          {report?.overCeiling && report.overCeiling.length > 0 && (
            <div>
              <h3 {...stylex.props(styles.sectionTitle)}>
                <IconAlertTriangle size={16} color={colors.danger} />
                Over-ceiling files (&gt; 14.25 GB)
              </h3>
              <p {...stylex.props(styles.cardDesc)}>
                Files between 14.25 GB and 15 GB breach the 750 MB reserve ceiling. Accept into Tsubasa or eject outside Tsubasa Storage/ to preserve incoming email delivery.
              </p>
              <div {...stylex.props(styles.cardList)}>
                {report.overCeiling.map((item) => (
                  <div key={item.driveFileId} {...stylex.props(styles.card, styles.cardOverCeiling)}>
                    <div {...stylex.props(styles.fileHeaderRow)}>
                      <div {...stylex.props(styles.fileTitleGroup)}>
                        <IconFile size={16} />
                        <div {...stylex.props(styles.fileTitleCol)}>
                          <span {...stylex.props(styles.fileName)} title={item.virtualPath}>
                            {item.name}
                          </span>
                          <span
                            {...stylex.props(styles.fileVirtualPath)}
                            title={item.virtualPath}
                          >
                            {item.virtualPath}
                          </span>
                        </div>
                      </div>
                      <span {...stylex.props(styles.fileMeta)}>{formatBytes(item.sizeBytes)}</span>
                    </div>

                    <div {...stylex.props(styles.actionsRow)}>
                      <button
                        type="button"
                        {...stylex.props(styles.btnPrimary)}
                        onClick={() => handleAccept(item)}
                        disabled={activeActionId === item.driveFileId}
                      >
                        Accept into Tsubasa (Over-ceiling mode)
                      </button>
                      <button
                        type="button"
                        {...stylex.props(styles.btnDanger)}
                        onClick={() => handleMoveToRoot(item)}
                        disabled={activeActionId === item.driveFileId}
                      >
                        Move to root (Eject)
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Unindexed external additions */}
          {report?.unindexed && report.unindexed.length > 0 && (
            <div>
              <h3 {...stylex.props(styles.sectionTitle)}>
                Unindexed files added in Google Drive
              </h3>
              <div {...stylex.props(styles.cardList)}>
                {report.unindexed.map((item) => (
                  <div key={item.driveFileId} {...stylex.props(styles.card)}>
                    <div {...stylex.props(styles.fileHeaderRow)}>
                      <div {...stylex.props(styles.fileTitleGroup)}>
                        <IconFile size={16} />
                        <div {...stylex.props(styles.fileTitleCol)}>
                          <span {...stylex.props(styles.fileName)} title={item.virtualPath}>
                            {item.name}
                          </span>
                          <span
                            {...stylex.props(styles.fileVirtualPath)}
                            title={item.virtualPath}
                          >
                            {item.virtualPath}
                          </span>
                        </div>
                      </div>
                      <span {...stylex.props(styles.fileMeta)}>{formatBytes(item.sizeBytes)}</span>
                    </div>

                    <div {...stylex.props(styles.actionsRow)}>
                      <button
                        type="button"
                        {...stylex.props(styles.btnPrimary)}
                        onClick={() => handleAccept(item)}
                        disabled={activeActionId === item.driveFileId}
                      >
                        Accept into Tsubasa
                      </button>
                      <button
                        type="button"
                        {...stylex.props(styles.btnSecondary)}
                        onClick={() => handleMoveToRoot(item)}
                        disabled={activeActionId === item.driveFileId}
                      >
                        Eject to Drive root
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Modified files */}
          {report?.modified && report.modified.length > 0 && (
            <div>
              <h3 {...stylex.props(styles.sectionTitle)}>Modified files</h3>
              <div {...stylex.props(styles.cardList)}>
                {report.modified.map((item) => (
                  <div key={item.driveFileId} {...stylex.props(styles.card)}>
                    <div {...stylex.props(styles.fileHeaderRow)}>
                      <div {...stylex.props(styles.fileTitleGroup)}>
                        <IconFile size={16} />
                        <div {...stylex.props(styles.fileTitleCol)}>
                          <span {...stylex.props(styles.fileName)} title={item.virtualPath}>
                            {item.name}
                          </span>
                          <span
                            {...stylex.props(styles.fileVirtualPath)}
                            title={item.virtualPath}
                          >
                            {item.virtualPath}
                          </span>
                        </div>
                      </div>
                      <span {...stylex.props(styles.fileMeta)}>{formatBytes(item.sizeBytes)}</span>
                    </div>

                    <div {...stylex.props(styles.actionsRow)}>
                      <button
                        type="button"
                        {...stylex.props(styles.btnPrimary)}
                        onClick={() => handleAccept(item)}
                        disabled={activeActionId === item.driveFileId}
                      >
                        Accept update
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Missing or externally moved files */}
          {report?.missingRemote && report.missingRemote.length > 0 && (
            <div>
              <h3 {...stylex.props(styles.sectionTitle)}>
                <IconAlertTriangle size={16} color={colors.warning} />
                Missing or externally moved files
              </h3>
              <p {...stylex.props(styles.cardDesc)}>
                These files were moved outside the Tsubasa folder structure or removed directly in Google Drive.
              </p>
              <div {...stylex.props(styles.cardList)}>
                {report.missingRemote.map((item) => (
                  <div key={item.driveFileId} {...stylex.props(styles.card)}>
                    <div {...stylex.props(styles.fileHeaderRow)}>
                      <div {...stylex.props(styles.fileTitleGroup)}>
                        <IconFile size={16} />
                        <span {...stylex.props(styles.fileName)} title={item.virtualPath}>
                          {item.virtualPath}
                        </span>
                      </div>
                    </div>

                    <div {...stylex.props(styles.actionsRow)}>
                      <button
                        type="button"
                        {...stylex.props(styles.btnDanger)}
                        onClick={() => handleRemoveMissing(item)}
                        disabled={activeActionId === item.driveFileId}
                      >
                        Remove from Tsubasa
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Rebalance section */}
          {showRebalance && (
            <div {...stylex.props(styles.rebalanceBanner)}>
              <div {...stylex.props(styles.rebalanceTitle)}>
                Auto-rebalance files
              </div>
              <p {...stylex.props(styles.cardDesc)}>
                This account breached its 750 MB safety buffer. Auto-rebalance moves Tsubasa files to an emptier account in your pool to restore safe headroom.
              </p>
              <div>
                <button
                  type="button"
                  {...stylex.props(styles.btnSecondary)}
                  onClick={handleAutoRebalance}
                  disabled={activeActionId === 'rebalance'}
                >
                  {activeActionId === 'rebalance' ? 'Rebalancing...' : 'Auto-rebalance'}
                </button>
              </div>
            </div>
          )}

          {/* Scanning indicator */}
          {isScanning && (
            <div {...stylex.props(styles.scanningNotice)}>
              <div {...stylex.props(styles.scanningNoticeText)}>
                Scanning Drive for external changes...
              </div>
            </div>
          )}

          {/* Empty state when no accounts have changes */}
          {!isScanning && accounts.length === 0 && (
            <div {...stylex.props(styles.emptyNotice)}>
              <IconCheck size={28} color={colors.success} />
              <div {...stylex.props(styles.emptyNoticeTitle)}>
                All accounts in sync
              </div>
              <p {...stylex.props(styles.cardDesc)}>
                No external modifications or over-ceiling files detected across any connected drives.
              </p>
            </div>
          )}

          {/* Empty state for the selected account */}
          {!isScanning && report !== null && accounts.length > 0 && totalDiscrepancies === 0 && !showRebalance && (
            <div {...stylex.props(styles.emptyNotice)}>
              <IconCheck size={28} color={colors.success} />
              <div {...stylex.props(styles.emptyNoticeTitle)}>
                Account in sync
              </div>
              <p {...stylex.props(styles.cardDesc)}>
                No external modifications or over-ceiling files detected on {selectedAccount}.
              </p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

