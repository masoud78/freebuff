import { useCallback, useEffect, useState } from 'react';
import type { GeminiModelInfo, ModelConfigResponse, ModelStage } from '@freebuff/contracts';
import { fetchModelConfigs, fetchModels, refreshModels, updateModelConfig } from '../../lib/api';

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export function useModels() {
  const [models, setModels] = useState<GeminiModelInfo[]>([]);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const [configs, setConfigs] = useState<ModelConfigResponse[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [savingStage, setSavingStage] = useState<ModelStage | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchModels(), fetchModelConfigs()])
      .then(([modelsResult, configsResult]) => {
        if (cancelled) return;
        setModels(modelsResult.models);
        setRefreshedAt(modelsResult.refreshedAt);
        setConfigs(configsResult);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoadError(error instanceof Error ? error.message : 'خطا در دریافت مدل‌ها.');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const retryLoad = useCallback(() => {
    setIsLoading(true);
    setLoadError(null);
    void Promise.all([fetchModels(), fetchModelConfigs()])
      .then(([modelsResult, configsResult]) => {
        setModels(modelsResult.models);
        setRefreshedAt(modelsResult.refreshedAt);
        setConfigs(configsResult);
      })
      .catch((error: unknown) => {
        setLoadError(error instanceof Error ? error.message : 'خطا در دریافت مدل‌ها.');
      })
      .finally(() => setIsLoading(false));
  }, []);

  const refresh = useCallback(async (): Promise<boolean> => {
    setIsRefreshing(true);
    setSaveMessage(null);
    try {
      const result = await refreshModels();
      setModels(result.models);
      setRefreshedAt(result.refreshedAt);
      // Re-check availability of the existing selections.
      const configsResult = await fetchModelConfigs();
      setConfigs(configsResult);
      return true;
    } catch (error) {
      setSaveMessage(error instanceof Error ? error.message : 'خطا در دریافت مدل‌ها.');
      return false;
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  const selectModel = useCallback(async (stage: ModelStage, modelId: string) => {
    setSavingStage(stage);
    setSaveState('saving');
    setSaveMessage(null);
    try {
      const updated = await updateModelConfig({ stage, modelId });
      setConfigs((prev) =>
        prev.map((config) =>
          config.stage === stage
            ? { ...config, modelId: updated.modelId, available: updated.available }
            : config,
        ),
      );
      setSaveState('saved');
    } catch (error) {
      setSaveState('error');
      setSaveMessage(error instanceof Error ? error.message : 'خطا در ذخیره انتخاب مدل.');
    } finally {
      setSavingStage(null);
    }
  }, []);

  const modelsForStage = useCallback(
    (stage: ModelStage): GeminiModelInfo[] => {
      const audioModels = models.filter((model) => model.capabilities.audio);
      switch (stage) {
        case 'EMBEDDING':
          return models.filter((model) => model.capabilities.embedding);
        case 'TRANSCRIPTION':
          // Prefer dedicated audio models; fall back to generative when the
          // account exposes no audio-capable models.
          return audioModels.length > 0
            ? audioModels
            : models.filter((model) => model.capabilities.generative);
        default:
          return models.filter((model) => model.capabilities.generative);
      }
    },
    [models],
  );

  return {
    models,
    refreshedAt,
    configs,
    isLoading,
    loadError,
    isRefreshing,
    savingStage,
    saveState,
    saveMessage,
    retryLoad,
    refresh,
    selectModel,
    modelsForStage,
  };
}
