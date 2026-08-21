export async function prepareShortcutSetup({ api, telegramUserId }) {
  try {
    const prepared = await api("/api/quick-access-token-preparations", { method: "POST", body: { telegramUserId } });
    return { status: "prepared", preparationId: prepared.preparationId, token: prepared.token };
  } catch (error) {
    return { status: "preparation_failed", preparationId: null, token: null, error };
  }
}

export async function handoffPreparedShortcut({ token, writeText, activate }) {
  if (!writeText) return { status: "copy_failed" };
  try {
    await writeText(token);
  } catch (error) {
    return { status: "copy_failed", error };
  }
  return activate();
}

export async function activatePreparedShortcut({ api, telegramUserId, preparationId, shortcutUrl, openShortcut }) {
  try {
    await api(`/api/quick-access-token-preparations/${preparationId}/activate`, { method: "POST", body: { telegramUserId } });
  } catch (error) {
    return { status: "activation_failed", error };
  }
  try { openShortcut?.(shortcutUrl); } catch { /* retain the ready state with a manual Open Shortcut action */ }
  return { status: "activated" };
}
