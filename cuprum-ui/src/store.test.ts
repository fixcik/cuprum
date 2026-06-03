import { describe, it, expect, beforeEach } from "vitest";
import { useStore, type Placement } from "@/store";
import { SCREEN_H_MM } from "@/lib/api";

// Reset the singleton store before each test for isolation.
const initial = useStore.getState();
beforeEach(() => useStore.setState(initial, true));

const s = () => useStore.getState();
const place = (id: string, x: number, y: number, w = 10, h = 10): Placement => ({
  id,
  path: `/p/${id}.gbr`,
  name: id,
  xMm: x,
  yMm: y,
  rotationDeg: 0,
  wMm: w,
  hMm: h,
  pngUrl: "",
});

describe("board + exposure clamps", () => {
  it("clamps board size into [1, screen]", () => {
    s().setBoard(0, 1e9);
    expect(s().boardWmm).toBe(1);
    expect(s().boardHmm).toBe(SCREEN_H_MM);
  });

  it("rounds and clamps exposure and pwm", () => {
    s().setExposure(0.4);
    expect(s().exposureS).toBe(1);
    s().setExposure(1000);
    expect(s().exposureS).toBe(600);
    s().setPwm(999);
    expect(s().pwm).toBe(255);
    s().setPwm(0.6);
    expect(s().pwm).toBe(1);
  });
});

describe("selection", () => {
  it("plain select replaces, additive toggles, null clears", () => {
    s().select("a");
    expect(s().selectedIds).toEqual(["a"]);
    s().select("b");
    expect(s().selectedIds).toEqual(["b"]);
    s().select("a", true);
    expect(s().selectedIds).toEqual(["b", "a"]);
    s().select("b", true);
    expect(s().selectedIds).toEqual(["a"]);
    s().select(null);
    expect(s().selectedIds).toEqual([]);
  });

  it("selectMany unions when additive, replaces otherwise", () => {
    useStore.setState({ selectedIds: ["a"] });
    s().selectMany(["b", "c"], true);
    expect(s().selectedIds).toEqual(["a", "b", "c"]);
    s().selectMany(["x"], false);
    expect(s().selectedIds).toEqual(["x"]);
  });
});

describe("move", () => {
  it("moves one placement and a batch", () => {
    useStore.setState({ placements: [place("a", 0, 0), place("b", 0, 0)], selectedIds: [] });
    s().movePlacement("a", 10, 20);
    expect(s().placements.find((p) => p.id === "a")!.xMm).toBe(10);
    s().moveMany([
      { id: "a", xMm: 1, yMm: 2 },
      { id: "b", xMm: 3, yMm: 4 },
    ]);
    const ps = s().placements;
    expect([ps.find((p) => p.id === "a")!.xMm, ps.find((p) => p.id === "b")!.xMm]).toEqual([1, 3]);
  });
});

describe("alignSelected", () => {
  it("aligns the selection to the left edge of its bounding box, leaving others", () => {
    useStore.setState({
      placements: [place("a", 0, 0, 10, 10), place("b", 50, 5, 20, 10), place("c", 100, 0)],
      selectedIds: ["a", "b"],
    });
    s().alignSelected("left");
    const ps = s().placements;
    expect(ps.find((p) => p.id === "a")!.xMm).toBe(0);
    expect(ps.find((p) => p.id === "b")!.xMm).toBe(0);
    expect(ps.find((p) => p.id === "c")!.xMm).toBe(100);
  });

  it("is a no-op with fewer than two selected", () => {
    useStore.setState({ placements: [place("a", 7, 7)], selectedIds: ["a"] });
    s().alignSelected("left");
    expect(s().placements[0].xMm).toBe(7);
  });
});

describe("distributeSelected", () => {
  it("evenly spaces 3+ selection centers along an axis", () => {
    // centers x = 5, 40, 105 -> step (105-5)/2 = 50 -> centers 5,55,105 -> x 0,50,100
    useStore.setState({
      placements: [place("a", 0, 0), place("b", 35, 0), place("c", 100, 0)],
      selectedIds: ["a", "b", "c"],
    });
    s().distributeSelected("h");
    const x = (id: string) => s().placements.find((p) => p.id === id)!.xMm;
    expect(x("a")).toBeCloseTo(0, 6);
    expect(x("b")).toBeCloseTo(50, 6);
    expect(x("c")).toBeCloseTo(100, 6);
  });

  it("is a no-op with fewer than three selected", () => {
    useStore.setState({ placements: [place("a", 0, 0), place("b", 35, 0)], selectedIds: ["a", "b"] });
    s().distributeSelected("h");
    expect(s().placements.find((p) => p.id === "b")!.xMm).toBe(35);
  });
});

describe("autoArrange", () => {
  it("packs count copies of the template, keeping other files", () => {
    useStore.setState({
      boardWmm: 100,
      boardHmm: 80,
      boardXmm: 0,
      boardYmm: 0,
      placements: [place("t", 0, 0, 20, 20), place("other", 0, 0, 5, 5)],
      selectedIds: ["t"],
    });
    s().autoArrange(4, 0);
    const ps = s().placements;
    expect(ps.filter((p) => p.path === "/p/other.gbr")).toHaveLength(1);
    expect(ps.filter((p) => p.path === "/p/t.gbr")).toHaveLength(4);
    expect(s().selectedIds).toHaveLength(4);
  });
});

describe("clipboard + duplicate + remove", () => {
  it("removes the selection and clears it", () => {
    useStore.setState({ placements: [place("a", 0, 0), place("b", 0, 0)], selectedIds: ["a"] });
    s().removeSelected();
    expect(s().placements.map((p) => p.id)).toEqual(["b"]);
    expect(s().selectedIds).toEqual([]);
  });

  it("duplicates the selection with fresh ids nudged +4mm and selects the copies", () => {
    useStore.setState({ placements: [place("a", 0, 0, 10, 10)], selectedIds: ["a"] });
    s().duplicateSelected();
    const ps = s().placements;
    expect(ps).toHaveLength(2);
    const dup = ps.find((p) => p.id !== "a")!;
    expect(dup.xMm).toBe(4);
    expect(dup.yMm).toBe(4);
    expect(s().selectedIds).toEqual([dup.id]);
  });

  it("copies to clipboard and pastes nudged duplicates", () => {
    useStore.setState({ placements: [place("a", 0, 0)], selectedIds: ["a"] });
    s().copySelected();
    s().select(null);
    s().paste();
    expect(s().placements).toHaveLength(2);
  });
});
