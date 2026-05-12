/**
 * Feature flags. v1 ships with no flags active. As v2 phases land, gate them
 * here rather than in conditional branches scattered through the codebase.
 *
 * Reads `WGC_FEATURE_FLAGS_*` env vars. Default for every flag is `false`.
 */
export type FeatureFlag =
  | 'whatsapp_receiver' // Phase 10
  | 'pillar_calculator' // Phase 11
  | 'timetable_drafter_mode_2'; // Phase 12

export const FEATURE_FLAGS: Record<FeatureFlag, boolean> = Object.freeze({
  whatsapp_receiver: process.env.WGC_FEATURE_FLAGS_WHATSAPP_RECEIVER === 'true',
  pillar_calculator: process.env.WGC_FEATURE_FLAGS_PILLAR_CALCULATOR === 'true',
  timetable_drafter_mode_2:
    process.env.WGC_FEATURE_FLAGS_TIMETABLE_DRAFTER_MODE_2 === 'true',
});
