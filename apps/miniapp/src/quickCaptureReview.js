export function quickCaptureItemNeedsReview(item) {
  return item.needs_review || item.category_slug === "other";
}

export function collectQuickCaptureReviewItems(items, readValue, categoryConfirmed = () => false) {
  return items.map((item, index) => {
    if (!quickCaptureItemNeedsReview(item)) return item;
    const userSelectedCategory = categoryConfirmed(index);
    return {
      ...item,
      amount: Number(readValue(`quick-capture-${index}-amount`) ?? item.amount),
      category_slug: userSelectedCategory ? (readValue(`quick-capture-${index}-category`) ?? item.category_slug) : item.category_slug,
      category_source: userSelectedCategory ? "user" : item.category_source,
      needs_review: false
    };
  });
}
