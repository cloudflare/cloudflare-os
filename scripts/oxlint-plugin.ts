import type {
  Comment, Definition, Diagnostic, ESTree, Plugin, Rule, RuleOptionsSchema, Scope,
} from "vite-plus/lint/plugins";

const preferJsdoc: Rule = {
  meta: {
    type: "layout",
    docs: {
      description: "Require JSDoc syntax for exported declaration comments",
    },
    fixable: "whitespace",
    messages: {
      useJsdoc: "Use a JSDoc comment (`/** ... */`) to document an exported declaration.",
    },
    schema: [],
  },
  create(context) {
    const sourceCode = context.sourceCode;
    const apiRootTypes = new Set([
      "ClassDeclaration",
      "ClassExpression",
      "FunctionDeclaration",
      "TSDeclareFunction",
      "TSInterfaceDeclaration",
      "TSTypeAliasDeclaration",
      "TSEnumDeclaration",
      "VariableDeclaration",
    ]);
    const classMemberTypes = new Set([
      "AccessorProperty",
      "MethodDefinition",
      "PropertyDefinition",
      "TSAbstractAccessorProperty",
      "TSAbstractMethodDefinition",
      "TSAbstractPropertyDefinition",
      "TSParameterProperty",
    ]);

    function startsOnOwnLine(comment: Comment) {
      const lineStart = sourceCode.text.lastIndexOf("\n", comment.range[0] - 1) + 1;
      return sourceCode.text.slice(lineStart, comment.range[0]).trim() === "";
    }

    function checkComments(node: ESTree.Node) {
      const comments = sourceCode.getCommentsBefore(node);
      const lastComment = comments.at(-1);
      if (!lastComment || lastComment.loc.end.line + 1 !== node.loc.start.line ||
          !startsOnOwnLine(lastComment)) return;

      if (lastComment.type === "Block") {
        const text = sourceCode.getText(lastComment);
        if (text.startsWith("/**") || text.startsWith("/*!") ||
            /^(?:[#@]__(?:NO_SIDE_EFFECTS|PURE)__|@ts-|c8 |eslint-|istanbul |oxlint-|prettier-|biome-)/i
              .test(lastComment.value.trimStart())) return;
        context.report({
          node,
          loc: lastComment.loc,
          messageId: "useJsdoc",
          fix: (fixer) => fixer.replaceTextRange(
            [lastComment.range[0], lastComment.range[0] + 2],
            "/**",
          ),
        });
        return;
      }
      if (lastComment.type !== "Line") return;

      let firstIndex = comments.length - 1;
      while (firstIndex > 0) {
        const previous = comments[firstIndex - 1];
        const current = comments[firstIndex];
        if (previous.type !== "Line" ||
            previous.loc.end.line + 1 !== current.loc.start.line) break;
        firstIndex--;
      }

      const docComments = comments.slice(firstIndex);
      if (docComments.some((comment) => !startsOnOwnLine(comment))) return;

      if (docComments.some((comment) =>
        sourceCode.getText(comment).startsWith("///") ||
        /^(?:@ts-|c8 |eslint-|istanbul |oxlint-|prettier-|biome-)/i
          .test(comment.value.trimStart()))) return;

      const firstComment = docComments[0];
      const indent = " ".repeat(firstComment.loc.start.column);
      const replacement = docComments.length === 1
        ? `/**${firstComment.value.trimEnd()} */`
        : `/**\n${docComments.map((comment) =>
          `${indent} *${comment.value.trimEnd()}`).join("\n")}\n${indent} */`;

      const report: Diagnostic = {
        node,
        loc: {
          start: firstComment.loc.start,
          end: lastComment.loc.end,
        },
        messageId: "useJsdoc",
      };
      if (!docComments.some((comment) => comment.value.includes("*/"))) {
        report.fix = (fixer) => fixer.replaceTextRange(
          [firstComment.range[0], lastComment.range[1]],
          replacement,
        );
      }
      context.report(report);
    }

    function checkExport(node: ESTree.ExportNamedDeclaration | ESTree.ExportDefaultDeclaration) {
      if (node.declaration) checkComments(node);
    }

    function isPrivateMember(node: ESTree.Node) {
      return ("accessibility" in node && node.accessibility === "private") ||
        ("key" in node && node.key?.type === "PrivateIdentifier");
    }

    function isExportedApiMember(node: ESTree.Node) {
      if (isPrivateMember(node)) return false;

      let root: ESTree.Node | null = node.parent;
      while (root) {
        if (classMemberTypes.has(root.type) && isPrivateMember(root)) return false;
        if ((root.type === "FunctionDeclaration" || root.type === "FunctionExpression" ||
            root.type === "ArrowFunctionExpression") && root.body &&
            node.range[0] >= root.body.range[0] && node.range[1] <= root.body.range[1]) {
          return false;
        }
        if ((root.type === "PropertyDefinition" || root.type === "AccessorProperty") && root.value &&
            node.range[0] >= root.value.range[0] && node.range[1] <= root.value.range[1]) {
          return false;
        }
        if (root.type === "StaticBlock") return false;
        if (apiRootTypes.has(root.type)) break;
        root = root.parent;
      }
      if (!root) return false;

      let parent: ESTree.Node | null = root.parent;
      while (parent?.type === "VariableDeclarator" || parent?.type === "VariableDeclaration") {
        parent = parent.parent;
      }
      return (parent?.type === "ExportDefaultDeclaration" ||
          parent?.type === "ExportNamedDeclaration") && parent.declaration !== null;
    }

    function checkApiMember(node: ESTree.Node) {
      if (isExportedApiMember(node)) checkComments(node);
    }

    const apiMemberSelector =
      ":matches(AccessorProperty, MethodDefinition, PropertyDefinition, " +
      "TSAbstractAccessorProperty, TSAbstractMethodDefinition, TSAbstractPropertyDefinition, " +
      "TSCallSignatureDeclaration, TSConstructSignatureDeclaration, TSEnumMember, " +
      "TSIndexSignature, TSMethodSignature, TSParameterProperty, TSPropertySignature)";

    return {
      ":matches(ExportDefaultDeclaration, ExportNamedDeclaration)": checkExport,
      [apiMemberSelector]: checkApiMember,
    };
  },
};

/** Modules the agent's own environment resolves, so agent-facing declarations may import them. */
const agentProvidedModules = ["cloudflare:workers"];

const selfContainedAgentTypes: Rule = {
  meta: {
    type: "problem",
    docs: {
      description: "Forbid module references in declarations delivered to agents as verbatim text",
    },
    messages: {
      moduleReference: "The agent receives this file as verbatim text and nothing resolves " +
        "`{{source}}` for it. Copy the referenced definitions into this file instead.",
    },
    schema: [{
      type: "object",
      properties: {
        allow: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    }],
  },
  create(context) {
    const options = context.options[0] as { allow?: string[] } | undefined;
    const allowed = new Set([...agentProvidedModules, ...(options?.allow ?? [])]);

    function check(source: ESTree.StringLiteral) {
      if (allowed.has(source.value)) return;
      context.report({ node: source, messageId: "moduleReference", data: { source: source.value } });
    }

    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          if (comment.type !== "Line") continue;
          const reference = /^\/\s*<reference\s+(?:path|types)\s*=\s*(["'])(.*?)\1/.exec(comment.value);
          if (!reference || allowed.has(reference[2])) continue;
          context.report({ loc: comment.loc, messageId: "moduleReference", data: { source: reference[2] } });
        }
      },
      ImportDeclaration: (node) => check(node.source),
      ExportAllDeclaration: (node) => check(node.source),
      ExportNamedDeclaration(node) {
        if (node.source) check(node.source);
      },
      TSImportType: (node) => check(node.source),
      TSExternalModuleReference: (node) => check(node.expression),
    };
  },
};

/** The names code reaches its global object by, the ones `no-restricted-globals` checks. */
const globalObjectNames = new Set(["globalThis", "self", "window"]);

/**
 * The expression under the casts and assertions that change no value. Parentheses need no
 * unwrapping: the tree a rule is given holds no node for them.
 */
function withoutTypeSyntax(node: ESTree.Expression): ESTree.Expression {
  while (node.type === "TSAsExpression" || node.type === "TSSatisfiesExpression" ||
      node.type === "TSNonNullExpression" || node.type === "TSTypeAssertion") {
    node = node.expression;
  }
  return node;
}

/** The options of a rule about restricted globals: each a global's `name`, and a `message` saying what to do instead. */
const restrictedGlobalsSchema: RuleOptionsSchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      name: { type: "string" },
      message: { type: "string" },
    },
    required: ["name"],
    additionalProperties: false,
  },
};

