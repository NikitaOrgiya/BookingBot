import { requireAdmin } from "@/lib/auth/require-admin";
import { Sidebar } from "@/components/admin/sidebar";
import { MobileNavigation } from "@/components/admin/mobile-navigation";

// Административные страницы никогда не должны кешироваться/статически
// генерироваться как общедоступный контент — каждый запрос обязан заново
// пройти requireAdmin().
export const dynamic = "force-dynamic";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireAdmin();

  return (
    <div className="flex min-h-screen bg-zinc-50 dark:bg-black">
      <Sidebar />
      <div className="flex flex-1 flex-col pb-16 sm:pb-0">
        <main className="flex-1 px-4 py-6 sm:px-8 sm:py-8">{children}</main>
      </div>
      <MobileNavigation />
    </div>
  );
}
