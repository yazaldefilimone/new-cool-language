import { Expr, FunctionDef, Item, Type } from "./ast";

export function printAst(ast: Item[]): string {
  return ast.map(printItem).join("\n");
}

function printItem(item: Item): string {
  switch (item.kind) {
    case "function": {
      return printFunction(item.node);
    }
  }
}

function printFunction(func: FunctionDef): string {
  const args = func.args
    .map(({ name, type }) => `${name}: ${printType(type)}`)
    .join(", ");
  const ret = func.returnType ? `: ${printType(func.returnType)}` : "";
  return `function ${func.name}(${args})${ret} = ${printExpr(func.body, 0)}`;
}

function printExpr(expr: Expr, indent: number): string {
  switch (expr.kind) {
    case "empty": {
      return "";
    }
    case "let": {
      const type = expr.type ? `: ${printType(expr.type)}` : "";

      return `let ${expr.name}${type} = ${printExpr(
        expr.rhs,
        indent + 1
      )} in${linebreak(indent)}${printExpr(expr.after, indent)}`;
    }
    case "block": {
      const exprs = expr.exprs.map((expr) => printExpr(expr, indent + 1));

      if (exprs.length === 1) {
        return `(${exprs[0]})`;
      }
      const shortExprs =
        exprs.map((s) => s.length).reduce((a, b) => a + b, 0) < 40;

      const alreadyHasTrailingSpace =
        expr.exprs[exprs.length - 1]?.kind === "empty";
      if (shortExprs) {
        const trailingSpace = alreadyHasTrailingSpace ? "" : " ";
        return `( ${exprs.join("; ")}${trailingSpace})`;
      } else {
        const joiner = `;${linebreak(indent + 1)}`;
        return (
          `(${linebreak(indent + 1)}` +
          `${exprs.join(joiner)}` +
          `${linebreak(indent)})`
        );
      }
    }
    case "literal": {
      switch (expr.value.kind) {
        case "str": {
          return `"${expr.value.value}"`;
        }
        case "int": {
          return `${expr.value.value}`;
        }
      }
    }
    case "ident": {
      return expr.value;
    }
    case "binary": {
      return `${printExpr(expr.lhs, indent)} ${expr.binaryKind} ${printExpr(
        expr.rhs,
        indent
      )}`;
    }
    case "unary": {
      return `${expr.unaryKind}${printExpr(expr.rhs, indent)}`;
    }
    case "call": {
      const args = expr.args.map((arg) => printExpr(arg, indent + 1));
      const shortArgs =
        args.map((s) => s.length).reduce((a, b) => a + b, 0) < 40;
      if (shortArgs) {
        return `${printExpr(expr.lhs, indent)}(${args.join(", ")})`;
      } else {
        return (
          `${printExpr(expr.lhs, indent)}(${linebreak(indent + 1)}` +
          `${args.join(linebreak(indent + 1))}` +
          `${linebreak(indent)})`
        );
      }
    }
    case "if": {
      const elsePart = expr.else
        ? ` else ${printExpr(expr.else, indent + 1)}`
        : "";
      return `if ${printExpr(expr.cond, indent + 1)} then ${printExpr(
        expr.then,
        indent + 1
      )}${elsePart}`;
    }
  }
}

function printType(type: Type): string {
  switch (type.kind) {
    case "ident":
      return type.value;
    case "list":
      return `[${printType(type.elem)}]`;
    case "tuple":
      return `(${type.elems.map(printType).join(", ")})`;
  }
}

function linebreak(indent: number): string {
  return `\n${ind(indent)}`;
}

function ind(indent: number): string {
  return "  ".repeat(indent * 2);
}
