import { useCallback, useEffect, useState } from 'react';
import type { PromptType, PromptVersionInfo } from '@freebuff/contracts';
import {
  activatePromptVersion,
  fetchPromptTemplates,
  fetchPromptVersions,
  savePromptVersion,
} from '../../lib/api';

interface PromptEditorState {
  drafts: Record<PromptType, string>;
  versions: Record<PromptType, PromptVersionInfo[]>;
  saving: PromptType | null;
  messages: Record<PromptType, { tone: 'success' | 'error'; text: string } | null>;
}

const INITIAL: PromptEditorState = {
  drafts: { TRANSCRIPTION: '', KNOWLEDGE_PROCESSING: '', CONTENT_GENERATION: '' },
  versions: { TRANSCRIPTION: [], KNOWLEDGE_PROCESSING: [], CONTENT_GENERATION: [] },
  saving: null,
  messages: { TRANSCRIPTION: null, KNOWLEDGE_PROCESSING: null, CONTENT_GENERATION: null },
};

export function usePrompts() {
  const [templates, setTemplates] = useState<Record<PromptType, string> | null>(null);
  const [editor, setEditor] = useState<PromptEditorState>(INITIAL);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetchPromptTemplates(),
      fetchPromptVersions('TRANSCRIPTION'),
      fetchPromptVersions('KNOWLEDGE_PROCESSING'),
      fetchPromptVersions('CONTENT_GENERATION'),
    ])
      .then(([templatesResult, ...versionsResults]) => {
        if (cancelled) return;
        setTemplates(
          Object.fromEntries(
            templatesResult.map((template) => [template.promptType, template.displayName]),
          ) as Record<PromptType, string>,
        );
        const versions = versionsResults.reduce<Record<PromptType, PromptVersionInfo[]>>(
          (acc, result) => {
            acc[result.promptType] = result.versions;
            return acc;
          },
          { TRANSCRIPTION: [], KNOWLEDGE_PROCESSING: [], CONTENT_GENERATION: [] },
        );
        setEditor((prev) => ({
          ...prev,
          versions,
          drafts: {
            TRANSCRIPTION: activeContent(versions.TRANSCRIPTION),
            KNOWLEDGE_PROCESSING: activeContent(versions.KNOWLEDGE_PROCESSING),
            CONTENT_GENERATION: activeContent(versions.CONTENT_GENERATION),
          },
        }));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoadError(error instanceof Error ? error.message : 'خطا در دریافت پرامپت‌ها.');
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
    void Promise.all([
      fetchPromptTemplates(),
      fetchPromptVersions('TRANSCRIPTION'),
      fetchPromptVersions('KNOWLEDGE_PROCESSING'),
      fetchPromptVersions('CONTENT_GENERATION'),
    ])
      .then(([templatesResult, ...versionsResults]) => {
        setTemplates(
          Object.fromEntries(
            templatesResult.map((template) => [template.promptType, template.displayName]),
          ) as Record<PromptType, string>,
        );
        const versions = versionsResults.reduce<Record<PromptType, PromptVersionInfo[]>>(
          (acc, result) => {
            acc[result.promptType] = result.versions;
            return acc;
          },
          { TRANSCRIPTION: [], KNOWLEDGE_PROCESSING: [], CONTENT_GENERATION: [] },
        );
        setEditor((prev) => ({
          ...prev,
          versions,
          drafts: {
            TRANSCRIPTION: activeContent(versions.TRANSCRIPTION),
            KNOWLEDGE_PROCESSING: activeContent(versions.KNOWLEDGE_PROCESSING),
            CONTENT_GENERATION: activeContent(versions.CONTENT_GENERATION),
          },
        }));
      })
      .catch((error: unknown) => {
        setLoadError(error instanceof Error ? error.message : 'خطا در دریافت پرامپت‌ها.');
      })
      .finally(() => setIsLoading(false));
  }, []);

  const setDraft = useCallback((promptType: PromptType, content: string) => {
    setEditor((prev) => ({
      ...prev,
      drafts: { ...prev.drafts, [promptType]: content },
      messages: { ...prev.messages, [promptType]: null },
    }));
  }, []);

  const save = useCallback(
    async (promptType: PromptType) => {
      const content = editor.drafts[promptType];
      setEditor((prev) => ({ ...prev, saving: promptType, messages: { ...prev.messages, [promptType]: null } }));
      try {
        const result = await savePromptVersion(promptType, content);
        setEditor((prev) => ({
          ...prev,
          saving: null,
          versions: { ...prev.versions, [promptType]: result.versions },
          messages: {
            ...prev.messages,
            [promptType]: { tone: 'success', text: 'نسخه جدید ذخیره شد.' },
          },
        }));
      } catch (error) {
        setEditor((prev) => ({
          ...prev,
          saving: null,
          messages: {
            ...prev.messages,
            [promptType]: {
              tone: 'error',
              text: error instanceof Error ? error.message : 'خطا در ذخیره پرامپت.',
            },
          },
        }));
      }
    },
    [editor.drafts],
  );

  const activate = useCallback(async (promptType: PromptType, versionId: number) => {
    try {
      const result = await activatePromptVersion(promptType, versionId);
      setEditor((prev) => ({
        ...prev,
        versions: { ...prev.versions, [promptType]: result.versions },
        drafts: { ...prev.drafts, [promptType]: activeContent(result.versions) },
        messages: {
          ...prev.messages,
          [promptType]: { tone: 'success', text: 'نسخه انتخاب‌شده فعال شد.' },
        },
      }));
    } catch (error) {
      setEditor((prev) => ({
        ...prev,
        messages: {
          ...prev.messages,
          [promptType]: {
            tone: 'error',
            text: error instanceof Error ? error.message : 'خطا در فعال‌سازی نسخه.',
          },
        },
      }));
    }
  }, []);

  return {
    templates,
    editor,
    isLoading,
    loadError,
    retryLoad,
    setDraft,
    save,
    activate,
  };
}

function activeContent(versions: PromptVersionInfo[]): string {
  return versions.find((version) => version.isActive)?.content ?? '';
}
