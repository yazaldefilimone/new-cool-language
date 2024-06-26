import { ErrorEmitted, LoadedFile, Span, unreachable } from "./error";
import { LitIntType } from "./lexer";
import { Ty, TyFn, TypeckResults } from "./types";
import { ComplexMap } from "./utils";
import { Instr, ValType } from "./wasm/defs";

export type Phase = {
  res: unknown;
  defPath: unknown;
  ty: unknown;
  typeckResults: unknown;
};

type No = object;

type HasRes = { res: Resolution };
type HasDefPath = { defPath: string[] };
type HasTy = { ty: Ty };
type HasTypeckResults = { typeckResults: TypeckResults };

export type Parsed = {
  res: No;
  defPath: No;
  ty: No;
  typeckResults: No;
};
export type Built = {
  res: No;
  defPath: No;
  ty: No;
  typeckResults: No;
};
export type Resolved = {
  res: HasRes;
  defPath: HasDefPath;
  ty: No;
  typeckResults: No;
};
export type Typecked = {
  res: HasRes;
  defPath: HasDefPath;
  ty: HasTy;
  typeckResults: HasTypeckResults;
};

export type Final = Typecked;

export type AnyPhase = {
  res: No | HasRes;
  defPath: No | HasDefPath;
  ty: No | HasTy;
  typeckResults: No | HasTypeckResults;
};

export type PkgId = number;

export type Pkg<P extends Phase> = {
  id: PkgId;
  rootItems: Item<P>[];
  itemsById: ComplexMap<ItemId, Item<P>>;
  packageName: string;
  rootFile: LoadedFile;
  fatalError: ErrorEmitted | undefined;
} & P["typeckResults"];

export type DepPkg = Pkg<Final>;

export type Ident = {
  name: string;
  span: Span;
};

export type IdentWithRes<P extends Phase> = {
  name: string;
  span: Span;
} & P["res"];

export class ItemId {
  public pkgId: number;
  public itemIdx: number;

  constructor(pkgId: number, itemIdx: number) {
    this.pkgId = pkgId;
    this.itemIdx = itemIdx;
  }

  static dummy(): ItemId {
    return new ItemId(999999, 999999);
  }

  static pkgRoot(pkg: PkgId): ItemId {
    return new ItemId(pkg, 0);
  }

  toString(): string {
    if (this.pkgId === 0) {
      return `${this.itemIdx}`;
    }
    return `[${this.pkgId}@${this.itemIdx}]`;
  }
}

export type ItemKind<P extends Phase> =
  | ItemKindFunction<P>
  | ItemKindType<P>
  | ItemKindImport<P>
  | ItemKindMod<P>
  | ItemKindExtern
  | ItemKindGlobal<P>
  | ItemKindUse<P>
  | ItemKindError;

type ItemVariant<Variant, P extends Phase> = Variant & Item<P>;

export type ItemFunction<P extends Phase> = ItemVariant<ItemKindFunction<P>, P>;
export type ItemType<P extends Phase> = ItemVariant<ItemKindType<P>, P>;
export type ItemImport<P extends Phase> = ItemVariant<ItemKindImport<P>, P>;
export type ItemMod<P extends Phase> = ItemVariant<ItemKindMod<P>, P>;
export type ItemExtern<P extends Phase> = ItemVariant<ItemKindExtern, P>;
export type ItemGlobal<P extends Phase> = ItemVariant<ItemKindGlobal<P>, P>;
export type ItemUse<P extends Phase> = ItemVariant<ItemKindUse<P>, P>;
export type ItemError<P extends Phase> = ItemVariant<ItemKindError, P>;

export type Item<P extends Phase> = ItemKind<P> & {
  span: Span;
  id: ItemId;
  name: string;
} & P["defPath"];

export type ItemKindFunction<P extends Phase> = {
  kind: "function";
  params: FunctionArg<P>[];
  body: Expr<P>;
  returnType?: Type<P>;
  ty?: TyFn;
};

export type FunctionArg<P extends Phase> = {
  ident: Ident;
  type: Type<P>;
};

