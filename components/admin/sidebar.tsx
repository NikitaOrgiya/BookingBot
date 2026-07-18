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

/** Desktop-навигация панели администратора. Скрыта на узких экранах —
 * там используется components/admin/mobile-navigation.tsx. */
export function Sidebar() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Навигация панели администратора"
      className="hidden w-56 shrink-0 flex-col border-r border-zinc-200 bg-white px-4 py-6 sm:flex dark:border-zinc-800 dark:bg-zinc-950"
    >
      <div className="mb-8 px-2 text-lg font-semibold text-zinc-950 dark:text-zinc-50">
        BookingBot
      </div>
      <ul className="flex flex-1 flex-col gap-1">
        {ADMIN_NAV_ITEMS.map((item) => {
          const active = isActive(pathname, item.href);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`block rounded-md px-3 py-2 text-sm font-medium ${
                  active
                    ? "bg-zinc-950 text-white dark:bg-zinc-50 dark:text-zinc-950"
                    : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-900"
                }`}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
      <form action={logout}>
        <button
          type="submit"
          className="mt-4 w-full rounded-md px-3 py-2 text-left text-sm font-medium text-zinc-500 hover:bg-zinc-100 hover:text-zinc-950 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-50"
        >
          Выход
        </button>
      </form>
    </nav>
  );
}
