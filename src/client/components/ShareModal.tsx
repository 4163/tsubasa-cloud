import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import * as stylex from '@stylexjs/stylex';
import { client } from '../api.js';
import type { InferResponseType } from 'hono/client';
import { colors, spacing, radius, layout, typography, motion } from '../tokens.stylex.js';
import {
  IconClose,
  IconShare,
  IconLink,
  IconMail,
  IconFolderFilled,
  IconFile,
  IconCheck,
  IconCopy,
  IconAlertTriangle,
} from './Icons.js';
import {
  formatBytes,
  maskEmail,
  copyTextToClipboard,
  COPY_FEEDBACK_DURATION_MS,
} from '../utils/format.js';
import { RedactedEmail } from './RedactedEmail.js';

export type ShareTargetItem = {
  kind: 'file' | 'folder';
  id: string;
  name: string;
  virtualPath: string;
};

type InspectResponse = InferResponseType<typeof client.api.share.inspect.$post, 200>;
type ValidateResponse = InferResponseType<typeof client.api.share.validate.$post, 200>;
type ExecuteResponse = InferResponseType<typeof client.api.share.execute.$post, 200>;
type EmptyShareAccount = InspectResponse['emptyAccounts'][number];

export type ShareExecuteResult = ExecuteResponse;

export interface ShareModalProps {
  isOpen: boolean;
  onClose: () => void;
  items: ShareTargetItem[];
  sourcePoolId: number;
  onComplete: (result: ShareExecuteResult) => Promise<void> | void;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseEmailTokens(raw: string): { valid: string[]; invalid: string[] } {
  const parts = raw
    .split(/[,\s;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const part of parts) {
    if (EMAIL_PATTERN.test(part)) {
      valid.push(part);
    } else {
      invalid.push(part);
    }
  }
  return { valid, invalid };
}

function getDriveStatusBadge(
  acc: EmptyShareAccount
): { label: string; tone: 'danger' | 'neutral' } | null {
  if (acc.isDisabled) return { label: 'Disabled', tone: 'danger' };
  if (!acc.authorized) return { label: 'Re-auth needed', tone: 'danger' };
  if (acc.syncState === 'error') return { label: 'Sync error', tone: 'danger' };
  if (acc.currentPoolIsShare) return { label: 'Already included', tone: 'neutral' };
  return null;
}

function isDriveSelectable(acc: EmptyShareAccount): boolean {
  return acc.authorized && !acc.isDisabled && acc.syncState !== 'error' && !acc.currentPoolIsShare;
}

function getAccountLabel(
  displayName: string | null | undefined,
  email: string,
  fallbackId: string
): string {
  return displayName && displayName !== email ? displayName : fallbackId;
}

const styles = stylex.create({
  backdrop: {
    position: 'fixed',
    inset: 0,
    backgroundColor: colors.modalBackdrop,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 110,
    padding: spacing.space4,
    boxSizing: 'border-box',
    transition: motion.transitionFast,
  },
  modal: {
    width: layout.shareModalWidth,
    maxWidth: '100%',
    maxHeight: 'calc(100vh - 32px)',
    backgroundColor: colors.surface,
    borderRadius: radius.card,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    zIndex: 120,
    boxSizing: 'border-box',
  },
  header: {
    height: '48px',
    paddingLeft: spacing.space5,
    paddingRight: spacing.space5,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.surface,
    flexShrink: 0,
  },
  titleGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space3,
    minWidth: 0,
  },
  title: {
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeSection,
    fontWeight: typography.fontWeightTitle,
    color: colors.primaryText,
    margin: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  closeBtn: {
    backgroundColor: 'transparent',
    borderWidth: '0px',
    cursor: 'pointer',
    color: colors.secondaryText,
    padding: spacing.space1,
    borderRadius: radius.compact,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    outline: 'none',
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.rowHover,
      color: colors.primaryText,
    },
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '1px',
    },
  },
  body: {
    padding: spacing.space5,
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space4,
    backgroundColor: colors.surface,
    overflowY: 'auto',
    flex: 1,
    minHeight: 0,
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minHeight: 0,
  },
  summaryCard: {
    padding: spacing.space3,
    borderRadius: radius.compact,
    backgroundColor: colors.surfaceAlt,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.space3,
  },
  summaryMain: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space3,
    minWidth: 0,
    flex: 1,
  },
  summaryIconWrap: {
    width: '32px',
    height: '32px',
    borderRadius: radius.compact,
    backgroundColor: colors.surface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    color: colors.secondaryText,
  },
  summaryIconFolder: {
    color: colors.poolGold,
  },
  summaryTextCol: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    minWidth: 0,
    flex: 1,
  },
  summaryTitle: {
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBody,
    fontWeight: typography.fontWeightTitle,
    color: colors.primaryText,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  summaryMeta: {
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeMeta,
    color: colors.secondaryText,
    fontVariantNumeric: 'tabular-nums',
  },
  summarySizePill: {
    fontFamily: typography.fontFamilyMono,
    fontSize: typography.fontSizeMeta,
    fontWeight: typography.fontWeightTitle,
    fontVariantNumeric: 'tabular-nums',
    color: colors.primaryText,
    backgroundColor: colors.surface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    borderRadius: radius.compact,
    paddingTop: '2px',
    paddingBottom: '2px',
    paddingLeft: spacing.space2,
    paddingRight: spacing.space2,
    flexShrink: 0,
  },
  loadingStrip: {
    padding: spacing.space4,
    borderRadius: radius.compact,
    backgroundColor: colors.surfaceAlt,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    fontSize: typography.fontSizeBody,
    color: colors.secondaryText,
    fontFamily: typography.fontFamilyBody,
  },
  dangerBanner: {
    padding: spacing.space3,
    borderRadius: radius.compact,
    backgroundColor: colors.dangerSurface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.dangerBorder,
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space1,
  },
  dangerBannerHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space2,
    color: colors.dangerTextOnSurface,
    fontSize: typography.fontSizeBody,
    fontWeight: typography.fontWeightTitle,
    fontFamily: typography.fontFamilyBody,
  },
  dangerBannerText: {
    margin: 0,
    fontSize: typography.fontSizeMeta,
    color: colors.dangerTextOnSurface,
    lineHeight: '1.4',
    fontVariantNumeric: 'tabular-nums',
  },
  successStrip: {
    padding: spacing.space3,
    borderRadius: radius.compact,
    backgroundColor: colors.successSurface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space2,
    color: colors.success,
    fontSize: typography.fontSizeMeta,
    fontWeight: typography.fontWeightTitle,
    fontFamily: typography.fontFamilyBody,
    fontVariantNumeric: 'tabular-nums',
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space2,
  },
  sectionHeaderRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.space2,
  },
  sectionLabel: {
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeMeta,
    fontWeight: typography.fontWeightTitle,
    color: colors.secondaryText,
  },
  optionalMeta: {
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeMeta,
    fontWeight: typography.fontWeightMeta,
    color: colors.dimText,
  },
  sectionHelperText: {
    margin: 0,
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeMeta,
    lineHeight: typography.lineHeightMeta,
    color: colors.secondaryText,
  },
  allocationPrompt: {
    margin: 0,
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBody,
    color: colors.primaryText,
    lineHeight: '1.4',
    fontVariantNumeric: 'tabular-nums',
  },
  meterBlock: {
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space1,
    padding: spacing.space3,
    borderRadius: radius.compact,
    backgroundColor: colors.surfaceAlt,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
  },
  meterTextRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.space2,
    fontSize: typography.fontSizeMeta,
    color: colors.secondaryText,
    fontVariantNumeric: 'tabular-nums',
  },
  meterValue: {
    fontFamily: typography.fontFamilyMono,
    fontWeight: typography.fontWeightTitle,
    color: colors.primaryText,
    fontVariantNumeric: 'tabular-nums',
  },
  meterTrack: {
    width: '100%',
    height: '6px',
    borderRadius: radius.pill,
    backgroundColor: colors.progressTrack,
    overflow: 'hidden',
  },
  meterFill: {
    height: '100%',
    borderRadius: radius.pill,
    backgroundColor: colors.brandAccent,
    transition: motion.transitionFast,
  },
  meterFillReady: {
    backgroundColor: colors.success,
  },
  autoSelectBtn: {
    height: '26px',
    paddingLeft: spacing.space3,
    paddingRight: spacing.space3,
    borderRadius: radius.compact,
    backgroundColor: colors.surface,
    color: colors.primaryText,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeMeta,
    fontWeight: typography.fontWeightTitle,
    cursor: 'pointer',
    outline: 'none',
    transition: motion.transitionFast,
    flexShrink: 0,
    ':hover': {
      backgroundColor: colors.rowHover,
      borderColor: colors.brandAccent,
    },
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '1px',
    },
    ':disabled': {
      opacity: 0.5,
      cursor: 'not-allowed',
    },
    '@media (pointer: coarse)': {
      minHeight: '36px',
    },
  },
  driveListContainer: {
    maxHeight: layout.shareDriveListMaxHeight,
    overflowY: 'auto',
    backgroundColor: colors.surfaceAlt,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    borderRadius: radius.compact,
    padding: spacing.space1,
    position: 'relative',
    boxSizing: 'border-box',
  },
  virtualTrack: {
    width: '100%',
    position: 'relative',
  },
  driveRow: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space3,
    paddingLeft: spacing.space3,
    paddingRight: spacing.space3,
    borderRadius: radius.compact,
    boxSizing: 'border-box',
    cursor: 'pointer',
    backgroundColor: 'transparent',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'transparent',
    textAlign: 'left',
    outline: 'none',
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.rowHover,
    },
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '-2px',
    },
    '@media (pointer: coarse)': {
      minHeight: '56px',
    },
  },
  driveRowSelected: {
    backgroundColor: colors.selectionBg,
    borderColor: colors.selectionBorder,
    ':hover': {
      backgroundColor: colors.selectionBg,
    },
  },
  driveRowDisabled: {
    opacity: 0.55,
    cursor: 'not-allowed',
    ':hover': {
      backgroundColor: 'transparent',
    },
  },
  checkbox: {
    width: '16px',
    height: '16px',
    borderRadius: radius.compact,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    backgroundColor: colors.surface,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    color: colors.accentGoldText,
    boxSizing: 'border-box',
    transition: motion.transitionFast,
  },
  checkboxChecked: {
    backgroundColor: colors.accentGold,
    borderColor: colors.accentGold,
    color: colors.accentGoldText,
  },
  driveInfoCol: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    minWidth: 0,
    flex: 1,
  },
  driveTopLine: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space2,
    minWidth: 0,
  },
  driveName: {
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBody,
    fontWeight: typography.fontWeightTitle,
    color: colors.primaryText,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  poolBadge: {
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBadge,
    fontWeight: typography.fontWeightBadge,
    color: colors.secondaryText,
    backgroundColor: colors.surface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    borderRadius: radius.compact,
    paddingTop: '1px',
    paddingBottom: '1px',
    paddingLeft: spacing.space2,
    paddingRight: spacing.space2,
    flexShrink: 0,
  },
  driveSubLine: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space2,
    minWidth: 0,
  },
  driveEmail: {
    fontFamily: typography.fontFamilyMono,
    fontSize: typography.fontSizeMeta,
    color: colors.secondaryText,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  driveStatusBadge: {
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBadge,
    fontWeight: typography.fontWeightBadge,
    color: colors.dangerTextOnSurface,
    backgroundColor: colors.dangerSurface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.dangerBorder,
    borderRadius: radius.compact,
    paddingTop: '1px',
    paddingBottom: '1px',
    paddingLeft: spacing.space2,
    paddingRight: spacing.space2,
    flexShrink: 0,
  },
  driveHeadroom: {
    fontFamily: typography.fontFamilyMono,
    fontSize: typography.fontSizeMeta,
    fontWeight: typography.fontWeightTitle,
    fontVariantNumeric: 'tabular-nums',
    color: colors.primaryText,
    flexShrink: 0,
  },
  emptyDriveNotice: {
    padding: spacing.space4,
    borderRadius: radius.compact,
    backgroundColor: colors.surfaceAlt,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    fontSize: typography.fontSizeMeta,
    color: colors.secondaryText,
  },
  emailInputRow: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space2,
  },
  emailBox: {
    flex: 1,
    minWidth: 0,
    minHeight: '36px',
    paddingTop: spacing.space1,
    paddingBottom: spacing.space1,
    paddingLeft: spacing.space3,
    paddingRight: spacing.space2,
    borderRadius: radius.compact,
    backgroundColor: colors.surfaceAlt,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.space1,
    boxSizing: 'border-box',
    transition: motion.transitionFast,
    ':focus-within': {
      borderColor: colors.focusRing,
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '-1px',
    },
  },
  emailInputIcon: {
    color: colors.secondaryText,
    display: 'inline-flex',
    alignItems: 'center',
    marginRight: spacing.space1,
    flexShrink: 0,
  },
  emailChip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: spacing.space1,
    paddingTop: '2px',
    paddingBottom: '2px',
    paddingLeft: spacing.space2,
    paddingRight: spacing.space1,
    borderRadius: radius.compact,
    backgroundColor: colors.selectionBg,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    color: colors.primaryText,
    fontFamily: typography.fontFamilyMono,
    fontSize: typography.fontSizeMeta,
    maxWidth: '100%',
  },
  chipText: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  chipRemoveBtn: {
    backgroundColor: 'transparent',
    borderWidth: '0px',
    padding: '2px',
    cursor: 'pointer',
    color: colors.secondaryText,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.compact,
    outline: 'none',
    ':hover': {
      color: colors.dangerTextOnSurface,
      backgroundColor: colors.dangerSurface,
    },
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
    },
  },
  emailTextInput: {
    flex: 1,
    minWidth: '140px',
    height: '26px',
    borderWidth: '0px',
    backgroundColor: 'transparent',
    color: colors.primaryText,
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBody,
    outline: 'none',
    padding: '0px',
  },
  addEmailBtn: {
    height: '36px',
    paddingLeft: spacing.space3,
    paddingRight: spacing.space3,
    borderRadius: radius.compact,
    backgroundColor: colors.surfaceAlt,
    color: colors.primaryText,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeMeta,
    fontWeight: typography.fontWeightTitle,
    cursor: 'pointer',
    flexShrink: 0,
    outline: 'none',
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.rowHover,
      borderColor: colors.primaryText,
    },
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '1px',
    },
    ':disabled': {
      opacity: 0.5,
      cursor: 'not-allowed',
    },
  },
  inlineErrorText: {
    fontSize: typography.fontSizeMeta,
    color: colors.dangerTextOnSurface,
    fontFamily: typography.fontFamilyBody,
  },
  noteTextarea: {
    width: '100%',
    minHeight: '64px',
    padding: spacing.space3,
    borderRadius: radius.compact,
    backgroundColor: colors.surfaceAlt,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    color: colors.primaryText,
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBody,
    lineHeight: '1.4',
    resize: 'vertical',
    boxSizing: 'border-box',
    outline: 'none',
    transition: motion.transitionFast,
    ':focus-visible': {
      borderColor: colors.focusRing,
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '-1px',
    },
  },
  linkCard: {
    padding: spacing.space3,
    borderRadius: radius.compact,
    backgroundColor: colors.surfaceAlt,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space2,
  },
  linkCardTop: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.space2,
  },
  linkAccountCol: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1px',
    minWidth: 0,
    flex: 1,
  },
  linkAccountName: {
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBody,
    fontWeight: typography.fontWeightTitle,
    color: colors.primaryText,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  linkAccountEmail: {
    fontFamily: typography.fontFamilyMono,
    fontSize: typography.fontSizeMeta,
    color: colors.secondaryText,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  coveragePill: {
    fontFamily: typography.fontFamilyMono,
    fontSize: typography.fontSizeBadge,
    fontWeight: typography.fontWeightBadge,
    fontVariantNumeric: 'tabular-nums',
    color: colors.primaryText,
    backgroundColor: colors.surface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    borderRadius: radius.compact,
    paddingTop: '2px',
    paddingBottom: '2px',
    paddingLeft: spacing.space2,
    paddingRight: spacing.space2,
    flexShrink: 0,
  },
  urlRow: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space2,
  },
  urlInput: {
    flex: 1,
    minWidth: 0,
    height: '32px',
    paddingLeft: spacing.space3,
    paddingRight: spacing.space3,
    borderRadius: radius.compact,
    backgroundColor: colors.surface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    color: colors.primaryText,
    fontFamily: typography.fontFamilyMono,
    fontSize: typography.fontSizeMeta,
    outline: 'none',
    boxSizing: 'border-box',
    ':focus-visible': {
      borderColor: colors.focusRing,
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '-1px',
    },
  },
  copyBtn: {
    height: '32px',
    paddingLeft: spacing.space3,
    paddingRight: spacing.space3,
    borderRadius: radius.compact,
    backgroundColor: colors.surface,
    color: colors.primaryText,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeMeta,
    fontWeight: typography.fontWeightTitle,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: spacing.space1,
    flexShrink: 0,
    outline: 'none',
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.rowHover,
      borderColor: colors.brandAccent,
    },
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '1px',
    },
  },
  copyBtnCopied: {
    backgroundColor: colors.successSurface,
    borderColor: colors.success,
    color: colors.success,
  },
  resultListContainer: {
    maxHeight: layout.shareResultListMaxHeight,
    overflowY: 'auto',
    position: 'relative',
  },
  virtualRowItem: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    paddingBottom: spacing.space2,
    boxSizing: 'border-box',
  },
  emailDeliveryRow: {
    padding: spacing.space2,
    paddingLeft: spacing.space3,
    paddingRight: spacing.space3,
    borderRadius: radius.compact,
    backgroundColor: colors.surfaceAlt,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.space2,
  },
  emailDeliveryLeft: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1px',
    minWidth: 0,
    flex: 1,
  },
  emailDeliveryTarget: {
    fontFamily: typography.fontFamilyMono,
    fontSize: typography.fontSizeMeta,
    color: colors.primaryText,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  emailDeliveryDrive: {
    fontFamily: typography.fontFamilyMono,
    fontSize: typography.fontSizeBadge,
    color: colors.secondaryText,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  deliveryBadgeOk: {
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBadge,
    fontWeight: typography.fontWeightBadge,
    color: colors.success,
    backgroundColor: colors.successSurface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    borderRadius: radius.compact,
    paddingTop: '2px',
    paddingBottom: '2px',
    paddingLeft: spacing.space2,
    paddingRight: spacing.space2,
    flexShrink: 0,
  },
  deliveryBadgeFail: {
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBadge,
    fontWeight: typography.fontWeightBadge,
    color: colors.dangerTextOnSurface,
    backgroundColor: colors.dangerSurface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.dangerBorder,
    borderRadius: radius.compact,
    paddingTop: '2px',
    paddingBottom: '2px',
    paddingLeft: spacing.space2,
    paddingRight: spacing.space2,
    flexShrink: 0,
    maxWidth: layout.deliveryBadgeMaxWidth,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  footer: {
    paddingLeft: spacing.space5,
    paddingRight: spacing.space5,
    paddingTop: spacing.space3,
    paddingBottom: spacing.space3,
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: colors.borderSubtle,
    backgroundColor: colors.surface,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing.space2,
    flexShrink: 0,
  },
  cancelBtn: {
    height: '32px',
    paddingLeft: spacing.space4,
    paddingRight: spacing.space4,
    borderRadius: radius.compact,
    backgroundColor: colors.surface,
    color: colors.secondaryText,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBody,
    fontWeight: '500',
    cursor: 'pointer',
    outline: 'none',
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.rowHover,
      color: colors.primaryText,
      borderColor: colors.primaryText,
    },
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '1px',
    },
    ':disabled': {
      opacity: 0.5,
      cursor: 'not-allowed',
    },
    '@media (pointer: coarse)': {
      minHeight: '56px',
    },
  },
  confirmBtn: {
    height: '32px',
    paddingLeft: spacing.space5,
    paddingRight: spacing.space5,
    borderRadius: radius.compact,
    backgroundColor: colors.brandAccent,
    color: colors.brandAccentText,
    borderWidth: '0px',
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBody,
    fontWeight: typography.fontWeightTitle,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: spacing.space2,
    outline: 'none',
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.brandAccentHover,
    },
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '1px',
    },
    ':disabled': {
      opacity: 0.5,
      cursor: 'not-allowed',
    },
    '@media (pointer: coarse)': {
      minHeight: '56px',
    },
  },
});

