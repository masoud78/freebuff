import { useAppShellContext } from '../components/AppShell';
import { PageHeader } from '../components/PageHeader';
import { SectionCard } from '../components/SectionCard';
import { ReadinessCard } from '../features/readiness/ReadinessCard';
import { SystemStatusSection } from '../features/system-status/SystemStatusSection';

export function OverviewPage() {
  const { status, retry } = useAppShellContext();

  return (
    <>
      <PageHeader title="نمای کلی" description="وضعیت زیرساخت، سرویس‌ها و پیکربندی هوش مصنوعی" />
      <div className="space-y-4">
        <SectionCard title="وضعیت سیستم" description="بررسی زنده Backend و Database از طریق Health API">
          <SystemStatusSection status={status} retry={retry} />
        </SectionCard>
        <SectionCard
          title="پیکربندی هوش مصنوعی"
          description="آمادگی کامل برای اجرای پردازش‌های Gemini"
        >
          <ReadinessCard />
        </SectionCard>
      </div>
    </>
  );
}
