import { useState, useEffect, useRef, useMemo, useCallback, type FormEvent } from 'react';
import type { InferResponseType } from 'hono/client';
import { client } from '../api.js';
import type {
  ShareTargetItem,
  ShareExecuteResult,
  ShareInspectResponse,
} from '../types.js';
import {
  getShareInspectCache,
  invalidateShareInspectCache,
  setShareInspectCache,
} from '../utils/queryCache.js';
import { readResponseError } from '../utils/workspaceHelpers.js';

type ValidateResponse = InferResponseType<typeof client.api.share.validate.$post, 200>;
export type EmptyShareAccount = ShareInspectResponse['emptyAccounts'][number];

export interface UseShareWizardOptions {
  isOpen: boolean;
  items: ShareTargetItem[];
  sourcePoolId: number;
  onComplete: (result: ShareExecuteResult) => Promise<void> | void;
  onClose: () => void;
}

export function isDriveSelectable(acc: EmptyShareAccount): boolean {
  return acc.authorized && !acc.isDisabled && acc.syncState !== 'error' && !acc.currentPoolIsShare;
}

function buildInspectSignature(sourcePoolId: number, items: ShareTargetItem[]): string {
  const itemKeys = items
    .map((i) => `${i.kind}:${i.id}`)
    .sort()
    .join(',');
  return `${sourcePoolId}:${itemKeys}`;
}

export function useShareWizard({
  isOpen,
  items,
  sourcePoolId,
  onComplete,
  onClose,
}: UseShareWizardOptions) {
  const [inspectData, setInspectData] = useState<ShareInspectResponse | null>(null);
  const [isInspecting, setIsInspecting] = useState(false);

  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const [validationData, setValidationData] = useState<ValidateResponse | null>(null);
  const [isValidating, setIsValidating] = useState(false);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [executeResult, setExecuteResult] = useState<ShareExecuteResult | null>(null);
  const [activeDriveIndex, setActiveDriveIndex] = useState<number>(0);

  const submittingRef = useRef(false);

  useEffect(() => {
    if (!isOpen || items.length === 0) {
      submittingRef.current = false;
      setInspectData(null);
      setIsInspecting(false);
      setSelectedAccountIds([]);
      setValidationData(null);
      setIsValidating(false);
      setIsSubmitting(false);
      setError(null);
      setExecuteResult(null);
      setActiveDriveIndex(0);
      return;
    }

    const signature = buildInspectSignature(sourcePoolId, items);
    const cachedData = getShareInspectCache(signature);

    submittingRef.current = false;
    setSelectedAccountIds([]);
    setValidationData(null);
    setIsValidating(false);
    setIsSubmitting(false);
    setError(null);
    setExecuteResult(null);
    setActiveDriveIndex(0);

    if (cachedData) {
      setInspectData(cachedData);
      setIsInspecting(false);
      return;
    }

    const controller = new AbortController();
    setInspectData(null);
    setIsInspecting(true);

    (async () => {
      try {
        const res = await client.api.share.inspect.$post(
          {
            json: {
              sourcePoolId,
              items: items.map((i) => ({ kind: i.kind, id: i.id })),
            },
          },
          { init: { signal: controller.signal } }
        );
        if (controller.signal.aborted) return;
        if (res.ok) {
          const parsed = (await res.json().catch(() => ({}))) as ShareInspectResponse;
          setShareInspectCache(signature, parsed);
          setInspectData(parsed);
        } else {
          setError(await readResponseError(res, 'Failed to inspect share targets'));
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!controller.signal.aborted) {
          setIsInspecting(false);
        }
      }
    })();

    return () => {
      controller.abort();
    };
  }, [isOpen, items, sourcePoolId]);

  const needsExpansion = Boolean(
    inspectData && !inspectData.sharePoolFitsWithoutExpansion && inspectData.overCeilingFiles.length === 0
  );

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

    const controller = new AbortController();
    setIsValidating(true);

    const timer = setTimeout(() => {
      (async () => {
        try {
          const res = await client.api.share.validate.$post(
            {
              json: {
                sourcePoolId,
                items: items.map((i) => ({ kind: i.kind, id: i.id })),
                selectedAccountIds,
              },
            },
            { init: { signal: controller.signal } }
          );
          if (controller.signal.aborted) return;
          if (res.ok) {
            setValidationData((await res.json().catch(() => ({}))) as ValidateResponse);
          } else {
            const reason = await readResponseError(res, 'Validation failed');
            setValidationData({
              valid: false,
              reason,
              totalAvailableHeadroomBytes: 0,
              requiredBytes: inspectData?.totalBytes ?? 0,
            });
          }
        } catch (err) {
          if (!controller.signal.aborted) {
            setValidationData({
              valid: false,
              reason: err instanceof Error ? err.message : String(err),
              totalAvailableHeadroomBytes: 0,
              requiredBytes: inspectData?.totalBytes ?? 0,
            });
          }
        } finally {
          if (!controller.signal.aborted) {
            setIsValidating(false);
          }
        }
      })();
    }, 180);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [isOpen, needsExpansion, selectedAccountIds, items, sourcePoolId, inspectData?.totalBytes]);

  const emptyAccounts = inspectData?.emptyAccounts ?? [];

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
      setError(null);
      setSelectedAccountIds((prev) =>
        prev.includes(acc.id) ? prev.filter((id) => id !== acc.id) : [...prev, acc.id]
      );
    },
    [isSubmitting]
  );

  const handleAutoSelect = useCallback(() => {
    if (isSubmitting || eligibleEmptyAccounts.length === 0) return;
    setError(null);
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
  }, [isSubmitting, eligibleEmptyAccounts, neededBytes]);

  const handleDismiss = useCallback(() => {
    if (submittingRef.current || isSubmitting) return;
    onClose();
  }, [isSubmitting, onClose]);

  const hasOverCeiling = (inspectData?.overCeilingFiles.length ?? 0) > 0;
  const allocationReady = Boolean(
    inspectData &&
      !hasOverCeiling &&
      (inspectData.sharePoolFitsWithoutExpansion || validationData?.valid)
  );
  const canSubmit = !isInspecting && !isValidating && !isSubmitting && allocationReady;

  const meterPercent =
    neededBytes === 0
      ? selectedAccountIds.length > 0
        ? 100
        : 0
      : Math.min(100, Math.round((selectedHeadroomBytes / neededBytes) * 100));

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (submittingRef.current || !inspectData || isSubmitting || isValidating) return;

    if (!allocationReady) return;

    submittingRef.current = true;
    setIsSubmitting(true);
    setError(null);

    try {
      const res = await client.api.share.execute.$post({
        json: {
          sourcePoolId,
          items: items.map((i) => ({ kind: i.kind, id: i.id })),
          selectedAccountIds: inspectData.sharePoolFitsWithoutExpansion ? [] : selectedAccountIds,
        },
      });
      if (res.ok) {
        const executed = (await res.json().catch(() => ({}))) as ShareExecuteResult;
        invalidateShareInspectCache();
        setExecuteResult(executed);
        await onComplete(executed);
      } else {
        setError(await readResponseError(res, 'Failed to share items'));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  return {
    inspectData,
    isInspecting,
    selectedAccountIds,
    validationData,
    isValidating,
    isSubmitting,
    error,
    setError,
    executeResult,
    activeDriveIndex,
    setActiveDriveIndex,
    emptyAccounts,
    neededBytes,
    selectedHeadroomBytes,
    eligibleEmptyAccounts,
    hasOverCeiling,
    canSubmit,
    meterPercent,
    handleToggleAccount,
    handleAutoSelect,
    handleDismiss,
    handleSubmit,
  };
}
