import { describe, expect, test } from "bun:test";
import { translateExact } from "./translateExact";

describe("translateExact", () => {
  test("returns an own dictionary translation", () => {
    expect(translateExact({ Settings: "设置" }, "Settings")).toBe("设置");
  });

  test.each(["constructor", "toString", "__proto__"])(
    "does not expose Object prototype value for %s",
    (text) => {
      expect(translateExact({}, text)).toBe(text);
    }
  );
});
