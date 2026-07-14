import { beforeAll } from "vitest";
import { assertE2EInfrastructure } from "./infrastructure.js";

/** Install the infrastructure guard for direct and suite-level test runs. */
export const requireE2EInfrastructure = (): void => {
  beforeAll(assertE2EInfrastructure);
};
