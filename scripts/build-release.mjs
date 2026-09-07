/*
 * Builds the installer with the build machine's paths kept out of the binary.
 *
 * Rust bakes absolute source paths into a release build - every dependency's
 * panic messages carry the full path they were compiled from. On a developer's
 * machine that is their home directory, so the shipped .exe tells everyone who
 * downloads it what the author's Windows account is called. Measured on this
 * project before the fix: 97 copies of it.
 *
 * The stable way to strip them is `--remap-path-prefix`, and Cargo's
 * `trim-paths` profile option is not stabilised yet (checked on Cargo 1.98).
 * The prefixes cannot be written into a committed config file, because they
 * differ per machine and hardcoding one would leak the very thing this is
 * removing - so they are computed here and passed through the environment.
 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const cargoHome = process.env.CARGO_HOME || join(homedir(), ".cargo");
const projectRoot = resolve(import.meta.dirname, "..");

const remaps = [
  // Dependency sources, which are the bulk of it.
  `--remap-path-prefix=${cargoHome}=/cargo`,
  // The rustup toolchain's own copy of std.
  `--remap-path-prefix=${process.env.RUSTUP_HOME || join(homedir(), ".rustup")}=/rustup`,
  // This project, so the binary does not say where it was checked out either.
  `--remap-path-prefix=${projectRoot}=/kickcut`,
];

// Anything the caller already set is kept: this adds to RUSTFLAGS rather than
// replacing it, or a CI runner's own flags would be silently dropped.
const rustflags = [process.env.RUSTFLAGS, ...remaps].filter(Boolean).join(" ");

console.log("building with path remapping:");
for (const remap of remaps) console.log("  " + remap.replace("--remap-path-prefix=", ""));

const child = spawn("npm", ["exec", "--", "tauri", "build", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, RUSTFLAGS: rustflags },
  // npm is a shell script on Windows, so it cannot be spawned directly.
  shell: process.platform === "win32",
});

child.on("exit", (code) => process.exit(code ?? 1));
