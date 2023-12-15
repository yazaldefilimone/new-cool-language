import {
  BuiltinName,
  COMPARISON_KINDS,
  Pkg,
  EQUALITY_KINDS,
  Expr,
  ExprBinary,
  ExprCall,
  ExprUnary,
  Folder,
  LOGICAL_KINDS,
  LoopId,
  Resolution,
  Resolved,
  StructLiteralField,
  TY_BOOL,
  TY_I32,
  TY_INT,
  TY_NEVER,
  TY_STRING,
  TY_UNIT,
  Ty,
  TyFn,
  Type,
  Typecked,
  mkDefaultFolder,
  superFoldExpr,
} from "../ast";
import { CompilerError, ErrorEmitted, Span, unreachable } from "../error";
import { printTy } from "../printer";
import { TypeckCtx, emitError, mkTyFn, tyError, tyErrorFrom } from "./base";
import { InferContext } from "./infer";
import {
  lowerAstTy,
  typeOfItem,
} from "./item";

export function exprError(err: ErrorEmitted, span: Span): Expr<Typecked> {
  return {
    kind: "error",
    err,
    span,
    ty: tyErrorFrom({ err }),
  };
}

type FuncCtx = {
  cx: TypeckCtx;
  infcx: InferContext;
  localTys: Ty[];
  loopState: LoopState[];
  checkExpr: (expr: Expr<Resolved>) => Expr<Typecked>;
};

type LoopState = { hasBreak: boolean; loopId: LoopId };

function typeOfValue(fcx: FuncCtx, res: Resolution, span: Span): Ty {
  switch (res.kind) {
    case "local": {
      const idx = fcx.localTys.length - 1 - res.index;
      return fcx.localTys[idx];
    }
    case "item": {
      return typeOfItem(fcx.cx, res.id, [], span);
    }
    case "builtin":
      return typeOfBuiltinValue(fcx, res.name, span);
    case "tyParam":
      return tyError(
        fcx.cx,
        new CompilerError(`type parameter cannot be used as value`, span),
      );
    case "error":
      return tyErrorFrom(res);
  }
}

export function typeOfBuiltinValue(
  fcx: FuncCtx,
  name: BuiltinName,
  span: Span,
): Ty {
  switch (name) {
    case "false":
    case "true":
      return TY_BOOL;
    case "print":
      return mkTyFn([TY_STRING], TY_UNIT);
    case "trap":
      return mkTyFn([], TY_NEVER);
    case "__NULL":
      return { kind: "rawptr", inner: fcx.infcx.newVar() };
    case "__i32_store":
      return mkTyFn([TY_I32, TY_I32], TY_UNIT);
    case "__i64_store":
      return mkTyFn([TY_I32, TY_INT], TY_UNIT);
    case "__i32_load":
      return mkTyFn([TY_I32], TY_I32);
    case "__i64_load":
      return mkTyFn([TY_I32], TY_INT);
    case "__memory_size":
      return mkTyFn([], TY_I32);
    case "__memory_grow":
      return mkTyFn([TY_I32], TY_I32);
    case "__i32_extend_to_i64_u":
      return mkTyFn([TY_I32], TY_INT);
    default: {
      return tyError(
        fcx.cx,
        new CompilerError(`\`${name}\` cannot be used as a value`, span),
      );
    }
  }
}