export type ItemKindType<P extends Phase> = {
  kind: "type";
  genericParams: Ident[];
  type: TypeDefKind<P>;
  ty?: Ty;
};

export type TypeDefKind<P extends Phase> =
  | {
      kind: "struct";
      fields: FieldDef<P>[];
    }
  | {
      kind: "alias";
      type: Type<P>;
    };

export type FieldDef<P extends Phase> = {
  name: Ident;
  type: Type<P>;
};

export type ItemKindImport<P extends Phase> = {
  kind: "import";
  module: StringLiteral;
  func: StringLiteral;
  params: FunctionArg<P>[];
  returnType?: Type<P>;
  ty?: TyFn;
};

export type ItemKindMod<P extends Phase> = {
  kind: "mod";
  contents: Item<P>[];
};

export type ItemKindExtern = { kind: "extern" };

export type ItemKindGlobal<P extends Phase> = {
  kind: "global";
  type: Type<P>;
  init: Expr<P>;
  ty?: Ty;
};

export type ItemKindUse<P extends Phase> = {
  kind: "use";
  segments: Ident[];
} & P["res"];

export type ItemKindError = {
  kind: "error";
  err: ErrorEmitted;
};

export type ExprEmpty = { kind: "empty" };

export type ExprLet<P extends Phase> = {
  kind: "let";
  name: Ident;
  type?: Type<P>;
  rhs: Expr<P>;
  // IMPORTANT: This is (sadly) shared with ExprBlock.
  // TODO: Stop this sharing and just store the stack of blocks in typeck.
  local?: LocalInfo;
};

// A bit like ExprBinary except there are restrictions
// on the LHS and precedence is unrestricted.
export type ExprAssign<P extends Phase> = {
  kind: "assign";
  lhs: Expr<P>;
  rhs: Expr<P>;
};

export type ExprBlock<P extends Phase> = {
  kind: "block";
  exprs: Expr<P>[];
  // IMPORTANT: This is (sadly) shared with ExprLet.
  locals?: LocalInfo[];
};

export type ExprLiteral = {
  kind: "literal";
  value: Literal;
};

export type ExprIdent<P extends Phase> = {
  kind: "ident";
  value: IdentWithRes<P>;
};

/**
 * `a.b.c` in source code where `a` and `b` are modules.
 * This expression is not parsed, but fieldAccess gets converted
 * to path expressions in resolve.
 */
export type ExprPath = {
  kind: "path";
  segments: string[];
  /**
   * Since this only exists after resolve, we always have a res.
   * The nested field is for symmetry with Ident.
   */
  value: {
    res: Resolution;
    span: Span;
  };
};

export type ExprBinary<P extends Phase> = {
  kind: "binary";
  binaryKind: BinaryKind;
  lhs: Expr<P>;
  rhs: Expr<P>;
};

export type ExprUnary<P extends Phase> = {
  kind: "unary";
  unaryKind: UnaryKind;
  rhs: Expr<P>;
};

export type ExprCall<P extends Phase> = {
  kind: "call";
  lhs: Expr<P>;
  args: Expr<P>[];
};

export type ExprFieldAccess<P extends Phase> = {
  kind: "fieldAccess";
  lhs: Expr<P>;
  field: {
    value: string | number;
    span: Span;
    fieldIdx?: number;
  };
};

export type ExprIf<P extends Phase> = {
  kind: "if";
  cond: Expr<P>;
  then: Expr<P>;
  else?: Expr<P>;
};

export type LoopId = number;

export type ExprLoop<P extends Phase> = {
  kind: "loop";
  body: Expr<P>;
  loopId: LoopId;
};

export type ExprBreak = {
  kind: "break";
  target?: LoopId;
};

export type ExprStructLiteral<P extends Phase> = {
  kind: "structLiteral";
  name: IdentWithRes<P>;
  fields: StructLiteralField<P>[];
};

export type StructLiteralField<P extends Phase> = {
  name: Ident;
  expr: Expr<P>;
  fieldIdx?: number;
};

