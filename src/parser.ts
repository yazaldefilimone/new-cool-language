import {
  ARITH_FACTOR_KINDS,
  ARITH_TERM_KINDS,
  Pkg,
  BinaryKind,
  COMPARISON_KINDS,
  mkDefaultFolder,
  Expr,
  ExprLoop,
  ExprStructLiteral,
  FieldDef,
  Folder,
  FunctionArg,
  Ident,
  Item,
  LOGICAL_KINDS,
  Type,
  UNARY_KINDS,
  UnaryKind,
  binaryExprPrecedenceClass,
  foldAst,
  superFoldExpr,
  superFoldItem,
  Built,
  Parsed,
  ItemId,
  ItemGlobal,
  StructLiteralField,
  TypeDefKind,
  ItemUse,
} from "./ast";
import { GlobalContext } from "./context";
import { CompilerError, ErrorEmitted, LoadedFile, Span } from "./error";
import {
  BaseToken,
  Token,
  TokenIdent,
  TokenLitString,
  tokenize,
} from "./lexer";
import { loadModuleFile } from "./loader";
import { ComplexMap, ComplexSet, Ids } from "./utils";

export type ParseState = {
  tokens: Token[];
  file: LoadedFile;
  gcx: GlobalContext;
};
type State = ParseState;

type Parser<T> = (t: State) => [State, T];

class FatalParseError extends Error {
  constructor(public inner: ErrorEmitted) {
    super("fatal parser error");
  }
}

export function parse(
  packageName: string,
  t: State,
  pkgId: number,
): Pkg<Built> {
  let items: Item<Parsed>[];
  let fatalError: ErrorEmitted | undefined = undefined;
  try {
    [, items] = parseItems(t);
  } catch (e) {
    if (e instanceof FatalParseError) {
      items = [];
      fatalError = e.inner;
    } else {
      throw e;
    }
  }

  const ast: Pkg<Built> = buildPkg(
    packageName,
    items,
    pkgId,
    t.file,
    fatalError,
  );

  validateAst(ast, t.gcx);

  return ast;
}

function parseItems(t: State): [State, Item<Parsed>[]] {
  const items: Item<Parsed>[] = [];

  while (t.tokens.length > 0) {
    let item;
    [t, item] = parseItem(t);
    items.push(item);
  }

  return [t, items];
}

