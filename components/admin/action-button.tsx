"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export interface ActionResult {
  ok: boolean;
  message: string;
}

/** Небольшая кнопка, вызывающая Server Action напрямую (не через form
 * action) с опциональным confirm() и обновлением страницы после успеха.
 * Общий виджет для повторяющихся действий (активировать/деактивировать/
 * удалить интервал или блокировку) на странице /admin/schedule. */
export function ActionButton({
  label,
  pendingLabel,
  confirmMessage,
  action,
  variant = "default",
}: {
  label: string;
  pendingLabel?: string;
  confirmMessage?: string;
  action: () => Promise<ActionResult>;
  variant?: "default" | "danger";
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const handleClick = () => {
    if (confirmMessage && !window.confirm(confirmMessage)) {
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.message);
        return;
      }
      router.refresh();
    });
  };

  const styles =
    variant === "danger"
      ? "border-red-300 text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950"
      : "border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900";

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={handleClick}
        disabled={isPending}
        className={`rounded-full border px-3 py-1 text-xs font-medium disabled:opacity-50 ${styles}`}
      >
        {isPending ? (pendingLabel ?? "…") : label}
      </button>
      {error ? (
        <span role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </span>
      ) : null}
    </div>
  );
}
