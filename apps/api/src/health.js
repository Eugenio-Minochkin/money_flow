export async function handleHealth({ repository, revision, isProduction, res, sendJson, logger = console }) {
  try {
    const health = await repository.health();
    if (isProduction && revision === 'unknown') {
      return sendJson(res, 503, { ok: false, ...health, revision });
    }
    return sendJson(res, 200, { ok: true, ...health, revision });
  } catch (error) {
    logger.error('[health] database check failed', error.message);
    return sendJson(res, 503, { ok: false, db: false, revision });
  }
}
