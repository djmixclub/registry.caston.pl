import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ValidationError } from "../../src/core/errors";
import {
  GROUPS_KEY,
  MAX_GROUPS,
  NO_GROUPS,
  assignPackages,
  cleanVisibility,
  childrenOf,
  createGroup,
  deleteGroup,
  flattenGroups,
  groupDepth,
  groupPath,
  groupOf,
  groupVisibility,
  isGroupHidden,
  isPackageHidden,
  normalizeGroups,
  packageGroupKey,
  parentChoices,
  parsePackageGroupKey,
  pruneAssignments,
  readGroups,
  resetGroupsCache,
  updateGroup,
  writeGroups,
  type PackageGroups,
} from "../../src/core/groups";

/** `a` > `b` > `c` > `d` > `e` (five levels) plus `x` at the top. */
function tree(): PackageGroups {
  let state: PackageGroups = NO_GROUPS;
  state = createGroup(state, "Alpha", null, "aaaa");
  state = createGroup(state, "Beta", "aaaa", "bbbb");
  state = createGroup(state, "Gamma", "bbbb", "cccc");
  state = createGroup(state, "Delta", "cccc", "dddd");
  state = createGroup(state, "Epsilon", "dddd", "eeee");
  state = createGroup(state, "Xylo", null, "xxxx");
  return state;
}

function refused(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ValidationError);
    return (err as ValidationError).message;
  }
  throw new Error("expected a ValidationError");
}

describe("package group keys", () => {
  it("joins the ecosystem and the name, lower-casing only NuGet and Swift names", () => {
    expect(packageGroupKey("npm", "@Acme/Sdk")).toBe("npm:@Acme/Sdk");
    expect(packageGroupKey("nuget", "Acme.Sdk")).toBe("nuget:acme.sdk");
    expect(packageGroupKey("swift", "Acme.Net")).toBe("swift:acme.net");
  });

  it("splits a key at the first colon, so Maven names keep theirs", () => {
    expect(parsePackageGroupKey("maven:org.acme:lib")).toEqual({
      eco: "maven",
      name: "org.acme:lib",
    });
    expect(parsePackageGroupKey("nope:x")).toBeNull();
    expect(parsePackageGroupKey("npm:")).toBeNull();
    expect(parsePackageGroupKey("npm")).toBeNull();
  });
});

describe("creating groups", () => {
  it("nests up to five levels", () => {
    const state = tree();
    expect(groupDepth(state, "eeee")).toBe(5);
    expect(refused(() => createGroup(state, "Zeta", "eeee", "ffff"))).toContain("5 levels");
  });

  it("trims and collapses the name, and refuses an empty or too long one", () => {
    const state = createGroup(NO_GROUPS, "  Licensing \t Kit  ", null, "aaaa");
    expect(state.groups[0]?.name).toBe("Licensing Kit");
    expect(refused(() => createGroup(NO_GROUPS, "   ", null, "aaaa"))).toContain("name");
    expect(refused(() => createGroup(NO_GROUPS, "x".repeat(61), null, "aaaa"))).toContain("60");
    expect(refused(() => createGroup(NO_GROUPS, "a\u0007b", null, "aaaa"))).toContain("control");
  });

  it("refuses a name that a sibling has, ignoring case and punctuation", () => {
    const state = createGroup(NO_GROUPS, "Licensing Kit", null, "aaaa");
    expect(refused(() => createGroup(state, "licensing-kit", null, "bbbb"))).toContain(
      "already a group",
    );
    // The same name is fine in another place.
    expect(createGroup(state, "Licensing Kit", "aaaa", "bbbb").groups).toHaveLength(2);
  });

  it("refuses an unknown parent and a group beyond the limit", () => {
    expect(refused(() => createGroup(NO_GROUPS, "A", "zzzz", "aaaa"))).toContain("does not exist");
    const full: PackageGroups = {
      groups: Array.from({ length: MAX_GROUPS }, (_, i) => ({
        id: `g${String(i).padStart(4, "0")}`,
        name: `Group ${i}`,
        parent: null,
      })),
      packages: {},
    };
    expect(refused(() => createGroup(full, "One more", null, "zzzz"))).toContain("200");
  });
});

