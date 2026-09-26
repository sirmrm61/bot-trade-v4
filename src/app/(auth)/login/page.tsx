"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ApiForm, Field, Input } from "@/components/client";
import { Suspense } from "react";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  return (
    <ApiForm
      endpoint="/api/auth/login"
      submitLabel="ورود"
      onSuccess={() => router.push(params.get("next") ?? "/dashboard")}
    >
      <Field label="نام کاربری یا ایمیل">
        <Input name="identifier" required autoComplete="username" />
      </Field>
      <Field label="رمز عبور">
        <Input name="password" type="password" required autoComplete="current-password" />
      </Field>
    </ApiForm>
  );
}

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md rounded-3xl border border-border bg-card p-8 shadow-sm">
        <div className="mb-8 text-center">
          <div className="text-2xl font-black">بات‌ترید</div>
          <p className="mt-2 text-sm text-muted">به حساب کاربری خود وارد شوید</p>
        </div>
        <Suspense>
          <LoginForm />
        </Suspense>
        <p className="mt-6 text-center text-sm text-muted">
          حساب ندارید؟{" "}
          <Link href="/register" className="font-bold text-primary">ثبت‌نام کنید</Link>
        </p>
      </div>
    </main>
  );
}
