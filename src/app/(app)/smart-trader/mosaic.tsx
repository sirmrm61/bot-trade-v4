"use client";

import { useState } from "react";
import { Modal } from "@/components/client";
import { Badge } from "@/components/ui";
import { cn } from "@/shared/utils";
import { ScannerDialog } from "./scanner-dialog";
import { WhaleDialog } from "./whale-dialog";
import { GridDialog } from "./grid-dialog";

/**
 * Smart Trader mosaic — data-driven idea tiles. To add an idea, append an
 * entry to IDEAS with an `icon` kind and a `dialog` key; the grid renders it
 * and clicking opens the matching dialog.
 */

type IconKind = "radar" | "sparkle" | "pulse";

interface Idea {
  id: string;
  title: string;
  description: string;
  icon: IconKind;
  accent: string;          // tailwind gradient classes for the icon plate
  badge?: string;
  disabled?: boolean;
}

const IDEAS: Idea[] = [
  {
    id: "opportunity-scanner",
    title: "اسکنر فرصت بازار",
    description:
      "بررسی مستمر جفت‌ارزها در تایم‌فریم‌های کوتاه — حجم، نقدشوندگی، اسپرد، نوسان، مومنتوم و هزینه‌ی واقعی معامله را لحاظ می‌کند و فرصت‌هایی با بازده خالص مثبت پیدا می‌کند.",
    icon: "radar",
    accent: "from-blue-500/15 to-cyan-400/15 text-blue-500",
    badge: "فعال",
  },
  {
    id: "smart-grid",
    title: "گرید هوشمند",
    description:
      "نردبان سفارش‌های لیمیت دور قیمت — خرید پایین، فروش بالا. فاصله‌ی پله‌ها با ATR تطبیق می‌یابد و با خروج قیمت از باند، نردبان بازچینی می‌شود.",
    icon: "pulse",
    accent: "from-violet-500/15 to-fuchsia-400/15 text-violet-500",
    badge: "فعال",
  },
  {
    id: "whale-watch",
    title: "ردیاب نهنگ",
    description:
      "اسکن اوردر‌بوک جفت‌های برتر — دیوارهای خرید/فروش بزرگ و عدم تعادل عمق را پیدا می‌کند تا حمایت و مقاومت نهنگ‌ها را ببینید.",
    icon: "sparkle",
    accent: "from-amber-500/15 to-orange-400/15 text-amber-500",
    badge: "فعال",
  },
];

/** Layered animated icon — pure CSS, driven by `icon` kind. */
function TileIcon({ kind, accent }: { kind: IconKind; accent: string }) {
  return (
    <div className={cn("relative flex size-20 items-center justify-center rounded-full bg-gradient-to-br", accent)}>
      {kind === "radar" && (
        <>
          <span className="tile-ring" />
          <span className="tile-ring tile-ring-delay" />
          <span className="tile-radar" />
        </>
      )}
      {kind === "sparkle" && (
        <>
          <span className="tile-sparkle left-1 top-1 size-2 rounded-full bg-current" />
          <span className="tile-sparkle bottom-2 right-2 size-1.5 rounded-full bg-current" style={{ animationDelay: "0.6s" }} />
          <span className="tile-sparkle right-3 top-2 size-1 rounded-full bg-current" style={{ animationDelay: "1.1s" }} />
        </>
      )}
      {kind === "pulse" && (
        <>
          <span className="tile-ring" />
          <span className="tile-ring" style={{ animationDelay: "0.85s" }} />
          <span className="tile-ring tile-ring-delay" />
        </>
      )}
      <span className="tile-float relative z-10">
        {kind === "radar" && <RadarGlyph />}
        {kind === "sparkle" && <SparkleGlyph />}
        {kind === "pulse" && <PulseGlyph />}
      </span>
    </div>
  );
}

function RadarGlyph() {
  return (
    <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <circle cx="12" cy="12" r="9" opacity="0.35" />
      <circle cx="12" cy="12" r="5.5" opacity="0.6" />
      <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
      <circle cx="16.5" cy="8.5" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

function SparkleGlyph() {
  return (
    <svg width="34" height="34" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2l1.8 5.7L20 9l-5 2.4L13 17l-1.5-4.4L7 10l5.2-1.3L12 2z" />
      <path d="M19 15l.9 2.6L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.4L19 15z" opacity="0.7" />
    </svg>
  );
}

function PulseGlyph() {
  return (
    <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12h4l2.5-6 3.5 12L14 12h4l2-3" />
    </svg>
  );
}

export function SmartTraderMosaic({ pairs }: { pairs: { symbol: string; exchange: string }[] }) {
  const [active, setActive] = useState<string | null>(null);
  const idea = IDEAS.find((i) => i.id === active);

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {IDEAS.map((i, idx) => (
          <button
            key={i.id}
            type="button"
            disabled={i.disabled}
            onClick={() => setActive(i.id)}
            className={cn(
              "tile-card group relative overflow-hidden rounded-2xl border border-border bg-card p-5 text-start shadow-sm transition",
              i.disabled
                ? "cursor-not-allowed opacity-60"
                : "hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-lg hover:shadow-primary/5",
            )}
            style={{ animationDelay: `${idx * 90}ms` }}
          >
            <div className="flex items-start justify-between gap-3">
              <TileIcon kind={i.icon} accent={i.accent} />
              {i.badge && <Badge tone={i.disabled ? "default" : "info"}>{i.badge}</Badge>}
            </div>
            <h3 className="mt-4 text-base font-bold">{i.title}</h3>
            <p className="mt-1.5 text-xs leading-6 text-muted">{i.description}</p>
            {!i.disabled && (
              <span className="mt-3 inline-flex items-center gap-1 text-xs font-bold text-primary transition group-hover:gap-2">
                اجرا ←
              </span>
            )}
          </button>
        ))}
      </div>

      <Modal
        open={active === "opportunity-scanner"}
        onClose={() => setActive(null)}
        title={
          <span className="flex items-center gap-2">
            {idea?.title}
            <Badge tone="info">اسکنر فرصت</Badge>
          </span>
        }
      >
        <ScannerDialog pairs={pairs} />
      </Modal>

      <Modal
        open={active === "whale-watch"}
        onClose={() => setActive(null)}
        title={
          <span className="flex items-center gap-2">
            {idea?.title}
            <Badge tone="warning">ردیابی اوردر‌بوک</Badge>
          </span>
        }
      >
        <WhaleDialog />
      </Modal>

      <Modal
        open={active === "smart-grid"}
        onClose={() => setActive(null)}
        title={
          <span className="flex items-center gap-2">
            {idea?.title}
            <Badge tone="success">استراتژی اجرایی</Badge>
          </span>
        }
      >
        <GridDialog pairs={pairs} />
      </Modal>
    </>
  );
}
