import strengthProfiles from "../data/operatorStrength.cn.json";
import type { OperatorStrengthProfile } from "../data/operatorStrength.schema";

const profiles = strengthProfiles as OperatorStrengthProfile[];
const profileByName = new Map<string, OperatorStrengthProfile>();

function addProfileKey(key: string, profile: OperatorStrengthProfile): void {
  const normalized = key.trim().toLowerCase();
  if (normalized) profileByName.set(normalized, profile);
}

for (const profile of profiles) {
  addProfileKey(profile.name, profile);
  for (const alias of profile.aliases || []) {
    addProfileKey(alias, profile);
  }
}

export function getOperatorStrengthProfile(name: string): OperatorStrengthProfile | undefined {
  return profileByName.get(name.trim().toLowerCase());
}

export function listOperatorStrengthProfiles(): OperatorStrengthProfile[] {
  return profiles;
}