describe("updating groups", () => {
  it("renames a group", () => {
    const state = updateGroup(tree(), "bbbb", { name: "Bravo" });
    expect(childrenOf(state, "aaaa").map((g) => g.name)).toEqual(["Bravo"]);
  });

  it("moves a group with what is inside it, within the depth limit", () => {
    const state = tree();
    // `Alpha` has four levels below it, so it fits nowhere but the top.
    expect(refused(() => updateGroup(state, "aaaa", { parent: "xxxx" }))).toContain("5 levels");
    const moved = updateGroup(state, "cccc", { parent: "xxxx" });
    expect(groupDepth(moved, "cccc")).toBe(2);
    expect(
      updateGroup(moved, "cccc", { parent: null }).groups.find((g) => g.id === "cccc"),
    ).toEqual({ id: "cccc", name: "Gamma", parent: null });
  });

  it("refuses to move a group into itself or into what is inside it", () => {
    const state = tree();
    expect(refused(() => updateGroup(state, "aaaa", { parent: "aaaa" }))).toContain("itself");
    expect(refused(() => updateGroup(state, "aaaa", { parent: "cccc" }))).toContain("itself");
  });

  it("refuses a name a sibling has and an unknown group", () => {
    const state = createGroup(tree(), "Alpha", "xxxx", "ffff");
    expect(refused(() => updateGroup(state, "ffff", { parent: null }))).toContain("already");
    expect(refused(() => updateGroup(state, "zzzz", { name: "x" }))).toContain("does not exist");
  });
});

describe("deleting groups", () => {
  it("moves subgroups and packages up one level", () => {
    let state = assignPackages(tree(), ["npm:a", "npm:b"], "bbbb");
    state = assignPackages(state, ["npm:c"], "cccc");
    const after = deleteGroup(state, "bbbb");
    expect(after.groups.map((g) => g.id).sort()).toEqual(["aaaa", "cccc", "dddd", "eeee", "xxxx"]);
    expect(groupDepth(after, "cccc")).toBe(2);
    expect(after.packages).toEqual({ "npm:a": "aaaa", "npm:b": "aaaa", "npm:c": "cccc" });
  });

  it("sends the packages of a top group to Ungrouped", () => {
    const state = assignPackages(tree(), ["npm:a"], "xxxx");
    const after = deleteGroup(state, "xxxx");
    expect(after.packages).toEqual({});
    expect(groupOf(after, "npm", "a")).toBeNull();
  });

  it("refuses when a subgroup's name is taken one level up", () => {
    let state = createGroup(NO_GROUPS, "Top", null, "aaaa");
    state = createGroup(state, "Middle", "aaaa", "bbbb");
    state = createGroup(state, "Same", "bbbb", "cccc");
    state = createGroup(state, "Same", "aaaa", "dddd");
    expect(refused(() => deleteGroup(state, "bbbb"))).toContain("already");
    expect(refused(() => deleteGroup(state, "zzzz"))).toContain("does not exist");
  });
});

describe("assigning packages", () => {
  it("keeps a package in one group at most", () => {
    let state = assignPackages(tree(), ["npm:a", "composer:b/c"], "aaaa");
    state = assignPackages(state, ["npm:a"], "xxxx");
    expect(groupOf(state, "npm", "a")).toBe("xxxx");
    expect(groupOf(state, "composer", "b/c")).toBe("aaaa");
    state = assignPackages(state, ["npm:a"], null);
    expect(groupOf(state, "npm", "a")).toBeNull();
  });

  it("refuses an unknown group", () => {
    expect(refused(() => assignPackages(tree(), ["npm:a"], "zzzz"))).toContain("does not exist");
  });

  it("forgets packages that are gone", () => {
    const state = assignPackages(tree(), ["npm:a", "npm:b"], "aaaa");
    expect(pruneAssignments(state, new Set(["npm:b"])).packages).toEqual({ "npm:b": "aaaa" });
  });
});