/** Each restricted name of a rule's options, with its message as a report appends it. */
function restrictedGlobals(options: readonly unknown[]): Map<string, string> {
  const restricted = new Map<string, string>();
  for (const option of options) {
    if (typeof option !== "object" || option === null || !("name" in option) ||
        typeof option.name !== "string") continue;
    const message = "message" in option && typeof option.message === "string" ? ` ${option.message}` : "";
    restricted.set(option.name, message);
  }
  return restricted;
}

/** Whether a node is declared with `declare`, which leaves nothing of it in the built file. */
function isDeclared(node: ESTree.Node | null | undefined): boolean {
  return typeof node === "object" && node !== null && "declare" in node && node.declare === true;
}

/**
 * Whether a definition is ambient: a `declare`d variable, function, class, enum or namespace. It
 * binds a name for the type checker alone, so at run time the name is whatever an outer scope, or
 * the runtime, holds under it.
 */
function isAmbient(definition: Definition): boolean {
  return isDeclared(definition.node) || isDeclared(definition.parent);
}

/**
 * The form `no-restricted-globals` does not see: a restricted global destructured out of the global
 * object (`const { fetch } = globalThis`), which also hides every later use behind a local binding.
 * Each option is one global in the shape that rule takes: its `name`, and a `message` saying what to
 * do instead.
 */
