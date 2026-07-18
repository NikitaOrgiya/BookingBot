import { createReminderCronHandler } from "@/lib/reminders/cron-handler";
import { processDueAppointmentReminders } from "@/lib/reminders/worker";

/**
 * Тонкий Route Handler (тот же принцип, что и app/api/telegram/webhook/route.ts):
 * вся логика — в lib/reminders/{cron-handler,worker}.ts. Экспортируется
 * только GET — Next.js сам вернёт 405 для любого другого HTTP-метода.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const handler = createReminderCronHandler({
    expectedSecret: process.env.CRON_SECRET,
    processReminders: processDueAppointmentReminders,
  });
  return handler(request);
}
