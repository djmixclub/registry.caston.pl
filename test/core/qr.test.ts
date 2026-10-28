import { describe, expect, it } from "vitest";
import { encodeQr, qrSvg, type Matrix } from "../../src/core/qr";
import fixtures from "./qr.fixtures.json";

// Reference symbols made with the Python library `segno` (error correction M, byte mode):
// every mask of each text, so the function patterns, the format and version information, the
// Reed-Solomon codewords and their interleaving are all checked module by module.
interface Fixture {
  text: string;
  version: number;
  autoMask: number;
  matrices: Record<string, string[]>;
}

const cases = Object.entries(fixtures as Record<string, Fixture>);

function rows(matrix: Matrix): string[] {
  return matrix.map((row) => row.map((dark) => (dark ? "1" : "0")).join(""));
}

describe("encodeQr", () => {
  for (const [name, fixture] of cases) {
    for (const [mask, expected] of Object.entries(fixture.matrices)) {
      it(`matches the reference for "${name}" (version ${fixture.version}) with mask ${mask}`, () => {
        const matrix = encodeQr(fixture.text, { mask: Number(mask) });
        expect(matrix).not.toBeNull();
        expect(rows(matrix ?? [])).toEqual(expected);
      });
    }

    it(`chooses the mask of the reference for "${name}"`, () => {
      const matrix = encodeQr(fixture.text);
      expect(rows(matrix ?? [])).toEqual(fixture.matrices[String(fixture.autoMask)]);
    });
  }

  it("uses the smallest version that fits", () => {
    expect(encodeQr("a")?.length).toBe(21);
    expect(encodeQr("a".repeat(14))?.length).toBe(21);
    expect(encodeQr("a".repeat(15))?.length).toBe(25);
    expect(encodeQr("a".repeat(213))?.length).toBe(57);
  });

  it("refuses text that does not fit in version 10", () => {
    expect(encodeQr("a".repeat(214))).toBeNull();
    expect(encodeQr("ż".repeat(107))).toBeNull();
  });

  it("is deterministic", () => {
    expect(rows(encodeQr("same") ?? [])).toEqual(rows(encodeQr("same") ?? []));
  });
});

describe("qrSvg", () => {
  it("renders a self-contained SVG with a quiet zone", () => {
    const svg = qrSvg("hello", 'a "label" <b>') ?? "";
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg).toContain('viewBox="0 0 29 29"');
    expect(svg).toContain('aria-label="a label b"');
    expect(svg).toContain('role="img"');
    expect(svg).toContain('<rect width="29" height="29" fill="#fff"/>');
    expect(svg).not.toMatch(/<script|style=|href=|<image|onload/i);
  });

  it("draws exactly the dark modules", () => {
    const matrix = encodeQr("hello") ?? [];
    const svg = qrSvg("hello", "x") ?? "";
    const path = /<path d="([^"]*)"/.exec(svg)?.[1] ?? "";
    const squares = [...path.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)];
    const drawn = new Set<string>();
    for (const [, x, y, width] of squares) {
      for (let k = 0; k < Number(width); k++) drawn.add(`${Number(x) + k},${y}`);
    }
    const dark = new Set<string>();
    matrix.forEach((row, r) =>
      row.forEach((on, c) => {
        if (on) dark.add(`${c + 4},${r + 4}`);
      }),
    );
    expect(drawn).toEqual(dark);
  });

  it("gives null for text that is too long", () => {
    expect(qrSvg("a".repeat(214), "x")).toBeNull();
  });
});
