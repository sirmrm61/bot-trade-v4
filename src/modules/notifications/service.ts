import { prisma } from "@/infrastructure/database/prisma";
import { enqueue, QUEUE_NAMES, type NotificationJobData } from "@/infrastructure/queue/queues";
import { logger } from "@/infrastructure/logging/logger";

/**
 * Notification service — creates the internal notification row and
 * enqueues a Telegram relay job. Telegram failures never block the caller.
 */

export async function notify(opts: {
  userId: string;
  type: string;
  title: string;
  body: string;
  severity?: "INFO" | "SUCCESS" | "WARNING" | "ERROR" | "CRITICAL";
  metadata?: Record<string, unknown>;
  telegram?: boolean;
}) {
  const notification = await prisma.notification.create({
    data: {
      userId: opts.userId,
      type: opts.type,
      title: opts.title,
      body: opts.body,
      severity: opts.severity ?? "INFO",
      metadata: opts.metadata ? JSON.stringify(opts.metadata) : null,
    },
  });

  if (opts.telegram !== false) {
    try {
      await enqueue<NotificationJobData>(QUEUE_NAMES.NOTIFICATION, "send", {
        notificationId: notification.id,
      });
    } catch (err) {
      // Redis down → notification still persisted internally
      logger.warn("notification enqueue failed", { module: "notifications", errorCode: String(err) });
    }
  }
  return notification;
}

/** Telegram sender — called only from the notification worker. */
export async function sendTelegram(chatId: string, text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || process.env.TELEGRAM_ENABLED !== "true") return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });
    return res.ok;
  } catch (err) {
    logger.warn("telegram send failed", { module: "notifications", errorCode: String(err) });
    return false;
  }
}