describe("the tree", () => {
  it("lists parents before children and siblings by name", () => {
    let state = createGroup(tree(), "Able", null, "ffff");
    state = createGroup(state, "Zed", "aaaa", "gggg");
    expect(flattenGroups(state).map(({ group, depth }) => `${depth}:${group.name}`)).toEqual([
      "1:Able",
      "1:Alpha",
      "2:Beta",
      "3:Gamma",
      "4:Delta",
      "5:Epsilon",
      "2:Zed",
      "1:Xylo",
    ]);
  });

  it("offers as parents only what is not inside the group and not too deep", () => {
    const state = tree();
    expect(parentChoices(state, null).map((c) => c.group.id)).toEqual([
      "aaaa",
      "bbbb",
      "cccc",
      "dddd",
      "xxxx",
    ]);
    expect(parentChoices(state, "cccc").map((c) => c.group.id)).toEqual(["aaaa", "bbbb", "xxxx"]);
    expect(parentChoices(state, "aaaa")).toEqual([]);
    expect(parentChoices(state, "bbbb").map((c) => c.group.id)).toEqual(["aaaa", "xxxx"]);
  });

  it("names a group by its path", () => {
    expect(groupPath(tree(), "cccc").map((g) => g.name)).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(groupPath(tree(), "zzzz")).toEqual([]);
  });
});

describe("normalizing stored groups", () => {
  it("drops what is inconsistent and keeps the rest", () => {
    const state = normalizeGroups({
      groups: [
        { id: "aaaa", name: "Alpha", parent: null },
        { id: "aaaa", name: "Duplicate id", parent: null },
        { id: "bbbb", name: "Orphan", parent: "gone" },
        { id: "cccc", name: "", parent: null },
        { id: "no", name: "Bad id", parent: null },
        { id: "dddd", name: "Loop one", parent: "eeee" },
        { id: "eeee", name: "Loop two", parent: "dddd" },
        "junk",
      ],
      packages: { "npm:a": "aaaa", "npm:b": "gone", "bogus:c": "aaaa", "npm:d": 7 },
    });
    expect(state.groups.map((g) => [g.id, g.parent])).toEqual([
      ["aaaa", null],
      ["bbbb", null],
      ["dddd", null],
      ["eeee", "dddd"],
    ]);
    expect(state.packages).toEqual({ "npm:a": "aaaa" });
  });

  it("moves a group nested too deeply to the top", () => {
    const state = normalizeGroups({
      groups: [
        { id: "aaaa", name: "A", parent: null },
        { id: "bbbb", name: "B", parent: "aaaa" },
        { id: "cccc", name: "C", parent: "bbbb" },
        { id: "dddd", name: "D", parent: "cccc" },
        { id: "eeee", name: "E", parent: "dddd" },
        { id: "ffff", name: "F", parent: "eeee" },
      ],
      packages: {},
    });
    expect(state.groups.find((g) => g.id === "ffff")?.parent).toBeNull();
    expect(groupDepth(state, "eeee")).toBe(5);
  });

  it("reads anything else as no groups", () => {
    expect(normalizeGroups(null)).toEqual(NO_GROUPS);
    expect(normalizeGroups("x")).toEqual(NO_GROUPS);
    expect(normalizeGroups({})).toEqual(NO_GROUPS);
  });
});

describe("storage", () => {
  beforeEach(async () => {
    resetGroupsCache();
    await env.AUTH.delete(GROUPS_KEY);
  });

  it("reads no groups when nothing is stored or the value is not JSON", async () => {
    expect(await readGroups(env, { fresh: true })).toEqual(NO_GROUPS);
    await env.AUTH.put(GROUPS_KEY, "{not json");
    expect(await readGroups(env, { fresh: true })).toEqual(NO_GROUPS);
  });

  it("writes one KV value and serves it from the isolate cache afterwards", async () => {
    const state = assignPackages(tree(), ["npm:a"], "aaaa");
    await writeGroups(env, state);
    expect(JSON.parse((await env.AUTH.get(GROUPS_KEY)) ?? "null")).toEqual(state);
    // Written elsewhere: invisible until the cache is skipped or expires.
    await env.AUTH.put(GROUPS_KEY, JSON.stringify(NO_GROUPS));
    expect(await readGroups(env)).toEqual(state);
    expect(await readGroups(env, { fresh: true })).toEqual(NO_GROUPS);
    expect(await readGroups(env)).toEqual(NO_GROUPS);
  });
});