export function checkBody(
  cx: TypeckCtx,
  ast: Pkg<Resolved>,
  body: Expr<Resolved>,
  fnTy: TyFn,
): Expr<Typecked> {
  const infcx = new InferContext(cx.gcx.error);

  const fcx: FuncCtx = {
    cx,
    infcx,
    localTys: [...fnTy.params],
    loopState: [],
    checkExpr: () => unreachable(),
  };

  const checker: Folder<Resolved, Typecked> = {
    ...mkDefaultFolder(),
    expr(expr): Expr<Typecked> {
      switch (expr.kind) {
        case "empty": {
          return { ...expr, ty: TY_UNIT };
        }
        case "let": {
          const loweredBindingTy = expr.type && lowerAstTy(cx, expr.type);
          const bindingTy = loweredBindingTy
            ? loweredBindingTy
            : infcx.newVar();

          const rhs = this.expr(expr.rhs);
          infcx.assign(bindingTy, rhs.ty, expr.span);

          // AST validation ensures that lets can only be in blocks, where
          // the types will be popped.
          fcx.localTys.push(bindingTy);

          expr.local!.ty = bindingTy;

          const type: Type<Typecked> | undefined = loweredBindingTy && {
            ...expr.type!,
          };

          return {
            kind: "let",
            name: expr.name,
            type,
            rhs,
            ty: TY_UNIT,
            span: expr.span,
          };
        }
        case "assign": {
          const lhs = this.expr(expr.lhs);
          const rhs = this.expr(expr.rhs);

          infcx.assign(lhs.ty, rhs.ty, expr.span);

          switch (lhs.kind) {
            case "ident":
            case "path": {
              const { res } = lhs.value;
              switch (res.kind) {
                case "local":
                  break;
                case "item": {
                  const item = cx.gcx.findItem(res.id, ast);
                  if (item.kind !== "global") {
                    emitError(
                      fcx.cx,
                      new CompilerError("cannot assign to item", expr.span),
                    );
                  }
                  break;
                }
                case "builtin":
                  emitError(
                    fcx.cx,
                    new CompilerError("cannot assign to builtins", expr.span),
                  );
              }
              break;
            }
            case "fieldAccess": {
              checkLValue(cx, lhs);
              break;
            }
            default: {
              emitError(
                fcx.cx,
                new CompilerError(
                  "invalid left-hand side of assignment",
                  lhs.span,
                ),
              );
            }
          }

          return {
            ...expr,
            kind: "assign",
            lhs,
            rhs,
            ty: TY_UNIT,
          };
        }
        case "block": {
          const prevLocalTysLen = fcx.localTys.length;

          const exprs = expr.exprs.map((expr) => this.expr(expr));

          const ty = exprs.length > 0 ? exprs[exprs.length - 1].ty : TY_UNIT;

          fcx.localTys.length = prevLocalTysLen;

          return {
            ...expr,
            exprs,
            ty,
          };
        }
        case "literal": {
          let ty;
          switch (expr.value.kind) {
            case "str": {
              ty = TY_STRING;
              break;
            }
            case "int": {
              switch (expr.value.type) {
                case "Int":
                  ty = TY_INT;
                  break;
                case "I32":
                  ty = TY_I32;
                  break;
              }
              break;
            }
          }

          return { ...expr, ty };
        }
        case "ident":
        case "path": {
          const ty = typeOfValue(fcx, expr.value.res, expr.value.span);

          return { ...expr, ty };
        }
        case "binary": {
          return checkBinary(fcx, expr);
        }
        case "unary": {
          const rhs = this.expr(expr.rhs);
          rhs.ty = infcx.resolveIfPossible(rhs.ty);
          return checkUnary(fcx, expr, rhs);
        }
        case "call": {
          return checkCall(fcx, expr);
        }
        case "fieldAccess": {
          const lhs = this.expr(expr.lhs);
          lhs.ty = infcx.resolveIfPossible(lhs.ty);

          const { field } = expr;
          let ty: Ty;
          let fieldIdx: number | undefined;
          switch (lhs.ty.kind) {
            case "tuple": {
              const { elems } = lhs.ty;
              if (typeof field.value === "number") {
                if (elems.length > field.value) {
                  ty = elems[field.value];
                  fieldIdx = field.value;
                } else {
                  ty = tyError(
                    fcx.cx,
                    new CompilerError(
                      `tuple with ${elems.length} elements cannot be indexed with ${field.value}`,
                      field.span,
                    ),
                  );
                }
              } else {
                ty = tyError(
                  fcx.cx,
                  new CompilerError(
                    "tuple fields must be accessed with numbers",
                    field.span,
                  ),
                );
              }
              break;
            }
            case "struct":
            case "rawptr": {
              let fields: [string, Ty][];
              if (lhs.ty.kind === "struct") {
                fields = lhs.ty.fields_no_subst;
              } else if (lhs.ty.kind === "rawptr") {
                let inner = fcx.infcx.resolveIfPossible(lhs.ty.inner);
                if (inner.kind !== "struct") {
                  inner = tyError(
                    fcx.cx,
                    new CompilerError(
                      "fields can only be accessed on pointers pointing to a struct",
                      expr.lhs.span,
                    ),
                  );
                  ty = inner;
                  break;
                } else {
                  fields = inner.fields_no_subst;
                }
              } else {
                fields = [];
                unreachable("must be struct or rawptr here");
              }

              if (typeof field.value === "string") {
                const idx = fields.findIndex(([name]) => name === field.value);
                if (idx === -1) {
                  ty = tyError(
                    fcx.cx,
                    new CompilerError(
                      `field \`${field.value}\` does not exist on ${printTy(
                        lhs.ty,
                      )}`,
                      field.span,
                    ),
                  );
                  break;
                }

                ty = fields[idx][1];
                fieldIdx = idx;
              } else {
                ty = tyError(
                  fcx.cx,
                  new CompilerError(
                    "struct fields must be accessed with their name",
                    field.span,
                  ),
                );
              }
              break;
            }
            default: {
              ty = tyError(
                fcx.cx,
                new CompilerError(
                  `cannot access field \`${field.value}\` on type \`${printTy(
                    lhs.ty,
                  )}\``,
                  expr.span,
                ),
              );
            }
          }

          return {
            ...expr,
            lhs,
            field: {
              ...expr.field,
              fieldIdx,
            },
            ty,
          };
        }
        case "if": {
          const cond = this.expr(expr.cond);
          const then = this.expr(expr.then);
          const elsePart = expr.else && this.expr(expr.else);

          infcx.assign(TY_BOOL, cond.ty, cond.span);

          let ty: Ty;
          if (elsePart) {
            infcx.assign(then.ty, elsePart.ty, elsePart.span);
            ty = then.ty!;
          } else {
            infcx.assign(TY_UNIT, then.ty, then.span);
            ty = TY_UNIT;
          }

          return { ...expr, cond, then, else: elsePart, ty };
        }
        case "loop": {
          fcx.loopState.push({
            hasBreak: false,
            loopId: expr.loopId,
          });

          const body = this.expr(expr.body);
          infcx.assign(TY_UNIT, body.ty, body.span);

          const hadBreak = fcx.loopState.pop();
          const ty = hadBreak ? TY_UNIT : TY_NEVER;

          return {
            ...expr,
            body,
            ty,
          };
        }
        case "break": {
          const loopStateLength = fcx.loopState.length;
          if (loopStateLength === 0) {
            const err: ErrorEmitted = emitError(
              fcx.cx,
              new CompilerError("break outside loop", expr.span),
            );
            return exprError(err, expr.span);
          }
          const target = fcx.loopState[loopStateLength - 1].loopId;
          fcx.loopState[loopStateLength - 1].hasBreak = true;

          return {
            ...expr,
            ty: TY_NEVER,
            target,
          };
        }
        case "structLiteral": {
          const fields = expr.fields.map<StructLiteralField<Typecked>>(
            ({ name, expr }) => ({ name, expr: this.expr(expr) }),
          );

          const structTy = typeOfValue(fcx, expr.name.res, expr.name.span);

          if (structTy.kind !== "struct") {
            const err: ErrorEmitted = emitError(
              fcx.cx,
              new CompilerError(
                `struct literal is only allowed for struct types`,
                expr.span,
              ),
            );
            return exprError(err, expr.span);
          }

          const assignedFields = new Set();

          fields.forEach(({ name, expr: field }, i) => {
            const fieldIdx = structTy.fields_no_subst.findIndex(
              (def) => def[0] === name.name,
            );
            if (fieldIdx == -1) {
              emitError(
                fcx.cx,
                new CompilerError(
                  `field ${name.name} doesn't exist on type ${expr.name.name}`,
                  name.span,
                ),
              );
            }
            const fieldTy = structTy.fields_no_subst[fieldIdx];
            infcx.assign(fieldTy[1], field.ty, field.span);
            assignedFields.add(name.name);
            fields[i].fieldIdx = fieldIdx;
          });

          const missing: string[] = [];
          structTy.fields_no_subst.forEach(([name]) => {
            if (!assignedFields.has(name)) {
              missing.push(name);
            }
          });
          if (missing.length > 0) {
            emitError(
              fcx.cx,
              new CompilerError(
                `missing fields in literal: ${missing.join(", ")}`,
                expr.span,
              ),
            );
          }

          return { ...expr, fields, ty: structTy };
        }
        case "tupleLiteral": {
          const fields = expr.fields.map((expr) => this.expr(expr));

          const ty: Ty = {
            kind: "tuple",
            elems: fields.map((field) => field.ty),
          };

          return { ...expr, fields, ty };
        }
        case "error": {
          return { ...expr, ty: tyErrorFrom(expr) };
        }
      }
    },
    itemInner(_item) {
      throw new Error("cannot deal with items inside body");
    },
    ident(ident) {
      return ident;
    },
    type(_type) {
      throw new Error("all types in the body should be handled elsewhere");
    },
  };

  fcx.checkExpr = checker.expr.bind(checker);

  const checked = checker.expr(body);

  infcx.assign(fnTy.returnTy, checked.ty, body.span);

  const resolved = resolveBody(fcx, checked);

  return resolved;
}