export function ShareModal({
  isOpen,
  onClose,
  items,
  sourcePoolId,
  onComplete,
}: ShareModalProps) {
  const [inspectData, setInspectData] = useState<InspectResponse | null>(null);
  const [isInspecting, setIsInspecting] = useState(false);
  const [inspectError, setInspectError] = useState<string | null>(null);

  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const [validationData, setValidationData] = useState<ValidateResponse | null>(null);
  const [isValidating, setIsValidating] = useState(false);

  const [emailChips, setEmailChips] = useState<string[]>([]);
  const [emailInput, setEmailInput] = useState('');
  const [emailInputError, setEmailInputError] = useState<string | null>(null);
  const [emailMessage, setEmailMessage] = useState('');

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [executeResult, setExecuteResult] = useState<ExecuteResponse | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [isCoarsePointer, setIsCoarsePointer] = useState(false);

  const driveListRef = useRef<HTMLDivElement | null>(null);
  const linksListRef = useRef<HTMLDivElement | null>(null);
  const deliveriesListRef = useRef<HTMLDivElement | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia('(pointer: coarse)');
    setIsCoarsePointer(mql.matches);
    const onChange = (e: MediaQueryListEvent) => setIsCoarsePointer(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  // Reset state cleanly on close/open and run inspect on open
  useEffect(() => {
    if (!isOpen || items.length === 0) {
      setInspectData(null);
      setIsInspecting(false);
      setInspectError(null);
      setSelectedAccountIds([]);
      setValidationData(null);
      setIsValidating(false);
      setEmailChips([]);
      setEmailInput('');
      setEmailInputError(null);
      setEmailMessage('');
      setIsSubmitting(false);
      setSubmitError(null);
      setExecuteResult(null);
      setCopiedKey(null);
      return;
    }

    let cancelled = false;
    setInspectData(null);
    setIsInspecting(true);
    setInspectError(null);
    setSelectedAccountIds([]);
    setValidationData(null);
    setIsValidating(false);
    setEmailChips([]);
    setEmailInput('');
    setEmailInputError(null);
    setEmailMessage('');
    setIsSubmitting(false);
    setSubmitError(null);
    setExecuteResult(null);
    setCopiedKey(null);

    (async () => {
      try {
        const res = await client.api.share.inspect.$post({
          json: {
            sourcePoolId,
            items: items.map((i) => ({ kind: i.kind, id: i.id })),
          },
        });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (res.ok) {
          setInspectData(data as InspectResponse);
        } else {
          setInspectError(
            ('error' in data ? (data.error as string) : null) || 'Failed to inspect share targets'
          );
        }
      } catch (err) {
        if (!cancelled) {
          setInspectError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) {
          setIsInspecting(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isOpen, items, sourcePoolId]);

  const needsExpansion = Boolean(
    inspectData && !inspectData.sharePoolFitsWithoutExpansion && inspectData.overCeilingFiles.length === 0
  );

  // Live validation whenever selectedAccountIds changes while expansion is needed
  useEffect(() => {
    if (!isOpen || !needsExpansion || items.length === 0) {
      setValidationData(null);
      setIsValidating(false);
      return;
    }

    if (selectedAccountIds.length === 0) {
      setValidationData(null);
      setIsValidating(false);
      return;
    }

    let cancelled = false;
    setIsValidating(true);

    (async () => {
      try {
        const res = await client.api.share.validate.$post({
          json: {
            sourcePoolId,
            items: items.map((i) => ({ kind: i.kind, id: i.id })),
            selectedAccountIds,
          },
        });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (res.ok) {
          setValidationData(data as ValidateResponse);
        } else {
          setValidationData({
            valid: false,
            reason: ('error' in data ? (data.error as string) : null) || 'Validation failed',
            totalAvailableHeadroomBytes: 0,
            requiredBytes: inspectData?.totalBytes ?? 0,
          });
        }
      } catch (err) {
        if (!cancelled) {
          setValidationData({
            valid: false,
            reason: err instanceof Error ? err.message : String(err),
            totalAvailableHeadroomBytes: 0,
            requiredBytes: inspectData?.totalBytes ?? 0,
          });
        }
      } finally {
        if (!cancelled) {
          setIsValidating(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isOpen, needsExpansion, selectedAccountIds, items, sourcePoolId, inspectData?.totalBytes]);

  const emptyAccounts = inspectData?.emptyAccounts ?? [];
  const driveVirtualizer = useVirtualizer({
    count: emptyAccounts.length,
    getScrollElement: () => driveListRef.current,
    estimateSize: () => (isCoarsePointer ? 58 : 50),
    overscan: 5,
  });

  const linksVirtualizer = useVirtualizer({
    count: executeResult?.links.length ?? 0,
    getScrollElement: () => linksListRef.current,
    estimateSize: () => 96,
    overscan: 4,
  });

  const deliveriesVirtualizer = useVirtualizer({
    count: executeResult?.emailDeliveries.length ?? 0,
    getScrollElement: () => deliveriesListRef.current,
    estimateSize: () => 52,
    overscan: 5,
  });

  const neededBytes = useMemo(() => {
    if (!inspectData) return 0;
    if (
      inspectData.sharePoolExists &&
      inspectData.existingSharePoolAccountCount > 0 &&
      inspectData.shortfallBytes > 0
    ) {
      return inspectData.shortfallBytes;
    }
    return inspectData.totalBytes;
  }, [inspectData]);

  const selectedHeadroomBytes = useMemo(() => {
    if (selectedAccountIds.length === 0) return 0;
    const selectedSet = new Set(selectedAccountIds);
    return emptyAccounts.reduce(
      (sum, acc) => (selectedSet.has(acc.id) ? sum + acc.headroomBytes : sum),
      0
    );
  }, [emptyAccounts, selectedAccountIds]);

  const eligibleEmptyAccounts = useMemo(
    () => emptyAccounts.filter((acc) => isDriveSelectable(acc)),
    [emptyAccounts]
  );

  const handleToggleAccount = useCallback(
    (acc: EmptyShareAccount) => {
      if (isSubmitting || !isDriveSelectable(acc)) return;
      setSubmitError(null);
      setSelectedAccountIds((prev) =>
        prev.includes(acc.id) ? prev.filter((id) => id !== acc.id) : [...prev, acc.id]
      );
    },
    [isSubmitting]
  );

  const handleAutoSelect = useCallback(() => {
    if (eligibleEmptyAccounts.length === 0) return;
    setSubmitError(null);
    const sorted = [...eligibleEmptyAccounts].sort((a, b) => {
      if (b.headroomBytes !== a.headroomBytes) {
        return b.headroomBytes - a.headroomBytes;
      }
      return a.email.localeCompare(b.email, undefined, { sensitivity: 'base' });
    });

    const picked: string[] = [];
    let covered = 0;
    for (const acc of sorted) {
      picked.push(acc.id);
      covered += acc.headroomBytes;
      if (neededBytes === 0 || covered >= neededBytes) {
        break;
      }
    }
    setSelectedAccountIds(picked);
  }, [eligibleEmptyAccounts, neededBytes]);

  const addEmailsFromText = useCallback(
    (raw: string): boolean => {
      const trimmed = raw.trim();
      if (!trimmed) return true;
      const { valid, invalid } = parseEmailTokens(trimmed);
      if (invalid.length > 0) {
        setEmailInputError(`Invalid email: ${invalid[0]}`);
        return false;
      }
      if (valid.length === 0) return true;
      setEmailChips((prev) => {
        const seen = new Set(prev.map((e) => e.toLowerCase()));
        const next = [...prev];
        for (const email of valid) {
          const key = email.toLowerCase();
          if (!seen.has(key)) {
            seen.add(key);
            next.push(email);
          }
        }
        return next;
      });
      setEmailInput('');
      setEmailInputError(null);
      return true;
    },
    []
  );

  const handleEmailKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addEmailsFromText(emailInput);
    } else if (e.key === 'Backspace' && emailInput === '' && emailChips.length > 0) {
      setEmailChips((prev) => prev.slice(0, -1));
    }
  };

  const handleCopyText = async (key: string, text: string) => {
    const ok = await copyTextToClipboard(text);
    if (!ok) return;
    setCopiedKey(key);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => {
      setCopiedKey((prev) => (prev === key ? null : prev));
    }, COPY_FEEDBACK_DURATION_MS);
  };

  const handleDismiss = useCallback(() => {
    if (isSubmitting) return;
    onClose();
  }, [isSubmitting, onClose]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      handleDismiss();
    }
  };

  if (!isOpen || items.length === 0) return null;

  const showNoteField = emailChips.length > 0 || emailInput.trim().length > 0;

  const hasOverCeiling = (inspectData?.overCeilingFiles.length ?? 0) > 0;
  const allocationReady = Boolean(
    inspectData &&
      !hasOverCeiling &&
      (inspectData.sharePoolFitsWithoutExpansion || validationData?.valid)
  );
  const canSubmit = !isInspecting && !isValidating && !isSubmitting && allocationReady;

  const summaryTitle =
    items.length === 1
      ? items[0].name
      : `${items[0].name} + ${items.length - 1} ${items.length - 1 === 1 ? 'other' : 'others'}`;

  const summaryHasFolder = items.some((i) => i.kind === 'folder');

  const meterPercent =
    neededBytes === 0
      ? selectedAccountIds.length > 0
        ? 100
        : 0
      : Math.min(100, Math.round((selectedHeadroomBytes / neededBytes) * 100));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inspectData || isSubmitting || isValidating) return;

    let finalEmails = [...emailChips];
    if (emailInput.trim()) {
      const parsed = parseEmailTokens(emailInput);
      if (parsed.invalid.length > 0) {
        setEmailInputError(`Invalid email: ${parsed.invalid[0]}`);
        return;
      }
      const seen = new Set(finalEmails.map((em) => em.toLowerCase()));
      for (const em of parsed.valid) {
        if (!seen.has(em.toLowerCase())) {
          seen.add(em.toLowerCase());
          finalEmails.push(em);
        }
      }
      setEmailChips(finalEmails);
      setEmailInput('');
      setEmailInputError(null);
    }

    if (!allocationReady) return;

    setIsSubmitting(true);
    setSubmitError(null);

    try {
      const res = await client.api.share.execute.$post({
        json: {
          sourcePoolId,
          items: items.map((i) => ({ kind: i.kind, id: i.id })),
          selectedAccountIds: inspectData.sharePoolFitsWithoutExpansion ? [] : selectedAccountIds,
          recipientEmails: finalEmails,
          emailMessage: emailMessage.trim() || undefined,
        },
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const executed = data as ExecuteResponse;
        setExecuteResult(executed);
        void onComplete(executed);
      } else {
        setSubmitError(
          ('error' in data ? (data.error as string) : null) || 'Failed to share items'
        );
      }
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  const linksWithUrl = executeResult?.links.filter((l) => Boolean(l.webViewLink)) ?? [];

  return (
    <div
      {...stylex.props(styles.backdrop)}
      onClick={handleDismiss}
      onKeyDown={handleKeyDown}
    >
      <div
        {...stylex.props(styles.modal)}
        role="dialog"
        aria-modal="true"
        aria-label={executeResult ? 'Share links ready' : 'Share via Drive'}
        onClick={(e) => e.stopPropagation()}
      >
        <div {...stylex.props(styles.header)}>
          <div {...stylex.props(styles.titleGroup)}>
            {executeResult ? <IconLink size={16} /> : <IconShare size={16} />}
            <h2 {...stylex.props(styles.title)}>
              {executeResult ? 'Share links ready' : 'Share via Drive'}
            </h2>
          </div>
          <button
            type="button"
            {...stylex.props(styles.closeBtn)}
            onClick={handleDismiss}
            disabled={isSubmitting}
            aria-label="Close"
          >
            <IconClose size={16} />
          </button>
        </div>

        {executeResult ? (
          <>
            <div {...stylex.props(styles.body)}>
              <div {...stylex.props(styles.successStrip)}>
                <IconCheck size={15} />
                <span>
                  Shared {executeResult.fileCount} {executeResult.fileCount === 1 ? 'file' : 'files'}
                  {executeResult.folderCount > 0
                    ? ` and ${executeResult.folderCount} ${executeResult.folderCount === 1 ? 'folder' : 'folders'}`
                    : ''}{' '}
                  ({formatBytes(executeResult.totalBytes)}) via _Tsubasa~ Pool share/
                  {executeResult.batchFolderName}
                </span>
              </div>

              {executeResult.links.length > 0 && (
                <div {...stylex.props(styles.section)}>
                  <div {...stylex.props(styles.sectionHeaderRow)}>
                    <span {...stylex.props(styles.sectionLabel)}>
                      Participating Share Pool drives ({executeResult.links.length})
                    </span>
                    {linksWithUrl.length > 1 && (
                      <button
                        type="button"
                        {...stylex.props(
                          styles.copyBtn,
                          copiedKey === 'all' && styles.copyBtnCopied
                        )}
                        onClick={() =>
                          void handleCopyText(
                            'all',
                            linksWithUrl.map((l) => l.webViewLink!).join('\n')
                          )
                        }
                      >
                        {copiedKey === 'all' ? <IconCheck size={13} /> : <IconCopy size={13} />}
                        {copiedKey === 'all' ? 'Copied all' : 'Copy all links'}
                      </button>
                    )}
                  </div>

                  <div ref={linksListRef} {...stylex.props(styles.resultListContainer)}>
                    <div
                      {...stylex.props(styles.virtualTrack)}
                      style={{ height: `${linksVirtualizer.getTotalSize()}px` }}
                    >
                      {linksVirtualizer.getVirtualItems().map((virtualRow) => {
                        const link = executeResult.links[virtualRow.index];
                        if (!link) return null;
                        const displayName = getAccountLabel(
                          link.accountDisplayName,
                          link.accountEmail,
                          link.accountId
                        );
                        const isCopied = copiedKey === link.accountId;
                        return (
                          <div
                            key={link.accountId}
                            ref={linksVirtualizer.measureElement}
                            data-index={virtualRow.index}
                            {...stylex.props(styles.virtualRowItem)}
                            style={{ transform: `translateY(${virtualRow.start}px)` }}
                          >
                            <div {...stylex.props(styles.linkCard)}>
                              <div {...stylex.props(styles.linkCardTop)}>
                                <div {...stylex.props(styles.linkAccountCol)}>
                                  <span {...stylex.props(styles.linkAccountName)}>{displayName}</span>
                                  <RedactedEmail
                                    email={link.accountEmail}
                                    style={styles.linkAccountEmail}
                                  />
                                </div>
                                <span {...stylex.props(styles.coveragePill)}>
                                  {link.filesCount} {link.filesCount === 1 ? 'file' : 'files'} ·{' '}
                                  {formatBytes(link.bytesAllocated)}
                                </span>
                              </div>

                              {link.webViewLink && (
                                <div {...stylex.props(styles.urlRow)}>
                                  <input
                                    type="text"
                                    readOnly
                                    value={link.webViewLink}
                                    aria-label={`Share link for ${maskEmail(link.accountEmail)}`}
                                    onClick={(e) => e.currentTarget.select()}
                                    {...stylex.props(styles.urlInput)}
                                  />
                                  <button
                                    type="button"
                                    {...stylex.props(styles.copyBtn, isCopied && styles.copyBtnCopied)}
                                    onClick={() => void handleCopyText(link.accountId, link.webViewLink!)}
                                  >
                                    {isCopied ? <IconCheck size={13} /> : <IconCopy size={13} />}
                                    {isCopied ? 'Copied' : 'Copy link'}
                                  </button>
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}

              {executeResult.emailDeliveries.length > 0 && (
                <div {...stylex.props(styles.section)}>
                  <span {...stylex.props(styles.sectionLabel)}>Email invitations</span>
                  <div ref={deliveriesListRef} {...stylex.props(styles.resultListContainer)}>
                    <div
                      {...stylex.props(styles.virtualTrack)}
                      style={{ height: `${deliveriesVirtualizer.getTotalSize()}px` }}
                    >
                      {deliveriesVirtualizer.getVirtualItems().map((virtualRow) => {
                        const delivery = executeResult.emailDeliveries[virtualRow.index];
                        if (!delivery) return null;
                        return (
                          <div
                            key={`${delivery.accountId}-${delivery.email}-${virtualRow.index}`}
                            ref={deliveriesVirtualizer.measureElement}
                            data-index={virtualRow.index}
                            {...stylex.props(styles.virtualRowItem)}
                            style={{ transform: `translateY(${virtualRow.start}px)` }}
                          >
                            <div {...stylex.props(styles.emailDeliveryRow)}>
                              <div {...stylex.props(styles.emailDeliveryLeft)}>
                                <RedactedEmail
                                  email={delivery.email}
                                  style={styles.emailDeliveryTarget}
                                />
                                <RedactedEmail
                                  email={delivery.accountEmail}
                                  prefix="via "
                                  style={styles.emailDeliveryDrive}
                                />
                              </div>
                              {delivery.success ? (
                                <span {...stylex.props(styles.deliveryBadgeOk)}>Sent via Drive</span>
                              ) : (
                                <span
                                  {...stylex.props(styles.deliveryBadgeFail)}
                                  title={delivery.error || 'Failed'}
                                >
                                  {delivery.error || 'Failed'}
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div {...stylex.props(styles.footer)}>
              <button
                type="button"
                {...stylex.props(styles.confirmBtn)}
                onClick={handleDismiss}
              >
                Done
              </button>
            </div>
          </>
        ) : (
          <form onSubmit={handleSubmit} {...stylex.props(styles.form)}>
            <div {...stylex.props(styles.body)}>
              {/* Target item summary card */}
              <div {...stylex.props(styles.summaryCard)}>
                <div {...stylex.props(styles.summaryMain)}>
                  <div
                    {...stylex.props(
                      styles.summaryIconWrap,
                      summaryHasFolder && styles.summaryIconFolder
                    )}
                  >
                    {summaryHasFolder ? <IconFolderFilled size={18} /> : <IconFile size={16} />}
                  </div>
                  <div {...stylex.props(styles.summaryTextCol)}>
                    <span {...stylex.props(styles.summaryTitle)} title={summaryTitle}>
                      {summaryTitle}
                    </span>
                    <span {...stylex.props(styles.summaryMeta)}>
                      {inspectData
                        ? `${inspectData.folderCount} ${inspectData.folderCount === 1 ? 'folder' : 'folders'} · ${inspectData.fileCount} ${inspectData.fileCount === 1 ? 'file' : 'files'}`
                        : `${items.length} selected ${items.length === 1 ? 'item' : 'items'}`}
                    </span>
                  </div>
                </div>
                <span {...stylex.props(styles.summarySizePill)}>
                  {inspectData ? formatBytes(inspectData.totalBytes) : '—'}
                </span>
              </div>

              {isInspecting && (
                <div {...stylex.props(styles.loadingStrip)}>
                  Inspecting Share Pool capacity and target files...
                </div>
              )}

              {inspectError && (
                <div {...stylex.props(styles.dangerBanner)}>
                  <div {...stylex.props(styles.dangerBannerHeader)}>
                    <IconAlertTriangle size={15} />
                    <span>Inspection failed</span>
                  </div>
                  <p {...stylex.props(styles.dangerBannerText)}>{inspectError}</p>
                </div>
              )}

              {inspectData && hasOverCeiling && (
                <div {...stylex.props(styles.dangerBanner)}>
                  <div {...stylex.props(styles.dangerBannerHeader)}>
                    <IconAlertTriangle size={15} />
                    <span>Exceeds 14.25 GB single-drive limit</span>
                  </div>
                  <p {...stylex.props(styles.dangerBannerText)}>
                    {inspectData.overCeilingFiles
                      .map((f) => `${f.name} (${formatBytes(f.sizeBytes)})`)
                      .join(', ')}{' '}
                    cannot be placed on a single Google Drive account.
                  </p>
                </div>
              )}

              {/* Conditional allocation panel */}
              {inspectData && !hasOverCeiling && inspectData.sharePoolFitsWithoutExpansion && (
                <div {...stylex.props(styles.successStrip)}>
                  <IconCheck size={15} />
                  <span>
                    Using Share Pool free space ·{' '}
                    {formatBytes(inspectData.existingSharePoolHeadroomBytes)} available of{' '}
                    {formatBytes(inspectData.totalBytes)} needed
                  </span>
                </div>
              )}

              {inspectData && !hasOverCeiling && !inspectData.sharePoolFitsWithoutExpansion && (
                <div {...stylex.props(styles.section)}>
                  <div {...stylex.props(styles.sectionHeaderRow)}>
                    <span {...stylex.props(styles.sectionLabel)}>Share Pool allocation</span>
                    <button
                      type="button"
                      {...stylex.props(styles.autoSelectBtn)}
                      onClick={handleAutoSelect}
                      disabled={eligibleEmptyAccounts.length === 0 || isSubmitting}
                    >
                      Auto-select
                    </button>
                  </div>

                  <p {...stylex.props(styles.allocationPrompt)}>
                    Share Pool size of {formatBytes(neededBytes)} is needed. Please select empty
                    drive(s) to use for the Share Pool.
                  </p>

                  <div {...stylex.props(styles.meterBlock)}>
                    <div {...stylex.props(styles.meterTextRow)}>
                      <span>
                        Selected headroom:{' '}
                        <span {...stylex.props(styles.meterValue)}>
                          {formatBytes(selectedHeadroomBytes)}
                        </span>
                      </span>
                      <span>
                        Needed:{' '}
                        <span {...stylex.props(styles.meterValue)}>
                          {formatBytes(neededBytes)}
                        </span>
                      </span>
                    </div>
                    <div {...stylex.props(styles.meterTrack)}>
                      <div
                        {...stylex.props(
                          styles.meterFill,
                          validationData?.valid && styles.meterFillReady
                        )}
                        style={{ width: `${meterPercent}%` }}
                      />
                    </div>
                  </div>

                  {emptyAccounts.length === 0 ? (
                    <div {...stylex.props(styles.emptyDriveNotice)}>
                      No empty drives found across your pools. Remove files from an account or add a
                      new Google Drive account to expand the Share Pool.
                    </div>
                  ) : (
                    <div ref={driveListRef} {...stylex.props(styles.driveListContainer)}>
                      <div
                        {...stylex.props(styles.virtualTrack)}
                        style={{ height: `${driveVirtualizer.getTotalSize()}px` }}
                      >
                        {driveVirtualizer.getVirtualItems().map((virtualRow) => {
                          const acc = emptyAccounts[virtualRow.index];
                          if (!acc) return null;
                          const selectable = isDriveSelectable(acc);
                          const isSelected = selectedAccountIds.includes(acc.id);
                          const statusBadge = getDriveStatusBadge(acc);

                          return (
                            <div
                              key={acc.id}
                              role="checkbox"
                              aria-checked={isSelected}
                              aria-disabled={!selectable || isSubmitting}
                              tabIndex={selectable && !isSubmitting ? 0 : -1}
                              onClick={() => handleToggleAccount(acc)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  handleToggleAccount(acc);
                                }
                              }}
                              {...stylex.props(
                                styles.driveRow,
                                isSelected && styles.driveRowSelected,
                                (!selectable || isSubmitting) && styles.driveRowDisabled
                              )}
                              style={{
                                height: `${virtualRow.size}px`,
                                transform: `translateY(${virtualRow.start}px)`,
                              }}
                            >
                              <span
                                {...stylex.props(
                                  styles.checkbox,
                                  isSelected && styles.checkboxChecked
                                )}
                              >
                                {isSelected && <IconCheck size={12} />}
                              </span>
                              <div {...stylex.props(styles.driveInfoCol)}>
                                <div {...stylex.props(styles.driveTopLine)}>
                                  <span {...stylex.props(styles.driveName)}>
                                    {getAccountLabel(acc.displayName, acc.email, acc.id)}
                                  </span>
                                  <span {...stylex.props(styles.poolBadge)}>
                                    {acc.currentPoolName}
                                  </span>
                                </div>
                                <div {...stylex.props(styles.driveSubLine)}>
                                  <RedactedEmail email={acc.email} style={styles.driveEmail} />
                                  {statusBadge && (
                                    <span
                                      {...stylex.props(
                                        statusBadge.tone === 'danger'
                                          ? styles.driveStatusBadge
                                          : styles.poolBadge
                                      )}
                                    >
                                      {statusBadge.label}
                                    </span>
                                  )}
                                </div>
                              </div>
                              <span {...stylex.props(styles.driveHeadroom)}>
                                {formatBytes(acc.headroomBytes)}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Delivery section */}
              <div {...stylex.props(styles.section)}>
                <div {...stylex.props(styles.sectionHeaderRow)}>
                  <span {...stylex.props(styles.sectionLabel)}>Recipients</span>
                  <span {...stylex.props(styles.optionalMeta)}>Optional</span>
                </div>
                <p {...stylex.props(styles.sectionHelperText)}>
                  Share links are generated automatically even without recipients.
                </p>
                <div {...stylex.props(styles.emailInputRow)}>
                  <div {...stylex.props(styles.emailBox)}>
                    <span {...stylex.props(styles.emailInputIcon)}>
                      <IconMail size={14} />
                    </span>
                    {emailChips.map((email) => (
                      <span key={email} {...stylex.props(styles.emailChip)}>
                        <span {...stylex.props(styles.chipText)}>{email}</span>
                        <button
                          type="button"
                          {...stylex.props(styles.chipRemoveBtn)}
                          onClick={() =>
                            setEmailChips((prev) => prev.filter((item) => item !== email))
                          }
                          aria-label={`Remove ${email}`}
                          disabled={isSubmitting}
                        >
                          <IconClose size={11} />
                        </button>
                      </span>
                    ))}
                    <input
                      type="text"
                      value={emailInput}
                      onChange={(e) => {
                        setEmailInput(e.target.value);
                        if (emailInputError) setEmailInputError(null);
                      }}
                      onKeyDown={handleEmailKeyDown}
                      placeholder="Add recipient email..."
                      disabled={isSubmitting}
                      aria-label="Add recipient email"
                      {...stylex.props(styles.emailTextInput)}
                    />
                  </div>
                  <button
                    type="button"
                    {...stylex.props(styles.addEmailBtn)}
                    onClick={() => addEmailsFromText(emailInput)}
                    disabled={isSubmitting || !emailInput.trim()}
                  >
                    Add
                  </button>
                </div>

                {emailInputError && (
                  <span {...stylex.props(styles.inlineErrorText)}>{emailInputError}</span>
                )}

                {showNoteField && (
                  <textarea
                    value={emailMessage}
                    onChange={(e) => setEmailMessage(e.target.value)}
                    placeholder="Add note (optional)"
                    disabled={isSubmitting}
                    aria-label="Add note (optional)"
                    {...stylex.props(styles.noteTextarea)}
                  />
                )}
              </div>

              {submitError && (
                <div {...stylex.props(styles.dangerBanner)}>
                  <div {...stylex.props(styles.dangerBannerHeader)}>
                    <IconAlertTriangle size={15} />
                    <span>Share failed</span>
                  </div>
                  <p {...stylex.props(styles.dangerBannerText)}>{submitError}</p>
                </div>
              )}
            </div>

            <div {...stylex.props(styles.footer)}>
              <button
                type="button"
                {...stylex.props(styles.cancelBtn)}
                onClick={handleDismiss}
                disabled={isSubmitting}
              >
                Cancel
              </button>
              <button
                type="submit"
                {...stylex.props(styles.confirmBtn)}
                disabled={!canSubmit}
              >
                <IconShare size={14} />
                {isSubmitting ? 'Sharing...' : 'Share'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
