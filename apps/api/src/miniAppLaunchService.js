import { normalizeAcquisitionSource, normalizeReportMarker } from "./productAnalytics.js";

export function createMiniAppLaunchService({ repository, now = () => new Date() }) {
  return {
    async loadDashboard({ auth, reportType, reportKey, timeZone, timing, defer = (operation) => operation() } = {}) {
      if (!auth?.verified || !auth.profile || Number(auth.profile.id) !== Number(auth.telegramUserId)) {
        throw codedError("Verified Telegram init data required", "telegram_init_data_required");
      }

      const hasStartParam = typeof auth.startParam === "string" && auth.startParam.trim() !== "";
      const acquisitionSource = normalizeAcquisitionSource(auth.startParam);
      const user = await measure(timing, "user_upsert", () => repository.upsertTelegramUser({
        ...auth.profile,
        acquisitionSource,
        acquisitionSeenAt: now()
      }));

      const candidateMarker = normalizeReportMarker(reportType, reportKey);
      const reportMarker = candidateMarker && await measure(timing, "report_lookup", () => repository.hasReportDelivery?.(
        user.id,
        candidateMarker.reportType,
        candidateMarker.reportKey
      )) ? candidateMarker : null;
      const launchSource = reportMarker
        ? "report"
        : hasStartParam ? "startapp" : "telegram_profile";
      const miniAppMetadata = { launchSource };
      if (hasStartParam) miniAppMetadata.startParam = acquisitionSource;

      const needsOnboarding = user.onboarding_step && user.onboarding_step !== "completed";
      if (needsOnboarding) {
        await scheduleRecord(repository, user.id, "miniapp_opened", miniAppMetadata);
      } else {
        defer(() => scheduleRecord(repository, user.id, "miniapp_opened", miniAppMetadata));
      }

      if (timeZone) await measure(timing, "timezone_sync", () => repository.syncUserTimezone?.(auth.telegramUserId, timeZone));

      if (needsOnboarding) {
        await safeRecordOnce(repository, user.id, "onboarding_started", {
          source: hasStartParam ? "startapp" : "miniapp"
        });
        return { onboarding: true, user };
      }

      const dashboard = await measure(timing, "repository_dashboard", () => repository.dashboard(auth.telegramUserId, undefined, timing));
      if (!dashboard) return null;

      if (reportMarker) {
        defer(() => scheduleRecord(repository, user.id, "report_app_clicked", reportMarker));
      }
      defer(() => scheduleRecord(repository, user.id, "dashboard_opened", {
        source: reportMarker ? "report" : hasStartParam ? "direct" : "menu"
      }));
      return dashboard;
    }
  };
}

async function scheduleRecord(repository, userId, eventName, metadata) {
  try {
    await repository.recordAppEvent?.(userId, eventName, metadata);
  } catch (error) {
    console.warn("[events] record failed", {
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
      eventName,
      message: error.message
    });
  }
}

function codedError(message, code) {
  return Object.assign(new Error(message), { code });
}

function measure(timing, name, operation) {
  return timing ? timing.measure(name, operation) : operation();
}