function parseItem(t: State): [State, Item<Parsed>] {
  let tok;
  [t, tok] = next(t);
  if (tok.kind === "function") {
    let sig: FunctionSig;
    [t, sig] = parseFunctionSig(t);

    [t] = expectNext(t, "=");

    let body;
    [t, body] = parseExpr(t);

    [t] = expectNext(t, ";");

    return [
      t,
      {
        kind: "function",
        ...sig,
        body,
        span: tok.span,
        // Assigned later.
        id: ItemId.dummy(),
      },
    ];
  } else if (tok.kind === "type") {
    let name;
    [t, name] = expectNext<TokenIdent>(t, "identifier");

    let generics;
    [t, generics] = parseGenericsDef(t);

    [t] = expectNext(t, "=");

    let type: TypeDefKind<Parsed>;

    let struct;
    [t, struct] = eat(t, "struct");
    if (struct) {
      [t] = expectNext(t, "{");

      let fields;
      [t, fields] = parseCommaSeparatedList<FieldDef<Parsed>>(t, "}", (t) => {
        let name;
        [t, name] = expectNext<TokenIdent>(t, "identifier");
        [t] = expectNext(t, ":");
        let type;
        [t, type] = parseType(t);
        return [
          t,
          {
            name: {
              name: name.ident,
              span: name.span,
            },
            type,
          },
        ];
      });

      type = { kind: "struct", fields };
    } else {
      let aliased: Type<Parsed>;
      [t, aliased] = parseType(t);

      type = { kind: "alias", type: aliased };
    }

    [t] = expectNext(t, ";");

    return [
      t,
      {
        kind: "type",
        name: name.ident,
        genericParams: generics,
        type,
        span: name.span,
        id: ItemId.dummy(),
      },
    ];
  } else if (tok.kind === "import") {
    [t] = expectNext(t, "(");
    let module;
    [t, module] = expectNext<TokenLitString>(t, "lit_string");
    let func;
    [t, func] = expectNext<TokenLitString>(t, "lit_string");
    [t] = expectNext(t, ")");

    let sig;
    [t, sig] = parseFunctionSig(t);

    [t] = expectNext(t, ";");

    return [
      t,
      {
        kind: "import",
        ...sig,
        module: { kind: "str", value: module.value, span: module.span },
        func: { kind: "str", value: func.value, span: func.span },
        span: tok.span,
        id: ItemId.dummy(),
      },
    ];
  } else if (tok.kind === "extern") {
    [t] = expectNext(t, "mod");
    let name;
    [t, name] = expectNext<TokenIdent>(t, "identifier");

    [t] = expectNext(t, ";");

    return [
      t,
      { kind: "extern", name: name.ident, span: name.span, id: ItemId.dummy() },
    ];
  } else if (tok.kind === "mod") {
    let name;
    [t, name] = expectNext<TokenIdent>(t, "identifier");

    let contents: Item<Parsed>[] = [];

    let popen = undefined;
    [t, popen] = eat(t, "(");
    if (popen) {
      while (peekKind(t) !== ")") {
        let item;
        [t, item] = parseItem(t);

        contents.push(item);
      }

      [t] = expectNext(t, ")");
    } else {
      if (name.span.file.path === undefined) {
        t.gcx.error.emitError(
          new CompilerError(
            `no known source file for statement, cannot load file relative to it`,
            name.span,
          ),
        );

        contents = [];
      } else {
        const file = loadModuleFile(name.span.file.path, name.ident, name.span);

        if (!file.ok) {
          t.gcx.error.emitError(file.err);
          contents = [];
        } else {
          const tokens = tokenize(t.gcx.error, file.value);
          if (!tokens.ok) {
            throw new FatalParseError(tokens.err);
          }
          [, contents] = parseItems({
            file: file.value,
            tokens: tokens.tokens,
            gcx: t.gcx,
          });
        }
      }
    }

    [t] = expectNext(t, ";");

    return [
      t,
      {
        kind: "mod",
        name: name.ident,
        contents,
        span: name.span,
        id: ItemId.dummy(),
      },
    ];
  } else if (tok.kind === "global") {
    let name;
    [t, name] = expectNext<TokenIdent>(t, "identifier");
    [t] = expectNext(t, ":");
    let type;
    [t, type] = parseType(t);
    [t] = expectNext(t, "=");
    let init;
    [t, init] = parseExpr(t);
    [t] = expectNext(t, ";");

    const global: ItemGlobal<Parsed> = {
      kind: "global",
      name: name.ident,
      type,
      init,
      span: name.span,
      id: ItemId.dummy(),
    };
    return [t, global];
  } else if (tok.kind === "use") {
    let ident;
    [t, ident] = expectNext<TokenIdent>(t, "identifier");

    const segments: Ident[] = [{ name: ident.ident, span: ident.span }];

    while (true) {
      let semi;
      [t, semi] = eat(t, ".");
      if (!semi) {
        break;
      }
      [t, ident] = expectNext<TokenIdent>(t, "identifier");
      segments.push({ name: ident.ident, span: ident.span });
    }

    [t] = expectNext(t, ";");

    const use: ItemUse<Parsed> = {
      kind: "use",
      name: segments[segments.length - 1].name,
      segments,
      span: tok.span,
      id: ItemId.dummy(),
    };

    return [t, use];
  } else {
    unexpectedToken(t, tok, "item");
  }
}

type FunctionSig = {
  name: string;
  params: FunctionArg<Parsed>[];
  returnType?: Type<Parsed>;
};

function parseFunctionSig(t: State): [State, FunctionSig] {
  let name;
  [t, name] = expectNext<TokenIdent>(t, "identifier");

  [t] = expectNext(t, "(");

  let params: FunctionArg<Parsed>[];
  [t, params] = parseCommaSeparatedList(
    t,
    ")",
    (t): [State, FunctionArg<Parsed>] => {
      let name;
      [t, name] = expectNext<TokenIdent>(t, "identifier");
      [t] = expectNext(t, ":");
      let type;
      [t, type] = parseType(t);

      return [t, { ident: { name: name.ident, span: name.span }, type }];
    },
  );

  let colon;
  let returnType = undefined;
  [t, colon] = eat(t, ":");
  if (colon) {
    [t, returnType] = parseType(t);
  }

  return [t, { name: name.ident, params, returnType }];
}

