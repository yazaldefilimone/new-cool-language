import { LoadedFile, Span } from "./error";
import { isValidIdent, tokenize } from "./lexer";
import { lower as lowerToWasm } from "./codegen";
import { ParseState, parse } from "./parser";
import { printAst } from "./printer";
import { resolve } from "./resolve";
import { typeck } from "./typeck";
import { writeModuleWatToString } from "./wasm/wat";
import fs from "fs";
import { exec } from "child_process";
import { Pkg, Built, Typecked } from "./ast";
import { GlobalContext } from "./context";
import { loadPkg } from "./loader";
import { parseArgs } from "./options";

const INPUT = `
type A = struct { a: Int };

function main() = (
  let a: Int = "";
  let b: Int = "";
  c;
);

function rawr(a: *A) = (
  a.a = 1;
);
`;

function main() {
  const opts = parseArgs(INPUT);
  const { filename, packageName, input, debug } = opts;

  if (!isValidIdent(packageName)) {
    console.error(
      `error: package name \`${packageName}\` is not a valid identifer`,
    );
    process.exit(1);
  }

  const file: LoadedFile = { path: filename, content: input };

  const gcx = new GlobalContext(opts, loadPkg);
  const mainPkg = gcx.pkgId.next();

  const start = Date.now();

  if (packageName !== "std" && !opts.noStd) {
    gcx.pkgLoader(gcx, "std", Span.startOfFile(file));
  }

  const tokens = tokenize(gcx.error, file);
  // We treat lexer errors as fatal.
  if (!tokens.ok) {
    process.exit(1);
  }
  if (debug.has("tokens")) {
    console.log("-----TOKENS------------");
    console.log(tokens);
  }

  const parseState: ParseState = { tokens: tokens.tokens, gcx, file };

  const ast: Pkg<Built> = parse(packageName, parseState, mainPkg);
  if (debug.has("ast")) {
    console.log("-----AST---------------");

    console.dir(ast.rootItems, { depth: 50 });

    console.log("-----AST pretty--------");
    const printed = printAst(ast);
    console.log(printed);
  }

  if (debug.has("resolved")) {
    console.log("-----AST resolved------");
  }
  const resolved = resolve(gcx, ast);
  if (debug.has("resolved")) {
    const resolvedPrinted = printAst(resolved);
    console.log(resolvedPrinted);
  }

  if (debug.has("typecked")) {
    console.log("-----AST typecked------");
  }
  const typecked: Pkg<Typecked> = typeck(gcx, resolved);
  if (debug.has("typecked")) {
    const typeckPrinted = printAst(typecked);
    console.log(typeckPrinted);
  }

  if (debug.has("wat")) {
    console.log("-----wasm--------------");
  }

  // Codegen should never handle errornous code.
  if (gcx.error.hasErrors()) {
    process.exit(1);
  }

  gcx.finalizedPkgs.push(typecked);
  const wasmModule = lowerToWasm(gcx);
  const moduleStringColor = writeModuleWatToString(wasmModule, true);
  const moduleString = writeModuleWatToString(wasmModule);

  if (debug.has("wat")) {
    console.log(moduleStringColor);
  }

  if (!opts.noOutput) {
    fs.writeFileSync("out.wat", moduleString);
  }

  if (debug.has("wasm-validate")) {
    console.log("--validate wasm-tools--");

    exec("wasm-tools validate out.wat", (error, stdout, stderr) => {
      if (error && error.code === 1) {
        console.log(stderr);
      } else if (error) {
        console.error(`failed to spawn wasm-tools: ${error.message}`);
      } else {
        if (stderr) {
          console.log(stderr);
        }
        if (stdout) {
          console.log(stdout);
        }
      }

      console.log(`finished in ${Date.now() - start}ms`);
    });
  }
}

main();
