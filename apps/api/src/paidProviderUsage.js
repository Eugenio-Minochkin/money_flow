export class PaidProviderLimitError extends Error {
  constructor(provider) {
    super("paid_provider_limit_reached");
    this.code = "paid_provider_limit_reached";
    this.provider = provider;
  }
}

export class PaidProviderDisabledError extends Error {
  constructor(provider) {
    super("paid_provider_disabled");
    this.code = "paid_provider_disabled";
    this.provider = provider;
  }
}

export function createPaidProviderUsageGate({ repository, provider, windowMs, maxRequests, maxAudioSeconds = null, enabled = true }) {
  return async ({ userId, requestUnits = 1, audioSeconds = 0, requestKey = null } = {}) => {
    if (!enabled) throw new PaidProviderDisabledError(provider);
    const result = await repository.reservePaidProviderUsage({
      userId,
      provider,
      windowMs,
      maxRequests,
      maxAudioSeconds,
      audioSeconds,
      requestUnits,
      requestKey
    });
    if (!result?.allowed) throw new PaidProviderLimitError(provider);
    return result;
  };
}