export type ExprTupleLiteral<P extends Phase> = {
  kind: "tupleLiteral";
  fields: Expr<P>[];
};

export type ExprInlineAsm = {
  kind: "asm";
  locals: ValType[];
  instructions: Instr[];
};

export type ExprError = {
  kind: "error";
  err: ErrorEmitted;
};

export type ExprKind<P extends Phase> =
  | ExprEmpty
  | ExprLet<P>
  | ExprAssign<P>
  | ExprBlock<P>
  | ExprLiteral
  | ExprIdent<P>
  | ExprPath
  | ExprBinary<P>
  | ExprUnary<P>
  | ExprCall<P>
  | ExprFieldAccess<P>
  | ExprIf<P>
  | ExprLoop<P>
  | ExprBreak
  | ExprStructLiteral<P>
  | ExprTupleLiteral<P>
  | ExprInlineAsm
  | ExprError;

export type Expr<P extends Phase> = ExprKind<P> & {
  span: Span;
} & P["ty"];

export type StringLiteral = {
  kind: "str";
  value: string;
  span: Span;
};

export type Literal =
  | StringLiteral
  | {
      kind: "int";
      value: number;
      type: LitIntType;
    };

export type BinaryKind =
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "&"
  | "|"
  | "<"
  | ">"
  | "=="
  | "<="
  | ">="
  | "!=";

export const COMPARISON_KINDS: BinaryKind[] = [
  ">",
  "<",
  "==",
  "<=",
  ">=",
  "!=",
];
export const EQUALITY_KINDS: BinaryKind[] = ["==", "!="];
export const LOGICAL_KINDS: BinaryKind[] = ["&", "|"];
export const ARITH_TERM_KINDS: BinaryKind[] = ["+", "-"];
export const ARITH_FACTOR_KINDS: BinaryKind[] = ["*", "/", "%"];

const BINARY_KIND_PREC_CLASS = new Map<BinaryKind, number>([
  ["+", 0],
  ["-", 0],
  ["*", 0],
  ["/", 0],
  ["%", 0],
  ["&", 1],
  ["|", 2],
  ["<", 3],
  [">", 4],
  ["==", 5],
  ["<=", 6],
  [">=", 7],
  ["!=", 8],
]);

export function binaryExprPrecedenceClass(k: BinaryKind): number {
  const cls = BINARY_KIND_PREC_CLASS.get(k);
  if (cls === undefined) {
    unreachable(`Invalid binary kind: '${k}'`);
  }
  return cls;
}

export type UnaryKind = "!" | "-";
export const UNARY_KINDS: UnaryKind[] = ["!", "-"];

export type TypeKind<P extends Phase> =
  | {
      kind: "ident";
      genericArgs: Type<P>[];
      value: IdentWithRes<P>;
    }
  | {
      kind: "tuple";
      elems: Type<P>[];
    }
  | {
      kind: "rawptr";
      inner: Type<P>;
    }
  | { kind: "never" }
  | { kind: "error"; err: ErrorEmitted };

export type Type<P extends Phase> = TypeKind<P> & {
  span: Span;
};

// name resolution stuff

export type Resolution =
  | {
      kind: "local";
      /**
       * The index of the local variable, from inside out.
       * ```
       * let a; let b; (a, b);
       *     ^      ^
       *     1      0
       * ```
       * When traversing resolutions, a stack of locals has to be kept.
       * It's similar to a De Bruijn index.
       *
       * You generally want to index the stack as stack[stack.len - 1 - res.idx].
       */
      index: number;
    }
  | {
      kind: "item";
      id: ItemId;
    }
  | {
      kind: "builtin";
      name: BuiltinName;
    }
  | {
      kind: "tyParam";
      /**
       * The index of the type parameter, from first to last.
       * ```
       * type A[T, U] = (T, U);
       *                 ^  ^
       *                 0  1
       * ```
       */
      index: number;
      name: string;
    }
  | { kind: "error"; err: ErrorEmitted };

