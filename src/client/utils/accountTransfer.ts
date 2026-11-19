export const DAILY_UPLOAD_LIMIT_BYTES = 750 * 1024 * 1024 * 1024;

export interface AccountTransferCandidateInput {
  id: string;
  displayName?: string;
  email?: string;
  isDisabled?: boolean;
  authorized: boolean;
  headroomBytes: number;
  transferStats?: {
    remainingUploadBytes24h?: number;
  };
}

export interface AccountTransferEvaluationOptions {
  isCurrent?: boolean;
  freedBytes?: number;
  isAutoSelected?: boolean;
  compactHeadroomLabel?: boolean;
}

export interface AccountTransferEvaluationResult {
  canHold: boolean;
  isMuted: boolean;
  labelSuffix: string;
  optionLabel: string;
}

/** Formats a byte count in gibibytes with one decimal place. */
export function formatGbCompact(bytes: number): string {
  return (bytes / (1024 * 1024 * 1024)).toFixed(1);
}

function getCandidateLabelSuffix(
  acc: AccountTransferCandidateInput,
  requiredBytes: number,
  flags: {
    isDriveDisabled: boolean;
    hasHeadroom: boolean;
    hasTransferBudget: boolean;
  },
  options?: AccountTransferEvaluationOptions,
): string {
  if (options?.isCurrent) return ' (Current)';
  if (flags.isDriveDisabled) return ' (Disabled)';
  if (!acc.authorized) return ' (Unauthorized)';
  if (!flags.hasHeadroom) {
    return options?.compactHeadroomLabel
      ? ' (No headroom)'
      : ` (No headroom: needs ${formatGbCompact(requiredBytes)} GB)`;
  }
  if (!flags.hasTransferBudget) {
    return options?.compactHeadroomLabel
      ? ' (24h limit reached)'
      : ' (24h transfer limit reached)';
  }
  if (options?.isAutoSelected) return ' (Auto)';
  if (options?.compactHeadroomLabel) return '';
  return ` (${formatGbCompact(acc.headroomBytes)} GB free)`;
}

/** Evaluates whether an account can accept a transfer and formats its selector labels. */
export function evaluateAccountTransferCandidate(
  acc: AccountTransferCandidateInput,
  requiredBytes: number,
  options?: AccountTransferEvaluationOptions,
): AccountTransferEvaluationResult {
  const isDriveDisabled = Boolean(acc.isDisabled);
  const hasHeadroom = acc.headroomBytes + (options?.freedBytes ?? 0) >= requiredBytes;
  const remainingBudget = acc.transferStats?.remainingUploadBytes24h ?? DAILY_UPLOAD_LIMIT_BYTES;
  const hasTransferBudget = remainingBudget >= requiredBytes;
  const canHold = !isDriveDisabled && acc.authorized && hasHeadroom && hasTransferBudget;
  const isMuted = !options?.isCurrent && !canHold;

  const labelSuffix = getCandidateLabelSuffix(
    acc,
    requiredBytes,
    { isDriveDisabled, hasHeadroom, hasTransferBudget },
    options,
  );
  const name = acc.displayName || acc.id;

  return {
    canHold,
    isMuted,
    labelSuffix,
    optionLabel: `${name}${labelSuffix}`,
  };
}
