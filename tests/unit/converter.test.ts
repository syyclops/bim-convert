import { describe, it, expect } from "bun:test";
import { parseProgressLine, ProgressTracker } from "../../lib/converter";

describe("parseProgressLine", () => {
  it("parses 'Progress: 45%'", () => {
    expect(parseProgressLine("Progress: 45%")).toBe(45);
  });

  it("parses '45%'", () => {
    expect(parseProgressLine("45%")).toBe(45);
  });

  it("parses 'Progress: 45.5%'", () => {
    expect(parseProgressLine("Progress: 45.5%")).toBe(46); // Rounded
  });

  it("returns null for unrecognized lines", () => {
    expect(parseProgressLine("Loading model...")).toBe(null);
    expect(parseProgressLine("")).toBe(null);
    expect(parseProgressLine("STATUS:Processing")).toBe(null);
  });

  it("handles 0% and 100%", () => {
    expect(parseProgressLine("Progress: 0%")).toBe(0);
    expect(parseProgressLine("Progress: 100%")).toBe(100);
  });

  it("rejects values out of range", () => {
    expect(parseProgressLine("Progress: 150%")).toBe(null);
  });
});

describe("ProgressTracker", () => {
  it("maps phase 1 (loading) to 0-15%", () => {
    const t = new ProgressTracker();
    t.processLine("------- Started Loading BimRv file...");
    expect(t.processLine("Progress: 0.00%")).toBe(0);
    expect(t.processLine("Progress: 50.00%")).toBe(8);   // 0 + 50% of 15 = 7.5 → 8
    expect(t.processLine("Progress: 100.00%")).toBe(15);
  });

  it("maps phase 2 (elements) to 15-30%", () => {
    const t = new ProgressTracker();
    t.processLine("------- Started Loading BimRv file...");
    t.processLine("------- Started Loading Elements...");
    expect(t.processLine("Progress: 0.00%")).toBe(15);
    expect(t.processLine("Progress: 50.00%")).toBe(23);  // 15 + 50% of 15 = 22.5 → 23
    expect(t.processLine("Progress: 100.00%")).toBe(30);
  });

  it("maps phase 3 (export) to 30-100%", () => {
    const t = new ProgressTracker();
    t.processLine("------- Started Loading BimRv file...");
    t.processLine("------- Started Loading Elements...");
    t.processLine("------- Started Export to IFC...");
    expect(t.processLine("Progress: 0.00%")).toBe(30);
    expect(t.processLine("Progress: 50.00%")).toBe(65);  // 30 + 50% of 70 = 65
    expect(t.processLine("Progress: 100.00%")).toBe(100);
  });

  it("never goes backwards", () => {
    const t = new ProgressTracker();
    // Phase 1 reaches 100% → 15
    t.processLine("------- Started Loading BimRv file...");
    const p1 = t.processLine("Progress: 100.00%");
    expect(p1).toBe(15);
    // Phase 2 starts at 0% → 15 (not 0)
    t.processLine("------- Started Loading Elements...");
    const p2 = t.processLine("Progress: 0.00%");
    expect(p2).toBe(15);
  });

  it("returns null for non-progress lines", () => {
    const t = new ProgressTracker();
    expect(t.processLine("------- Started Loading BimRv file...")).toBe(null);
    expect(t.processLine("All export options:")).toBe(null);
    expect(t.processLine("[Service]")).toBe(null);
  });

  it("defaults to phase 1 if no trigger seen", () => {
    const t = new ProgressTracker();
    expect(t.processLine("Progress: 50.00%")).toBe(8); // Phase 1 range: 0-15%
  });
});
