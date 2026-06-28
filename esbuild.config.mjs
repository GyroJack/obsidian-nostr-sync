import esbuild from "esbuild";
import process from "process";

const prod = process.argv[2] === "production";

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  outfile: "main.js",
  external: ["obsidian", "electron"],
  sourcemap: prod ? false : "inline",
  minify: prod,
  treeShaking: true,
  loader: { ".ts": "ts" },
  logLevel: "info",
});

if (prod) {
  await context.rebuild();
  await context.dispose();
  console.log("✅ Production build complete");
} else {
  await context.watch();
  console.log("👀 Watching for changes...");
}
