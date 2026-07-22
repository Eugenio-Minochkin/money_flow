export function createPlannedRecreateSession() {
  return { busy: false, completed: false };
}

export async function runPlannedRecreate({
  session,
  recreateRequest,
  closeForm,
  loadDashboard,
  refreshArchive,
  showCreated,
  showRefreshWarning
}) {
  if (session.busy || session.completed) return { status: "busy" };
  session.busy = true;
  try {
    const result = await recreateRequest();
    session.completed = true;
    closeForm();
    showCreated(result);
    const settled = await Promise.allSettled([loadDashboard(), refreshArchive()]);
    const refreshFailed = settled.some((entry) => entry.status === "rejected");
    if (refreshFailed) showRefreshWarning();
    return { status: refreshFailed ? "created_with_refresh_warning" : "created", result };
  } catch (error) {
    if (!session.completed) session.busy = false;
    throw error;
  }
}
