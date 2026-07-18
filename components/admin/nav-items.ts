export interface AdminNavItem {
  href: string;
  label: string;
}

export const ADMIN_NAV_ITEMS: AdminNavItem[] = [
  { href: "/admin", label: "Dashboard" },
  { href: "/admin/appointments", label: "Записи" },
  { href: "/admin/services", label: "Услуги" },
  { href: "/admin/schedule", label: "Расписание" },
  { href: "/admin/settings", label: "Настройки" },
];