function parseGenericsDef(t: State): [State, Ident[]] {
  let openBracket;
  [t, openBracket] = eat(t, "[");
  if (openBracket) {
    let elems;
    [t, elems] = parseCommaSeparatedList<Ident>(t, "]", (t) => {
      let name;
      [t, name] = expectNext<TokenIdent>(t, "identifier");

      return [t, { name: name.ident, span: name.span }];
    });
    return [t, elems];
  } else {
    return [t, []];
  }
}

function parseGenericsArgs(t: State): [State, Type<Parsed>[]] {
  let openBracket;
  [t, openBracket] = eat(t, "[");
  if (openBracket) {
    return parseCommaSeparatedList(t, "]", parseType);
  } else {
    return [t, []];
  }
}

function parseExpr(t: State): [State, Expr<Parsed>] {
  /*
  EXPR = ASSIGNMENT

  LET = "let" NAME { ":" TYPE } "=" EXPR "in" EXPR
  IF = "if" EXPR "then" EXPR { "else" EXPR }
  LOOP = "loop" EXPR
  BREAK = "break"

  ASSIGNMENT = COMPARISON { "=" ASSIGNMENT }

  // The precende here is pretty arbitrary since we forbid mixing of operators
  // with different precedence classes anyways.
  COMPARISON = LOGICAL { ( ">" | "<" | "==" | "<=" | ">=" | "!=" ) COMPARISON }
  LOGICAL = ARITH_TERM { ( "&" | "|" ) LOGICAL }

  // Here it matters though.
  ARITH_TERM = ATOM { ( "+" | "-" ) ARITH_TERM }
  ARITH_FACTOR = UNARY { ( "*" | "/" ) ARITH_FACTOR }

  UNARY = { "!" | "-" } CALL

  CALL = ATOM { ( "(" EXPR_LIST ")" ) | ( "." ( IDENT | NUMBER ) ) }

  ATOM = "(" { EXPR ";" | "," } EXPR ")" | IDENT { STRUCT_INIT } | LITERAL | EMPTY | LET | IF | LOOP | BREAK
  EMPTY =
  STRUCT_INIT = "{" { NAME ":" EXPR } { "," NAME ":" EXPR } { "," } "}"
  EXPR_LIST = { EXPR { "," EXPR } { "," } }
  */
  return parseExprAssignment(t);
}

function mkBinaryExpr(
  lhs: Expr<Parsed>,
  rhs: Expr<Parsed>,
  span: Span,
  kind: string,
): Expr<Parsed> {
  return { kind: "binary", binaryKind: kind as BinaryKind, lhs, rhs, span };
}

function mkParserExprBinary(
  lower: Parser<Expr<Parsed>>,
  kinds: string[],
  mkExpr = mkBinaryExpr,
): Parser<Expr<Parsed>> {
  function parser(t: State): [State, Expr<Parsed>] {
    let lhs;
    [t, lhs] = lower(t);

    const peek = peekKind(t);
    if (peek && kinds.includes(peek)) {
      let tok;
      [t, tok] = next(t);
      let rhs;
      [t, rhs] = parser(t);
      const span = lhs.span.merge(rhs.span);

      return [t, mkExpr(lhs, rhs, span, tok.kind)];
    }

    return [t, lhs];
  }

  return parser;
}

const parseExprArithFactor = mkParserExprBinary(
  parseExprUnary,
  ARITH_FACTOR_KINDS,
);

const parseExprArithTerm = mkParserExprBinary(
  parseExprArithFactor,
  ARITH_TERM_KINDS,
);

const parseExprLogical = mkParserExprBinary(parseExprArithTerm, LOGICAL_KINDS);

const parseExprComparison = mkParserExprBinary(
  parseExprLogical,
  COMPARISON_KINDS,
);

const parseExprAssignment = mkParserExprBinary(
  parseExprComparison,
  ["="],
  (lhs, rhs, span) => ({ kind: "assign", lhs, rhs, span }),
);

