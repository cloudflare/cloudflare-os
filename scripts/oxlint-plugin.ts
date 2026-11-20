import type { Comment, Diagnostic, ESTree, Plugin, Rule } from "vite-plus/lint/plugins";

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

type ClassMember = ESTree.ClassBody["body"][number];

/**
 * The class's instance method named `name`, when it is declared with a plain name and a body. An
 * overload signature has no body and is not the method that runs.
 */
function methodNamed(body: ESTree.ClassBody, name: string): ESTree.MethodDefinition | undefined {
  return body.body.find((member: ClassMember): member is ESTree.MethodDefinition =>
    member.type === "MethodDefinition" && !member.static && !member.computed &&
    member.key.type === "Identifier" && member.key.name === name && !!member.value.body);
}

/** Whether a member expression reads the plain property `name`: not computed, not `#private`. */
function reads(member: ESTree.MemberExpression, name: string): boolean {
  return !member.computed && member.property.type === "Identifier" && member.property.name === name;
}

/** The name a property is written under, quoted or not; undefined for a spread or a computed key. */
function keyName(property: ESTree.Node): string | undefined {
  if (property.type !== "Property" || property.computed) return undefined;
  const { key } = property;
  if (key.type === "Identifier") return key.name;
  return key.type === "Literal" && typeof key.value === "string" ? key.value : undefined;
}

/**
 * The expressions a value written in place may turn out to be: itself, or any branch of a
 * conditional or of `??`, `||` and `&&`. What `satisfies` and `as` wrap is the value that is sent.
 */
function* branches(node: ESTree.Node | null | undefined): Generator<ESTree.Node> {
  if (node?.type === "TSSatisfiesExpression" || node?.type === "TSAsExpression") {
    yield* branches(node.expression);
  } else if (node?.type === "ConditionalExpression") {
    yield* branches(node.consequent);
    yield* branches(node.alternate);
  } else if (node?.type === "LogicalExpression") {
    yield* branches(node.left);
    yield* branches(node.right);
  } else if (node) {
    yield node;
  }
}

const newGatekeeperObserverContract: Rule = {
  meta: {
    type: "problem",
    docs: {
      description: "Hold a gatekeeper to the parts of the new-gatekeeper observer contract that " +
        "its types do not enforce (see the write-gatekeeper skill)",
    },
    messages: {
      missingHistory: "A gatekeeper needs `getHistoricalSubresources()`, which the `Gatekeeper` " +
        "interface does not declare. A new gatekeeper returns `[]` from it.",
      history: "A new gatekeeper's `getHistoricalSubresources()` only returns `[]`: it has no " +
        "reads made before subresources were reported.",
      observerState: "A new gatekeeper's `{{name}}()` does nothing. Report `subresources` on every " +
        "read and check each observer in `verifyObserverAccess()`.",
      unreported: "Pass `subresources` explicitly, after any spread, which could replace it, and " +
        "`[]` for a read nothing restricts. Leaving it out adds no requirement and reads as one " +
        "that was forgotten.",
      excludeObservers: "`excludeObservers` belongs to the legacy observer protocol. Report " +
        "`subresources` and deny in `verifyObserverAccess()`.",
    },
    schema: [],
  },
  create(context) {
    return {
      "ClassDeclaration, ClassExpression"({ body, id, implements: interfaces, superClass }: ESTree.Class) {
        const addObserver = methodNamed(body, "addObserver");
        const declared = interfaces?.some(({ expression }) =>
          expression.type === "Identifier" && expression.name === "Gatekeeper");
        if (!declared && !(methodNamed(body, "startSession") && addObserver)) return;

        const history = methodNamed(body, "getHistoricalSubresources");
        const statements = history?.value.body?.body;
        const [returned, ...others] = statements?.length === 1 && statements[0].type === "ReturnStatement"
          ? branches(statements[0].argument) : [];
        // A facet base of the gatekeeper's own may supply it, as it may supply `startSession()`.
        // Cloudflare's `DurableObject` supplies neither.
        const inherits = superClass && !(superClass.type === "Identifier" && superClass.name === "DurableObject");
        if (!history) {
          if (!inherits) context.report({ node: addObserver?.key ?? id ?? body, messageId: "missingHistory" });
        } else if (others.length || returned?.type !== "ArrayExpression" || returned.elements.length > 0) {
          context.report({ node: history.key, messageId: "history" });
        }

        for (const name of ["addObserver", "removeObserver"]) {
          const method = methodNamed(body, name);
          if (method?.value.body && method.value.body.body.length > 0) {
            context.report({ node: method.key, messageId: "observerState", data: { name } });
          }
        }
      },
      CallExpression(node) {
        const { callee } = node;
        if (callee.type !== "MemberExpression" || !reads(callee, "authorizeObservation")) return;
        // A description built elsewhere is its helper's type to check; one written here is this
        // rule's, in each branch it is written in.
        for (const description of branches(node.arguments[0])) {
          if (description.type !== "ObjectExpression") continue;
          // The last word on the field: a spread after it can replace it, and the kernel reads
          // `subresources: undefined` as the field left out.
          const last = description.properties.findLast(property =>
            property.type === "SpreadElement" || keyName(property) === "subresources");
          const reported = last?.type === "Property" && !branches(last.value).some(value =>
            value.type === "Identifier" && value.name === "undefined");
          if (!reported) context.report({ node: description, messageId: "unreported" });
        }
      },
      Property(node) {
        if (keyName(node) === "excludeObservers") context.report({ node, messageId: "excludeObservers" });
      },
      MemberExpression(node) {
        if (reads(node, "excludeObservers")) context.report({ node, messageId: "excludeObservers" });
      },
    };
  },
};

export default {
  meta: {
    name: "gadgets",
  },
  rules: {
    "new-gatekeeper-observer-contract": newGatekeeperObserverContract,
    "prefer-jsdoc": preferJsdoc,
    "self-contained-agent-types": selfContainedAgentTypes,
  },
} satisfies Plugin;
