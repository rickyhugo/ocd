import { FakeAdapter } from "./fake.ts";
import type { HarnessDescriptor } from "./harness.ts";

/** The scripted harness behind tests and dry runs; `allowFakeHarness` switches it on. */
export const fakeHarness: HarnessDescriptor = {
  name: "fake",
  label: "Fake harness",
  binary: "fake",
  config: null,
  sessionsSurviveSupervisor: false,
  profileName: "fake",
  create: () => new FakeAdapter(),
  models: {},
};
