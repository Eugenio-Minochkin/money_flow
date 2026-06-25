export function resolveDraftSaveResponse(status, body) {
  if (status === 409 && body?.draft) return { conflict: true, draft: body.draft };
  return { conflict: false, draft: body?.draft ?? null };
}

export function classifyConfirmOutcome(data) {
  return { alreadySaved: Boolean(data?.alreadySaved) };
}