describe("visibility", () => {
  it("is visible unless a group says otherwise, and only collapsed and hidden are stored", () => {
    let state = createGroup(NO_GROUPS, "Open", null, "aaaa");
    state = createGroup(state, "Closed", null, "bbbb", "collapsed");
    state = createGroup(state, "Secret", null, "cccc", "hidden");
    expect(state.groups.map((g) => [g.id, groupVisibility(g)])).toEqual([
      ["aaaa", "visible"],
      ["bbbb", "collapsed"],
      ["cccc", "hidden"],
    ]);
    expect(state.groups[0]).toEqual({ id: "aaaa", name: "Open", parent: null });
    expect(state.groups[2]).toEqual({
      id: "cccc",
      name: "Secret",
      parent: null,
      visibility: "hidden",
    });
  });

  it("is changed with the group, and kept by a rename and a move", () => {
    let state = createGroup(tree(), "Secret", null, "ffff");
    state = updateGroup(state, "ffff", { visibility: "hidden" });
    expect(state.groups.find((g) => g.id === "ffff")?.visibility).toBe("hidden");
    state = updateGroup(state, "ffff", { name: "Vault" });
    state = updateGroup(state, "ffff", { parent: "xxxx" });
    expect(state.groups.find((g) => g.id === "ffff")).toEqual({
      id: "ffff",
      name: "Vault",
      parent: "xxxx",
      visibility: "hidden",
    });
    state = updateGroup(state, "ffff", { visibility: "visible" });
    expect(state.groups.find((g) => g.id === "ffff")).toEqual({
      id: "ffff",
      name: "Vault",
      parent: "xxxx",
    });
  });

  it("hides what is inside a hidden group, packages and subgroups alike", () => {
    let state = updateGroup(tree(), "bbbb", { visibility: "hidden" });
    state = assignPackages(state, ["npm:in-beta", "npm:in-delta"], "bbbb");
    state = assignPackages(state, ["npm:in-delta"], "dddd");
    state = assignPackages(state, ["npm:in-alpha"], "aaaa");
    expect(isGroupHidden(state, "aaaa")).toBe(false);
    expect(isGroupHidden(state, "bbbb")).toBe(true);
    expect(isGroupHidden(state, "dddd")).toBe(true);
    expect(isGroupHidden(state, "zzzz")).toBe(false);
    expect(isPackageHidden(state, "npm", "in-beta")).toBe(true);
    expect(isPackageHidden(state, "npm", "in-delta")).toBe(true);
    expect(isPackageHidden(state, "npm", "in-alpha")).toBe(false);
    expect(isPackageHidden(state, "npm", "loose")).toBe(false);
  });

  it("is kept by deleting the group above, so what was inside takes the group above's place", () => {
    let state = updateGroup(tree(), "cccc", { visibility: "hidden" });
    state = deleteGroup(state, "bbbb");
    expect(state.groups.find((g) => g.id === "cccc")).toMatchObject({
      parent: "aaaa",
      visibility: "hidden",
    });
  });

  it("is read from a form field", () => {
    expect(cleanVisibility(null)).toBe("visible");
    expect(cleanVisibility("")).toBe("visible");
    expect(cleanVisibility("hidden")).toBe("hidden");
    expect(cleanVisibility("collapsed")).toBe("collapsed");
    expect(refused(() => cleanVisibility("secret"))).toContain("visibility");
  });

  it("is normalised: unknown values and visible are dropped", () => {
    const state = normalizeGroups({
      groups: [
        { id: "aaaa", name: "A", parent: null, visibility: "hidden" },
        { id: "bbbb", name: "B", parent: null, visibility: "collapsed" },
        { id: "cccc", name: "C", parent: null, visibility: "visible" },
        { id: "dddd", name: "D", parent: null, visibility: "secret" },
        { id: "eeee", name: "E", parent: null, visibility: 3 },
      ],
      packages: {},
    });
    expect(state.groups.map((g) => g.visibility)).toEqual([
      "hidden",
      "collapsed",
      undefined,
      undefined,
      undefined,
    ]);
  });
});
