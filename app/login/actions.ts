"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createAuthServerClient } from "@/lib/supabase/auth-server-client";

/**
 * Публичной регистрации в проекте нет — эта форма только проверяет
 * учётные данные уже существующего пользователя Supabase Auth. Первый
 * production-администратор создаётся вручную (см. README).
 */
const loginSchema = z.object({
  email: z.string().min(1, "Email обязателен").email("Некорректный email"),
  password: z.string().min(1, "Пароль обязателен"),
});

/**
 * Вход администратора. Пароль нигде не логируется и не сохраняется за
 * пределами вызова signInWithPassword. Ошибка валидации формы и ошибка
 * "неверный email/пароль" от Supabase Auth намеренно сведены к одному и
 * тому же сообщению (`invalid_credentials`) — иначе поведение раскрывало
 * бы, существует ли такой email.
 */
export async function login(formData: FormData): Promise<void> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    redirect("/login?error=invalid_credentials");
  }

  const supabase = await createAuthServerClient();

  const { data, error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });

  if (error || !data.user) {
    redirect("/login?error=invalid_credentials");
  }

  const { data: isAdmin } = await supabase.rpc("is_admin");

  if (!isAdmin) {
    // Учётные данные верны (это подтверждённый пользователь Supabase
    // Auth), но он не администратор — не оставляем ему активную сессию
    // панели и сообщаем отдельным, но всё равно общим сообщением, ничего
    // не раскрывающим о содержимом admin_users.
    await supabase.auth.signOut();
    redirect("/login?error=forbidden");
  }

  redirect("/admin");
}

export async function logout(): Promise<void> {
  const supabase = await createAuthServerClient();
  await supabase.auth.signOut();
  redirect("/login");
}
