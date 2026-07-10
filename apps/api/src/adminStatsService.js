import { createTechnicalStatsService, formatTechnicalStats } from "./technicalStatsService.js";

export function createAdminStatsService({
  pool,
  now = () => new Date(),
  productStatsService,
  technicalStatsService
}) {
  const technical = technicalStatsService ?? createTechnicalStatsService({ pool, now });
  const product = productStatsService ?? technical;
  return {
    getAdminStats() {
      if (typeof product.getProductStats === "function") return product.getProductStats();
      return product.getTechnicalStats();
    },
    getTechnicalStats() {
      return technical.getTechnicalStats();
    }
  };
}

// Kept as a compatibility export while Telegram command formatting is split.
export const formatAdminStats = formatTechnicalStats;