export const BUILTINS = [
  "print",
  "String",
  "Int",
  "I32",
  "Bool",
  "true",
  "false",
  "trap",
  // Intrinsics:
  "__NULL", // null raw pointer
  "__i32_store",
  "__i64_store",
  "__i32_load",
  "__i64_load",
  "__i32_extend_to_i64_u",
  "___transmute",
  "___asm",
  "__locals",
] as const;

export type BuiltinName = (typeof BUILTINS)[number];

export type LocalInfo = {
  name: string;
  span: Span;
  ty?: Ty;
};

// types

// folders

export type FoldFn<From, To> = (value: From) => To;

export type Folder<From extends Phase, To extends Phase> = {
  newItemsById: ComplexMap<ItemId, Item<To>>;
  /**
   * This should not be overridden.
   */
  item: FoldFn<Item<From>, Item<To>>;
  itemInner: FoldFn<Item<From>, Item<To>>;
  expr: FoldFn<Expr<From>, Expr<To>>;
  ident: FoldFn<IdentWithRes<From>, IdentWithRes<To>>;
  type: FoldFn<Type<From>, Type<To>>;
};

type ItemFolder<From extends Phase, To extends Phase> = {
  newItemsById: ComplexMap<ItemId, Item<To>>;
  item: FoldFn<Item<From>, Item<To>>;
  itemInner: FoldFn<Item<From>, Item<To>>;
};

const ITEM_DEFAULT = Symbol("item must not be overriden");

export function mkDefaultFolder<
  From extends Phase,
  To extends Phase,
>(): ItemFolder<From, To> {
  const folder: ItemFolder<From, To> = {
    newItemsById: new ComplexMap(),
    item(item) {
      const newItem = this.itemInner(item);
      this.newItemsById.set(newItem.id, newItem);
      return newItem;
    },
    itemInner(_item) {
      unreachable("unimplemented");
    },
  };
  (folder.item as any)[ITEM_DEFAULT] = ITEM_DEFAULT;

  return folder;
}

export function foldAst<From extends Phase, To extends Phase>(
  ast: Pkg<From>,
  folder: Folder<From, To>,
): Pkg<To> {
  if ((folder.item as any)[ITEM_DEFAULT] !== ITEM_DEFAULT) {
    unreachable("must not override `item` on folders");
  }

  return {
    id: ast.id,
    rootItems: ast.rootItems.map((item) => folder.item(item)),
    itemsById: folder.newItemsById,
    typeckResults: "typeckResults" in ast ? ast.typeckResults : undefined,
    packageName: ast.packageName,
    rootFile: ast.rootFile,
    fatalError: ast.fatalError,
  };
}

export function superFoldItem<From extends Phase, To extends Phase>(
  item: Item<From>,
  folder: Folder<From, To>,
): Item<To> {
  switch (item.kind) {
    case "function": {
      const args = item.params.map(({ ident, type }) => ({
        ident,
        type: folder.type(type),
      }));

      return {
        ...item,
        kind: "function",
        name: item.name,
        params: args,
        body: folder.expr(item.body),
        returnType: item.returnType && folder.type(item.returnType),
      };
    }
    case "type": {
      const typeKind = item.type;
      let type: TypeDefKind<To>;
      switch (typeKind.kind) {
        case "struct": {
          const fields = typeKind.fields.map(({ name, type }) => ({
            name,
            type: folder.type(type),
          }));
          type = { kind: "struct", fields };
          break;
        }
        case "alias": {
          type = {
            kind: "alias",
            type: folder.type(typeKind.type),
          };
        }
      }

      return {
        ...item,
        kind: "type",
        name: item.name,
        type,
      };
    }
    case "import": {
      const args = item.params.map(({ ident, type }) => ({
        ident,
        type: folder.type(type),
      }));
      return {
        ...item,
        kind: "import",
        module: item.module,
        func: item.func,
        name: item.name,
        params: args,
        returnType: item.returnType && folder.type(item.returnType),
      };
    }
    case "mod": {
      return {
        ...item,
        kind: "mod",
        name: item.name,
        contents: item.contents.map((item) => folder.item(item)),
      };
    }
    case "extern": {
      return { ...item, kind: "extern" };
    }
    case "global": {
      return {
        ...item,
        kind: "global",
        name: item.name,
        type: folder.type(item.type),
        init: folder.expr(item.init),
      };
    }
    case "use": {
      return { ...item };
    }
    case "error": {
      return { ...item };
    }
  }
}

