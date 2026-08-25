import * as esbuild from "npm:esbuild@^0.25.0";
import { denoPlugins } from "jsr:@luca/esbuild-deno-loader@^0.11.1";

await esbuild.build({
  plugins: [...denoPlugins()],
  entryPoints: ["./src/main.ts"],
  outfile: "./dist/main.js",
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "esnext",
  treeShaking: true,
  minify: true,
  sourcemap: false,
});

await esbuild.stop();
