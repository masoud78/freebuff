import { Cpu, FileText, FolderOpen, Sparkles } from 'lucide-react';
import { GeminiSection } from '../features/gemini/GeminiSection';
import { ModelsSection } from '../features/models/ModelsSection';
import { PromptsSection } from '../features/prompts/PromptsSection';
import { WorkspaceSettingsForm } from '../features/settings/WorkspaceSettingsForm';
import { PageHeader } from '../components/PageHeader';
import { SectionCard } from '../components/SectionCard';

export function SettingsPage() {
  return (
    <>
      <PageHeader title="تنظیمات" description="پیکربندی برنامه — اتصال Gemini، مدل‌ها، پرامپت‌ها و فضای کاری" />

      <div className="space-y-4">
        <SectionCard
          title="Workspace"
          description="تنظیمات عمومی فضای کاری"
          icon={<FolderOpen className="size-4" />}
        >
          <WorkspaceSettingsForm />
        </SectionCard>

        <SectionCard
          title="Gemini"
          description="کلید API و بررسی اتصال به Gemini"
          icon={<Sparkles className="size-4" />}
        >
          <GeminiSection />
        </SectionCard>

        <SectionCard
          title="Models"
          description="انتخاب مدل مناسب برای هر مرحله از پردازش"
          icon={<Cpu className="size-4" />}
        >
          <ModelsSection />
        </SectionCard>

        <SectionCard
          title="Prompts"
          description="مدیریت پرامپت‌های اصلی با تاریخچه نسخه‌ها"
          icon={<FileText className="size-4" />}
        >
          <PromptsSection />
        </SectionCard>
      </div>
    </>
  );
}
