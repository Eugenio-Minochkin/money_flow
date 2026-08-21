export async function advanceShortcutSetup({ api, telegramUserId, writeText, preparationId = null, shortcutUrl = null, openShortcut = null }) {
  let nextPreparationId = preparationId;
  if (!nextPreparationId) {
    try {
      const prepared = await api("/api/quick-access-token-preparations", { method: "POST", body: { telegramUserId } });
      await writeText(prepared.token);
      nextPreparationId = prepared.preparationId;
    } catch (error) {
      return { status: "preparation_failed", preparationId: null, error };
    }
  }
  try {
    await api(`/api/quick-access-token-preparations/${nextPreparationId}/activate`, { method: "POST", body: { telegramUserId } });
  } catch (error) {
    return { status: "activation_failed", preparationId: nextPreparationId, error };
  }
  try { if (shortcutUrl && openShortcut) openShortcut(shortcutUrl); } catch { /* the ready state retains a manual Open Shortcut action */ }
  return { status: "activated", preparationId: null };
}
