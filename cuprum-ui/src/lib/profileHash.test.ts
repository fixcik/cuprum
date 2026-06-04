import { describe, it, expect } from "vitest";
import { profileHash } from "@/lib/profileHash";
import { DEFAULT_PROFILE } from "@/lib/capabilityProfile";
import type { CapabilityProfile } from "@/lib/capabilityProfile";

describe("profileHash", () => {
  it("returns a non-empty string", () => {
    expect(profileHash(DEFAULT_PROFILE)).toBeTruthy();
    expect(typeof profileHash(DEFAULT_PROFILE)).toBe("string");
  });

  it("same profile produces same hash (stable)", () => {
    const h1 = profileHash(DEFAULT_PROFILE);
    const h2 = profileHash({ ...DEFAULT_PROFILE });
    expect(h1).toBe(h2);
  });

  it("key insertion order does not affect the hash", () => {
    // Build the same profile with different key orders
    const p1: CapabilityProfile = { ...DEFAULT_PROFILE };
    // Reverse the key order by building a fresh object with reversed keys
    const entries = Object.entries(p1).reverse();
    const p2 = Object.fromEntries(entries) as unknown as CapabilityProfile;
    expect(profileHash(p1)).toBe(profileHash(p2));
  });

  it("changing minTraceMm produces a different hash", () => {
    const h1 = profileHash(DEFAULT_PROFILE);
    const h2 = profileHash({ ...DEFAULT_PROFILE, minTraceMm: 0.2 });
    expect(h1).not.toBe(h2);
  });

  it("changing maxPanelWidthMm produces a different hash", () => {
    const h1 = profileHash(DEFAULT_PROFILE);
    const h2 = profileHash({ ...DEFAULT_PROFILE, maxPanelWidthMm: 150 });
    expect(h1).not.toBe(h2);
  });

  it("changing minDrillMm produces a different hash", () => {
    const h1 = profileHash(DEFAULT_PROFILE);
    const h2 = profileHash({ ...DEFAULT_PROFILE, minDrillMm: 0.5 });
    expect(h1).not.toBe(h2);
  });

  it("changing a boolean flag produces a different hash", () => {
    const h1 = profileHash(DEFAULT_PROFILE);
    const h2 = profileHash({ ...DEFAULT_PROFILE, allowRotateToFit: !DEFAULT_PROFILE.allowRotateToFit });
    expect(h1).not.toBe(h2);
  });

  it("different profiles produce different hashes (no collision on common variants)", () => {
    const profiles: CapabilityProfile[] = [
      DEFAULT_PROFILE,
      { ...DEFAULT_PROFILE, minTraceMm: 0.1 },
      { ...DEFAULT_PROFILE, maxPanelWidthMm: 300 },
      { ...DEFAULT_PROFILE, viaPlatingAvailable: true },
    ];
    const hashes = profiles.map(profileHash);
    const unique = new Set(hashes);
    expect(unique.size).toBe(profiles.length);
  });
});
