import { afterAll } from "vitest";
import { removeTemporaryPaths } from "./git";

// Runs once per test file, since vitest loads setup files per file.
afterAll(removeTemporaryPaths);
