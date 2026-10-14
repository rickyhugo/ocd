import type { ManagerInfo } from "@ocd/core";
import { describe, expect, it } from "vite-plus/test";

import { managerSessionFor } from "./manager-route.ts";

const info = (id: string | null): ManagerInfo => ({
  directory: "/m",
  active: id ? { sessionId: id, directory: "/m", activatedAt: "2026-10-13T00:00:00Z" } : null,
});

describe("managerSessionFor", () => {
  it("accepts only the supervisor's active manager session", () => {
    expect(managerSessionFor({ type: "session", sessionID: "m" }, info("m"))).toBe("m");
    expect(managerSessionFor({ type: "session", sessionID: "w" }, info("m"))).toBeNull();
    expect(managerSessionFor({ type: "session", sessionID: "m" }, info(null))).toBeNull();
    expect(managerSessionFor({ type: "home" }, info("m"))).toBeNull();
    expect(managerSessionFor({ type: "session", sessionID: "m" }, null)).toBeNull();
  });
});
