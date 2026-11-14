import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { colors, componentColors, radius, type } from "./tokens";

// Reads the @theme block in src/index.css and checks it against tokens.ts, so
// a colour changed in one place but not the other fails CI. Vitest replaces
// CSS imports with empty strings, so the file is read from disk. Tests run
// from the project root.
const css = readFileSync(resolve(process.cwd(), "src/index.css"), "utf8");

function themeVar(name: string): string | undefined {
  const match = css.match(new RegExp(`--${name}:\\s*([^;]+);`));
  return match?.[1]?.trim();
}

function kebab(value: string): string {
  return value.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

describe("index.css @theme matches tokens.ts", () => {
  const cases: Array<[string, string]> = [
    ...Object.entries(colors.bg).map(([k, v]): [string, string] => [`color-bg-${k}`, v]),
    ...Object.entries(colors.text).map(([k, v]): [string, string] => [`color-text-${k}`, v]),
    ...Object.entries(colors.semantic).map(([k, v]): [string, string] => [`color-${k}`, v]),
    ...Object.entries(colors.tools).map(([k, v]): [string, string] => [`color-tool-${k}`, v]),
    ...Object.entries(componentColors.button).map(([k, v]): [string, string] => [
      `color-button-${kebab(k)}`,
      v,
    ]),
    ...Object.entries(componentColors.badge).map(([k, v]): [string, string] => [`color-badge-${k}`, v]),
    ...Object.entries(type.size).map(([k, v]): [string, string] => [`text-${k}`, v]),
    ...Object.entries(type.leading).map(([k, v]): [string, string] => [`leading-${k}`, v]),
    ...Object.entries(radius)
      .filter(([k]) => k !== "full")
      .map(([k, v]): [string, string] => [`radius-${k}`, v]),
  ];

  it.each(cases)("--%s is %s", (name, value) => {
    expect(themeVar(name)?.toLowerCase()).toBe(value.toLowerCase());
  });

  it("uses a 4px spacing unit", () => {
    expect(themeVar("spacing")).toBe("4px");
  });

  it("uses the token font stacks", () => {
    const normalise = (s: string | undefined) => s?.replace(/["']/g, "").replace(/\s+/g, " ");
    expect(normalise(themeVar("font-sans"))).toBe(normalise(type.family.sans));
    expect(normalise(themeVar("font-mono"))).toBe(normalise(type.family.mono));
  });
});