function checkLValue(cx: TypeckCtx, expr: Expr<Typecked>) {
  switch (expr.kind) {
    case "ident":
    case "path":
      break;
    case "fieldAccess":
      checkLValue(cx, expr.lhs);
      break;
    default:
      emitError(
        cx,
        new CompilerError("invalid left-hand side of assignment", expr.span),
      );
  }
}

function checkBinary(
  fcx: FuncCtx,
  expr: Expr<Resolved> & ExprBinary<Resolved>,
): Expr<Typecked> {
  const lhs = fcx.checkExpr(expr.lhs);
  const rhs = fcx.checkExpr(expr.rhs);

  lhs.ty = fcx.infcx.resolveIfPossible(lhs.ty);
  rhs.ty = fcx.infcx.resolveIfPossible(rhs.ty);

  const lhsTy = lhs.ty;
  const rhsTy = rhs.ty;

  if (COMPARISON_KINDS.includes(expr.binaryKind)) {
    if (lhsTy.kind === "int" && rhsTy.kind === "int") {
      return { ...expr, lhs, rhs, ty: TY_BOOL };
    }

    if (lhsTy.kind === "i32" && rhsTy.kind === "i32") {
      return { ...expr, lhs, rhs, ty: TY_BOOL };
    }

    if (lhsTy.kind === "string" && rhsTy.kind === "string") {
      return { ...expr, lhs, rhs, ty: TY_BOOL };
    }

    if (lhsTy.kind === "rawptr" && rhsTy.kind === "rawptr") {
      fcx.infcx.assign(lhsTy.inner, rhsTy.inner, expr.span);
      return { ...expr, lhs, rhs, ty: TY_BOOL };
    }

    if (EQUALITY_KINDS.includes(expr.binaryKind)) {
      if (lhsTy.kind === "bool" && rhsTy.kind === "bool") {
        return { ...expr, lhs, rhs, ty: TY_BOOL };
      }
    }
  }

  if (lhsTy.kind === "int" && rhsTy.kind === "int") {
    return { ...expr, lhs, rhs, ty: TY_INT };
  }
  if (lhsTy.kind === "i32" && rhsTy.kind === "i32") {
    return { ...expr, lhs, rhs, ty: TY_I32 };
  }

  if (LOGICAL_KINDS.includes(expr.binaryKind)) {
    if (lhsTy.kind === "bool" && rhsTy.kind === "bool") {
      return { ...expr, lhs, rhs, ty: TY_BOOL };
    }
  }

  const ty = tyError(
    fcx.cx,
    new CompilerError(
      `invalid types for binary operation: ${printTy(lhs.ty)} ${
        expr.binaryKind
      } ${printTy(rhs.ty)}`,
      expr.span,
    ),
  );
  return { ...expr, lhs, rhs, ty };
}

