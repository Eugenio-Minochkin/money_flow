export async function advanceShortcutSetup({ api, telegramUserId, writeText, preparationId = null }) {
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
    return { status: "activated", preparationId: null };
  } catch (error) {
    return { status: "activation_failed", preparationId: nextPreparationId, error };
  }
}
