"use client";

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-1 flex-col items-center justify-center gap-4 py-24 text-center"
    >
      <p className="text-sm font-medium text-red-700 dark:text-red-400">
        Что-то пошло не так при загрузке этой страницы.
      </p>
      <p className="max-w-md text-sm text-zinc-500 dark:text-zinc-400">
        {error.message || "Неизвестная ошибка."}
      </p>
      <button
        type="button"
        onClick={reset}
        className="rounded-full border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
      >
        Попробовать снова
      </button>
    </div>
  );
}
