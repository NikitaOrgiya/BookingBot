"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setServiceActive } from "@/app/admin/services/actions";

export function ServiceActiveToggle({
  serviceId,
  isActive,
}: {
  serviceId: string;
  isActive: boolean;
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const handleClick = () => {
    if (isActive && !window.confirm("Деактивировать эту услугу? Она перестанет предлагаться в Telegram-боте.")) {
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await setServiceActive(serviceId, !isActive);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      router.refresh();
    });
  };

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={handleClick}
        disabled={isPending}
        className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
      >
        {isPending ? "…" : isActive ? "Деактивировать" : "Активировать"}
      </button>
      {error ? (
        <span role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </span>
      ) : null}
    </div>
  );
}
