import { createTechnicalStatsService, formatTechnicalStats } from "./technicalStatsService.js";
import { createProductStatsService } from "./productStatsService.js";

export function createAdminStatsService({
  pool,
  now = () => new Date(),
  productStatsService,
  technicalStatsService
}) {
  const technical = technicalStatsService ?? createTechnicalStatsService({ pool, now });
  const product = productStatsService ?? createProductStatsService({ pool, now });
  return {
    getAdminStats() {
      return product.getProductStats();
    },
    getTechnicalStats() {
      return technical.getTechnicalStats();
    }
  };
}

// Kept as a compatibility export while Telegram command formatting is split.
export const formatAdminStats = formatTechnicalStats;