const noRestrictedGlobalDestructuring: Rule = {
  meta: {
    type: "problem",
    docs: {
      description: "Forbid destructuring a restricted global out of the global object",
    },
    messages: {
      restricted: "Unexpected use of '{{name}}', destructured from '{{object}}'.{{message}}",
    },
    schema: restrictedGlobalsSchema,
  },
  create(context) {
    const sourceCode = context.sourceCode;
    const restricted = restrictedGlobals(context.options);

    // An identifier that no declaration in the file binds at run time is the runtime's own: an
    // ambient declaration binds nothing there.
    function isGlobal(node: ESTree.IdentifierReference) {
      for (let scope: Scope | null = sourceCode.getScope(node); scope; scope = scope.upper) {
        if (scope.set.get(node.name)?.defs.some(definition => !isAmbient(definition))) return false;
      }
      return true;
    }

    function check(pattern: ESTree.Node, source: ESTree.Expression | null) {
      if (pattern.type !== "ObjectPattern" || !source) return;
      const object = withoutTypeSyntax(source);
      if (object.type !== "Identifier" || !globalObjectNames.has(object.name) ||
          !isGlobal(object)) return;

      for (const property of pattern.properties) {
        if (property.type !== "Property") continue;
        const key = property.key;
        const name = key.type === "Identifier" && !property.computed ? key.name
          : key.type === "Literal" && typeof key.value === "string" ? key.value
          : null;
        const message = name === null ? undefined : restricted.get(name);
        if (name === null || message === undefined) continue;
        context.report({
          node: key,
          messageId: "restricted",
          data: { name, object: object.name, message },
        });
      }
    }

    return {
      VariableDeclarator: (node) => check(node.id, node.init),
      AssignmentExpression: (node) => check(node.left, node.right),
      AssignmentPattern: (node) => check(node.left, node.right),
    };
  },
};

/**
 * Each identifier a declarator's target binds: the name itself, or every name a destructuring
 * binds at any depth, a renamed property's new name and a rest element's included.
 */
function* boundIdentifiers(target: ESTree.Node | null): Generator<ESTree.Node> {
  switch (target?.type) {
    case "Identifier":
      yield target;
      break;
    case "ObjectPattern":
      for (const property of target.properties) {
        yield* boundIdentifiers(property.type === "Property" ? property.value : property);
      }
      break;
    case "ArrayPattern":
      for (const element of target.elements) yield* boundIdentifiers(element);
      break;
    case "AssignmentPattern":
      yield* boundIdentifiers(target.left);
      break;
    case "RestElement":
      yield* boundIdentifiers(target.argument);
      break;
  }
}

/**
 * A second form `no-restricted-globals` does not see: an ambient declaration that binds the name
 * of a restricted global (`declare const fetch: ...`, `declare function fetch(...)`, or a
 * destructuring one, `declare const { fetch }: ...`). Scope analysis reads it as a local binding,
 * so no later use of the name is reported, while the built file holds nothing of it and every such
 * use is the global's. A name of the global object is listed beside the globals reached through
 * it: `declare const self: ...` hides `self.fetch` the same way. Each option is one global in the
 * shape that rule takes: its `name`, and a `message` saying what to do instead. A declaration
 * inside `declare global` or a `declare namespace` hides nothing outside its block, and is not
 * reported.
 */
const noRestrictedGlobalDeclaration: Rule = {
  meta: {
    type: "problem",
    docs: {
      description: "Forbid an ambient declaration named after a restricted global",
    },
    messages: {
      restricted: "Unexpected ambient declaration of '{{name}}', which hides the global from lint.{{message}}",
    },
    schema: restrictedGlobalsSchema,
  },
  create(context) {
    const restricted = restrictedGlobals(context.options);

    function check(name: ESTree.Node | null) {
      if (name?.type !== "Identifier") return;
      const message = restricted.get(name.name);
      if (message === undefined) return;
      context.report({ node: name, messageId: "restricted", data: { name: name.name, message } });
    }

    // A function, class, enum or namespace that is declared with `declare`.
    function checkDeclared(node: ESTree.Node & { id: ESTree.Node | null }) {
      if (isDeclared(node)) check(node.id);
    }

    return {
      VariableDeclaration(node) {
        if (!node.declare) return;
        for (const declarator of node.declarations) {
          for (const name of boundIdentifiers(declarator.id)) check(name);
        }
      },
      TSDeclareFunction: checkDeclared,
      ClassDeclaration: checkDeclared,
      TSEnumDeclaration: checkDeclared,
      TSModuleDeclaration: checkDeclared,
    };
  },
};

export default {
  meta: {
    name: "gadgets",
  },
  rules: {
    "prefer-jsdoc": preferJsdoc,
    "self-contained-agent-types": selfContainedAgentTypes,
    "no-restricted-global-destructuring": noRestrictedGlobalDestructuring,
    "no-restricted-global-declaration": noRestrictedGlobalDeclaration,
  },
} satisfies Plugin;
