import { ChevronDown, Cpu, FileText, FolderOpen, Sparkles } from 'lucide-react';
import { GeminiSection } from '../features/gemini/GeminiSection';
import { ModelsSection } from '../features/models/ModelsSection';
import { PromptsSection } from '../features/prompts/PromptsSection';
import { WorkspaceSettingsForm } from '../features/settings/WorkspaceSettingsForm';
import { PageHeader } from '../components/PageHeader';
import { SectionCard } from '../components/SectionCard';

export function SettingsPage() {
  return (
    <>
      <PageHeader
        title="تنظیمات"
        description="اتصال Gemini، انتخاب مدل‌ها و پرامپت‌های پردازش"
      />

      <div className="space-y-4">
        <SectionCard
          title="Gemini"
          description="کلید API و بررسی اتصال"
          icon={<Sparkles className="size-4" />}
        >
          <GeminiSection />
        </SectionCard>

        <SectionCard
          title="مدل‌ها"
          description="مدل تبدیل ویس به متن و مدل پردازش و استخراج نکات"
          icon={<Cpu className="size-4" />}
        >
          <ModelsSection />
        </SectionCard>

        <SectionCard
          title="پرامپت‌ها"
          description="پرامپت تبدیل به متن و پرامپت پردازش"
          icon={<FileText className="size-4" />}
        >
          <PromptsSection />
        </SectionCard>

        <details className="group overflow-hidden rounded-lg border border-border bg-surface shadow-card">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-4 text-sm font-semibold text-text-primary">
            <FolderOpen className="size-4 text-text-secondary" aria-hidden="true" />
            تنظیمات پیشرفته
            <ChevronDown className="size-4 text-text-secondary transition-transform group-open:rotate-180" aria-hidden="true" />
          </summary>
          <div className="border-t border-border px-5 py-5">
            <WorkspaceSettingsForm />
          </div>
        </details>
      </div>
    </>
  );
}