export function superFoldExpr<From extends Phase, To extends Phase>(
  expr: Expr<From>,
  folder: Folder<From, To>,
): Expr<To> {
  const span = expr.span;
  switch (expr.kind) {
    case "empty": {
      return { kind: "empty", span };
    }
    case "let": {
      return {
        ...expr,
        kind: "let",
        name: expr.name,
        type: expr.type && folder.type(expr.type),
        rhs: folder.expr(expr.rhs),
      };
    }
    case "assign": {
      return {
        ...expr,
        kind: "assign",
        lhs: folder.expr(expr.lhs),
        rhs: folder.expr(expr.rhs),
      };
    }
    case "block": {
      return {
        ...expr,
        kind: "block",
        exprs: expr.exprs.map((expr) => folder.expr(expr)),
      };
    }
    case "literal": {
      return { kind: "literal", value: expr.value, span };
    }
    case "ident": {
      return { kind: "ident", value: folder.ident(expr.value), span };
    }
    case "path": {
      return { ...expr, kind: "path" };
    }
    case "binary": {
      return {
        ...expr,
        kind: "binary",
        binaryKind: expr.binaryKind,
        lhs: folder.expr(expr.lhs),
        rhs: folder.expr(expr.rhs),
      };
    }
    case "unary": {
      return {
        ...expr,
        kind: "unary",
        unaryKind: expr.unaryKind,
        rhs: folder.expr(expr.rhs),
      };
    }
    case "call": {
      return {
        ...expr,
        kind: "call",
        lhs: folder.expr(expr.lhs),
        args: expr.args.map((expr) => folder.expr(expr)),
      };
    }
    case "fieldAccess": {
      return {
        ...expr,
        kind: "fieldAccess",
        lhs: folder.expr(expr.lhs),
      };
    }
    case "if": {
      return {
        ...expr,
        kind: "if",
        cond: folder.expr(expr.cond),
        then: folder.expr(expr.then),
        else: expr.else && folder.expr(expr.else),
      };
    }
    case "loop": {
      return {
        ...expr,
        kind: "loop",
        body: folder.expr(expr.body),
      };
    }
    case "break": {
      return {
        ...expr,
        kind: "break",
      };
    }
    case "structLiteral": {
      return {
        ...expr,
        kind: "structLiteral",
        name: folder.ident(expr.name),
        fields: expr.fields.map(({ name, expr }) => ({
          name,
          expr: folder.expr(expr),
        })),
      };
    }
    case "tupleLiteral": {
      return {
        ...expr,
        kind: "tupleLiteral",
        fields: expr.fields.map(folder.expr.bind(folder)),
      };
    }
    case "asm": {
      return { ...expr };
    }
    case "error": {
      return { ...expr };
    }
  }
}

export function superFoldType<From extends Phase, To extends Phase>(
  type: Type<From>,
  folder: Folder<From, To>,
): Type<To> {
  const span = type.span;
  switch (type.kind) {
    case "ident": {
      return {
        kind: "ident",
        genericArgs: type.genericArgs.map((type) => folder.type(type)),
        value: folder.ident(type.value),
        span,
      };
    }
    case "tuple": {
      return {
        kind: "tuple",
        elems: type.elems.map((type) => folder.type(type)),
        span,
      };
    }
    case "rawptr": {
      return {
        ...type,
        inner: folder.type(type.inner),
      };
    }
    case "never": {
      return { ...type, kind: "never" };
    }
    case "error":
      return { ...type };
  }
}

export function varUnreachable(): never {
  unreachable("Type variables must not occur after type checking");
}

export function paramUnreachable(ty: Ty): never {
  unreachable(`type ${ty.kind} should never occur in codegen`);
}