function parseExprUnary(t: State): [State, Expr<Parsed>] {
  const peek = peekKind(t);
  if (peek && UNARY_KINDS.includes(peek as UnaryKind)) {
    let tok: Token;
    [t, tok] = expectNext(t, peek);
    let rhs;
    [t, rhs] = parseExprUnary(t);
    return [
      t,
      {
        kind: "unary",
        unaryKind: tok.kind as UnaryKind,
        rhs,
        span: tok.span,
      },
    ];
  }

  return parseExprCall(t);
}
function parseExprCall(t: State): [State, Expr<Parsed>] {
  let lhs: Expr<Parsed>;
  [t, lhs] = parseExprAtom(t);

  while (peekKind(t) === "(" || peekKind(t) === ".") {
    let tok;
    [t, tok] = next(t);

    if (tok.kind === "(") {
      let args;
      [t, args] = parseCommaSeparatedList(t, ")", parseExpr);

      lhs = { kind: "call", span: tok.span, lhs, args };
    } else if (tok.kind === ".") {
      let access;
      [t, access] = next(t);
      let value;
      if (access.kind === "identifier") {
        value = access.ident;
      } else if (access.kind === "lit_int") {
        value = access.value;
      } else {
        unexpectedToken(t, access, "identifier or integer");
      }

      lhs = {
        kind: "fieldAccess",
        lhs,
        field: { span: access.span, value },
        span: lhs.span.merge(access.span),
      };
    }
  }

  return [t, lhs];
}

function parseExprAtom(startT: State): [State, Expr<Parsed>] {
  // eslint-disable-next-line prefer-const
  let [t, tok] = next(startT);
  const span = tok.span;

  if (tok.kind === "(") {
    let expr: Expr<Parsed>;
    [t, expr] = parseExpr(t);

    // This could be a block or a tuple literal. We can only know after
    // parsing the first expression and looking at the delimiter.

    const [, peek] = next(t);
    // It's a single element, which we interpret as a block.
    // `(0,)` is the one elem tuple.
    if (peek.kind === ")") {
      [t] = expectNext(t, ")");
      return [t, { kind: "block", span, exprs: [expr] }];
    }
    // It's a block.
    if (peek.kind === ";") {
      const exprs = [expr];
      while (peekKind(t) !== ")") {
        [t] = expectNext(t, ";");
        [t, expr] = parseExpr(t);
        exprs.push(expr);
      }
      [t] = expectNext(t, ")");

      return [t, { kind: "block", span, exprs }];
    }
    // It's a tuple.
    if (peek.kind === ",") {
      [t] = expectNext(t, ",");
      let rest;
      [t, rest] = parseCommaSeparatedList(t, ")", parseExpr);

      return [t, { kind: "tupleLiteral", span, fields: [expr, ...rest] }];
    }
    unexpectedToken(t, peek, "`,`, `;` or `)`");
  }

  if (tok.kind === "lit_string") {
    return [
      t,
      {
        kind: "literal",
        span,
        value: { kind: "str", value: tok.value, span: tok.span },
      },
    ];
  }

  if (tok.kind === "lit_int") {
    return [
      t,
      {
        kind: "literal",
        span,
        value: { kind: "int", value: tok.value, type: tok.type },
      },
    ];
  }

  if (tok.kind === "identifier") {
    if (maybeNextT(t)[1]?.kind === "{") {
      let fields;
      [t, fields] = parseStructInit(t);
      return [
        t,
        {
          kind: "structLiteral",
          name: { name: tok.ident, span },
          fields,
          span,
        },
      ];
    }

    return [
      t,
      {
        kind: "ident",
        span,
        value: { name: tok.ident, span },
      },
    ];
  }

  if (tok.kind === "let") {
    let name;
    [t, name] = expectNext<TokenIdent>(t, "identifier");

    let type = undefined;
    let colon;
    [t, colon] = eat(t, ":");
    if (colon) {
      [t, type] = parseType(t);
    }

    [t] = expectNext(t, "=");
    let rhs;
    [t, rhs] = parseExpr(t);

    const nameIdent: Ident = { name: name.ident, span: name.span };

    return [
      t,
      {
        kind: "let",
        name: nameIdent,
        type,
        rhs,
        span: name.span,
      },
    ];
  }

  if (tok.kind === "if") {
    let cond;
    [t, cond] = parseExpr(t);

    [t] = expectNext(t, "then");
    let then;
    [t, then] = parseExpr(t);

    let elseTok;
    [t, elseTok] = eat(t, "else");
    let elsePart = undefined;
    if (elseTok) {
      [t, elsePart] = parseExpr(t);
    }

    return [t, { kind: "if", cond, then, else: elsePart, span: tok.span }];
  }

  if (tok.kind === "loop") {
    let body;
    [t, body] = parseExpr(t);
    return [t, { kind: "loop", body, span: tok.span, loopId: 0 }];
  }

  if (tok.kind === "break") {
    return [t, { kind: "break", span: tok.span }];
  }

  // Parse nothing at all.
  return [startT, { kind: "empty", span }];
}

