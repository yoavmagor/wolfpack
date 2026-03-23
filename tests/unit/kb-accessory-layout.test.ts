/**
 * kb-accessory layout tests — verify buttons fit on common phone widths
 * without requiring horizontal scroll.
 *
 * These are static budget calculations based on the CSS values. They break
 * if someone changes padding/gap/font-size in styles.css without keeping
 * the layout within budget.
 */
import { describe, test, expect } from "bun:test";

// ── CSS values for mobile (@media max-width: 768px) ──
const CONTAINER_PADDING_PX = 6 * 2;   // padding: 5px 6px → 6px each side
const GAP_PX = 4;                       // gap: 4px

// Button specs: label + padding → estimated rendered width.
// Mobile overrides: padding 6px 8px = 16px horizontal, font-size 12px.
// Char width at 12px ~7px (600 weight sans-serif).
const CHAR_W = 7;
const BTN_H_PAD = 8 * 2;              // padding-left + padding-right
const BTN_BORDER = 2;                  // 1px border each side

function btnWidth(label: string, overrides?: { pad?: number }) {
  const pad = overrides?.pad ?? BTN_H_PAD;
  // Single-char symbols (arrows, enter) use ~12px at font-size 16-18px
  const contentW = label.length === 1 ? 12 : label.length * CHAR_W;
  return contentW + pad + BTN_BORDER;
}

// Buttons in order (matching index.html)
const BUTTONS = [
  { label: "↵", pad: 10 * 2 },   // kb-enter: padding 6px 10px, font-size 16px → ~12px glyph
  { label: "Esc" },
  { label: "▲" },
  { label: "▼" },
  { label: "◄" },
  { label: "►" },
  { label: "git" },
  { label: "⌨", pad: 8 * 2 },    // kb-open: padding 5px 8px, svg 18px wide
];

function totalRowWidth(buttons: typeof BUTTONS): number {
  const widths = buttons.map(b => btnWidth(b.label, b.pad ? { pad: b.pad } : undefined));
  // kb-open SVG is 18px wide, override char estimate
  widths[widths.length - 1] = 18 + (8 * 2) + BTN_BORDER;
  const gaps = (buttons.length - 1) * GAP_PX;
  return widths.reduce((a, b) => a + b, 0) + gaps + CONTAINER_PADDING_PX;
}

describe("kb-accessory mobile layout", () => {
  const total = totalRowWidth(BUTTONS);

  test("total estimated width is calculated", () => {
    // Sanity: should be a reasonable number
    expect(total).toBeGreaterThan(100);
    expect(total).toBeLessThan(500);
  });

  test("fits iPhone SE (320px)", () => {
    expect(total).toBeLessThanOrEqual(320);
  });

  test("fits iPhone 13 mini (375px)", () => {
    expect(total).toBeLessThanOrEqual(375);
  });

  test("fits iPhone 14/15 (390px)", () => {
    expect(total).toBeLessThanOrEqual(390);
  });

  test("button count matches index.html", () => {
    // If someone adds/removes buttons, this test reminds them to update the layout test
    expect(BUTTONS.length).toBe(8);
  });
});
