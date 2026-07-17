"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { logout } from "@/app/login/actions";
import { ADMIN_NAV_ITEMS } from "./nav-items";

function isActive(pathname: string, href: string): boolean {
  if (href === "/admin") {
    return pathname === "/admin";
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Нижняя панель навигации для мобильных экранов (< sm). Дублирует ссылки
 * components/admin/sidebar.tsx, скрытого на этой ширине. */
export function MobileNavigation() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Навигация панели администратора (мобильная)"
      className="fixed inset-x-0 bottom-0 z-10 flex border-t border-zinc-200 bg-white sm:hidden dark:border-zinc-800 dark:bg-zinc-950"
    >
      {ADMIN_NAV_ITEMS.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`flex flex-1 flex-col items-center gap-0.5 px-2 py-2.5 text-[11px] font-medium ${
              active
                ? "text-zinc-950 dark:text-zinc-50"
                : "text-zinc-500 dark:text-zinc-400"
            }`}
          >
            {item.label}
          </Link>
        );
      })}
      <form action={logout} className="flex flex-1">
        <button
          type="submit"
          className="flex flex-1 flex-col items-center gap-0.5 px-2 py-2.5 text-[11px] font-medium text-zinc-500 dark:text-zinc-400"
        >
          Выход
        </button>
      </form>
    </nav>
  );
}