function parseStructInit(
  t: State,
): [State, ExprStructLiteral<Parsed>["fields"]] {
  [t] = expectNext(t, "{");

  let fields;
  [t, fields] = parseCommaSeparatedList<StructLiteralField<Parsed>>(
    t,
    "}",
    (t) => {
      let name;
      [t, name] = expectNext<TokenIdent>(t, "identifier");
      [t] = expectNext(t, ":");
      let expr;
      [t, expr] = parseExpr(t);

      return [t, { name: { name: name.ident, span: name.span }, expr }];
    },
  );

  return [t, fields];
}

function parseType(t: State): [State, Type<Parsed>] {
  let tok;
  [t, tok] = next(t);
  const span = tok.span;

  switch (tok.kind) {
    case "!": {
      return [t, { kind: "never", span }];
    }
    case "identifier": {
      let generics;
      [t, generics] = parseGenericsArgs(t);
      return [
        t,
        {
          kind: "ident",
          genericArgs: generics,
          value: { name: tok.ident, span },
          span,
        },
      ];
    }
    case "(": {
      // `()` is a the unit type, an empty tuple.
      // `(T)` is just `T`
      // `(T,)` is a tuple
      if (peekKind(t) === ")") {
        [t] = next(t);
        return [t, { kind: "tuple", elems: [], span }];
      }
      let head;
      [t, head] = parseType(t);

      if (peekKind(t) === ")") {
        [t] = next(t);
        // Just a type inside parens, not a tuple. `(T,)` is a tuple.
        return [t, head];
      }

      [t] = expectNext(t, ",");

      let tail;
      [t, tail] = parseCommaSeparatedList(t, ")", parseType);

      return [t, { kind: "tuple", elems: [head, ...tail], span }];
    }
    case "*": {
      let inner;
      [t, inner] = parseType(t);

      return [t, { kind: "rawptr", inner, span }];
    }
    default: {
      throw new FatalParseError(
        t.gcx.error.emitError(
          new CompilerError(
            `unexpected token: \`${tok.kind}\`, expected type`,
            span,
          ),
        ),
      );
    }
  }
}

// helpers

function parseCommaSeparatedList<R>(
  t: State,
  terminator: Token["kind"],
  parser: Parser<R>,
): [State, R[]] {
  const items: R[] = [];

  // () | (a) | (a,) | (a, b)

  while (peekKind(t) !== terminator) {
    let nextValue;
    [t, nextValue] = parser(t);

    items.push(nextValue);

    let comma;
    [t, comma] = eat(t, ",");
    if (!comma) {
      // No comma? Fine, you don't like trailing commas.
      // But this better be the end.
      if (peekKind(t) !== terminator) {
        unexpectedToken(t, next(t)[1], `, or ${terminator}`);
      }
      break;
    }
  }

  [t] = expectNext(t, terminator);

  return [t, items];
}

function eat<T extends BaseToken>(
  t: State,
  kind: T["kind"],
): [State, T | undefined] {
  if (peekKind(t) === kind) {
    return expectNext(t, kind);
  }
  return [t, undefined];
}

function peekKind(t: State): Token["kind"] | undefined {
  return maybeNextT(t)?.[1]?.kind;
}

function expectNext<T extends BaseToken>(
  t: State,
  kind: T["kind"],
): [State, T & Token] {
  let tok;
  [t, tok] = maybeNextT(t);
  if (!tok) {
    throw new FatalParseError(
      t.gcx.error.emitError(
        new CompilerError(
          `expected \`${kind}\`, found end of file`,
          Span.eof(t.file),
        ),
      ),
    );
  }
  if (tok.kind !== kind) {
    throw new FatalParseError(
      t.gcx.error.emitError(
        new CompilerError(
          `expected \`${kind}\`, found \`${tok.kind}\``,
          tok.span,
        ),
      ),
    );
  }
  return [t, tok as unknown as T & Token];
}

