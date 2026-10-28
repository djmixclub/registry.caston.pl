import SDK_POM from "./sdk-1.4.0.pom?raw";

export { SDK_POM };

/** One `<dependency>` as the CLI sends it in the manifest. */
export interface PomDependency {
  groupId: string;
  artifactId: string;
  version: string | null;
  scope: string;
  optional: boolean;
}

/**
 * The `init` manifest the CLI builds from `sdk-1.4.0.pom` (`Pom::manifest` in
 * `crates/eco-maven/src/pom.rs`): the project's `<dependencies>` in order, without those of
 * `<dependencyManagement>`, `scope` defaulting to `compile`, `version` `null` when a BOM
 * manages it.
 */
export const SDK_DEPENDENCIES: PomDependency[] = [
  {
    groupId: "com.acme",
    artifactId: "http",
    version: "[1.0,2.0)",
    scope: "compile",
    optional: false,
  },
  {
    groupId: "com.squareup.okhttp3",
    artifactId: "okhttp",
    version: "4.12.0",
    scope: "compile",
    optional: false,
  },
  {
    groupId: "com.fasterxml.jackson.core",
    artifactId: "jackson-databind",
    version: null,
    scope: "runtime",
    optional: false,
  },
  { groupId: "com.acme", artifactId: "logging", version: "0.3.2", scope: "runtime", optional: false },
  { groupId: "com.acme", artifactId: "metrics", version: "2.1.0", scope: "compile", optional: true },
  {
    groupId: "javax.annotation",
    artifactId: "javax.annotation-api",
    version: "1.3.2",
    scope: "provided",
    optional: false,
  },
  { groupId: "com.acme", artifactId: "testkit", version: "1.4.0", scope: "test", optional: false },
  {
    groupId: "org.junit.jupiter",
    artifactId: "junit-jupiter",
    version: "5.10.3",
    scope: "test",
    optional: false,
  },
];

/** A minimal effective POM for other coordinates. */
export function pomFor(
  groupId: string,
  artifactId: string,
  version: string,
  packaging = "jar",
): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<project xmlns="http://maven.apache.org/POM/4.0.0">\n` +
    `  <modelVersion>4.0.0</modelVersion>\n` +
    `  <groupId>${groupId}</groupId>\n` +
    `  <artifactId>${artifactId}</artifactId>\n` +
    `  <version>${version}</version>\n` +
    (packaging === "jar" ? "" : `  <packaging>${packaging}</packaging>\n`) +
    `</project>\n`
  );
}