function checkUnary(
  fcx: FuncCtx,
  expr: Expr<Resolved> & ExprUnary<Resolved>,
  rhs: Expr<Typecked>,
): Expr<Typecked> {
  const rhsTy = rhs.ty;

  if (
    expr.unaryKind === "!" &&
    (rhsTy.kind === "int" || rhsTy.kind === "i32" || rhsTy.kind === "bool")
  ) {
    return { ...expr, rhs, ty: rhsTy };
  }

  if (expr.unaryKind === "-" && rhsTy.kind == "int") {
    // Negating an unsigned integer is a bad idea.
  }

  const ty = tyError(
    fcx.cx,
    new CompilerError(
      `invalid types for unary operation: ${expr.unaryKind} ${printTy(rhs.ty)}`,
      expr.span,
    ),
  );
  return { ...expr, rhs, ty };
}

function checkCall(
  fcx: FuncCtx,
  expr: ExprCall<Resolved> & Expr<Resolved>,
): Expr<Typecked> {
  if (
    expr.lhs.kind === "ident" &&
    expr.lhs.value.res.kind === "builtin" &&
    expr.lhs.value.res.name === "___transmute"
  ) {
    const ty = fcx.infcx.newVar();
    const args = expr.args.map((arg) => fcx.checkExpr(arg));
    const ret: Expr<Typecked> = {
      ...expr,
      lhs: { ...expr.lhs, ty: TY_UNIT },
      args,
      ty,
    };

    return ret;
  }

  const lhs = fcx.checkExpr(expr.lhs);
  lhs.ty = fcx.infcx.resolveIfPossible(lhs.ty);

  // check args before checking the lhs.
  const args = expr.args.map((arg) => fcx.checkExpr(arg));

  const lhsTy = lhs.ty;
  if (lhsTy.kind !== "fn") {
    const ty = tyError(
      fcx.cx,
      new CompilerError(
        `expression of type ${printTy(lhsTy)} is not callable`,
        lhs.span,
      ),
    );
    return { ...expr, lhs, args, ty };
  }

  lhsTy.params.forEach((param, i) => {
    if (args.length <= i) {
      emitError(
        fcx.cx,
        new CompilerError(
          `missing argument of type ${printTy(param)}`,
          expr.span,
        ),
      );
      return;
    }

    fcx.infcx.assign(param, args[i].ty, args[i].span);
  });

  if (args.length > lhsTy.params.length) {
    emitError(
      fcx.cx,
      new CompilerError(
        `too many arguments passed, expected ${lhsTy.params.length}, found ${args.length}`,
        expr.span,
      ),
    );
  }

  return { ...expr, lhs, args, ty: lhsTy.returnTy };
}

function resolveBody(fcx: FuncCtx, checked: Expr<Typecked>): Expr<Typecked> {
  const resolveTy = (ty: Ty, span: Span) => {
    const resTy = fcx.infcx.resolveIfPossible(ty);
    // TODO: When doing deep resolution, we need to check for _any_ vars.
    if (resTy.kind === "var") {
      return tyError(fcx.cx, new CompilerError("cannot infer type", span));
    }
    return resTy;
  };

  const resolver: Folder<Typecked, Typecked> = {
    ...mkDefaultFolder(),
    expr(expr) {
      const ty = resolveTy(expr.ty, expr.span);

      if (expr.kind === "block") {
        expr.locals!.forEach((local) => {
          local.ty = resolveTy(local.ty!, local.span);
        });
      }

      const innerExpr = superFoldExpr(expr, this);

      return { ...innerExpr, ty };
    },
    type(type) {
      return type;
    },
    ident(ident) {
      return ident;
    },
  };

  const resolved = resolver.expr(checked);

  return resolved;
}
