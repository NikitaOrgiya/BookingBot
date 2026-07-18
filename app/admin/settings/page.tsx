import { getAdminBusinessSettings } from "@/lib/admin/business-settings";
import { SettingsForm } from "@/components/admin/settings-form";

export default async function AdminSettingsPage() {
  const settings = await getAdminBusinessSettings();

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold text-zinc-950 dark:text-zinc-50">
          Настройки организации
        </h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Эти настройки использует и Telegram-бот, и расчёт свободных слотов — изменения
          применяются сразу.
        </p>
      </header>

      <SettingsForm settings={settings} />
    </div>
  );
}
