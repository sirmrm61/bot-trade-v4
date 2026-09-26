"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ApiForm, Field, Input } from "@/components/client";
import { Suspense } from "react";

function RegisterForm() {
  const router = useRouter();
  const params = useSearchParams();
  const ref = params.get("ref") ?? "";
  return (
    <ApiForm
      endpoint="/api/auth/register"
      submitLabel="ایجاد حساب"
      onSuccess={() => router.push("/dashboard")}
    >
      <Field label="نام کاربری" hint="فقط حروف انگلیسی، عدد و _">
        <Input name="username" required minLength={3} pattern="[a-zA-Z0-9_]+" dir="ltr" />
      </Field>
      <Field label="ایمیل (اختیاری)">
        <Input name="email" type="email" dir="ltr" />
      </Field>
      <Field label="موبایل (اختیاری)">
        <Input name="mobile" dir="ltr" placeholder="09xxxxxxxxx" />
      </Field>
      <Field label="رمز عبور" hint="حداقل ۸ کاراکتر">
        <Input name="password" type="password" required minLength={8} autoComplete="new-password" />
      </Field>
      <Field label="کد معرف (اختیاری)">
        <Input name="referralCode" defaultValue={ref} dir="ltr" />
      </Field>
    </ApiForm>
  );
}

export default function RegisterPage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md rounded-3xl border border-border bg-card p-8 shadow-sm">
        <div className="mb-8 text-center">
          <div className="text-2xl font-black">بات‌ترید</div>
          <p className="mt-2 text-sm text-muted">حساب رایگان بسازید — ۷ روز پلن آزمایشی</p>
        </div>
        <Suspense>
          <RegisterForm />
        </Suspense>
        <p className="mt-6 text-center text-sm text-muted">
          قبلاً ثبت‌نام کرده‌اید؟{" "}
          <Link href="/login" className="font-bold text-primary">وارد شوید</Link>
        </p>
      </div>
    </main>
  );
}
