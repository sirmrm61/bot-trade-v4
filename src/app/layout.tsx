import type { Metadata } from "next";
import "@fontsource/vazirmatn/400.css";
import "@fontsource/vazirmatn/500.css";
import "@fontsource/vazirmatn/700.css";
import "@fontsource/vazirmatn/900.css";
import "./globals.css";
import { ToastProvider } from "@/components/toast";

export const metadata: Metadata = {
  title: "بات‌ترید — پلتفرم معاملات خودکار نوبیتکس",
  description: "طراحی، بک‌تست و اجرای استراتژی‌های معاملاتی روی نوبیتکس",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fa" dir="rtl" className="h-full antialiased" suppressHydrationWarning>
      <body className="min-h-full flex flex-col bg-background text-foreground font-sans">
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
