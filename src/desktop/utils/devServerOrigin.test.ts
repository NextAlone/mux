import { describe, expect, test } from "bun:test";
import { getDesktopDevServerOrigin } from "./devServerOrigin";

describe("getDesktopDevServerOrigin", () => {
  test("uses the shared desktop development defaults", () => {
    expect(getDesktopDevServerOrigin({})).toBe("http://127.0.0.1:5173");
  });

  test("uses the configured host and port together", () => {
    expect(
      getDesktopDevServerOrigin({
        MUX_DEVSERVER_HOST: "localhost",
        MUX_DEVSERVER_PORT: "6173",
      })
    ).toBe("http://localhost:6173");
  });
});