function next(t: State): [State, Token] {
  const [rest, next] = maybeNextT(t);
  if (!next) {
    throw new FatalParseError(
      t.gcx.error.emitError(
        new CompilerError("unexpected end of file", Span.eof(t.file)),
      ),
    );
  }
  return [rest, next];
}

function maybeNextT(t: State): [State, Token | undefined] {
  const next = t.tokens[0];
  const rest = t.tokens.slice(1);

  return [{ ...t, tokens: rest }, next];
}

function unexpectedToken(t: ParseState, token: Token, expected: string): never {
  throw new FatalParseError(
    t.gcx.error.emitError(
      new CompilerError(`unexpected token, expected ${expected}`, token.span),
    ),
  );
}

function validateAst(ast: Pkg<Built>, gcx: GlobalContext) {
  const seenItemIds = new ComplexSet();

  const validator: Folder<Built, Built> = {
    ...mkDefaultFolder(),
    itemInner(item: Item<Built>): Item<Built> {
      if (seenItemIds.has(item.id)) {
        throw new Error(
          `duplicate item id: ${item.id.toString()} for ${item.name}`,
        );
      }
      seenItemIds.add(item.id);
      return superFoldItem(item, this);
    },
    expr(expr: Expr<Built>): Expr<Built> {
      if (expr.kind === "block") {
        expr.exprs.forEach((inner) => {
          if (inner.kind === "let") {
            this.expr(inner.rhs);
            if (inner.type) {
              this.type(inner.type);
            }
          } else {
            this.expr(inner);
          }
        });
        return expr;
      } else if (expr.kind === "let") {
        gcx.error.emitError(
          new CompilerError("let is only allowed in blocks", expr.span),
        );
        return superFoldExpr(expr, this);
      } else if (expr.kind === "binary") {
        const checkPrecedence = (inner: Expr<Built>, side: string) => {
          if (inner.kind === "binary") {
            const ourClass = binaryExprPrecedenceClass(expr.binaryKind);
            const innerClass = binaryExprPrecedenceClass(inner.binaryKind);

            if (ourClass !== innerClass) {
              gcx.error.emitError(
                new CompilerError(
                  `mixing operators without parentheses is not allowed. ${side} is ${inner.binaryKind}, which is different from ${expr.binaryKind}`,
                  expr.span,
                ),
              );
            }
          }
        };

        checkPrecedence(expr.lhs, "left");
        checkPrecedence(expr.rhs, "right");

        return superFoldExpr(expr, this);
      } else {
        return superFoldExpr(expr, this);
      }
    },
    ident(ident) {
      return ident;
    },
    type(type) {
      return type;
    },
  };

  foldAst(ast, validator);
}

function buildPkg(
  packageName: string,
  rootItems: Item<Parsed>[],
  pkgId: number,
  rootFile: LoadedFile,
  fatalError: ErrorEmitted | undefined,
): Pkg<Built> {
  const itemId = new Ids();
  itemId.next(); // pkg root ID
  const loopId = new Ids();

  const ast: Pkg<Built> = {
    id: pkgId,
    rootItems,
    itemsById: new ComplexMap(),
    packageName,
    rootFile,
    fatalError,
  };

  const assigner: Folder<Parsed, Built> = {
    ...mkDefaultFolder(),
    itemInner(item: Item<Parsed>): Item<Built> {
      const id = new ItemId(pkgId, itemId.next());
      return { ...superFoldItem(item, this), id };
    },
    expr(expr: Expr<Parsed>): Expr<Built> {
      if (expr.kind === "loop") {
        return {
          ...(superFoldExpr(expr, this) as ExprLoop<Built> & Expr<Built>),
          loopId: loopId.next(),
        };
      }
      return superFoldExpr(expr, this);
    },
    ident(ident) {
      return ident;
    },
    type(type) {
      return type;
    },
  };

  const pkg = foldAst(ast, assigner);

  return pkg;
}
