import { draftNeedsCategoryChoice } from "./draftCategory.js";

export function isQuickCaptureAutoSaveEligible(items) {
  return Array.isArray(items)
    && items.length === 1
    && items[0]?.needs_review !== true
    && !draftNeedsCategoryChoice(items[0]);
}
