/**
 * Shared status-payload types for the Setup Wizard's configuration-detection
 * flow. Imported by both the backend route (configRoutes.ts) and the
 * frontend (SetupWizard.tsx / App.tsx) so the two sides can't drift apart on
 * field names or the "already configured, don't resend" sentinel value.
 */

export type ConfigSource = "env" | "db" | null;

export interface ConfigItemStatus {
  isConfigured: boolean;
  source: ConfigSource;
}

export interface WizardStatusResponse {
  aiProviders: Record<string, ConfigItemStatus>;
  brokers: Record<string, ConfigItemStatus>;
  dataProviders: Record<string, ConfigItemStatus>;
}

/**
 * Placeholder value the frontend puts into a locked field's state so it has
 * *something* non-empty to satisfy existing "is this filled in" checks,
 * without ever holding a real secret. Any save/submit path MUST treat this
 * value as "no new key entered" and skip sending it to the backend - never
 * forward it as a real apiKey, or it will overwrite the real stored key with
 * this literal string.
 */
export const CONFIGURED_SENTINEL = "__configured__";
