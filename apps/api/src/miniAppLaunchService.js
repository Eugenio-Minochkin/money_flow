import { normalizeAcquisitionSource, normalizeReportMarker } from "./productAnalytics.js";

export function createMiniAppLaunchService({ repository, now = () => new Date() }) {
  return {
    async loadDashboard({ auth, reportType, reportKey, timeZone } = {}) {
      if (!auth?.verified || !auth.profile || Number(auth.profile.id) !== Number(auth.telegramUserId)) {
        throw codedError("Verified Telegram init data required", "telegram_init_data_required");
      }

      const hasStartParam = typeof auth.startParam === "string" && auth.startParam.trim() !== "";
      const acquisitionSource = normalizeAcquisitionSource(auth.startParam);
      const user = await repository.upsertTelegramUser({
        ...auth.profile,
        acquisitionSource,
        acquisitionSeenAt: now()
      });

      const candidateMarker = normalizeReportMarker(reportType, reportKey);
      const reportMarker = candidateMarker && await repository.hasReportDelivery?.(
        user.id,
        candidateMarker.reportType,
        candidateMarker.reportKey
      ) ? candidateMarker : null;
      const launchSource = reportMarker
        ? "report"
        : hasStartParam ? "startapp" : "telegram_profile";
      const miniAppMetadata = { launchSource };
      if (hasStartParam) miniAppMetadata.startParam = acquisitionSource;
      await safeRecord(repository, user.id, "miniapp_opened", miniAppMetadata);

      if (timeZone) await repository.syncUserTimezone?.(auth.telegramUserId, timeZone);

      if (user.onboarding_step && user.onboarding_step !== "completed") {
        await safeRecordOnce(repository, user.id, "onboarding_started", {
          source: hasStartParam ? "startapp" : "miniapp"
        });
        return { onboarding: true, user };
      }

      const dashboard = await repository.dashboard(auth.telegramUserId);
      if (!dashboard) return null;

      if (reportMarker) {
        await safeRecord(repository, user.id, "report_app_clicked", reportMarker);
      }
      await safeRecord(repository, user.id, "dashboard_opened", {
        source: reportMarker ? "report" : hasStartParam ? "direct" : "menu"
      });
      return dashboard;
    }
  };
}

async function safeRecord(repository, userId, eventName, metadata) {
  try {
    await repository.recordAppEvent?.(userId, eventName, metadata);
  } catch (error) {
    console.warn("[events] record failed", {
      userId: userId ?? null,
      eventName,
      message: error.message
    });
  }
}

async function safeRecordOnce(repository, userId, eventName, metadata) {
  try {
    await repository.recordAppEventOnce?.(userId, eventName, metadata);
  } catch (error) {
    console.warn("[events] record failed", {
      userId: userId ?? null,
      eventName,
      message: error.message
    });
  }
}

function codedError(message, code) {
  return Object.assign(new Error(message), { code });
}
