export function draftNeedsCategoryChoice(item) {
  return item?.category_source !== "user"
    && (item?.category_slug === "other" || Boolean(item?.needs_review));
}
