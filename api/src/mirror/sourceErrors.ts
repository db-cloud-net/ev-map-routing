export type SourceErrorCode =
  | "CONFIG_MISSING"
  | "REMOTE_HTTP"
  | "REMOTE_RATE_LIMIT"
  | "REMOTE_TIMEOUT"
  | "REMOTE_NETWORK"
  | "REMOTE_PARSE"
  | "MIRROR_UNAVAILABLE"
  | "MIRROR_MANIFEST_MISSING"
  | "MIRROR_MANIFEST_INVALID"
  | "MIRROR_ARTIFACT_MISSING"
  | "MIRROR_ARTIFACT_CORRUPT"
  | "SCHEMA_MISMATCH"
  | "SNAPSHOT_INVALID"
  | "STALE_SNAPSHOT"
  | "INTERNAL";

export type SourceTier = "nrel" | "overpass" | "mirror";

export type SourceError = Error & {
  code: SourceErrorCode;
  source: SourceTier;
  retryable: boolean;
  fallbackSuggested?: boolean;
  context?: Record<string, unknown>;
};

export class SourceErrorImpl extends Error {
  public code: SourceErrorCode;
  public source: SourceTier;
  public retryable: boolean;
  public fallbackSuggested?: boolean;
  public context?: Record<string, unknown>;

  constructor(args: {
    message: string;
    code: SourceErrorCode;
    source: SourceTier;
    retryable: boolean;
    fallbackSuggested?: boolean;
    cause?: unknown;
    context?: Record<string, unknown>;
  }) {
    super(args.message);
    this.name = "SourceError";
    this.code = args.code;
    this.source = args.source;
    this.retryable = args.retryable;
    this.fallbackSuggested = args.fallbackSuggested;
    this.context = args.context;

    // Preserve the original error for debugging while still mapping to codes.
    if (args.cause instanceof Error) {
      (this as any).cause = args.cause;
    }
  }
}

